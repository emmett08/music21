# Security model

The remote endpoint is designed for a named user's private ChatGPT connection, not anonymous
public use.

## Trust boundaries

- Cloudflare Access authenticates the human user.
- The Worker verifies the upstream identity, restricts it to `ALLOWED_EMAILS`, and issues the
  short-lived OAuth credentials used by the MCP client.
- The authorisation page displays the registered client and the scopes Approve will grant.
  Clients that omit `scope` still receive `mcp`; `offline_access` is added only when requested.
  Tokens with an empty scope list are treated as that default grant. One-time KV state, a
  hardened `__Host-` CSRF cookie, PKCE and a separate browser-binding cookie prevent consent
  and login-CSRF flows from being replayed in another browser.
- Only the Worker can address the backend Container Durable Object.
- The container receives score data but no Cloudflare or Access credentials, and its public
  internet access is disabled.

## Input and execution controls

- Inline text only; no URL fetching or caller-selected paths.
- Closed input, analysis, transform and output enums.
- Maximum 256 KiB source payload and bounded recursive score traversal.
- MusicXML entity declarations are rejected before parsing.
- No pickle, jsonpickle, Python execution, corpus lookup, `show()`, ZIP/MXL, or raw `.ly` input.
- LilyPond is invoked with an argument vector, `shell=False`, a timeout and a fresh temporary
  directory.
- Backslashes and quotation marks from score text are escaped by the music21 LilyPond
  formatter. Before execution, the backend strips strings/comments for inspection and rejects
  generated file directives or active Scheme outside a small finite allow-list.
- Generated files are read only from the temporary directory and are size-limited.
- Container storage is ephemeral and each request removes its temporary files.

## Operational controls

- Keep `ALLOWED_EMAILS` to the smallest possible list.
- Store all OAuth values with `wrangler secret put`; never use committed variables for secrets.
- Enable Cloudflare observability, but do not log score source or generated artefacts.
- Keep the container at one instance until memory and LilyPond concurrency have been measured.
- Review dependency and base-image updates before deployment.

Cloudflare Access policy is the first identity gate. `ALLOWED_EMAILS` is an independent second
gate, so a broad Access policy does not silently grant MCP tool access.
