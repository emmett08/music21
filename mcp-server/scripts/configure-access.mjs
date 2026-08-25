#!/usr/bin/env node
// This file was written with AI assistance.
// Create or update the Access SaaS OIDC app this Worker already uses.

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  accessOidcUrls,
  defaultEnvPath,
  loadDotEnv,
  optionalValue,
  parseEmailList,
  publicCallbackUrl,
  requiredValue,
  writeEnvValues,
} from "./env.mjs";

const mcpServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = defaultEnvPath(mcpServerRoot);
await access(envPath).catch(() => {
  throw new Error(`Missing ${envPath}. Copy .env.example to .env and fill in values.`);
});

const env = loadDotEnv(envPath);
const accountId = requiredValue(
  { CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID },
  "CLOUDFLARE_ACCOUNT_ID",
);
const apiToken = requiredValue(
  { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN },
  "CLOUDFLARE_API_TOKEN",
);
const publicBaseUrl = requiredValue(env, "MUSIC21_MCP_PUBLIC_BASE_URL");
const emails = parseEmailList(requiredValue(env, "ALLOWED_EMAILS"));
if (emails.length === 0) {
  throw new Error("ALLOWED_EMAILS must contain at least one address");
}
const appName = optionalValue(env, "MUSIC21_MCP_ACCESS_APP_NAME", "music21 MCP");
const redirectUri = publicCallbackUrl(publicBaseUrl);
const teamDomain = trimSlash(
  optionalValue(env, "MUSIC21_MCP_ACCESS_TEAM_DOMAIN") ||
    (await accessApi(apiToken, `/accounts/${accountId}/access/organizations`)).auth_domain,
);

const payload = {
  name: appName,
  type: "saas",
  policies: [
    {
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
      name: "Allow listed emails",
    },
  ],
  saas_app: {
    auth_type: "oidc",
    grant_types: ["authorization_code", "authorization_code_with_pkce"],
    redirect_uris: [redirectUri],
  },
};

const existing = (await accessApi(apiToken, `/accounts/${accountId}/access/apps`)).find(
  (app) => app.name === appName && app.type === "saas",
);
const app = existing
  ? await accessApi(apiToken, `/accounts/${accountId}/access/apps/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
  : await accessApi(apiToken, `/accounts/${accountId}/access/apps`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

const clientId = app.saas_app?.client_id || app.client_id;
const clientSecret = app.saas_app?.client_secret || existing && env.ACCESS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error("Access application response did not include OIDC client credentials");
}

const updates = {
  ACCESS_CLIENT_ID: clientId,
  ACCESS_CLIENT_SECRET: clientSecret,
  MUSIC21_MCP_ACCESS_TEAM_DOMAIN: teamDomain.startsWith("https://")
    ? teamDomain
    : `https://${teamDomain}`,
  ...accessOidcUrls(
    teamDomain.startsWith("https://") ? teamDomain : `https://${teamDomain}`,
    clientId,
  ),
};
writeEnvValues(envPath, updates);
console.log(`${existing ? "Updated" : "Created"} Access SaaS app ${appName}`);
console.log(`Redirect URI ${redirectUri}`);
console.log(`Wrote ACCESS_* values to ${envPath}`);

async function accessApi(token, apiPath, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    const detail = JSON.stringify(body.errors ?? body);
    throw new Error(`Cloudflare Access API ${apiPath} failed: ${detail}`);
  }
  return body.result;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}
