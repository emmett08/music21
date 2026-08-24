'''
Private HTTP API used by the Cloudflare Worker MCP facade.

The container is not directly internet-addressable; authentication and MCP
transport handling live in the Worker.  This module was written with AI
assistance.
'''

from __future__ import annotations

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from backend.models import AnalyseRequest
from backend.models import ConvertRequest
from backend.models import RenderRequest
from backend.models import ScoreRequest
from backend.models import TransposeRequest
from backend.service import analyse_score
from backend.service import convert_score
from backend.service import health_status
from backend.service import inspect_score
from backend.service import parse_score
from backend.service import render_score
from backend.service import ServiceError
from backend.service import transpose_score


app = FastAPI(
    title='music21 MCP backend',
    version='1',
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.exception_handler(ServiceError)
async def service_error_handler(unused_request, exc: ServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            'ok': False,
            'error': {'code': exc.code, 'message': exc.message},
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    unused_request,
    unused_exc: RequestValidationError,
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            'ok': False,
            'error': {
                'code': 'invalid_request',
                'message': 'The request does not match the bounded API contract.',
            },
        },
    )


@app.get('/health')
def health() -> dict:
    return {'ok': True, 'data': health_status()}


@app.post('/v1/inspect')
def inspect(request: ScoreRequest) -> dict:
    parsed = parse_score(request.source, request.input_format)
    return {'ok': True, 'data': inspect_score(parsed)}


@app.post('/v1/analyse')
def analyse(request: AnalyseRequest) -> dict:
    parsed = parse_score(request.source, request.input_format)
    return {'ok': True, 'data': analyse_score(parsed, request.analyses)}


@app.post('/v1/transpose')
def transpose(request: TransposeRequest) -> dict:
    parsed = parse_score(request.source, request.input_format)
    data = transpose_score(parsed, request.interval, request.output_format)
    return {'ok': True, 'data': data}


@app.post('/v1/convert')
def convert(request: ConvertRequest) -> dict:
    parsed = parse_score(request.source, request.input_format)
    artifact = convert_score(parsed, request.output_format)
    return {'ok': True, 'data': {'artifact': artifact}}


@app.post('/v1/render')
def render(request: RenderRequest) -> dict:
    parsed = parse_score(request.source, request.input_format)
    return {'ok': True, 'data': render_score(parsed, request.output_format)}
