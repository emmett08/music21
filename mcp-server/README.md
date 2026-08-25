# music21 MCP server

This subproject exposes a deliberately small part of music21 as a remote Model Context
Protocol (MCP) server. It is separate from the Python package so installing music21 does not
also install server or Cloudflare dependencies.

The deployment has two layers:

1. A stateless Cloudflare Worker terminates OAuth and the MCP Streamable HTTP transport.
2. A private Cloudflare Container runs CPython, this checkout of music21, LilyPond,
   FluidSynth and FFmpeg.

The Worker never accepts Python expressions, filesystem paths, URLs, raw LilyPond or
arbitrary music21 method names. See [the tool contract](docs/tools.md),
[the audio renderer](docs/audio.md) and [the security model](docs/security.md).

The deployable package includes:

- a Cloudflare Worker with OAuth 2.1 discovery, consent, PKCE and the stateless MCP endpoint;
- a private Cloudflare Container wrapper for CPython, this checkout of music21 and the fixed
  notation and audio renderers;
- six bounded tools for inspection, analysis, transposition, conversion, notation rendering
  and audio rendering;
- PDF, SVG and PNG score output plus WAV and MP3 audio output;
- a reproducible Node dependency lock, Python dependency pins, tests and GitHub Actions
  workflows;
- a Wrangler configuration plus step-by-step Access, secret, deployment and ChatGPT setup
  notes.

## Requirements

- Node.js 24 or later
- Python 3.12 or later and `uv`
- Docker for local container testing
- a Cloudflare Workers Paid account (Containers require the paid plan)
- a Cloudflare Zero Trust organisation for the OAuth identity provider

## Local checks

From the repository root:

```bash
uv sync --locked
uv pip install --requirement mcp-server/backend/requirements.txt
uv run pytest mcp-server/backend/tests
python .agents/skills/musical-genius/scripts/validate_skill.py

cd mcp-server
npm ci --ignore-scripts
npm test
npm run typecheck
cd ..

docker build --platform linux/amd64 -f Dockerfile.mcp -t music21-mcp-backend .
docker run --rm -p 8080:8080 music21-mcp-backend
curl --fail http://127.0.0.1:8080/health
```

In another terminal, run `npm run dev` from `mcp-server/`. Wrangler starts the Worker and
its configured container. A real Docker-compatible engine is required for container-enabled
local development.

## Deploy

Follow [the Cloudflare deployment guide](docs/cloudflare.md). Copy `mcp-server/.env.example`
to `mcp-server/.env`, then run `npm run cf:configure-access`, `npm run cf:sync-secrets` and
`npm run cf:deploy` from `mcp-server/`. Do not expose `/mcp` without OAuth, and do not put
Cloudflare or Access secrets in this repository.

Deployment is intentionally not automatic from pull requests: it requires an authenticated
Cloudflare account, a Workers Paid plan and the account-specific Access application values.

## Scope

Version 1 is stateless: each tool receives the score source it operates on. This avoids
cross-user score storage and keeps authorisation easy to audit. Opaque score handles and R2
artefact storage can be added later without changing the existing tools.

Audio synthesis uses one server-selected General MIDI soundfont. The caller can select WAV
or MP3 but cannot select executables, codecs, filters, files or soundfonts. See
[the audio notice](docs/audio.md) before redistributing generated waveforms.
