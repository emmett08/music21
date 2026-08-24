'''
Focused API and service tests for the music21 MCP container backend.

These tests were written with AI assistance.
'''

from __future__ import annotations

import base64
import itertools
from pathlib import Path
import subprocess
from typing import Any, cast

from fastapi.testclient import TestClient
from music21 import converter
from music21 import metadata
from music21.musicxml.m21ToXml import GeneralObjectExporter
from music21 import note
from music21 import stream
import pytest

from backend.app import app
from backend.models import InputFormat
from backend.models import MAX_OUTPUT_BYTES
from backend.models import MAX_SOURCE_BYTES
from backend import service


client = TestClient(app)
TINY_SCORE = 'tinyNotation: 4/4 C4 D4 E4 F4'


def _request(output_format: str | None = None) -> dict[str, object]:
    request: dict[str, object] = {
        'source': TINY_SCORE,
        'inputFormat': 'tiny_notation',
    }
    if output_format is not None:
        request['outputFormat'] = output_format
    return request


def test_health_reports_versions_and_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service, 'probe_lilypond', lambda: (True, '2.24.3'))

    response = client.get('/health')

    assert response.status_code == 200
    data = response.json()['data']
    assert data['service'] == 'music21-mcp-backend'
    assert data['music21Version']
    assert data['lilypond'] == {'available': True, 'version': '2.24.3'}
    assert data['limits']['sourceBytes'] == MAX_SOURCE_BYTES


def test_inspect_returns_bounded_deterministic_structure() -> None:
    response = client.post('/v1/inspect', json=_request())
    repeated_response = client.post('/v1/inspect', json=_request())

    assert response.status_code == 200
    data = response.json()['data']
    assert repeated_response.json()['data'] == data
    assert data['noteCount'] == 4
    assert data['restCount'] == 0
    assert data['durationQuarterLength'] == 4.0
    assert data['pitchRange'] == {'lowest': 'C3', 'highest': 'F3', 'semitones': 5.0}
    assert data['timeSignatures'] == ['4/4']
    assert data['parts'][0]['id'] is None
    assert data['metadata'] == {
        'title': None,
        'composer': None,
        'movementName': None,
        'movementNumber': None,
        'opusNumber': None,
    }


def test_inspect_normalises_metadata() -> None:
    score = stream.Score()
    score.append(note.Note('C4'))
    score.metadata = metadata.Metadata()
    score.metadata.title = '  Example\n title  '
    score.metadata.composer = 'A.  Composer'

    result = service.inspect_score(score)

    assert result['metadata']['title'] == 'Example title'
    assert result['metadata']['composer'] == 'A. Composer'


@pytest.mark.parametrize(
    'source,input_format,error_code',
    [
        ('https://example.test/score.musicxml', 'musicxml', 'invalid_request'),
        ('/etc/passwd', 'tiny_notation', 'invalid_request'),
        ('file:///tmp/score.xml', 'musicxml', 'invalid_request'),
        ('<!DOCTYPE score-partwise><score-partwise/>', 'musicxml', 'unsafe_xml'),
        (
            '<!ENTITY xxe SYSTEM "file:///etc/passwd"><score-partwise/>',
            'musicxml',
            'invalid_request',
        ),
    ],
)
def test_rejects_urls_paths_and_xml_entities(
    source: str,
    input_format: str,
    error_code: str,
) -> None:
    response = client.post(
        '/v1/inspect',
        json={'source': source, 'inputFormat': input_format},
    )

    assert response.status_code == 422
    assert response.json()['error']['code'] == error_code


def test_accepts_standard_musicxml_doctype_without_resolving_it() -> None:
    score = stream.Score()
    part = stream.Part()
    part.append(note.Note('C4'))
    score.append(part)
    source = GeneralObjectExporter(score).parse().decode('utf-8')
    assert '<!DOCTYPE score-partwise' in source

    response = client.post(
        '/v1/inspect',
        json={'source': source, 'inputFormat': 'musicxml'},
    )

    assert response.status_code == 200
    assert response.json()['data']['noteCount'] == 1


def test_rejects_utf8_source_over_byte_limit() -> None:
    response = client.post(
        '/v1/inspect',
        json={'source': 'é' * (MAX_SOURCE_BYTES // 2 + 1), 'inputFormat': 'abc'},
    )

    assert response.status_code == 422
    assert response.json()['error']['code'] == 'invalid_request'


def test_rejects_unknown_fields_and_formats() -> None:
    request = _request()
    request['unexpected'] = True
    response = client.post('/v1/inspect', json=request)

    assert response.status_code == 422
    assert response.json()['error']['code'] == 'invalid_request'

    request = _request('wav')
    response = client.post('/v1/convert', json=request)
    assert response.status_code == 422


def test_enforces_post_parse_element_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service, 'MAX_ELEMENTS', 2)

    response = client.post('/v1/inspect', json=_request())

    assert response.status_code == 413
    assert response.json()['error']['code'] == 'score_too_complex'
    assert TINY_SCORE not in response.text


def test_post_parse_limit_stops_an_unbounded_traversal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parsed = stream.Part()
    monkeypatch.setattr(
        parsed,
        'recurse',
        lambda: itertools.repeat(note.Note('C4')),
    )
    monkeypatch.setattr(service.converter, 'parseData', lambda *args, **kwargs: parsed)
    monkeypatch.setattr(service, 'MAX_ELEMENTS', 3)

    with pytest.raises(service.ServiceError, match='element limit') as raised:
        service.parse_score(TINY_SCORE, InputFormat.TINY_NOTATION)

    assert raised.value.code == 'score_too_complex'


def test_musicxml_preflight_limits_depth_and_node_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deeply_nested = '<score-partwise>' + '<part>' * 129 + '</part>' * 129 + '</score-partwise>'
    response = client.post(
        '/v1/inspect',
        json={'source': deeply_nested, 'inputFormat': 'musicxml'},
    )
    assert response.status_code == 413
    assert response.json()['error']['code'] == 'xml_too_complex'

    monkeypatch.setattr(service, 'MAX_XML_NODES', 2)
    response = client.post(
        '/v1/inspect',
        json={
            'source': '<score-partwise><part-list/><part/></score-partwise>',
            'inputFormat': 'musicxml',
        },
    )
    assert response.status_code == 413
    assert response.json()['error']['code'] == 'xml_too_complex'


def test_analyse_runs_only_allow_list() -> None:
    request = _request()
    request['analyses'] = ['key', 'ambitus', 'pitch_class_histogram']

    response = client.post('/v1/analyse', json=request)

    assert response.status_code == 200
    results = response.json()['data']['results']
    assert set(results) == {'key', 'ambitus', 'pitchClassHistogram'}
    assert results['ambitus']['semitones'] == 5.0
    assert results['pitchClassHistogram'] == [1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0]
    assert results['key']['mode'] in {'major', 'minor'}


def test_analyse_rejects_duplicate_or_unknown_algorithms() -> None:
    request = _request()
    request['analyses'] = ['key', 'key']
    response = client.post('/v1/analyse', json=request)
    assert response.status_code == 422

    request['analyses'] = ['arbitrary_python_method']
    response = client.post('/v1/analyse', json=request)
    assert response.status_code == 422


def test_convert_musicxml_and_midi_include_artifact_metadata() -> None:
    xml_response = client.post('/v1/convert', json=_request('musicxml'))
    midi_response = client.post('/v1/convert', json=_request('midi'))

    assert xml_response.status_code == 200
    xml_artifact = xml_response.json()['data']['artifact']
    assert xml_artifact['outputFormat'] == 'musicxml'
    assert xml_artifact['contentType'] == 'application/vnd.recordare.musicxml+xml'
    assert xml_artifact['encoding'] == 'utf-8'
    assert xml_artifact['size'] == len(xml_artifact['content'].encode('utf-8'))
    assert '<score-partwise' in xml_artifact['content']

    assert midi_response.status_code == 200
    midi_artifact = midi_response.json()['data']['artifact']
    midi_bytes = base64.b64decode(midi_artifact['content'])
    assert midi_artifact['contentType'] == 'audio/midi'
    assert midi_artifact['encoding'] == 'base64'
    assert midi_artifact['size'] == len(midi_bytes)
    assert midi_bytes.startswith(b'MThd')


def test_convert_lilypond_uses_bounded_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service, 'probe_lilypond', lambda: (True, '2.24.3'))

    response = client.post('/v1/convert', json=_request('lilypond'))

    assert response.status_code == 200
    artifact = response.json()['data']['artifact']
    assert artifact['contentType'] == 'text/x-lilypond; charset=utf-8'
    assert artifact['encoding'] == 'utf-8'
    assert '\\version "2.24"' in artifact['content']


def test_lilypond_generation_keeps_untrusted_text_in_strings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service, 'probe_lilypond', lambda: (True, '2.24.3'))
    score = stream.Score()
    part = stream.Part()
    unsafe_lyric = note.Note('C4')
    unsafe_lyric.lyric = r'"" #(error "MCP_PROBE") \\include'
    unsafe_lyric.style.color = r'" #(error "MCP_COLOUR_PROBE")'
    part.append(unsafe_lyric)
    score.append(part)
    score.metadata = metadata.Metadata()
    score.metadata.title = r'" #(error "MCP_TITLE_PROBE")'

    source = service._lilypond_source(score)
    executable_code = service._lilypond_code_only(source)

    assert 'MCP_PROBE' not in executable_code
    assert 'MCP_COLOUR_PROBE' not in executable_code
    assert 'MCP_TITLE_PROBE' not in executable_code
    assert '\\include' not in executable_code


@pytest.mark.parametrize(
    'source',
    [
        'c\'4 #(error "MCP_PROBE")',
        'c\'4 $(error "MCP_PROBE")',
        '\\include "untrusted.ly"',
        '\\bookOutputName "/tmp/untrusted"',
        "\\apply #SYSTEM c'4",
    ],
)
def test_lilypond_generation_rejects_active_extensions(source: str) -> None:
    with pytest.raises(service.ServiceError) as raised:
        service._validate_generated_lilypond(source)

    assert raised.value.code == 'unsafe_lilypond'


def test_transpose_returns_normalised_interval_and_parseable_output() -> None:
    request = _request('musicxml')
    request['interval'] = 'P5'

    response = client.post('/v1/transpose', json=request)

    assert response.status_code == 200
    data = response.json()['data']
    assert data['interval'] == {'name': 'P5', 'semitones': 7}
    converted = converter.parseData(data['artifact']['content'], format='musicxml')
    assert [n.pitch.nameWithOctave for n in converted.recurse().notes] == [
        'G3',
        'A3',
        'B3',
        'C4',
    ]


def test_transpose_rejects_large_named_interval() -> None:
    request = _request('musicxml')
    request['interval'] = 'P50'

    response = client.post('/v1/transpose', json=request)

    assert response.status_code == 422
    assert response.json()['error']['code'] == 'invalid_interval'


def test_generated_file_size_is_checked_before_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert MAX_OUTPUT_BYTES == 2 * 1024 * 1024
    oversized = tmp_path / 'oversized.pdf'
    oversized.touch()
    oversized.write_bytes(b'')
    oversized.chmod(0o600)
    with oversized.open('r+b') as output_file:
        output_file.truncate(MAX_OUTPUT_BYTES + 1)

    def unexpected_read(unused_path):
        raise AssertionError('oversized file must not be read')

    monkeypatch.setattr(Path, 'read_bytes', unexpected_read)
    with pytest.raises(service.ServiceError) as raised:
        service._read_bounded_files((oversized,))

    assert raised.value.code == 'output_too_large'


def test_render_uses_argument_vector_and_returns_all_pages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service, 'probe_lilypond', lambda: (True, '2.24.3'))
    observed: dict[str, object] = {}

    def fake_run(command, **kwargs):
        observed['command'] = command
        observed['kwargs'] = kwargs
        output_base = Path(command[command.index('-o') + 1])
        output_base.with_name(output_base.name + '-1').with_suffix('.svg').write_text(
            '<svg>one</svg>', encoding='utf-8'
        )
        output_base.with_name(output_base.name + '-2').with_suffix('.svg').write_text(
            '<svg>two</svg>', encoding='utf-8'
        )
        return subprocess.CompletedProcess(command, 0, b'', b'')

    monkeypatch.setattr(service.subprocess, 'run', fake_run)
    response = client.post('/v1/render', json=_request('svg'))

    assert response.status_code == 200
    data = response.json()['data']
    assert data['pageCount'] == 2
    assert [artifact['content'] for artifact in data['artifacts']] == [
        '<svg>one</svg>',
        '<svg>two</svg>',
    ]
    command = cast(list[str], observed['command'])
    run_kwargs = cast(dict[str, Any], observed['kwargs'])
    assert command[0] == 'lilypond'
    assert command[1:3] == ['--svg', '-dno-point-and-click']
    assert run_kwargs['shell'] is False
    assert run_kwargs['stdout'] is subprocess.DEVNULL
    assert run_kwargs['stderr'] is subprocess.DEVNULL
    assert run_kwargs['timeout'] == service.LILYPOND_TIMEOUT_SECONDS


def test_render_timeout_is_stable_and_does_not_echo_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service, 'probe_lilypond', lambda: (True, '2.24.3'))

    def raise_timeout(command, **unused_kwargs):
        raise subprocess.TimeoutExpired(command, service.LILYPOND_TIMEOUT_SECONDS)

    monkeypatch.setattr(service.subprocess, 'run', raise_timeout)
    response = client.post('/v1/render', json=_request('pdf'))

    assert response.status_code == 504
    assert response.json()['error']['code'] == 'render_timeout'
    assert TINY_SCORE not in response.text
