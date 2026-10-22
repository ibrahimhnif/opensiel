#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  envFileBlock,
  escapeCommand,
  isValidEnvKey,
  parseBoolean,
  renderDotenv,
} from "./opensiel-action-lib.mjs";

const apiUrl = (process.env.OPENSIEL_API_URL || "").replace(/\/+$/, "");
const project = process.env.OPENSIEL_PROJECT || "";
const environment = process.env.OPENSIEL_ENV || "";
const clientId = process.env.OPENSIEL_CLIENT_ID || "";
const clientSecret = process.env.OPENSIEL_CLIENT_SECRET || "";
const tokenInput = process.env.OPENSIEL_TOKEN || "";
const outputFile = process.env.OPENSIEL_OUTPUT_FILE || "";
const exportEnv = parseBoolean(process.env.OPENSIEL_EXPORT_ENV, true);
const mask = parseBoolean(process.env.OPENSIEL_MASK, true);
const command = process.env.OPENSIEL_COMMAND || "";
const githubEnv = process.env.GITHUB_ENV || "";
const githubOutput = process.env.GITHUB_OUTPUT || "";
const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

function fail(message) {
  console.error(`::error::${escapeCommand(message)}`);
  process.exit(1);
}

function commandValue(value) {
  console.log(`::add-mask::${escapeCommand(value)}`);
}

async function request(path, { method = "GET", body, token } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail(`could not reach ${apiUrl}: ${error.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.message) message = parsed.message;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new Error(message);
  }
  return text ? JSON.parse(text) : undefined;
}

async function main() {
  if (!apiUrl) fail("api-url is required");
  if (!/^https?:\/\//i.test(apiUrl)) fail("api-url must start with http:// or https://");
  if (!project) fail("project is required");
  if (!environment) fail("env is required");
  if (!tokenInput && (!clientId || !clientSecret)) {
    fail("provide token, or both client-id and client-secret");
  }

  let token = tokenInput;
  if (!token) {
    const result = await request("/api/auth/token", {
      method: "POST",
      body: { clientId, clientSecret },
    });
    token = result.accessToken;
  }

  let projectId = project;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project)) {
    const result = await request("/api/projects", { token });
    const projects = result.projects || [];
    const match = projects.find(
      (item) => item.id === project || item.slug === project || item.name === project,
    );
    if (!match) {
      const names = projects.map((item) => item.slug).join(", ");
      fail(`project "${project}" not found${names ? `; available: ${names}` : ""}`);
    }
    projectId = match.id;
  }

  const secrets = await request(
    `/api/projects/${encodeURIComponent(projectId)}/export?env=${encodeURIComponent(environment)}&format=json`,
    { token },
  );

  const entries = Object.entries(secrets || {}).filter(([key]) => {
    if (isValidEnvKey(key)) return true;
    console.log(
      `::warning::skipping "${escapeCommand(key)}": not a valid environment variable name`,
    );
    return false;
  });

  if (mask) {
    for (const [, value] of entries) {
      const text = String(value);
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) commandValue(line);
      }
      if (text.includes("\n")) commandValue(text);
    }
  }

  if (outputFile) {
    const target = isAbsolute(outputFile) ? outputFile : resolve(workspace, outputFile);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderDotenv(Object.fromEntries(entries)), { mode: 0o600 });
    try {
      await chmod(target, 0o600);
    } catch {
      // Windows runners may not support POSIX modes.
    }
    if (githubOutput) {
      await appendFile(githubOutput, `env-file=${target}\n`);
    }
  }

  if (exportEnv) {
    if (!githubEnv) {
      console.log("::warning::GITHUB_ENV is not set; skipping environment export");
    } else {
      const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
      const blocks = entries.map(([key, value]) => envFileBlock(key, value, nonce));
      if (blocks.length > 0) await appendFile(githubEnv, blocks.join("\n") + "\n");
    }
  }

  if (githubOutput) {
    await appendFile(githubOutput, `project-id=${projectId}\nsecret-count=${entries.length}\n`);
  }

  console.log(
    `Loaded ${entries.length} secret(s) for ${environment} from ${apiUrl}` +
      `${outputFile ? ` into ${outputFile}` : ""}${exportEnv ? " and GITHUB_ENV" : ""}.`,
  );

  if (command) {
    const result = spawnSync(command, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, ...Object.fromEntries(entries) },
    });
    if (result.error) fail(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

main().catch((error) => fail(error.message));
