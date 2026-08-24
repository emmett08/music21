'''
Validated request and response models for the music21 MCP backend.

The API is intentionally smaller than music21's Python API.  This module was
written with AI assistance.
'''

from __future__ import annotations

from enum import StrEnum
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator


MAX_SOURCE_BYTES = 256 * 1024
MAX_ELEMENTS = 10_000
MAX_PARTS = 64
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_RENDER_PAGES = 16
MAX_XML_NODES = 50_000
MAX_XML_DEPTH = 128


class InputFormat(StrEnum):
    MUSICXML = 'musicxml'
    ABC = 'abc'
    TINY_NOTATION = 'tiny_notation'
    ROMAN_TEXT = 'roman_text'


class AnalysisKind(StrEnum):
    KEY = 'key'
    AMBITUS = 'ambitus'
    PITCH_CLASS_HISTOGRAM = 'pitch_class_histogram'


class ConvertFormat(StrEnum):
    MUSICXML = 'musicxml'
    MIDI = 'midi'
    LILYPOND = 'lilypond'


class RenderFormat(StrEnum):
    SVG = 'svg'
    PNG = 'png'
    PDF = 'pdf'


class RequestModel(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True)


class ScoreRequest(RequestModel):
    input_format: InputFormat = Field(alias='inputFormat')
    source: str = Field(min_length=1, max_length=MAX_SOURCE_BYTES)

    @field_validator('source')
    @classmethod
    def validate_inline_source(cls, value: str) -> str:
        if len(value.encode('utf-8')) > MAX_SOURCE_BYTES:
            raise ValueError(f'source must be at most {MAX_SOURCE_BYTES} UTF-8 bytes')
        if '\x00' in value:
            raise ValueError('source must not contain NUL bytes')

        stripped = value.strip()
        if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', stripped):
            raise ValueError('source must be inline score data, not a URL')
        if re.match(r'^(?:/|~[/\\]|\.\.?[/\\]|[A-Za-z]:[/\\])', stripped):
            raise ValueError('source must be inline score data, not a filesystem path')
        return value

    @field_validator('source')
    @classmethod
    def reject_xml_entities(cls, value: str, info) -> str:
        input_format = info.data.get('input_format')
        if input_format == InputFormat.MUSICXML:
            upper_source = value.upper()
            if '<!ENTITY' in upper_source:
                raise ValueError('MusicXML entity declarations are not allowed')
        return value


class AnalyseRequest(ScoreRequest):
    analyses: list[AnalysisKind] = Field(
        default_factory=lambda: list(AnalysisKind),
        min_length=1,
        max_length=len(AnalysisKind),
    )

    @field_validator('analyses')
    @classmethod
    def reject_duplicate_analyses(cls, value: list[AnalysisKind]) -> list[AnalysisKind]:
        if len(value) != len(set(value)):
            raise ValueError('analyses must not contain duplicates')
        return value


class TransposeRequest(ScoreRequest):
    interval: int | str
    output_format: ConvertFormat = Field(alias='outputFormat')

    @field_validator('interval', mode='before')
    @classmethod
    def validate_interval(cls, value: int | str) -> int | str:
        if isinstance(value, bool):
            raise ValueError('interval must be an integer or a music21 interval name')
        if isinstance(value, int):
            if not -48 <= value <= 48:
                raise ValueError('integer interval must be between -48 and 48 semitones')
            return value

        if not re.fullmatch(r'-?[A-Za-z][A-Za-z0-9+#-]{0,11}', value):
            raise ValueError('interval must use a short music21 interval name')
        return value


class ConvertRequest(ScoreRequest):
    output_format: ConvertFormat = Field(alias='outputFormat')


class RenderRequest(ScoreRequest):
    output_format: RenderFormat = Field(alias='outputFormat')


class GeneratedArtifact(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    output_format: str = Field(alias='outputFormat')
    content_type: str = Field(alias='contentType')
    encoding: str
    size: int
    content: str

    def as_api_dict(self) -> dict[str, str | int]:
        return self.model_dump(by_alias=True)
