# Audio rendering and soundfont notice

## Rendering path

`render_audio` follows one bounded pipeline:

1. music21 serialises the parsed score to a temporary MIDI file.
2. FluidSynth renders that MIDI with one container-owned General MIDI soundfont.
3. FFmpeg applies a fixed loudness-normalisation filter and writes either
   44.1 kHz stereo PCM WAV or 192 kbit/s MP3.
4. The backend verifies a regular output file and its size before returning a
   base64 MCP resource.

The caller controls only the inline score format, score source and the `wav` or
`mp3` target. Executable paths, soundfont path, gain, sample rate, codec,
bitrate, channel count and filter graph are deployment settings.

This renderer is a dependable proof and listening reference, not a substitute
for a recorded or professionally mixed performance. MIDI program changes,
velocity, duration, articulation and dynamics in the score materially affect
the result; notation-only instructions that do not survive MIDI conversion do
not.

## Limits

- Maximum generated audio: 16 MiB.
- FluidSynth timeout: 35 seconds.
- FFmpeg timeout: 25 seconds.
- Sample rate: 44.1 kHz.
- Channels: stereo.
- MP3 bitrate: 192 kbit/s.
- Target loudness: -16 LUFS integrated, -1.5 dB true peak, 11 LU range.

The musical-genius skill therefore defaults to a 45–75 second composition.
Longer work should be split into movements or rendered with a storage-backed
future version of the service.

## Soundfont

The container installs Debian's `musescore-general-soundfont` package and
creates a stable private symlink at `/usr/share/sounds/music21-mcp.sf3`. The
package supplies the high-quality MuseScore General SF3 soundfont and
retains its full machine-readable notice at:

```text
/usr/share/doc/musescore-general-soundfont/copyright
```

Generated waveforms must be accompanied by the relevant licence and copyright
notice. The musical-genius skill must therefore include this associated notice
when it returns WAV or MP3 audio:

> Rendered with the MIT-licensed MuseScore General SoundFont. FluidR3:
> Frank Wen © 2000–2002, 2008; FluidR3Mono: Michael Cowgill © 2014–2017;
> MuseScore General adaptation: S. Christian Collins © 2018–2021. Additional
> credited samples include work by Ethan Winer and Michael Schorsch. The
> soundfont is supplied without warranty.

The complete package notice remains authoritative and must accompany a waveform
when downstream distribution requires the complete terms. The standard MIT
permission condition requires preservation of the copyright and permission
notice in copies or substantial portions; it also disclaims warranties and
liability.
