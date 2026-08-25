export const BACKEND_TIMEOUT_MS = 75_000;
export const MAX_BACKEND_RESPONSE_BYTES = 24 * 1024 * 1024;
export const MAX_SOURCE_CHARACTERS = 256 * 1024;

export type BackendEndpoint =
  | "/v1/analyse"
  | "/v1/audio"
  | "/v1/convert"
  | "/v1/inspect"
  | "/v1/render"
  | "/v1/transpose";

export type BackendData = Record<string, unknown>;
export type ContainerFetch = (request: Request) => Promise<Response>;

interface BackendSuccess {
  data: BackendData;
  ok: true;
}

interface BackendFailure {
  error?: {
    code?: unknown;
    message?: unknown;
  };
  ok?: false;
}

export class BackendError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code = "backend_error",
  ) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Call the private music21 container and strictly bound the returned payload.
 *
 * This module was drafted with AI assistance and reviewed for bounded I/O.
 */
export async function callBackend(
  containerFetch: ContainerFetch,
  endpoint: BackendEndpoint,
  payload: Record<string, unknown>,
  options: {
    maxResponseBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<BackendData> {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_BACKEND_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? BACKEND_TIMEOUT_MS;
  const request = new Request(`http://music21.internal${endpoint}`, {
    body: JSON.stringify(payload),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });

  let response: Response;
  try {
    response = await containerFetch(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new BackendError("music21 processing timed out", 504, "backend_timeout");
    }
    throw new BackendError("music21 processing service is unavailable", 503, "backend_unavailable");
  }

  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new BackendError("music21 result exceeded the response limit", 502, "response_too_large");
  }

  const body = await readBoundedText(response, maxResponseBytes);
  let decoded: BackendSuccess | BackendFailure;
  try {
    decoded = JSON.parse(body) as BackendSuccess | BackendFailure;
  } catch {
    throw new BackendError("music21 processing returned an invalid response", 502, "invalid_backend_response");
  }

  if (decoded.ok !== true) {
    const code = stringField(decoded.error?.code, "processing_failed");
    const message = stringField(decoded.error?.message, "music21 could not process the score");
    throw new BackendError(message.slice(0, 1_000), response.status || 502, code.slice(0, 100));
  }
  if (!response.ok) {
    throw new BackendError(
      "music21 processing returned an inconsistent response",
      response.status,
      "invalid_backend_response",
    );
  }
  if (!isPlainObject(decoded.data)) {
    throw new BackendError("music21 processing returned invalid result data", 502, "invalid_backend_response");
  }
  return decoded.data;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BackendError("music21 result exceeded the response limit", 502, "response_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
