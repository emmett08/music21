#!/usr/bin/env node
// This file was written with AI assistance.
// Publish music21 MCP Worker secrets from mcp-server/.env without printing values.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKER_SECRET_NAMES,
  defaultEnvPath,
  loadDotEnv,
  requiredValue,
} from "./env.mjs";

const dryRun = process.argv.includes("--dry-run");
const mcpServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = defaultEnvPath(mcpServerRoot);

await access(envPath).catch(() => {
  throw new Error(`Missing ${envPath}. Copy .env.example to .env and fill in values.`);
});

const env = loadDotEnv(envPath);
const secrets = Object.fromEntries(
  WORKER_SECRET_NAMES.map((name) => [name, requiredValue(env, name)]),
);

const wranglerEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID:
    process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "",
  CLOUDFLARE_API_TOKEN:
    process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN || "",
};

if (dryRun) {
  console.log(`Would publish ${WORKER_SECRET_NAMES.length} Worker secrets from ${envPath}:`);
  for (const name of WORKER_SECRET_NAMES) {
    console.log(`  ${name} (${secrets[name].length} characters)`);
  }
  process.exit(0);
}

for (const name of WORKER_SECRET_NAMES) {
  await putSecret(name, secrets[name], wranglerEnv);
  console.log(`Published ${name}`);
}

async function putSecret(name, value, childEnv) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["--no-install", "wrangler", "secret", "put", name],
      {
        cwd: mcpServerRoot,
        env: childEnv,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`wrangler secret put ${name} exited with ${code}`));
    });
    child.stdin.end(value);
  });
}
