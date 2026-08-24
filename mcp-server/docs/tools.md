# MCP tool contract

Every tool accepts score data supplied directly by the caller. The server rejects URLs,
filesystem paths, archives, raw LilyPond, and input over 256 KiB.

## Common fields

| Field | Type | Values |
|---|---|---|
| `source` | string | Inline score text; never a path or URL |
| `inputFormat` | string | `musicxml`, `abc`, `tiny_notation`, or `roman_text` |

## Tools

### `inspect_score`

Returns bounded structural information such as part, measure, note, rest and element counts,
duration, pitch range, time signatures and a small metadata allow-list.

### `analyse_score`

Adds an `analyses` array containing one or more of `key`, `ambitus`, and
`pitch_class_histogram`. Only these named algorithms are dispatched; caller-provided method
names are never evaluated.

### `transpose_score`

Adds `interval` and `outputFormat`. Intervals use music21's conventional interval syntax but
are restricted to a short grammar and a maximum displacement. `outputFormat` is one of
`musicxml`, `midi`, or `lilypond`.

### `convert_score`

Adds `outputFormat`, one of `musicxml`, `midi`, or `lilypond`. Text outputs are UTF-8; MIDI is
base64. The response includes its media type, encoding and byte size.

### `render_score`

Adds `outputFormat`, one of `svg`, `png`, or `pdf`. LilyPond runs with fixed arguments,
without a shell, in a server-created temporary directory. Binary output is base64; the
response includes its media type and byte size.

## Errors

Validation errors are returned as tool errors with no score content echoed. Backend timeouts,
size ceilings and unavailable-container errors use stable, non-sensitive messages. Diagnostic
output is bounded and must not contain local paths or secrets.
