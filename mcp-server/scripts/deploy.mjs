#!/usr/bin/env node
// This file was written with AI assistance.
// Run wrangler with CLOUDFLARE_* values from mcp-server/.env when present.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultEnvPath, loadDotEnv } from "./env.mjs";

const mcpServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = defaultEnvPath(mcpServerRoot);
const wranglerArgs = process.argv.slice(2);
const childEnv = { ...process.env };

try {
  await access(envPath);
  const env = loadDotEnv(envPath);
  childEnv.CLOUDFLARE_ACCOUNT_ID =
    process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "";
  childEnv.CLOUDFLARE_API_TOKEN =
    process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN || "";
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

const child = spawn("npx", ["--no-install", "wrangler", ...wranglerArgs], {
  cwd: mcpServerRoot,
  env: childEnv,
  stdio: "inherit",
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
