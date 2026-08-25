---
name: musical-genius
description: >-
  Compose, revise, validate and render original music intended to be coherent,
  memorable, expressive and pleasurable for human listeners. Use for composition,
  arrangement, orchestration, thematic development or score-and-audio delivery.
  The workflow uses the connected music21 MCP and finishes with verified WAV,
  MP3 and PDF sheet-music artefacts.
---

# Musical genius

## Purpose

Create original music whose aesthetic effect follows from audible musical
relationships rather than decorative complexity. Treat beauty as a
listener-dependent judgement, not a computable guarantee. Optimise the
composition for coherence, expressive shape, perceptual interest, idiomatic
writing and the user's stated purpose.

Read [the aesthetic principles](references/aesthetic-principles.md) before
composing. Apply them as defeasible design guidance rather than a formula.

## Required result

A completed run produces all of the following from one canonical score:

1. PDF sheet music through `render_score` with `outputFormat: pdf`.
2. WAV audio through `render_audio` with `outputFormat: wav`.
3. MP3 audio through `render_audio` with `outputFormat: mp3`.
4. The associated MuseScore General SoundFont notice from
   `mcp-server/docs/audio.md` whenever WAV or MP3 is distributed.

Also retain MusicXML as the canonical editable source and MIDI as a useful
intermediate when the tool budget permits. Never report an artefact as complete
until the corresponding MCP call has returned it.

## Establish the brief

Extract or infer these constraints:

- intended emotion, dramatic function and listening context;
- duration;
- ensemble and practical player ranges;
- technical difficulty;
- stylistic vocabulary stated as musical properties;
- preferred density, pulse, harmonic language and degree of surprise;
- whether the score is for human performance, synthetic playback or both.

When the request leaves a field unspecified, make a defensible assumption and
state it in the final response. Do not stop for optional details. Default to a
45–75 second piece, a clearly audible pulse, moderate predictive complexity,
one memorable thematic identity and a playable chamber or piano texture.

A request to combine named artists or composers means combine abstract
properties such as phrase architecture, harmonic colour, registral design,
contrapuntal density, vocality, rhythmic propulsion or dramatic pacing. Do not
copy a recognisable melody, lyric, accompaniment pattern or substantial
passage.

## Compose from an audible argument

### 1. Define the perceptual arc

Write a one-sentence dramatic trajectory, for example:

> intimate stability → gathering instability → luminous release

Map that trajectory onto form, register, density, harmony, rhythm, articulation
and dynamics. Give the piece a beginning that establishes its listening grammar,
a middle that changes the stakes and an ending that retrospectively clarifies
the journey.

### 2. Invent a compact identity

Create a motif with a distinctive contour and rhythmic fingerprint. Two to five
structural pitches are usually enough. Test that it remains recognisable after
at least three transformations chosen from:

- sequence or intervallic expansion;
- rhythmic displacement, augmentation or diminution;
- inversion or contour rotation;
- fragmentation and recombination;
- reharmonisation;
- transfer between registers, voices or instruments;
- change of articulation, metre or accompaniment.

Repeat to create memory; vary to preserve attention. A recurrence must either
confirm an expectation, alter its meaning or prepare a later event.

### 3. Design several simultaneous expectation levels

Maintain intelligible regularity at phrase, metre or harmonic-function level
while introducing surprise in one or two other dimensions. Avoid making
harmony, rhythm, register, texture and form maximally uncertain at the same
time.

Prefer manageable predictive challenges:

- establish a pattern before violating it;
- make a deviation locally legible;
- let a surprising event affect what follows;
- resolve some tensions and deliberately retain only those needed by the ending.

### 4. Shape melody and voice leading

Give each phrase a directed contour, focal pitch and point of arrival. Balance
steps with structurally meaningful leaps. Recover large leaps by register,
contrary motion, harmonic support or later completion rather than by automatic
rule.

For polyphonic or chordal writing:

- preserve independent, singable lines;
- favour economical voice leading unless a registral rupture has dramatic work;
- prepare and resolve salient dissonances according to the chosen idiom;
- prevent accompaniment activity from obscuring the principal line;
- keep each instrument within a credible range and articulation.

### 5. Make rhythm bodily intelligible

Establish a dependable metrical hierarchy before adding displacement,
syncopation, cross-accent or changing metre. Moderate rhythmic complexity often
supports engagement better than either mechanical regularity or continuous
disruption. Place rhythmic novelty where it advances phrase direction.

### 6. Control tension and release

Build tension through interacting parameters, not merely more notes. Coordinate
some of:

- harmonic instability and delayed closure;
- registral ascent or compression;
- increasing density or contrapuntal friction;
- louder dynamics or sharper articulation;
- acceleration, subdivision or syncopation;
- timbral brightening;
- phrase extension and withheld cadence.

A climax should be prepared, proportionate and consequential. After it, change
at least one structural condition rather than simply reducing volume.

### 7. Notate interpretation

Encode tempo, dynamics, articulation, slurs, breath or phrase marks, pedalling
where appropriate, and gradual changes. Synthetic playback must not be a
velocity-flat proof of notes. Human performers must be able to infer hierarchy
and gesture without prose instructions compensating for unclear notation.

## Build and inspect with music21 MCP

Use MusicXML for any multi-part or notation-rich score. ABC is acceptable for a
simple single-line or folk-derived draft. Keep all source inline and within the
MCP limit.

For each serious draft:

1. Call `inspect_score`.
2. Call `analyse_score` for `key`, `ambitus` and
   `pitch_class_histogram`.
3. Check part count, duration, metre, pitch range, note density and metadata
   against the brief.
4. Render a PNG or PDF proof with `render_score` and inspect page layout,
   collisions, impractical page turns and missing expressive marks.
5. Repair the score source rather than explaining away a defect.

Analysis describes the score; it does not decide its quality. A key estimate or
pitch-class histogram may reveal an unintended result, but it must not replace
harmonic hearing and compositional judgement.

## Mandatory revision cycle

Complete at least two musically substantive revision passes for a piece longer
than eight bars.

### Pass A: identity and continuity

Test:

- Can the principal idea be identified after one hearing?
- Does each section grow from, answer or deliberately oppose earlier material?
- Does repetition create recognition without inert duplication?
- Are transitions caused by audible changes rather than arbitrary adjacency?
- Does the ending complete, transform or productively deny the opening premise?

### Pass B: expression and economy

Test:

- Is the emotional trajectory carried by actual pitch, rhythm, texture and
  timing?
- Does every dense passage need its density?
- Is the high point distinguishable from the merely loudest point?
- Are rests, sustain and resonance doing structural work?
- Can any note, doubling, chord change or marking be removed without loss?
- Are playable constraints and synthetic balance both credible?

A failed criterion causes a score revision and renewed MCP inspection. Do not
substitute a written audit for a musical change.

## Human-listener quality gate

Before final rendering, require no serious defect in any of these dimensions:

| Dimension | Acceptance condition |
|---|---|
| Identity | At least one memorable and transformable musical idea |
| Coherence | Local events imply a comprehensible larger form |
| Interest | Predictability and surprise remain in productive tension |
| Phrasing | Boundaries, continuations and arrivals are audible |
| Harmony | Dissonance, colour and closure serve the intended language |
| Rhythm | Pulse and grouping remain intelligible through variation |
| Voice leading | Lines and registral moves sound intentional |
| Proportion | Preparation, climax and release have credible durations |
| Expression | Dynamics, articulation and timing reinforce structure |
| Craft | Score, ranges, notation and playback are technically sound |

Do not calculate a single “beauty score”. Record the most important residual
qualification in the final response.

## Final rendering and verification

From the same final MusicXML source:

1. Call `render_score` with `outputFormat: pdf`.
2. Call `render_audio` with `outputFormat: wav`.
3. Call `render_audio` with `outputFormat: mp3`.
4. Optionally call `convert_score` for MusicXML and MIDI preservation.
5. Verify that:
   - the PDF is non-empty and contains every expected part and page;
   - the WAV resource reports `audio/wav`;
   - the MP3 resource reports `audio/mpeg`;
   - all three artefacts derive from the same final source revision;
   - the reported duration and instrumentation match the score.

If a render fails, return an exact success/failure matrix and repair what can be
repaired in the current run. Never replace missing audio with MIDI while calling
it WAV or MP3.

## Final response

State:

- title;
- instrumentation;
- approximate duration;
- formal and expressive trajectory;
- principal compositional idea;
- assumptions made;
- links or attached resources for PDF, WAV and MP3;
- the associated soundfont notice required by `mcp-server/docs/audio.md`;
- any material limitation that remains.

Keep the account of method shorter than the music's result.
