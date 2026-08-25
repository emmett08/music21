import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import type { AuthProps, Env } from "./env.ts";

const OAUTH_STATE_PREFIX = "access-oauth-state:";
const CONSENT_STATE_PREFIX = "access-consent-state:";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const CONSENT_CSRF_COOKIE = "__Host-music21-consent-csrf";
const ACCESS_STATE_COOKIE = "__Host-music21-access-state";
const MAX_AUTHORIZE_URL_BYTES = 8 * 1024;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_COOKIE_HEADER_BYTES = 8 * 1024;
const MAX_STORED_STATE_BYTES = 32 * 1024;
const MAX_CLIENT_NAME_LENGTH = 256;
const MAX_SCOPE_COUNT = 32;
const MAX_SCOPE_LENGTH = 256;
const UPSTREAM_FETCH_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 128 * 1024;
const CLOCK_SKEW_SECONDS = 60;

interface AuthConfig {
  allowedEmails: ReadonlySet<string>;
  authorizationUrl: URL;
  clientId: string;
  clientSecret: string;
  issuer: string;
  jwksUrl: URL;
  tokenUrl: URL;
}

interface StoredOAuthState {
  browserBindingHash: string;
  callbackUrl: string;
  codeVerifier: string;
  oauthRequest: AuthRequest;
}

interface StoredConsentState {
  csrfHash: string;
  oauthRequest: AuthRequest;
}

type OAuthEnvironment = Env & { OAUTH_PROVIDER: OAuthHelpers };

class AuthConfigurationError extends Error {
  override readonly name = "AuthConfigurationError";
}

class AccessAuthenticationError extends Error {
  override readonly name = "AccessAuthenticationError";
}

/**
 * Handle the Cloudflare Access side of the OAuth 2.1 authorization-code flow.
 *
 * The implementation was drafted with AI assistance. It deliberately fails
 * closed, uses one-time state in KV, uses PKCE upstream, verifies the Access ID
 * token signature and claims, and allows only configured email identities.
 */
export const accessAuthHandler: ExportedHandler<Env> = {
  async fetch(request, rawEnv): Promise<Response> {
    const env = rawEnv as OAuthEnvironment;
    const url = new URL(request.url);

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return healthResponse(env);
    }

    let config: AuthConfig;
    try {
      config = readAuthConfig(env);
    } catch (error) {
      console.error("Cloudflare Access configuration is incomplete", safeErrorName(error));
      return jsonResponse(
        { error: "authentication_not_configured", ok: false },
        503,
      );
    }

    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        return await showAuthorizationConsent(request, env, config);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        return await handleAuthorizationConsent(request, env, config);
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        return await completeAccessAuthorization(request, env, config);
      }
    } catch (error) {
      const status = error instanceof AccessAuthenticationError ? 400 : 502;
      console.error("Cloudflare Access authorization failed", safeErrorName(error));
      return jsonResponse({ error: "authentication_failed", ok: false }, status);
    }

    return jsonResponse({ error: "not_found", ok: false }, 404);
  },
};

export function allowedEmailSet(value: string): ReadonlySet<string> {
  const emails = value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  if (
    emails.length === 0 ||
    emails.some(
      (email) => email.includes("*") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    )
  ) {
    throw new AuthConfigurationError("ALLOWED_EMAILS must contain valid email addresses");
  }
  return new Set(emails);
}

async function showAuthorizationConsent(
  request: Request,
  env: OAuthEnvironment,
  config: AuthConfig,
): Promise<Response> {
  if (byteLength(request.url) > MAX_AUTHORIZE_URL_BYTES) {
    return jsonResponse({ error: "request_too_large", ok: false }, 414);
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) {
      throw error;
    }
    return authorizationRequestErrorResponse(error);
  }

  const client = oauthRequest.clientId
    ? await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId)
    : null;
  if (!client) {
    throw new AccessAuthenticationError("Unknown OAuth client");
  }

  const clientName = (client.clientName || "Unnamed MCP client").trim();
  if (!clientName || clientName.length > MAX_CLIENT_NAME_LENGTH) {
    throw new AccessAuthenticationError("OAuth client name is invalid");
  }
  if (
    oauthRequest.scope.length > MAX_SCOPE_COUNT ||
    oauthRequest.scope.some((scope) => scope.length === 0 || scope.length > MAX_SCOPE_LENGTH)
  ) {
    throw new AccessAuthenticationError("OAuth scope list is invalid");
  }

  const consentState = randomBase64Url(32);
  const csrfToken = randomBase64Url(32);
  const stored: StoredConsentState = {
    csrfHash: await sha256Base64Url(csrfToken),
    oauthRequest,
  };
  await putBoundedState(env, `${CONSENT_STATE_PREFIX}${consentState}`, stored);

  return consentPageResponse(
    clientName,
    oauthRequest.scope,
    consentState,
    csrfToken,
    config.authorizationUrl.origin,
    new URL(oauthRequest.redirectUri).origin,
  );
}

async function handleAuthorizationConsent(
  request: Request,
  env: OAuthEnvironment,
  config: AuthConfig,
): Promise<Response> {
  if (byteLength(request.url) > MAX_AUTHORIZE_URL_BYTES) {
    throw new AccessAuthenticationError("Consent request is too large");
  }
  const form = await readBoundedForm(request);
  const decision = requiredSingleFormValue(form, "decision");
  if (decision !== "approve" && decision !== "deny") {
    throw new AccessAuthenticationError("Consent decision is invalid");
  }
  const consentState = requiredRandomToken(
    requiredSingleFormValue(form, "consent_state"),
    "Consent state",
  );
  const csrfToken = requiredRandomToken(
    requiredSingleFormValue(form, "csrf_token"),
    "CSRF token",
  );
  const csrfCookie = requiredRandomToken(
    requiredCookie(request, CONSENT_CSRF_COOKIE),
    "CSRF cookie",
  );

  if (!(await constantTimeEqual(csrfToken, csrfCookie))) {
    throw new AccessAuthenticationError("CSRF validation failed");
  }

  const stateKey = `${CONSENT_STATE_PREFIX}${consentState}`;
  const stored = parseStoredConsentState(await env.OAUTH_KV.get(stateKey));
  if (!(await constantTimeEqual(await sha256Base64Url(csrfToken), stored.csrfHash))) {
    throw new AccessAuthenticationError("CSRF validation failed");
  }

  // Consume the locally issued consent state before either terminal action.
  await env.OAUTH_KV.delete(stateKey);
  if (decision === "deny") {
    return oauthErrorRedirect(
      stored.oauthRequest,
      "access_denied",
      "The resource owner denied the request.",
      [clearCookie(CONSENT_CSRF_COOKIE)],
    );
  }

  return beginAccessAuthorization(request, env, config, stored.oauthRequest);
}

async function beginAccessAuthorization(
  request: Request,
  env: OAuthEnvironment,
  config: AuthConfig,
  oauthRequest: AuthRequest,
): Promise<Response> {
  const state = randomBase64Url(32);
  const browserBinding = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const callbackUrl = new URL("/callback", request.url).href;
  const stored: StoredOAuthState = {
    browserBindingHash: await sha256Base64Url(browserBinding),
    callbackUrl,
    codeVerifier,
    oauthRequest,
  };
  await putBoundedState(env, `${OAUTH_STATE_PREFIX}${state}`, stored);

  const destination = new URL(config.authorizationUrl);
  destination.searchParams.set("client_id", config.clientId);
  destination.searchParams.set("code_challenge", codeChallenge);
  destination.searchParams.set("code_challenge_method", "S256");
  destination.searchParams.set("redirect_uri", callbackUrl);
  destination.searchParams.set("response_type", "code");
  destination.searchParams.set("scope", "openid email profile");
  destination.searchParams.set("state", state);
  return redirectResponse(destination, [
    clearCookie(CONSENT_CSRF_COOKIE),
    secureCookie(ACCESS_STATE_COOKIE, browserBinding),
  ]);
}

async function completeAccessAuthorization(
  request: Request,
  env: OAuthEnvironment,
  config: AuthConfig,
): Promise<Response> {
  const url = new URL(request.url);
  if (byteLength(request.url) > MAX_AUTHORIZE_URL_BYTES) {
    throw new AccessAuthenticationError("Callback request is too large");
  }
  const state = requiredRandomToken(
    requiredSingleSearchParam(url, "state"),
    "Callback state",
  );
  const stored = await consumeAccessState(request, env, state);

  try {
    if (url.searchParams.has("error")) {
      requiredSingleSearchParam(url, "error");
      return oauthErrorRedirect(
        stored.oauthRequest,
        "access_denied",
        "The upstream identity provider denied the request.",
        [clearCookie(ACCESS_STATE_COOKIE)],
      );
    }

    const code = requiredSingleSearchParam(url, "code");
    if (!code || code.length > 8_192) {
      throw new AccessAuthenticationError("Missing or invalid callback code");
    }
    const idToken = await exchangeAuthorizationCode(code, stored, config);
    const claims = await verifyAccessIdToken(idToken, config);

    const email = requiredClaim(claims, "email").toLowerCase();
    const sub = requiredClaim(claims, "sub");
    if (!config.allowedEmails.has(email)) {
      throw new AccessAuthenticationError("Identity is not permitted");
    }
    const name = typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim()
      : email;
    const props: AuthProps = { email, name, sub };

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: { label: email },
      props,
      request: stored.oauthRequest,
      scope: stored.oauthRequest.scope,
      userId: sub,
    });
    return redirectResponse(new URL(redirectTo), [clearCookie(ACCESS_STATE_COOKIE)]);
  } catch (error) {
    // A reconstructed request must not be used to build another redirect when
    // completion validation fails; report the provider error locally instead.
    const status = error instanceof AccessAuthenticationError || error instanceof AuthorizationError
      ? 400
      : 502;
    console.error("Cloudflare Access callback failed", safeErrorName(error));
    const response = jsonResponse({ error: "authentication_failed", ok: false }, status);
    response.headers.append("Set-Cookie", clearCookie(ACCESS_STATE_COOKIE));
    return response;
  }
}

async function exchangeAuthorizationCode(
  code: string,
  state: StoredOAuthState,
  config: AuthConfig,
): Promise<string> {
  const response = await fetch(config.tokenUrl, {
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: state.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: state.callbackUrl,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AccessAuthenticationError("Cloudflare Access token exchange failed");
  }
  const body = await readBoundedJson(response, MAX_UPSTREAM_RESPONSE_BYTES);
  if (!isObject(body) || typeof body.id_token !== "string" || body.id_token.length > 32_768) {
    throw new AccessAuthenticationError("Cloudflare Access did not return an ID token");
  }
  return body.id_token;
}

async function verifyAccessIdToken(
  token: string,
  config: AuthConfig,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AccessAuthenticationError("Malformed ID token");
  }
  const header = decodeJwtObject(parts[0]);
  const claims = decodeJwtObject(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) {
    throw new AccessAuthenticationError("Unsupported ID token signature");
  }

  const jwksResponse = await fetch(config.jwksUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
  });
  if (!jwksResponse.ok) {
    await jwksResponse.body?.cancel();
    throw new AccessAuthenticationError("Cloudflare Access keys are unavailable");
  }
  const jwks = await readBoundedJson(jwksResponse, MAX_UPSTREAM_RESPONSE_BYTES);
  if (!isObject(jwks) || !Array.isArray(jwks.keys)) {
    throw new AccessAuthenticationError("Cloudflare Access returned invalid keys");
  }
  const jwk = jwks.keys.find(
    (candidate): candidate is JsonWebKey & { kid: string } =>
      isObject(candidate) && candidate.kid === header.kid,
  );
  if (!jwk || (jwk.alg !== undefined && jwk.alg !== "RS256")) {
    throw new AccessAuthenticationError("ID token signing key was not found");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]).buffer as ArrayBuffer,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) {
    throw new AccessAuthenticationError("Invalid ID token signature");
  }

  validateClaims(claims, config);
  return claims;
}

function validateClaims(claims: Record<string, unknown>, config: AuthConfig): void {
  const now = Math.floor(Date.now() / 1_000);
  if (claims.iss !== config.issuer) {
    throw new AccessAuthenticationError("Invalid ID token issuer");
  }
  const audiences = typeof claims.aud === "string"
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((value) => typeof value === "string")
      ? claims.aud
      : [];
  if (!audiences.includes(config.clientId)) {
    throw new AccessAuthenticationError("Invalid ID token audience");
  }
  if (audiences.length > 1 && claims.azp !== config.clientId) {
    throw new AccessAuthenticationError("Invalid ID token authorized party");
  }
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new AccessAuthenticationError("Expired ID token");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    throw new AccessAuthenticationError("ID token is not yet valid");
  }
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) {
    throw new AccessAuthenticationError("Invalid ID token issue time");
  }
  requiredClaim(claims, "sub");
  requiredClaim(claims, "email");
}

function authorizationRequestErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) {
    return jsonResponse(
      { error: error.code, error_description: error.description, ok: false },
      400,
    );
  }

  const destination = new URL(error.redirectUri);
  destination.searchParams.set("error", error.code);
  destination.searchParams.set("error_description", error.description);
  if (error.state) {
    destination.searchParams.set("state", error.state);
  }
  if (error.issuer) {
    destination.searchParams.set("iss", error.issuer);
  }
  return redirectResponse(destination);
}

function consentPageResponse(
  clientName: string,
  scopes: readonly string[],
  consentState: string,
  csrfToken: string,
  accessOrigin: string,
  clientOrigin: string,
): Response {
  const scopeItems = scopes.length > 0
    ? scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")
    : "<li>No additional scopes requested</li>";
  const escapedName = escapeHtml(clientName);
  const formAction = consentFormAction(accessOrigin, clientOrigin);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${escapedName}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      color: #111827;
      background: #f3f4f6;
    }
    main {
      max-width: 36rem;
      margin: 3rem auto;
      padding: 1.75rem;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 0.75rem;
    }
    h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
    h2 { margin: 1.5rem 0 0.5rem; font-size: 1rem; }
    p, li { color: #374151; }
    code {
      font: 0.9em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    form { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 0.5rem;
      padding: 0.6rem 1rem;
      font: inherit;
      cursor: pointer;
    }
    button[value="approve"] { color: #fff; background: #111827; }
    button[value="deny"] { color: #111827; background: #fff; border-color: #d1d5db; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize ${escapedName}?</h1>
    <p>This application is requesting access to the music21 MCP server.</p>
    <h2>Requested permissions</h2>
    <ul>${scopeItems}</ul>
    <form action="/authorize" method="post" autocomplete="off">
      <input type="hidden" name="consent_state" value="${escapeHtml(consentState)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        `default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": secureCookie(CONSENT_CSRF_COOKIE, csrfToken),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
    status: 200,
  });
}

function consentFormAction(accessOrigin: string, clientOrigin: string): string {
  const origins = ["'self'", accessOrigin];
  if (clientOrigin !== accessOrigin) {
    origins.push(clientOrigin);
  }
  return origins.join(" ");
}

async function readBoundedForm(request: Request): Promise<URLSearchParams> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new AccessAuthenticationError("Consent form content type is invalid");
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_FORM_BYTES) {
      throw new AccessAuthenticationError("Consent form is too large");
    }
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_FORM_BYTES) {
        await reader.cancel();
        throw new AccessAuthenticationError("Consent form is too large");
      }
      chunks.push(value);
    }
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
  } catch {
    throw new AccessAuthenticationError("Consent form is invalid");
  }
}

function requiredSingleFormValue(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new AccessAuthenticationError(`Consent form ${name} is invalid`);
  }
  return values[0];
}

function requiredSingleSearchParam(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new AccessAuthenticationError(`Callback ${name} is invalid`);
  }
  return values[0];
}

function requiredRandomToken(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AccessAuthenticationError(`${name} is invalid`);
  }
  return value;
}

function requiredCookie(request: Request, name: string): string {
  const header = request.headers.get("Cookie");
  if (!header || byteLength(header) > MAX_COOKIE_HEADER_BYTES) {
    throw new AccessAuthenticationError(`${name} is missing or invalid`);
  }

  const values: string[] = [];
  for (const segment of header.split(";")) {
    const cookie = segment.trim();
    const separator = cookie.indexOf("=");
    if (separator > 0 && cookie.slice(0, separator) === name) {
      values.push(cookie.slice(separator + 1));
    }
  }
  if (values.length !== 1 || !values[0]) {
    throw new AccessAuthenticationError(`${name} is missing or invalid`);
  }
  return values[0];
}

async function consumeAccessState(
  request: Request,
  env: OAuthEnvironment,
  state: string,
): Promise<StoredOAuthState> {
  const browserBinding = requiredRandomToken(
    requiredCookie(request, ACCESS_STATE_COOKIE),
    "Access state cookie",
  );
  const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
  const stored = parseStoredOAuthState(await env.OAUTH_KV.get(stateKey));
  const bindingHash = await sha256Base64Url(browserBinding);
  if (!(await constantTimeEqual(bindingHash, stored.browserBindingHash))) {
    throw new AccessAuthenticationError("Callback browser binding failed");
  }

  // Do not consume state until its independent browser secret has matched.
  await env.OAUTH_KV.delete(stateKey);
  return stored;
}

async function putBoundedState(
  env: OAuthEnvironment,
  key: string,
  value: StoredConsentState | StoredOAuthState,
): Promise<void> {
  const encoded = JSON.stringify(value);
  if (byteLength(encoded) > MAX_STORED_STATE_BYTES) {
    throw new AccessAuthenticationError("OAuth state is too large");
  }
  await env.OAUTH_KV.put(key, encoded, { expirationTtl: OAUTH_STATE_TTL_SECONDS });
}

function parseStoredConsentState(value: string | null): StoredConsentState {
  const parsed = parseStoredJson(value);
  if (
    !isObject(parsed) ||
    typeof parsed.csrfHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.csrfHash) ||
    !isAuthRequest(parsed.oauthRequest)
  ) {
    throw new AccessAuthenticationError("Consent state is invalid");
  }
  return parsed as unknown as StoredConsentState;
}

function parseStoredOAuthState(value: string | null): StoredOAuthState {
  const parsed = parseStoredJson(value);
  if (
    !isObject(parsed) ||
    typeof parsed.browserBindingHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.browserBindingHash) ||
    typeof parsed.callbackUrl !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    !/^[A-Za-z0-9_-]{64}$/.test(parsed.codeVerifier) ||
    !isAuthRequest(parsed.oauthRequest)
  ) {
    throw new AccessAuthenticationError("OAuth state is invalid");
  }
  try {
    new URL(parsed.callbackUrl);
  } catch {
    throw new AccessAuthenticationError("OAuth state is invalid");
  }
  return parsed as unknown as StoredOAuthState;
}

function parseStoredJson(value: string | null): unknown {
  if (!value) {
    throw new AccessAuthenticationError("OAuth state is missing or expired");
  }
  if (byteLength(value) > MAX_STORED_STATE_BYTES) {
    throw new AccessAuthenticationError("OAuth state is invalid");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AccessAuthenticationError("OAuth state is invalid");
  }
}

function isAuthRequest(value: unknown): value is AuthRequest {
  return isObject(value) &&
    typeof value.responseType === "string" &&
    typeof value.clientId === "string" &&
    typeof value.redirectUri === "string" &&
    Array.isArray(value.scope) &&
    value.scope.every((scope) => typeof scope === "string") &&
    typeof value.state === "string" &&
    (value.codeChallenge === undefined || typeof value.codeChallenge === "string") &&
    (value.codeChallengeMethod === undefined || typeof value.codeChallengeMethod === "string") &&
    (
      value.resource === undefined ||
      typeof value.resource === "string" ||
      (Array.isArray(value.resource) && value.resource.every((resource) => typeof resource === "string"))
    ) &&
    (value.issuer === undefined || typeof value.issuer === "string");
}

function oauthErrorRedirect(
  oauthRequest: AuthRequest,
  code: "access_denied",
  description: string,
  cookies: readonly string[] = [],
): Response {
  const destination = new URL(oauthRequest.redirectUri);
  destination.searchParams.set("error", code);
  destination.searchParams.set("error_description", description);
  destination.searchParams.set("state", oauthRequest.state);
  if (oauthRequest.issuer) {
    destination.searchParams.set("iss", oauthRequest.issuer);
  }
  return redirectResponse(destination, cookies);
}

function redirectResponse(destination: URL, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    Location: destination.href,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { headers, status: 302 });
}

function secureCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; Max-Age=${OAUTH_STATE_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readAuthConfig(env: Env): AuthConfig {
  const configuredIssuer = requiredSetting(env.ACCESS_ISSUER, "ACCESS_ISSUER");
  requiredHttpsUrl(configuredIssuer, "ACCESS_ISSUER");
  return {
    allowedEmails: allowedEmailSet(requiredSetting(env.ALLOWED_EMAILS, "ALLOWED_EMAILS")),
    authorizationUrl: requiredHttpsUrl(
      env.ACCESS_AUTHORIZATION_URL,
      "ACCESS_AUTHORIZATION_URL",
    ),
    clientId: requiredSetting(env.ACCESS_CLIENT_ID, "ACCESS_CLIENT_ID"),
    clientSecret: requiredSetting(env.ACCESS_CLIENT_SECRET, "ACCESS_CLIENT_SECRET"),
    // Preserve the exact OIDC issuer string: URL normalisation may add a slash
    // that is not present in the signed `iss` claim.
    issuer: configuredIssuer,
    jwksUrl: requiredHttpsUrl(env.ACCESS_JWKS_URL, "ACCESS_JWKS_URL"),
    tokenUrl: requiredHttpsUrl(env.ACCESS_TOKEN_URL, "ACCESS_TOKEN_URL"),
  };
}

function requiredSetting(value: string | undefined, name: string): string {
  if (!value || !value.trim()) {
    throw new AuthConfigurationError(`${name} is required`);
  }
  return value.trim();
}

function requiredHttpsUrl(value: string | undefined, name: string): URL {
  let url: URL;
  try {
    url = new URL(requiredSetting(value, name));
  } catch {
    throw new AuthConfigurationError(`${name} must be a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AuthConfigurationError(`${name} must be an HTTPS URL without credentials`);
  }
  return url;
}

async function healthResponse(env: Env): Promise<Response> {
  try {
    readAuthConfig(env);
    return jsonResponse({ auth: "configured", ok: true, service: "music21-mcp" }, 200);
  } catch {
    return jsonResponse(
      { auth: "not_configured", ok: false, service: "music21-mcp" },
      503,
    );
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  const declaredLength = contentLength === null ? undefined : Number(contentLength);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    await response.body?.cancel();
    throw new AccessAuthenticationError("Upstream response is too large");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AccessAuthenticationError("Upstream response is too large");
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new AccessAuthenticationError("Upstream response is not JSON");
  }
}

function decodeJwtObject(value: string): Record<string, unknown> {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
    if (!isObject(decoded)) {
      throw new Error("not an object");
    }
    return decoded;
  } catch {
    throw new AccessAuthenticationError("Malformed ID token");
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function requiredClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new AccessAuthenticationError(`Missing ID token ${name}`);
  }
  return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
    status,
  });
}
