#!/usr/bin/env python3
"""Validate the musical-genius skill and its MCP output contract."""

from __future__ import annotations

from pathlib import Path
import re
import sys


SKILL_DIR = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
SKILL_PATH = SKILL_DIR / 'SKILL.md'
REFERENCE_PATH = SKILL_DIR / 'references' / 'aesthetic-principles.md'
SERVER_PATH = REPOSITORY_ROOT / 'mcp-server' / 'src' / 'server.ts'
MODELS_PATH = REPOSITORY_ROOT / 'mcp-server' / 'backend' / 'models.py'
AUDIO_DOC_PATH = REPOSITORY_ROOT / 'mcp-server' / 'docs' / 'audio.md'


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def frontmatter(text: str) -> str:
    match = re.match(r'\A---\n(.*?)\n---\n', text, flags=re.DOTALL)
    require(match is not None, 'SKILL.md must begin with YAML frontmatter')
    return match.group(1)


def main() -> int:
    skill = SKILL_PATH.read_text(encoding='utf-8')
    references = REFERENCE_PATH.read_text(encoding='utf-8')
    server = SERVER_PATH.read_text(encoding='utf-8')
    models = MODELS_PATH.read_text(encoding='utf-8')
    audio_documentation = AUDIO_DOC_PATH.read_text(encoding='utf-8')

    metadata = frontmatter(skill)
    require(re.search(r'^name:\s*musical-genius\s*$', metadata, re.MULTILINE) is not None,
            'frontmatter must declare name: musical-genius')
    require(re.search(r'^description:\s*>-', metadata, re.MULTILINE) is not None,
            'frontmatter must contain a folded description')

    for tool_name in ('inspect_score', 'analyse_score', 'render_score', 'render_audio'):
        require(f'`{tool_name}`' in skill, f'SKILL.md must invoke {tool_name}')
    for output_format in ('PDF', 'WAV', 'MP3'):
        require(output_format in skill, f'SKILL.md must require {output_format}')

    require('aesthetic-principles.md' in skill,
            'SKILL.md must load the evidence note')
    for doi in (
        '10.1523/JNEUROSCI.0428-19.2019',
        '10.3389/fpsyg.2022.906190',
        '10.1037/a0023747',
        '10.1525/MP.2011.28.3.219',
    ):
        require(doi in references, f'evidence note is missing DOI {doi}')

    require('"render_audio"' in server,
            'the MCP Worker must register render_audio')
    require('z.enum(["wav", "mp3"])' in server,
            'render_audio must expose only WAV and MP3')
    require("class AudioFormat(StrEnum):" in models,
            'the backend must define the bounded audio format enum')
    require("WAV = 'wav'" in models and "MP3 = 'mp3'" in models,
            'the backend must accept WAV and MP3')

    require('mcp-server/docs/audio.md' in skill,
            'the skill must require the associated soundfont notice')
    require('MuseScore General SoundFont' in audio_documentation,
            'audio documentation must identify the rendering soundfont')

    require('beauty score' in skill.lower(),
            'the skill must reject a scalar beauty score')
    require('Never report an artefact as complete' in skill,
            'the skill must require verified artefacts')

    print('musical-genius skill contract: valid')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (AssertionError, OSError) as exc:
        print(f'musical-genius skill contract: invalid: {exc}', file=sys.stderr)
        raise SystemExit(1)
