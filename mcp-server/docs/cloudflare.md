# Cloudflare deployment

This service needs a Worker plus a Linux/AMD64 Cloudflare Container. A plain JavaScript or
Python Worker cannot host the complete music21 and LilyPond runtime.

## 1. Create the Access application

In Cloudflare Zero Trust, create an Access SaaS application using OIDC. Set its callback URL
to:

```text
https://music21-mcp.<your-workers-subdomain>.workers.dev/callback
```

Permit the `openid`, `email` and `profile` scopes, ensure the ID token contains the `email`
claim, and create an Access policy allowing only the intended identity. Record the client ID,
client secret, authorisation endpoint, token endpoint, JWKS endpoint and issuer exactly as
shown in the application's OIDC discovery/configuration data. The upstream Access refresh
token is not needed: this Worker validates the returned ID token, discards the upstream token
response and issues its own MCP credentials.

## 2. Install Wrangler and authenticate

From `mcp-server/`:

```bash
npm ci --ignore-scripts
npx wrangler login
```

The `OAUTH_KV` binding in `wrangler.jsonc` intentionally has no namespace ID. Current
Wrangler releases automatically provision the namespace on the first deployment. If automatic
resource provisioning is disabled for the account, create the namespace explicitly with
`npx wrangler kv namespace create OAUTH_KV` and add the returned ID to that binding.

## 3. Store secrets

Set each value interactively so it is not written to shell history or committed files:

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_JWKS_URL
npx wrangler secret put ACCESS_ISSUER
npx wrangler secret put ALLOWED_EMAILS
```

`ACCESS_ISSUER` must exactly match the `iss` value in the Access ID token. `ALLOWED_EMAILS`
is a comma-separated list; use one address for a personal deployment.

The Worker issues one-hour access tokens and refresh tokens valid for 30 days. Dynamically
registered MCP clients expire after 90 days. Those durations are set explicitly in
`src/server.ts` and can be shortened for a stricter private deployment.

## 4. Deploy and verify

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run --containers-rollout none
npx wrangler deploy
npx wrangler containers list
npx wrangler containers images list
curl --fail https://music21-mcp.<your-workers-subdomain>.workers.dev/health
```

The first container request can take longer while Cloudflare provisions or wakes the image.
Use the MCP Inspector against the `/mcp` URL and complete the Access login before adding the
server to ChatGPT.

## 5. Make it persistent in ChatGPT

In ChatGPT web, open **Workspace settings → Apps → Create**. Enter:

```text
https://music21-mcp.<your-workers-subdomain>.workers.dev/mcp
```

Choose OAuth, scan the tools, complete the Access sign-in, and create the app. The installed
app is the persistent connection; a local Codex MCP configuration alone does not register an
app in ChatGPT web.

## Git-based deployment

Cloudflare Workers Builds can deploy from this repository. Keep the project root at the
repository root and use
`npm --prefix mcp-server ci --ignore-scripts && npm --prefix mcp-server run deploy`
as the production command; the image build needs both `mcp-server/` and the music21 checkout.
Container Workers use Durable Objects, so use a separate staging Worker for pre-production
deployments rather than relying on ordinary branch preview URLs.
