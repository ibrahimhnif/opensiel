import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  dotenvValue,
  envFileBlock,
  escapeCommand,
  isValidEnvKey,
  parseBoolean,
  renderDotenv,
} from "./opensiel-action-lib.mjs";

const execFileAsync = promisify(execFile);

test("parseBoolean accepts common truthy values", () => {
  for (const value of ["1", "true", "YES", "on"]) {
    assert.equal(parseBoolean(value, false), true);
  }
  assert.equal(parseBoolean("false", true), false);
  assert.equal(parseBoolean("", true), true);
  assert.equal(parseBoolean(undefined, true), true);
});

test("isValidEnvKey rejects names a shell cannot export", () => {
  assert.equal(isValidEnvKey("DATABASE_URL"), true);
  assert.equal(isValidEnvKey("_PRIVATE"), true);
  assert.equal(isValidEnvKey("bad-key"), false);
  assert.equal(isValidEnvKey("1KEY"), false);
  assert.equal(isValidEnvKey("with.dot"), false);
});

test("dotenvValue leaves simple values alone and quotes the rest", () => {
  assert.equal(dotenvValue("postgres://user:pass@db:5432/app"), "postgres://user:pass@db:5432/app");
  assert.equal(dotenvValue("hello world"), '"hello world"');
  assert.equal(dotenvValue('a"b'), '"a\\"b"');
  assert.equal(dotenvValue("line1\nline2"), '"line1\\nline2"');
  assert.equal(dotenvValue("a$b"), '"a\\$b"');
});

test("renderDotenv filters invalid keys and ends with a newline", () => {
  const output = renderDotenv({ A: "1", "BAD-KEY": "x", B: "two words" });
  assert.equal(output, 'A=1\nB="two words"\n');
});

test("envFileBlock picks a delimiter that is not in the value", () => {
  const block = envFileBlock("TOKEN", "line\nOPENSIEL_EOF_nonce", "nonce");
  assert.match(block, /^TOKEN<<OPENSIEL_EOF_nonce_\n/);
  assert.match(block, /\nOPENSIEL_EOF_nonce_$/);
});

test("escapeCommand escapes workflow command characters", () => {
  assert.equal(escapeCommand("a\nb%"), "a%0Ab%25");
  assert.equal(escapeCommand("a\rb"), "a%0Db");
});

test("action fetches, masks, writes dotenv, and exports GITHUB_ENV", async () => {
  const projectId = "11111111-2222-4333-8444-555555555555";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/token") {
      response.end(JSON.stringify({ accessToken: "test-token", expiresIn: 900 }));
      return;
    }
    if (request.url === "/api/projects") {
      response.end(
        JSON.stringify({
          projects: [{ id: projectId, name: "Web App", slug: "web-app", environments: [] }],
        }),
      );
      return;
    }
    if (request.url === `/api/projects/${projectId}/export?env=prod&format=json`) {
      if (request.headers.authorization !== "Bearer test-token") {
        response.statusCode = 401;
        response.end(JSON.stringify({ message: "bad token" }));
        return;
      }
      response.end(
        JSON.stringify({
          DATABASE_URL: "postgres://user:pass@db:5432/app",
          MULTILINE: "line1\nline2",
          "BAD-KEY": "ignored",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "opensiel-action-"));
  const githubEnv = join(directory, "github-env");
  const githubOutput = join(directory, "github-output");
  await writeFile(githubEnv, "");
  await writeFile(githubOutput, "");

  try {
    await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("./opensiel-action.mjs", import.meta.url))],
      {
        env: {
          ...process.env,
          GITHUB_WORKSPACE: directory,
          GITHUB_ENV: githubEnv,
          GITHUB_OUTPUT: githubOutput,
          OPENSIEL_API_URL: `http://127.0.0.1:${address.port}`,
          OPENSIEL_PROJECT: "web-app",
          OPENSIEL_ENV: "prod",
          OPENSIEL_CLIENT_ID: "client",
          OPENSIEL_CLIENT_SECRET: "secret",
          OPENSIEL_OUTPUT_FILE: ".env.opensiel",
          OPENSIEL_EXPORT_ENV: "true",
          OPENSIEL_MASK: "false",
          OPENSIEL_COMMAND: "true",
        },
      },
    );
  } finally {
    server.close();
  }

  const dotenv = await readFile(join(directory, ".env.opensiel"), "utf8");
  assert.match(dotenv, /^DATABASE_URL=postgres:\/\/user:pass@db:5432\/app$/m);
  assert.match(dotenv, /^MULTILINE="line1\\nline2"$/m);
  assert.doesNotMatch(dotenv, /BAD-KEY/);

  const envFile = await readFile(githubEnv, "utf8");
  assert.match(envFile, /^DATABASE_URL<<OPENSIEL_EOF_/m);
  assert.match(envFile, /^MULTILINE<<OPENSIEL_EOF_/m);

  const outputs = await readFile(githubOutput, "utf8");
  assert.match(outputs, new RegExp(`project-id=${projectId}`));
  assert.match(outputs, /secret-count=2/);

  if (process.platform !== "win32") {
    const mode = (await stat(join(directory, ".env.opensiel"))).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});
