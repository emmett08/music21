'''
Bounded music21 operations used by the private MCP container API.

The functions in this module accept inline score data only and expose a closed
set of analysis and conversion operations.  This module was written with AI
assistance.
'''

from __future__ import annotations

import base64
from collections.abc import Iterable
import itertools
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
from typing import Any, cast
import xml.etree.ElementTree as ElementTree

import music21
from music21 import chord
from music21 import converter
from music21 import interval as m21interval
from music21 import key
from music21.lily import lilyObjects as lyo
from music21.lily.translate import LilypondConverter
from music21 import meter
from music21 import note
from music21 import stream

from backend.models import AnalysisKind
from backend.models import ConvertFormat
from backend.models import GeneratedArtifact
from backend.models import InputFormat
from backend.models import MAX_ELEMENTS
from backend.models import MAX_OUTPUT_BYTES
from backend.models import MAX_PARTS
from backend.models import MAX_RENDER_PAGES
from backend.models import MAX_SOURCE_BYTES
from backend.models import MAX_XML_DEPTH
from backend.models import MAX_XML_NODES
from backend.models import RenderFormat


LILYPOND_TIMEOUT_SECONDS = 20
LILYPOND_PROBE_TIMEOUT_SECONDS = 3

_INPUT_FORMAT_NAMES = {
    InputFormat.MUSICXML: 'musicxml',
    InputFormat.ABC: 'abc',
    InputFormat.TINY_NOTATION: 'tinyNotation',
    InputFormat.ROMAN_TEXT: 'romanText',
}
_CONVERT_MEDIA_TYPES = {
    ConvertFormat.MUSICXML: 'application/vnd.recordare.musicxml+xml',
    ConvertFormat.MIDI: 'audio/midi',
    ConvertFormat.LILYPOND: 'text/x-lilypond; charset=utf-8',
}
_RENDER_MEDIA_TYPES = {
    RenderFormat.SVG: 'image/svg+xml',
    RenderFormat.PNG: 'image/png',
    RenderFormat.PDF: 'application/pdf',
}
_TEXT_FORMATS = {ConvertFormat.MUSICXML, ConvertFormat.LILYPOND, RenderFormat.SVG}
_DOCTYPE_DECLARATION = re.compile(r'<!DOCTYPE\b.*?>', flags=re.IGNORECASE | re.DOTALL)
_STANDARD_MUSICXML_DOCTYPE = re.compile(
    r'''<!DOCTYPE\s+(score-(?:partwise|timewise))\s+PUBLIC\s+
        "-//Recordare//DTD\s+MusicXML\s+([1-4]\.\d)\s+(Partwise|Timewise)//EN"\s+
        "http://www\.musicxml\.org/dtds/(partwise|timewise)\.dtd"\s*>''',
    flags=re.IGNORECASE | re.VERBOSE,
)


class ServiceError(Exception):
    '''A stable API error which does not include score data or local paths.'''

    def __init__(self, code: str, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def parse_score(source: str, input_format: InputFormat) -> stream.Score | stream.Part:
    '''Parse inline score text and enforce post-parse structural limits.'''

    if input_format == InputFormat.MUSICXML:
        source = _preflight_musicxml(source)

    try:
        parsed = converter.parseData(source, format=_INPUT_FORMAT_NAMES[input_format])
    except Exception as exc:
        raise ServiceError('parse_failed', 'The supplied score could not be parsed.') from exc

    if isinstance(parsed, stream.Opus):
        raise ServiceError(
            'multiple_scores',
            'Opus input containing multiple scores is not supported.',
        )

    _bounded_elements(parsed)

    part_count = 1 if isinstance(parsed, stream.Part) else len(parsed.parts)
    if part_count > MAX_PARTS:
        raise ServiceError(
            'score_too_complex',
            f'The parsed score exceeds the {MAX_PARTS}-part limit.',
            status_code=413,
        )
    return parsed


def inspect_score(score: stream.Score | stream.Part) -> dict[str, Any]:
    '''Return deterministic, bounded structural and metadata fields.'''

    elements = tuple(score.recurse())
    pitches = tuple(_iter_pitches(elements))
    parts = (score,) if isinstance(score, stream.Part) else tuple(score.parts)

    time_signatures = _unique_limited(
        element.ratioString
        for element in elements
        if isinstance(element, meter.TimeSignature)
    )
    key_signatures = _unique_limited(
        _key_signature_name(element)
        for element in elements
        if isinstance(element, (key.Key, key.KeySignature))
    )

    return {
        'metadata': _metadata_fields(score),
        'elementCount': len(elements),
        'partCount': len(parts),
        'measureCount': sum(isinstance(element, stream.Measure) for element in elements),
        'noteCount': sum(isinstance(element, note.Note) for element in elements),
        'chordCount': sum(isinstance(element, chord.Chord) for element in elements),
        'restCount': sum(isinstance(element, note.Rest) for element in elements),
        'durationQuarterLength': _finite_float(score.highestTime),
        'pitchRange': _pitch_range(pitches),
        'timeSignatures': time_signatures,
        'keySignatures': key_signatures,
        'parts': [_part_summary(part, index) for index, part in enumerate(parts)],
    }


def analyse_score(
    score: stream.Score | stream.Part,
    analyses: Iterable[AnalysisKind],
) -> dict[str, Any]:
    '''Run only the named, allow-listed music21 analyses.'''

    requested = tuple(analyses)
    results: dict[str, Any] = {}
    pitches = tuple(_iter_pitches(tuple(score.recurse())))

    for analysis in requested:
        if analysis == AnalysisKind.KEY:
            results['key'] = _analyse_key(score, pitches)
        elif analysis == AnalysisKind.AMBITUS:
            results['ambitus'] = _analyse_ambitus(score, pitches)
        elif analysis == AnalysisKind.PITCH_CLASS_HISTOGRAM:
            histogram = [0] * 12
            for this_pitch in pitches:
                histogram[int(this_pitch.pitchClass) % 12] += 1
            results['pitchClassHistogram'] = histogram

    return {'results': results}


def transpose_score(
    score: stream.Score | stream.Part,
    interval_spec: int | str,
    output_format: ConvertFormat,
) -> dict[str, Any]:
    '''Transpose a score by a bounded interval and serialise it.'''

    try:
        requested_interval = m21interval.Interval(interval_spec)
        semitones = float(requested_interval.semitones)
        if not math.isfinite(semitones) or abs(semitones) > 48:
            raise ValueError('interval exceeds service limits')
        transposed = score.transpose(requested_interval)
    except Exception as exc:
        raise ServiceError('invalid_interval', 'The requested interval is not valid.') from exc

    artifact = convert_score(transposed, output_format)
    return {
        'interval': {
            'name': requested_interval.directedName,
            'semitones': int(semitones) if semitones.is_integer() else semitones,
        },
        'artifact': artifact,
    }


def convert_score(
    score: stream.Score | stream.Part,
    output_format: ConvertFormat,
) -> dict[str, str | int]:
    '''Convert a parsed score to one fixed output format.'''

    try:
        with tempfile.TemporaryDirectory(prefix='music21-mcp-convert-') as temp_directory:
            temp_path = Path(temp_directory)
            if output_format == ConvertFormat.MUSICXML:
                output_path = temp_path / 'score.musicxml'
                score.write('musicxml', fp=output_path)
                content = _read_bounded_files((output_path,))[0]
            elif output_format == ConvertFormat.MIDI:
                output_path = temp_path / 'score.mid'
                score.write('midi', fp=output_path)
                content = _read_bounded_files((output_path,))[0]
            else:
                content = _lilypond_source(score).encode('utf-8')
    except ServiceError:
        raise
    except Exception as exc:
        raise ServiceError('conversion_failed', 'The score could not be converted.') from exc

    return _artifact(output_format, _CONVERT_MEDIA_TYPES[output_format], content).as_api_dict()


def render_score(
    score: stream.Score | stream.Part,
    output_format: RenderFormat,
) -> dict[str, Any]:
    '''Render a score with LilyPond using fixed arguments and a hard timeout.'''

    lilypond_source = _lilypond_source(score)
    binary = _lilypond_binary()

    with tempfile.TemporaryDirectory(prefix='music21-mcp-render-') as temp_directory:
        temp_path = Path(temp_directory)
        source_path = temp_path / 'score.ly'
        output_base = temp_path / 'score'
        source_path.write_text(lilypond_source, encoding='utf-8')

        command = [
            binary,
            f'--{output_format.value}',
            '-dno-point-and-click',
        ]
        if output_format == RenderFormat.PNG:
            command.append('-dresolution=150')
        command.extend(['-o', str(output_base), str(source_path)])

        try:
            completed = subprocess.run(
                command,
                cwd=temp_path,
                stdin=subprocess.DEVNULL,
                # LilyPond diagnostics are not returned to callers.  Discarding them also
                # prevents an adversarial score from filling memory through captured output.
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                shell=False,
                timeout=LILYPOND_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise ServiceError(
                'render_timeout',
                f'LilyPond did not finish within {LILYPOND_TIMEOUT_SECONDS} seconds.',
                status_code=504,
            ) from exc
        except OSError as exc:
            raise ServiceError(
                'lilypond_unavailable',
                'LilyPond is not available in the rendering container.',
                status_code=503,
            ) from exc

        if completed.returncode != 0:
            raise ServiceError('render_failed', 'LilyPond could not render the score.')

        output_paths = sorted(
            temp_path.glob(f'score*.{output_format.value}'),
            key=_rendered_page_sort_key,
        )
        if not output_paths:
            raise ServiceError('render_failed', 'LilyPond did not produce the requested output.')
        if len(output_paths) > MAX_RENDER_PAGES:
            raise ServiceError(
                'output_too_large',
                f'Rendered output exceeds the {MAX_RENDER_PAGES}-page limit.',
                status_code=413,
            )

        rendered_files = _read_bounded_files(output_paths)
        artifacts = [
            _artifact(output_format, _RENDER_MEDIA_TYPES[output_format], content).as_api_dict()
            for content in rendered_files
        ]

    return {'pageCount': len(artifacts), 'artifacts': artifacts}


def health_status() -> dict[str, Any]:
    '''Return dependency versions and the service's enforced ceilings.'''

    lilypond_available, lilypond_version = probe_lilypond()
    return {
        'service': 'music21-mcp-backend',
        'music21Version': music21.VERSION_STR,
        'lilypond': {
            'available': lilypond_available,
            'version': lilypond_version,
        },
        'limits': {
            'sourceBytes': MAX_SOURCE_BYTES,
            'elements': MAX_ELEMENTS,
            'parts': MAX_PARTS,
            'outputBytes': MAX_OUTPUT_BYTES,
            'renderPages': MAX_RENDER_PAGES,
            'xmlNodes': MAX_XML_NODES,
            'xmlDepth': MAX_XML_DEPTH,
            'lilypondTimeoutSeconds': LILYPOND_TIMEOUT_SECONDS,
        },
    }


def probe_lilypond() -> tuple[bool, str | None]:
    '''Probe the configured LilyPond executable with a bounded subprocess.'''

    try:
        completed = subprocess.run(
            [_lilypond_binary(), '--version'],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            shell=False,
            timeout=LILYPOND_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, None

    if completed.returncode != 0:
        return False, None
    output = completed.stdout.decode('utf-8', errors='replace')
    version_match = re.search(r'\b(\d+\.\d+(?:\.\d+)?)\b', output)
    return True, version_match.group(1) if version_match else None


class _BoundedLilypondConverter(LilypondConverter):
    '''Initialise music21's exporter without optional executable Scheme helpers.'''

    # These upstream fragments load a preamble and define a Scheme colour
    # function.  The bounded service does not need either feature, and omitting
    # them lets the generated-source check reject every active Scheme form.
    bookHeader = ''
    colorDef = ''

    def setupTools(self) -> None:
        available, version = probe_lilypond()
        if not available or version is None:
            raise ServiceError(
                'lilypond_unavailable',
                'LilyPond is not available in the rendering container.',
                status_code=503,
            )

        version_parts = version.split('.')
        self.majorVersion = version_parts[0]
        self.minorVersion = version_parts[1]
        self.LILYEXEC = _lilypond_binary()
        short_version = f'{self.majorVersion}.{self.minorVersion}'
        self.versionString = (
            self.topLevelObject.backslash
            + 'version '
            + self.topLevelObject.quoteString(short_version)
        )
        self.versionScheme = lyo.LyEmbeddedScm(self.versionString)
        self.headerScheme = lyo.LyEmbeddedScm(self.bookHeader)
        self.backend = 'ps'
        self.backendString = '-dbackend=' if int(self.majorVersion) >= 2 else '--backend='


def _lilypond_source(score: stream.Score | stream.Part) -> str:
    try:
        source = _BoundedLilypondConverter().textFromMusic21Object(score) + '\n'
        _validate_generated_lilypond(source)
        return source
    except ServiceError:
        raise
    except Exception as exc:
        raise ServiceError(
            'conversion_failed',
            'The score could not be converted to LilyPond.',
        ) from exc


def _validate_generated_lilypond(source: str) -> None:
    '''Reject executable Scheme and file-loading directives outside quoted text.'''

    code = _lilypond_code_only(source)
    forbidden_commands = re.compile(
        r'\\(?:include|bookOutputName|bookOutputSuffix|sourcefilename|sourcefileline)\b',
        flags=re.IGNORECASE,
    )
    if forbidden_commands.search(code) or '$' in code:
        raise ServiceError(
            'unsafe_lilypond',
            'The score requires a LilyPond feature that is not available in this service.',
        )

    # Remove the finite set of atomic Scheme values emitted by music21.  Any
    # remaining hash marker could introduce an active form such as `#(...)`.
    code_without_safe_values = re.sub(r'##[tf]\b', '', code)
    code_without_safe_values = re.sub(r"#'transparent\b", '', code_without_safe_values)
    code_without_safe_values = re.sub(r'#(?:UP|DOWN)\b', '', code_without_safe_values)
    code_without_safe_values = re.sub(
        r'#-?(?:\d+(?:\.\d*)?|\.\d+)\b',
        '',
        code_without_safe_values,
    )
    if '#' in code_without_safe_values:
        raise ServiceError(
            'unsafe_lilypond',
            'The score requires a LilyPond feature that is not available in this service.',
        )


def _lilypond_code_only(source: str) -> str:
    '''Return source outside strings and comments, preserving token boundaries.'''

    output: list[str] = []
    index = 0
    length = len(source)
    while index < length:
        character = source[index]
        next_character = source[index + 1] if index + 1 < length else ''

        if character == '"':
            # A preceding `#` makes a Scheme string value.  It is data, not an
            # executable form, so remove the marker with the quoted contents.
            if output and output[-1] == '#':
                output.pop()
            index += 1
            while index < length:
                if source[index] == '\\':
                    index += 2
                    continue
                if source[index] == '"':
                    index += 1
                    break
                index += 1
            else:
                raise ServiceError('unsafe_lilypond', 'Generated LilyPond text is malformed.')
            output.append(' ')
            continue

        if character == '%' and next_character == '{':
            index += 2
            depth = 1
            while index < length and depth:
                pair = source[index:index + 2]
                if pair == '%{':
                    depth += 1
                    index += 2
                elif pair == '%}':
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise ServiceError('unsafe_lilypond', 'Generated LilyPond text is malformed.')
            output.append(' ')
            continue

        if character == '%':
            newline = source.find('\n', index + 1)
            index = length if newline < 0 else newline
            output.append(' ')
            continue

        output.append(character)
        index += 1

    return ''.join(output)


def _lilypond_binary() -> str:
    return os.environ.get('MUSIC21_MCP_LILYPOND', 'lilypond')


def _preflight_musicxml(source: str) -> str:
    source = _strip_standard_musicxml_doctype(source)
    parser = ElementTree.XMLPullParser(events=('start', 'end'))
    node_count = 0
    depth = 0
    try:
        for offset in range(0, len(source), 16_384):
            parser.feed(source[offset:offset + 16_384])
            node_count, depth = _consume_xml_events(parser, node_count, depth)
        parser.close()
        node_count, depth = _consume_xml_events(parser, node_count, depth)
    except ElementTree.ParseError as exc:
        raise ServiceError('parse_failed', 'The supplied MusicXML is not well formed.') from exc
    return source


def _strip_standard_musicxml_doctype(source: str) -> str:
    declarations = tuple(_DOCTYPE_DECLARATION.finditer(source))
    if not declarations:
        return source
    if len(declarations) != 1:
        raise ServiceError('unsafe_xml', 'MusicXML document type is not allowed.')

    declaration = declarations[0]
    matched = _STANDARD_MUSICXML_DOCTYPE.fullmatch(declaration.group())
    if matched is None:
        raise ServiceError('unsafe_xml', 'MusicXML document type is not allowed.')

    root_name, unused_version, public_kind, file_kind = matched.groups()
    root_kind = root_name.removeprefix('score-')
    if root_kind.lower() != public_kind.lower() or root_kind.lower() != file_kind.lower():
        raise ServiceError('unsafe_xml', 'MusicXML document type is not allowed.')

    # ElementTree does not need the external DTD.  Removing the declaration
    # ensures neither it nor a downstream parser can retrieve external content.
    return source[:declaration.start()] + source[declaration.end():]


def _consume_xml_events(
    parser: ElementTree.XMLPullParser,
    node_count: int,
    depth: int,
) -> tuple[int, int]:
    events = cast(
        Iterable[tuple[str, ElementTree.Element]],
        parser.read_events(),
    )
    for event, unused_element in events:
        if event == 'start':
            node_count += 1
            depth += 1
            if node_count > MAX_XML_NODES or depth > MAX_XML_DEPTH:
                raise ServiceError(
                    'xml_too_complex',
                    'The supplied MusicXML exceeds the structural limits.',
                    status_code=413,
                )
        else:
            depth -= 1
    return node_count, depth


def _bounded_elements(score: stream.Score | stream.Part) -> tuple:
    elements = tuple(itertools.islice(score.recurse(), MAX_ELEMENTS + 1))
    if len(elements) > MAX_ELEMENTS:
        raise ServiceError(
            'score_too_complex',
            f'The parsed score exceeds the {MAX_ELEMENTS}-element limit.',
            status_code=413,
        )
    return elements


def _read_bounded_files(paths: Iterable[Path]) -> list[bytes]:
    materialised_paths = tuple(paths)
    total_size = 0
    for path in materialised_paths:
        file_status = path.lstat()
        if not stat.S_ISREG(file_status.st_mode):
            raise ServiceError('conversion_failed', 'Generated output was not a regular file.')
        total_size += file_status.st_size
        if total_size > MAX_OUTPUT_BYTES:
            raise ServiceError(
                'output_too_large',
                f'Generated output exceeds the {MAX_OUTPUT_BYTES}-byte limit.',
                status_code=413,
            )

    contents = [path.read_bytes() for path in materialised_paths]
    if sum(len(content) for content in contents) > MAX_OUTPUT_BYTES:
        raise ServiceError(
            'output_too_large',
            f'Generated output exceeds the {MAX_OUTPUT_BYTES}-byte limit.',
            status_code=413,
        )
    return contents


def _artifact(
    output_format: ConvertFormat | RenderFormat,
    content_type: str,
    content: bytes,
) -> GeneratedArtifact:
    if len(content) > MAX_OUTPUT_BYTES:
        raise ServiceError(
            'output_too_large',
            f'Generated output exceeds the {MAX_OUTPUT_BYTES}-byte limit.',
            status_code=413,
        )

    if output_format in _TEXT_FORMATS:
        try:
            encoded_content = content.decode('utf-8')
        except UnicodeDecodeError as exc:
            raise ServiceError('conversion_failed', 'Generated text was not valid UTF-8.') from exc
        encoding = 'utf-8'
    else:
        encoded_content = base64.b64encode(content).decode('ascii')
        encoding = 'base64'

    return GeneratedArtifact(
        outputFormat=output_format.value,
        contentType=content_type,
        encoding=encoding,
        size=len(content),
        content=encoded_content,
    )


def _metadata_fields(score: stream.Score | stream.Part) -> dict[str, str | None]:
    metadata_object = score.metadata
    fields = {
        'title': getattr(metadata_object, 'title', None),
        'composer': getattr(metadata_object, 'composer', None),
        'movementName': getattr(metadata_object, 'movementName', None),
        'movementNumber': getattr(metadata_object, 'movementNumber', None),
        'opusNumber': getattr(metadata_object, 'opusNumber', None),
    }
    return {name: _normalise_text(value) for name, value in fields.items()}


def _normalise_text(value: object | None) -> str | None:
    if value is None:
        return None
    normalised = ' '.join(str(value).split())
    return normalised[:512] or None


def _part_summary(part: stream.Part, index: int) -> dict[str, Any]:
    elements = tuple(part.recurse())
    return {
        'index': index,
        'id': _normalise_text(getattr(part, '_id', None)),
        'name': _normalise_text(part.partName),
        'measureCount': sum(isinstance(element, stream.Measure) for element in elements),
        'noteCount': sum(isinstance(element, note.Note) for element in elements),
        'chordCount': sum(isinstance(element, chord.Chord) for element in elements),
        'restCount': sum(isinstance(element, note.Rest) for element in elements),
        'durationQuarterLength': _finite_float(part.highestTime),
    }


def _iter_pitches(elements: Iterable[object]):
    for element in elements:
        if isinstance(element, note.Note):
            yield element.pitch
        elif isinstance(element, chord.Chord):
            yield from element.pitches


def _pitch_range(pitches: tuple) -> dict[str, str | float] | None:
    if not pitches:
        return None
    lowest = min(pitches, key=lambda this_pitch: this_pitch.ps)
    highest = max(pitches, key=lambda this_pitch: this_pitch.ps)
    return {
        'lowest': lowest.nameWithOctave,
        'highest': highest.nameWithOctave,
        'semitones': float(highest.ps - lowest.ps),
    }


def _analyse_key(
    score: stream.Score | stream.Part,
    pitches: tuple,
) -> dict[str, str | float] | None:
    if not pitches:
        return None
    try:
        analysed_key = score.analyze('key')
    except Exception:
        return None
    return {
        'tonic': analysed_key.tonic.name,
        'mode': analysed_key.mode,
        'name': analysed_key.name,
        'correlationCoefficient': float(analysed_key.correlationCoefficient),
    }


def _analyse_ambitus(
    score: stream.Score | stream.Part,
    pitches: tuple,
) -> dict[str, str | float] | None:
    if not pitches:
        return None
    try:
        ambitus = score.analyze('ambitus')
    except Exception:
        return None
    return {
        'name': ambitus.directedName,
        'niceName': ambitus.niceName,
        'semitones': float(ambitus.semitones),
    }


def _key_signature_name(signature: key.Key | key.KeySignature) -> str:
    if isinstance(signature, key.Key):
        return signature.name
    return f'{signature.sharps:+d}'


def _unique_limited(values: Iterable[str], limit: int = 32) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
        if len(output) == limit:
            break
    return output


def _finite_float(value: Any) -> float:
    converted = float(value)
    return converted if math.isfinite(converted) else 0.0


def _rendered_page_sort_key(path: Path) -> tuple[int, str]:
    page_match = re.search(r'-(\d+)$', path.stem)
    return (int(page_match.group(1)) if page_match else 0, path.name)
