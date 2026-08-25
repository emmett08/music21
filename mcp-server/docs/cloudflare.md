# Cloudflare deployment

This service needs a Worker plus a Linux/AMD64 Cloudflare Container. A plain JavaScript or
Python Worker cannot host the complete music21 and LilyPond runtime.

## 1. Fill in `mcp-server/.env`

Copy `mcp-server/.env.example` to `mcp-server/.env`. The file is gitignored. The same
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` names used by the EARL MCP delivery
`.env` work here; Wrangler also reads those from the process environment.

Set `MUSIC21_MCP_PUBLIC_BASE_URL` to the public Worker URL, usually
`https://music21-mcp.<your-workers-subdomain>.workers.dev`, and put the allowed identities
in `ALLOWED_EMAILS`. After the first deploy you can leave the Access OIDC fields empty and
let `npm run cf:configure-access` write them back.

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

`wrangler.jsonc` sets `image_build_context` to the repository root so `Dockerfile.mcp` can
copy `music21/` and `pyproject.toml` when Wrangler builds from this directory.

## 3. Create the Access application and store secrets

`npm run cf:configure-access` creates or updates an Access SaaS OIDC application whose
callback is `${MUSIC21_MCP_PUBLIC_BASE_URL}/callback`, then writes `ACCESS_*` into `.env`.
The upstream Access refresh token is not needed: this Worker validates the returned ID
token, discards the upstream token response and issues its own MCP credentials.

```bash
npm run cf:configure-access
npm run cf:sync-secrets:dry-run
npm run cf:sync-secrets
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
npm run cf:sync-secrets:dry-run
npx wrangler deploy --dry-run --containers-rollout none
npm run cf:deploy
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
