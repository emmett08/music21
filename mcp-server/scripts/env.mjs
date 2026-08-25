// This file was written with AI assistance.
// Shared .env helpers for the music21 MCP Cloudflare deploy scripts.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WORKER_SECRET_NAMES = Object.freeze([
  "ACCESS_AUTHORIZATION_URL",
  "ACCESS_CLIENT_ID",
  "ACCESS_CLIENT_SECRET",
  "ACCESS_ISSUER",
  "ACCESS_JWKS_URL",
  "ACCESS_TOKEN_URL",
  "ALLOWED_EMAILS",
]);

export function parseDotEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!key) {
      continue;
    }
    env[key] = unquote(line.slice(separator + 1).trim());
  }
  return env;
}

export function loadDotEnv(envPath) {
  return parseDotEnv(readFileSync(envPath, "utf8"));
}

export function defaultEnvPath(cwd = process.cwd()) {
  return path.resolve(cwd, ".env");
}

export function requiredValue(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in .env`);
  }
  return value;
}

export function optionalValue(env, name, fallback = "") {
  const value = env[name]?.trim();
  return value || fallback;
}

export function parseEmailList(value) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function publicCallbackUrl(publicBaseUrl) {
  return new URL("/callback", withTrailingSlash(publicBaseUrl)).href;
}

export function accessOidcUrls(teamDomain, clientId) {
  const issuer = `${trimTrailingSlash(teamDomain)}/cdn-cgi/access/sso/oidc/${clientId}`;
  return {
    ACCESS_AUTHORIZATION_URL: `${issuer}/authorization`,
    ACCESS_ISSUER: issuer,
    ACCESS_JWKS_URL: `${issuer}/jwks`,
    ACCESS_TOKEN_URL: `${issuer}/token`,
  };
}

export function upsertEnvValues(existingText, updates) {
  const lines = existingText.length === 0 ? [] : existingText.split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !(match[1] in updates)) {
      return line;
    }
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      if (next.length > 0 && next[next.length - 1] !== "") {
        next.push("");
      }
      next.push(`${key}=${value}`);
    }
  }
  return next.join("\n").replace(/\n*$/, "\n");
}

export function writeEnvValues(envPath, updates) {
  let existing = "";
  try {
    existing = readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  writeFileSync(envPath, upsertEnvValues(existing, updates), { mode: 0o600 });
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function withTrailingSlash(value) {
  return `${trimTrailingSlash(value)}/`;
}
