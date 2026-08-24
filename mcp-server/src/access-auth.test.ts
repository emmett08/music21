import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The provider targets Workers and imports the runtime-only module at load time.
// This minimal test hook keeps these pure HTTP-flow tests runnable in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20class%20WorkerEntrypoint%20%7B%7D",
      };
    }
    return nextResolve(specifier, context);
  },
});
Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
});

const { accessAuthHandler, allowedEmailSet } = await import("./access-auth.ts");
const { AuthorizationError } = await import("@cloudflare/workers-oauth-provider");

const oauthRequest = {
  clientId: "test-client",
  issuer: "https://mcp.example.test",
  redirectUri: "https://client.example.test/oauth/callback?existing=1",
  responseType: "code",
  scope: ["mcp", "music:read&write"],
  state: "client-state",
};

class MemoryKv {
  readonly values = new Map<string, string>();

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function testEnvironment() {
  const kv = new MemoryKv();
  return {
    ACCESS_AUTHORIZATION_URL: "https://access.example.test/authorize",
    ACCESS_CLIENT_ID: "access-client",
    ACCESS_CLIENT_SECRET: "access-secret",
    ACCESS_ISSUER: "https://access.example.test",
    ACCESS_JWKS_URL: "https://access.example.test/certs",
    ACCESS_TOKEN_URL: "https://access.example.test/token",
    ALLOWED_EMAILS: "owner@example.test",
    MUSIC21_CONTAINER: {},
    OAUTH_KV: kv,
    OAUTH_PROVIDER: {
      async completeAuthorization() {
        return { redirectTo: "https://client.example.test/oauth/callback?code=downstream" };
      },
      async lookupClient() {
        return {
          clientId: "test-client",
          clientName: "<Music & Theory>",
          redirectUris: [oauthRequest.redirectUri],
          tokenEndpointAuthMethod: "none",
        };
      },
      async parseAuthRequest() {
        return structuredClone(oauthRequest);
      },
    },
  };
}

async function dispatch(request: Request, env: ReturnType<typeof testEnvironment>): Promise<Response> {
  assert.equal(typeof accessAuthHandler.fetch, "function");
  return accessAuthHandler.fetch(request, env as never, {} as ExecutionContext);
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([A-Za-z0-9_-]+)"`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(cookies: readonly string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  assert.ok(cookie, `missing ${name} cookie`);
  const value = cookie.slice(name.length + 1).split(";", 1)[0];
  assert.ok(value, `empty ${name} cookie`);
  return value;
}

async function consentFixture(env: ReturnType<typeof testEnvironment>) {
  const response = await dispatch(
    new Request("https://mcp.example.test/authorize?client_id=test-client"),
    env,
  );
  const html = await response.text();
  const csrfToken = hiddenValue(html, "csrf_token");
  return {
    consentState: hiddenValue(html, "consent_state"),
    csrfCookie: cookieValue(setCookies(response), "__Host-music21-consent-csrf"),
    csrfToken,
    html,
    response,
  };
}

function consentRequest(
  fixture: Awaited<ReturnType<typeof consentFixture>>,
  decision: "approve" | "deny",
): Request {
  return new Request("https://mcp.example.test/authorize", {
    body: new URLSearchParams({
      consent_state: fixture.consentState,
      csrf_token: fixture.csrfToken,
      decision,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `__Host-music21-consent-csrf=${fixture.csrfCookie}`,
    },
    method: "POST",
  });
}

test("normalises an explicit allow-list", () => {
  assert.deepEqual(
    [...allowedEmailSet(" Owner@Example.com,second@example.org ")],
    ["owner@example.com", "second@example.org"],
  );
});

test("fails closed for an empty allow-list", () => {
  assert.throws(() => allowedEmailSet(" , "), /ALLOWED_EMAILS/);
});

test("rejects wildcards and malformed identities", () => {
  assert.throws(() => allowedEmailSet("*@example.com"), /ALLOWED_EMAILS/);
  assert.throws(() => allowedEmailSet("not-an-email"), /ALLOWED_EMAILS/);
});

test("renders an AuthorizationError locally when no redirect URI was validated", async () => {
  const env = testEnvironment();
  env.OAUTH_PROVIDER.parseAuthRequest = async () => {
    throw new AuthorizationError("invalid_request", {
      description: "The authorization request is invalid.",
    });
  };

  const response = await dispatch(
    new Request("https://mcp.example.test/authorize?client_id=unknown"),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_request",
    error_description: "The authorization request is invalid.",
    ok: false,
  });
});

test("redirects an AuthorizationError only after provider redirect validation", async () => {
  const env = testEnvironment();
  env.OAUTH_PROVIDER.parseAuthRequest = async () => {
    throw new AuthorizationError("invalid_scope", {
      description: "The requested scope is invalid.",
      issuer: "https://mcp.example.test",
      redirectUri: oauthRequest.redirectUri,
      state: oauthRequest.state,
    });
  };

  const response = await dispatch(
    new Request("https://mcp.example.test/authorize?client_id=test-client"),
    env,
  );
  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get("location") ?? "");
  assert.equal(destination.origin, "https://client.example.test");
  assert.equal(destination.searchParams.get("existing"), "1");
  assert.equal(destination.searchParams.get("error"), "invalid_scope");
  assert.equal(destination.searchParams.get("state"), "client-state");
  assert.equal(destination.searchParams.get("iss"), "https://mcp.example.test");
});

test("renders escaped consent metadata with a hardened CSRF cookie", async () => {
  const env = testEnvironment();
  const fixture = await consentFixture(env);

  assert.equal(fixture.response.status, 200);
  assert.match(fixture.response.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(
    fixture.response.headers.get("content-security-policy") ?? "",
    /default-src 'none'/,
  );
  assert.match(fixture.html, /&lt;Music &amp; Theory&gt;/);
  assert.match(fixture.html, /music:read&amp;write/);
  assert.doesNotMatch(fixture.html, /<script/i);
  assert.equal(fixture.csrfCookie, fixture.csrfToken);
  const cookie = setCookies(fixture.response)[0];
  assert.match(cookie, /^__Host-music21-consent-csrf=/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.equal(
    [...env.OAUTH_KV.values.keys()].filter((key) => key.startsWith("access-consent-state:"))
      .length,
    1,
  );
});

test("approval consumes consent state and binds upstream state to the browser", async () => {
  const env = testEnvironment();
  const fixture = await consentFixture(env);
  const response = await dispatch(consentRequest(fixture, "approve"), env);

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://access.example.test");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  const state = location.searchParams.get("state");
  assert.match(state ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(env.OAUTH_KV.values.has(`access-consent-state:${fixture.consentState}`), false);
  assert.equal(env.OAUTH_KV.values.has(`access-oauth-state:${state}`), true);

  const cookies = setCookies(response);
  assert.match(
    cookies.find((cookie) => cookie.startsWith("__Host-music21-consent-csrf=")) ?? "",
    /Max-Age=0/,
  );
  const binding = cookieValue(cookies, "__Host-music21-access-state");
  assert.match(binding, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(binding, state);
  const storedState = JSON.parse(env.OAUTH_KV.values.get(`access-oauth-state:${state}`) ?? "null");
  assert.notEqual(storedState.browserBindingHash, binding);

  const replay = await dispatch(consentRequest(fixture, "approve"), env);
  assert.equal(replay.status, 400);
});

test("callback rejects another browser without consuming upstream state", async () => {
  const env = testEnvironment();
  const fixture = await consentFixture(env);
  const approval = await dispatch(consentRequest(fixture, "approve"), env);
  const accessLocation = new URL(approval.headers.get("location") ?? "");
  const state = accessLocation.searchParams.get("state");
  assert.ok(state);

  const wrongBrowser = await dispatch(
    new Request(
      `https://mcp.example.test/callback?state=${state}&error=access_denied`,
      { headers: { Cookie: `__Host-music21-access-state=${"x".repeat(43)}` } },
    ),
    env,
  );
  assert.equal(wrongBrowser.status, 400);
  assert.equal(env.OAUTH_KV.values.has(`access-oauth-state:${state}`), true);

  const binding = cookieValue(setCookies(approval), "__Host-music21-access-state");
  const sameBrowser = await dispatch(
    new Request(
      `https://mcp.example.test/callback?state=${state}&error=access_denied`,
      { headers: { Cookie: `__Host-music21-access-state=${binding}` } },
    ),
    env,
  );
  assert.equal(sameBrowser.status, 302);
  assert.equal(env.OAUTH_KV.values.has(`access-oauth-state:${state}`), false);
  const destination = new URL(sameBrowser.headers.get("location") ?? "");
  assert.equal(destination.origin, "https://client.example.test");
  assert.equal(destination.pathname, "/oauth/callback");
  assert.equal(destination.searchParams.get("existing"), "1");
  assert.equal(destination.searchParams.get("error"), "access_denied");
  assert.equal(destination.searchParams.get("state"), "client-state");
  assert.equal(destination.searchParams.get("iss"), "https://mcp.example.test");
  assert.match(setCookies(sameBrowser)[0], /Max-Age=0/);
});

test("denial redirects only to the redirect URI validated on the GET request", async () => {
  const env = testEnvironment();
  const fixture = await consentFixture(env);
  const response = await dispatch(consentRequest(fixture, "deny"), env);

  assert.equal(response.status, 302);
  const destination = new URL(response.headers.get("location") ?? "");
  assert.equal(destination.origin, "https://client.example.test");
  assert.equal(destination.pathname, "/oauth/callback");
  assert.equal(destination.searchParams.get("error"), "access_denied");
  assert.equal(destination.searchParams.get("state"), "client-state");
  assert.equal(
    [...env.OAUTH_KV.values.keys()].some((key) => key.startsWith("access-oauth-state:")),
    false,
  );
});

test("rejects oversized and duplicate consent form fields without consuming state", async () => {
  const env = testEnvironment();
  const fixture = await consentFixture(env);
  const oversized = await dispatch(
    new Request("https://mcp.example.test/authorize", {
      body: "x".repeat(8 * 1024 + 1),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-music21-consent-csrf=${fixture.csrfCookie}`,
      },
      method: "POST",
    }),
    env,
  );
  assert.equal(oversized.status, 400);
  assert.equal(env.OAUTH_KV.values.has(`access-consent-state:${fixture.consentState}`), true);

  const duplicated = new URLSearchParams({
    consent_state: fixture.consentState,
    csrf_token: fixture.csrfToken,
    decision: "approve",
  });
  duplicated.append("decision", "deny");
  const duplicateResponse = await dispatch(
    new Request("https://mcp.example.test/authorize", {
      body: duplicated,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-music21-consent-csrf=${fixture.csrfCookie}`,
      },
      method: "POST",
    }),
    env,
  );
  assert.equal(duplicateResponse.status, 400);
  assert.equal(env.OAUTH_KV.values.has(`access-consent-state:${fixture.consentState}`), true);
});

test("rejects a mismatched CSRF cookie without consuming consent state", async () => {
  const env = testEnvironment();
  const fixture = await consentFixture(env);
  const response = await dispatch(
    new Request("https://mcp.example.test/authorize", {
      body: new URLSearchParams({
        consent_state: fixture.consentState,
        csrf_token: fixture.csrfToken,
        decision: "approve",
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-music21-consent-csrf=${"x".repeat(43)}`,
      },
      method: "POST",
    }),
    env,
  );

  assert.equal(response.status, 400);
  assert.equal(env.OAUTH_KV.values.has(`access-consent-state:${fixture.consentState}`), true);
});
