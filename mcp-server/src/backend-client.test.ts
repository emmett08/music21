import assert from "node:assert/strict";
import test from "node:test";

import {
  BackendError,
  callBackend,
  type ContainerFetch,
} from "./backend-client.ts";

test("returns bounded backend data", async () => {
  const fetcher: ContainerFetch = async (request) => {
    assert.equal(new URL(request.url).pathname, "/v1/inspect");
    assert.equal(request.method, "POST");
    return Response.json({ data: { notes: 4 }, ok: true });
  };

  assert.deepEqual(await callBackend(fetcher, "/v1/inspect", { source: "c4" }), { notes: 4 });
});

test("preserves a structured backend failure", async () => {
  const fetcher: ContainerFetch = async () =>
    Response.json(
      { error: { code: "invalid_score", message: "The score is invalid" }, ok: false },
      { status: 422 },
    );

  await assert.rejects(
    callBackend(fetcher, "/v1/inspect", { source: "?" }),
    (error: unknown) =>
      error instanceof BackendError &&
      error.code === "invalid_score" &&
      error.status === 422 &&
      error.message === "The score is invalid",
  );
});

test("rejects malformed successful responses", async () => {
  const fetcher: ContainerFetch = async () => Response.json({ data: [], ok: true });

  await assert.rejects(
    callBackend(fetcher, "/v1/inspect", { source: "c4" }),
    (error: unknown) => error instanceof BackendError && error.code === "invalid_backend_response",
  );
});

test("rejects a response whose declared size is too large", async () => {
  const fetcher: ContainerFetch = async () =>
    new Response("{}", { headers: { "Content-Length": "100" } });

  await assert.rejects(
    callBackend(fetcher, "/v1/inspect", {}, { maxResponseBytes: 10 }),
    (error: unknown) => error instanceof BackendError && error.code === "response_too_large",
  );
});

test("rejects a streamed response that crosses the size limit", async () => {
  const fetcher: ContainerFetch = async () =>
    Response.json({ data: { value: "1234567890" }, ok: true });

  await assert.rejects(
    callBackend(fetcher, "/v1/inspect", {}, { maxResponseBytes: 10 }),
    (error: unknown) => error instanceof BackendError && error.code === "response_too_large",
  );
});
