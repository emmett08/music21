'''
Bounded score-to-audio rendering for the music21 MCP backend.

Audio rendering accepts only parsed scores and fixed WAV or MP3 targets.  MIDI
synthesis and transcoding run without a shell, without network access and only
inside a server-created temporary directory.  This module was written with AI
assistance.
'''

from __future__ import annotations

import base64
import os
from pathlib import Path
import stat
import subprocess
import tempfile

from music21 import stream

from backend.models import AudioFormat
from backend.models import GeneratedArtifact
from backend.models import MAX_AUDIO_OUTPUT_BYTES
from backend.service import ServiceError


AUDIO_SAMPLE_RATE = 44_100
AUDIO_GAIN = '0.8'
FLUIDSYNTH_TIMEOUT_SECONDS = 35
FFMPEG_TIMEOUT_SECONDS = 25
AUDIO_PROBE_TIMEOUT_SECONDS = 3

_AUDIO_MEDIA_TYPES = {
    AudioFormat.WAV: 'audio/wav',
    AudioFormat.MP3: 'audio/mpeg',
}


def audio_health_status() -> dict[str, object]:
    '''Return audio renderer availability without exposing local paths.'''

    soundfont_available = _configured_soundfont_path().is_file()
    fluidsynth_available = _probe_executable(_fluidsynth_binary(), '--version')
    ffmpeg_available = _probe_executable(_ffmpeg_binary(), '-version')
    return {
        'available': soundfont_available and fluidsynth_available and ffmpeg_available,
        'formats': [audio_format.value for audio_format in AudioFormat],
        'sampleRate': AUDIO_SAMPLE_RATE,
        'maximumOutputBytes': MAX_AUDIO_OUTPUT_BYTES,
        'soundfontAvailable': soundfont_available,
        'fluidsynthAvailable': fluidsynth_available,
        'ffmpegAvailable': ffmpeg_available,
    }


def render_audio(
    score: stream.Score | stream.Part,
    output_format: AudioFormat,
) -> dict[str, str | int]:
    '''Render one parsed score to a normalised WAV or MP3 artefact.'''

    with tempfile.TemporaryDirectory(prefix='music21-mcp-audio-') as temp_directory:
        temp_path = Path(temp_directory)
        midi_path = temp_path / 'score.mid'
        synthesis_path = temp_path / 'synthesis.wav'
        output_path = temp_path / f'score.{output_format.value}'

        try:
            score.write('midi', fp=midi_path)
        except Exception as exc:
            raise ServiceError(
                'audio_render_failed',
                'The score could not be prepared for audio rendering.',
            ) from exc

        _synthesise_midi(midi_path, synthesis_path)
        _transcode_audio(synthesis_path, output_path, output_format)
        content = _read_bounded_audio(output_path)

    return GeneratedArtifact(
        outputFormat=output_format.value,
        contentType=_AUDIO_MEDIA_TYPES[output_format],
        encoding='base64',
        size=len(content),
        content=base64.b64encode(content).decode('ascii'),
    ).as_api_dict()


def _synthesise_midi(midi_path: Path, output_path: Path) -> None:
    command = [
        _fluidsynth_binary(),
        '-n',
        '-i',
        '-F',
        str(output_path),
        '-T',
        'wav',
        '-r',
        str(AUDIO_SAMPLE_RATE),
        '-g',
        AUDIO_GAIN,
        str(_soundfont_path()),
        str(midi_path),
    ]
    _run_audio_process(command, FLUIDSYNTH_TIMEOUT_SECONDS)


def _transcode_audio(
    input_path: Path,
    output_path: Path,
    output_format: AudioFormat,
) -> None:
    command = [
        _ffmpeg_binary(),
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-i',
        str(input_path),
        '-af',
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar',
        str(AUDIO_SAMPLE_RATE),
        '-ac',
        '2',
    ]
    if output_format == AudioFormat.WAV:
        command.extend(['-c:a', 'pcm_s16le'])
    else:
        command.extend(['-c:a', 'libmp3lame', '-b:a', '192k'])
    command.append(str(output_path))
    _run_audio_process(command, FFMPEG_TIMEOUT_SECONDS)


def _run_audio_process(command: list[str], timeout_seconds: int) -> None:
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            shell=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise ServiceError(
            'audio_render_timeout',
            'Audio rendering did not finish within the service time limit.',
            status_code=504,
        ) from exc
    except OSError as exc:
        raise ServiceError(
            'audio_renderer_unavailable',
            'The audio renderer is not available in the processing container.',
            status_code=503,
        ) from exc

    if completed.returncode != 0:
        raise ServiceError(
            'audio_render_failed',
            'The audio renderer could not render the score.',
        )


def _read_bounded_audio(path: Path) -> bytes:
    try:
        file_status = path.lstat()
    except OSError as exc:
        raise ServiceError(
            'audio_render_failed',
            'The audio renderer did not produce the requested output.',
        ) from exc

    if not stat.S_ISREG(file_status.st_mode):
        raise ServiceError(
            'audio_render_failed',
            'Generated audio was not a regular file.',
        )
    if file_status.st_size > MAX_AUDIO_OUTPUT_BYTES:
        raise ServiceError(
            'output_too_large',
            f'Generated audio exceeds the {MAX_AUDIO_OUTPUT_BYTES}-byte limit.',
            status_code=413,
        )

    content = path.read_bytes()
    if len(content) > MAX_AUDIO_OUTPUT_BYTES:
        raise ServiceError(
            'output_too_large',
            f'Generated audio exceeds the {MAX_AUDIO_OUTPUT_BYTES}-byte limit.',
            status_code=413,
        )
    return content


def _soundfont_path() -> Path:
    path = _configured_soundfont_path()
    if not path.is_file():
        raise ServiceError(
            'audio_renderer_unavailable',
            'The configured audio soundfont is not available.',
            status_code=503,
        )
    return path


def _configured_soundfont_path() -> Path:
    return Path(
        os.environ.get(
            'MUSIC21_MCP_SOUNDFONT',
            '/usr/share/sounds/music21-mcp.sf3',
        )
    )


def _probe_executable(binary: str, version_argument: str) -> bool:
    try:
        completed = subprocess.run(
            [binary, version_argument],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            shell=False,
            timeout=AUDIO_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _fluidsynth_binary() -> str:
    return os.environ.get('MUSIC21_MCP_FLUIDSYNTH', 'fluidsynth')


def _ffmpeg_binary() -> str:
    return os.environ.get('MUSIC21_MCP_FFMPEG', 'ffmpeg')
