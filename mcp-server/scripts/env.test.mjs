import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_SECRET_NAMES,
  accessOidcUrls,
  parseDotEnv,
  parseEmailList,
  publicCallbackUrl,
  upsertEnvValues,
} from "./env.mjs";

test("parseDotEnv ignores comments and unwraps quotes", () => {
  const env = parseDotEnv(`
# comment
ACCESS_CLIENT_ID=abc
ALLOWED_EMAILS="owner@example.test, other@example.test"
EMPTY=
`);
  assert.equal(env.ACCESS_CLIENT_ID, "abc");
  assert.equal(env.ALLOWED_EMAILS, "owner@example.test, other@example.test");
  assert.equal(env.EMPTY, "");
});

test("publicCallbackUrl uses the Worker /callback route", () => {
  assert.equal(
    publicCallbackUrl("https://music21-mcp.example.workers.dev"),
    "https://music21-mcp.example.workers.dev/callback",
  );
});

test("accessOidcUrls match the Access SaaS discovery paths", () => {
  const urls = accessOidcUrls("https://team.cloudflareaccess.com", "client-id");
  assert.equal(
    urls.ACCESS_ISSUER,
    "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-id",
  );
  assert.equal(
    urls.ACCESS_AUTHORIZATION_URL,
    "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-id/authorization",
  );
  assert.equal(
    urls.ACCESS_TOKEN_URL,
    "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-id/token",
  );
  assert.equal(
    urls.ACCESS_JWKS_URL,
    "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-id/jwks",
  );
});

test("upsertEnvValues replaces existing keys without dropping comments", () => {
  const next = upsertEnvValues(
    "# keep\nACCESS_CLIENT_ID=old\nALLOWED_EMAILS=a@example.test\n",
    { ACCESS_CLIENT_ID: "new", ACCESS_CLIENT_SECRET: "secret" },
  );
  assert.match(next, /^# keep$/m);
  assert.match(next, /^ACCESS_CLIENT_ID=new$/m);
  assert.match(next, /^ACCESS_CLIENT_SECRET=secret$/m);
  assert.match(next, /^ALLOWED_EMAILS=a@example.test$/m);
});

test("parseEmailList de-duplicates listed identities", () => {
  assert.deepEqual(parseEmailList("a@example.test, a@example.test, b@example.test"), [
    "a@example.test",
    "b@example.test",
  ]);
});

test("Worker secret list matches wrangler.jsonc required secrets", () => {
  assert.deepEqual(
    [...WORKER_SECRET_NAMES],
    [
      "ACCESS_AUTHORIZATION_URL",
      "ACCESS_CLIENT_ID",
      "ACCESS_CLIENT_SECRET",
      "ACCESS_ISSUER",
      "ACCESS_JWKS_URL",
      "ACCESS_TOKEN_URL",
      "ALLOWED_EMAILS",
    ],
  );
});
