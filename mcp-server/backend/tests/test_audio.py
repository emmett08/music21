'''
Focused tests for bounded WAV and MP3 rendering.

These tests were written with AI assistance.
'''

from __future__ import annotations

import base64
from pathlib import Path
import subprocess
from typing import Any, cast

from fastapi.testclient import TestClient
import pytest

from backend import audio
from backend.app import app


client = TestClient(app)
TINY_SCORE = 'tinyNotation: 4/4 C4 D4 E4 F4'


def _request(output_format: str) -> dict[str, str]:
    return {
        'source': TINY_SCORE,
        'inputFormat': 'tiny_notation',
        'outputFormat': output_format,
    }


def test_audio_health_status_reports_dependency_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soundfont = tmp_path / 'fixed.sf3'
    soundfont.write_bytes(b'soundfont')
    monkeypatch.setenv('MUSIC21_MCP_SOUNDFONT', str(soundfont))
    monkeypatch.setattr(audio, '_probe_executable', lambda binary, argument: True)

    status = audio.audio_health_status()

    assert status == {
        'available': True,
        'formats': ['wav', 'mp3'],
        'sampleRate': 44_100,
        'maximumOutputBytes': audio.MAX_AUDIO_OUTPUT_BYTES,
        'soundfontAvailable': True,
        'fluidsynthAvailable': True,
        'ffmpegAvailable': True,
    }


@pytest.mark.parametrize(
    'output_format,content_type,prefix',
    [
        ('wav', 'audio/wav', b'RIFF'),
        ('mp3', 'audio/mpeg', b'ID3'),
    ],
)
def test_render_audio_uses_fixed_processes_and_returns_artifact(
    output_format: str,
    content_type: str,
    prefix: bytes,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soundfont = tmp_path / 'fixed.sf3'
    soundfont.write_bytes(b'soundfont')
    monkeypatch.setenv('MUSIC21_MCP_SOUNDFONT', str(soundfont))

    observed: list[tuple[list[str], dict[str, Any]]] = []

    def fake_run(command, **kwargs):
        observed.append((command, kwargs))
        if Path(command[0]).name == 'fluidsynth':
            synthesis_path = Path(command[command.index('-F') + 1])
            synthesis_path.write_bytes(b'RIFFsyntheticWAVE')
        else:
            output_path = Path(command[-1])
            output_path.write_bytes(
                b'RIFFboundedWAVE' if output_path.suffix == '.wav' else b'ID3boundedMP3'
            )
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(audio.subprocess, 'run', fake_run)

    response = client.post('/v1/audio', json=_request(output_format))

    assert response.status_code == 200
    artifact = response.json()['data']['artifact']
    decoded = base64.b64decode(artifact['content'])
    assert artifact['outputFormat'] == output_format
    assert artifact['contentType'] == content_type
    assert artifact['encoding'] == 'base64'
    assert artifact['size'] == len(decoded)
    assert decoded.startswith(prefix)

    assert len(observed) == 2
    fluidsynth_command, fluidsynth_kwargs = observed[0]
    ffmpeg_command, ffmpeg_kwargs = observed[1]
    assert Path(fluidsynth_command[0]).name == 'fluidsynth'
    assert fluidsynth_command[1:3] == ['-n', '-i']
    assert '-F' in fluidsynth_command
    assert '-T' in fluidsynth_command
    assert fluidsynth_command[-2] == str(soundfont)
    assert Path(ffmpeg_command[0]).name == 'ffmpeg'
    assert '-nostdin' in ffmpeg_command
    assert 'loudnorm=I=-16:TP=-1.5:LRA=11' in ffmpeg_command
    if output_format == 'wav':
        assert ['-c:a', 'pcm_s16le'] == ffmpeg_command[-3:-1]
    else:
        assert 'libmp3lame' in ffmpeg_command
        assert '192k' in ffmpeg_command

    for kwargs in (fluidsynth_kwargs, ffmpeg_kwargs):
        run_kwargs = cast(dict[str, Any], kwargs)
        assert run_kwargs['shell'] is False
        assert run_kwargs['stdin'] is subprocess.DEVNULL
        assert run_kwargs['stdout'] is subprocess.DEVNULL
        assert run_kwargs['stderr'] is subprocess.DEVNULL


def test_render_audio_rejects_unknown_format() -> None:
    response = client.post('/v1/audio', json=_request('flac'))

    assert response.status_code == 422
    assert response.json()['error']['code'] == 'invalid_request'


def test_render_audio_timeout_is_stable_and_does_not_echo_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soundfont = tmp_path / 'fixed.sf3'
    soundfont.write_bytes(b'soundfont')
    monkeypatch.setenv('MUSIC21_MCP_SOUNDFONT', str(soundfont))

    def raise_timeout(command, **unused_kwargs):
        raise subprocess.TimeoutExpired(command, audio.FLUIDSYNTH_TIMEOUT_SECONDS)

    monkeypatch.setattr(audio.subprocess, 'run', raise_timeout)

    response = client.post('/v1/audio', json=_request('wav'))

    assert response.status_code == 504
    assert response.json()['error']['code'] == 'audio_render_timeout'
    assert TINY_SCORE not in response.text


def test_render_audio_reports_missing_soundfont(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('MUSIC21_MCP_SOUNDFONT', str(tmp_path / 'missing.sf3'))

    response = client.post('/v1/audio', json=_request('mp3'))

    assert response.status_code == 503
    assert response.json()['error']['code'] == 'audio_renderer_unavailable'


def test_render_audio_checks_size_before_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    soundfont = tmp_path / 'fixed.sf3'
    soundfont.write_bytes(b'soundfont')
    monkeypatch.setenv('MUSIC21_MCP_SOUNDFONT', str(soundfont))
    monkeypatch.setattr(audio, 'MAX_AUDIO_OUTPUT_BYTES', 8)

    def fake_run(command, **unused_kwargs):
        if Path(command[0]).name == 'fluidsynth':
            output_path = Path(command[command.index('-F') + 1])
            output_path.write_bytes(b'RIFF')
        else:
            Path(command[-1]).write_bytes(b'012345678')
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(audio.subprocess, 'run', fake_run)

    def unexpected_read(unused_path):
        raise AssertionError('oversized audio must not be read')

    monkeypatch.setattr(Path, 'read_bytes', unexpected_read)

    response = client.post('/v1/audio', json=_request('wav'))

    assert response.status_code == 413
    assert response.json()['error']['code'] == 'output_too_large'
