import { Command } from "commander";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { ImportSecretsResult, ProjectDto } from "@opensiel/shared";

interface Config {
  apiUrl: string;
  token?: string;
}

interface ProjectConfig {
  projectId: string;
  env?: string;
}

interface SecretDto {
  key: string;
  value: string;
  path: string;
  version: number;
  updatedAt: string;
}

const CONFIG_DIR = join(homedir(), ".opensiel");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PROJECT_PATH = join(process.cwd(), ".opensiel.json");
const DEFAULT_API_URL = "http://localhost:8787";

function readConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    return { apiUrl: parsed.apiUrl ?? DEFAULT_API_URL, token: parsed.token };
  } catch {
    return { apiUrl: DEFAULT_API_URL };
  }
}

function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

function readProjectConfig(): ProjectConfig | null {
  try {
    return JSON.parse(readFileSync(PROJECT_PATH, "utf8")) as ProjectConfig;
  } catch {
    return null;
  }
}

function writeProjectConfig(config: ProjectConfig): void {
  writeFileSync(PROJECT_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function requireConfigWithToken(): Config {
  const config = readConfig();
  if (!config.token && !process.env.OPENSIEL_TOKEN) {
    fail("not logged in; run `opensiel login` first");
  }
  return config;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; apiUrl?: string } = {},
): Promise<T> {
  const config = readConfig();
  const apiUrl = (options.apiUrl ?? config.apiUrl).replace(/\/$/, "");
  const token = options.token ?? process.env.OPENSIEL_TOKEN ?? config.token;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    fail(`cannot reach ${apiUrl}: ${(error as Error).message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    fail(message);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function apiText(path: string): Promise<string> {
  const config = requireConfigWithToken();
  const token = process.env.OPENSIEL_TOKEN ?? config.token;
  const response = await fetch(`${config.apiUrl.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) fail(`${response.status} ${await response.text()}`);
  return response.text();
}

function resolveProjectId(flag?: string): string {
  if (flag) return flag;
  const project = readProjectConfig();
  if (!project?.projectId) {
    fail("no project linked here; run `opensiel init` or pass --project");
  }
  return project.projectId;
}

function resolveEnv(flag?: string): string {
  return flag ?? readProjectConfig()?.env ?? "dev";
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

const program = new Command();
program
  .name("opensiel")
  .description("opensiel — self-hosted secrets manager CLI")
  .version("0.1.0")
  .option("--api-url <url>", "opensiel server URL")
  .option("--token <token>", "session or machine token");

program
  .command("login")
  .description("log in to an opensiel instance")
  .option("--email <email>")
  .option("--password <password>")
  .option("--token <token>", "store an existing token instead of logging in")
  .action(async (options) => {
    const globals = program.opts<{ apiUrl?: string; token?: string }>();
    const apiUrl = (options.apiUrl as string | undefined) ?? globals.apiUrl ?? readConfig().apiUrl;

    if (options.token || globals.token) {
      const token = (options.token as string | undefined) ?? globals.token!;
      if (token.split(".").length === 3) {
        writeConfig({ apiUrl, token });
        console.log(`stored machine token for ${apiUrl} (expires in 15 minutes)`);
        return;
      }
      const me = await apiRequest<{ user: { email: string; name: string } }>("/api/auth/me", {
        token,
        apiUrl,
      });
      writeConfig({ apiUrl, token });
      console.log(`logged in as ${me.user.email} (${apiUrl})`);
      return;
    }

    const email = (options.email as string | undefined) ?? (await prompt("email: "));
    const password = (options.password as string | undefined) ?? (await prompt("password: "));
    const result = await apiRequest<{ token: string; user: { email: string; name: string } }>(
      "/api/auth/login",
      { method: "POST", body: { email, password }, apiUrl },
    );
    writeConfig({ apiUrl, token: result.token });
    console.log(`logged in as ${result.user.email} (${apiUrl})`);
  });

program
  .command("logout")
  .description("remove the stored session token")
  .action(() => {
    const config = readConfig();
    writeConfig({ apiUrl: config.apiUrl });
    console.log("logged out");
  });

program
  .command("init")
  .description("link this directory to an opensiel project")
  .option("--project <idOrSlug>")
  .option("--env <env>")
  .action(async (options) => {
    const { projects } = await apiRequest<{ projects: ProjectDto[] }>("/api/projects");
    if (projects.length === 0) fail("no projects available; create one in the web UI first");

    let project: ProjectDto | undefined;
    if (options.project) {
      project = projects.find(
        (candidate) =>
          candidate.id === options.project ||
          candidate.slug === options.project ||
          candidate.name === options.project,
      );
      if (!project) fail(`project '${options.project}' not found`);
    } else if (projects.length === 1) {
      project = projects[0];
    } else {
      console.log("projects:");
      projects.forEach((candidate, index) =>
        console.log(`  ${index + 1}. ${candidate.name} (${candidate.slug})`),
      );
      const answer = await prompt("select project: ");
      project = projects[Number(answer) - 1];
      if (!project) fail("invalid selection");
    }

    const env = options.env ?? project.environments[0]?.slug ?? "dev";
    writeProjectConfig({ projectId: project.id, env });
    console.log(`linked ${project.name} (${env}) -> ${PROJECT_PATH}`);
  });

const secrets = program.command("secrets").description("manage secrets");

secrets
  .command("list")
  .description("list secrets for an environment")
  .option("--env <env>")
  .option("--path <path>")
  .option("--recursive")
  .option("--reveal")
  .action(async (options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const query = new URLSearchParams({ env });
    if (options.path) query.set("path", options.path as string);
    if (options.recursive) query.set("recursive", "true");
    const { secrets: rows } = await apiRequest<{ secrets: SecretDto[] }>(
      `/api/projects/${projectId}/secrets?${query}`,
    );
    if (rows.length === 0) {
      console.log("no secrets");
      return;
    }
    printTable(
      ["KEY", "VALUE", "VERSION", "UPDATED"],
      rows.map((row) => [
        row.path === "/" ? row.key : `${row.path}/${row.key}`,
        options.reveal ? row.value : "••••••••",
        String(row.version),
        row.updatedAt.slice(0, 19).replace("T", " "),
      ]),
    );
  });

secrets
  .command("get <key>")
  .description("print a secret value")
  .option("--env <env>")
  .option("--path <path>")
  .action(async (key: string, options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const query = new URLSearchParams({ env });
    if (options.path) query.set("path", options.path as string);
    const { secret } = await apiRequest<{ secret: SecretDto }>(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(key)}?${query}`,
    );
    process.stdout.write(`${secret.value}\n`);
  });

secrets
  .command("set [pairs...]")
  .description("set one or more secrets (KEY=VALUE)")
  .option("--env <env>")
  .option("--path <path>")
  .option("--comment <comment>")
  .action(async (pairs: string[], options) => {
    if (!pairs || pairs.length === 0) fail("provide at least one KEY=VALUE pair");
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    for (const pair of pairs) {
      const index = pair.indexOf("=");
      if (index <= 0) fail(`invalid pair '${pair}', expected KEY=VALUE`);
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const result = await apiRequest<{
        secret?: { key: string; version: number };
        changeRequest?: { id: string; requiredApprovals: number };
      }>(`/api/projects/${projectId}/secrets`, {
        method: "POST",
        body: {
          key,
          value,
          env,
          path: options.path,
          comment: options.comment,
        },
      });
      if (result.changeRequest) {
        console.log(
          `submitted ${key} for approval (${result.changeRequest.id}) — needs ${result.changeRequest.requiredApprovals} approval(s)`,
        );
      } else if (result.secret) {
        console.log(`set ${result.secret.key} (v${result.secret.version}) in ${env}`);
      }
    }
  });

secrets
  .command("import <file>")
  .description("import secrets from a .env file (use '-' to read stdin)")
  .option("--stdin", "read the .env content from stdin")
  .option("--env <env>")
  .option("--path <path>")
  .option("--comment <comment>")
  .option("--dry-run", "only parse and list the keys")
  .action(async (file: string, options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const fromStdin = Boolean(options.stdin) || file === "-";
    const contents = fromStdin ? readFileSync(0, "utf8") : readFileSync(file, "utf8");

    const result = await apiRequest<ImportSecretsResult>(
      `/api/projects/${projectId}/secrets/import`,
      {
        method: "POST",
        body: {
          env,
          path: options.path,
          format: "env",
          contents,
          comment: options.comment,
          dryRun: Boolean(options.dryRun),
        },
      },
    );

    if (result.dryRun) {
      console.log(`${result.keys.length} key(s): ${result.keys.join(", ")}`);
    } else {
      console.log(
        `imported ${result.imported.length} secrets into ${env} (${result.created} new, ${result.updated} updated)`,
      );
    }
  });

secrets
  .command("delete <key>")
  .description("delete a secret")
  .option("--env <env>")
  .option("--path <path>")
  .action(async (key: string, options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const query = new URLSearchParams({ env });
    if (options.path) query.set("path", options.path as string);
    const result = await apiRequest<{ ok?: boolean; changeRequest?: { id: string } }>(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(key)}?${query}`,
      { method: "DELETE" },
    );
    console.log(
      result.changeRequest
        ? `delete of ${key} submitted for approval (${result.changeRequest.id})`
        : `deleted ${key} from ${env}`,
    );
  });

secrets
  .command("versions <key>")
  .description("show the version history of a secret")
  .option("--env <env>")
  .option("--path <path>")
  .action(async (key: string, options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const query = new URLSearchParams({ env });
    if (options.path) query.set("path", options.path as string);
    const { versions } = await apiRequest<{
      versions: {
        version: number;
        comment: string | null;
        fingerprint: string;
        createdByType: string;
        createdAt: string;
        current: boolean;
      }[];
    }>(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}/versions?${query}`);

    printTable(
      ["VERSION", "CURRENT", "BY", "COMMENT", "CREATED"],
      versions.map((version) => [
        String(version.version),
        version.current ? "yes" : "",
        version.createdByType,
        version.comment ?? "",
        version.createdAt.slice(0, 19).replace("T", " "),
      ]),
    );
  });

secrets
  .command("rollback <key>")
  .description("roll a secret back to an earlier version")
  .requiredOption("--version <version>")
  .option("--env <env>")
  .option("--path <path>")
  .action(async (key: string, options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const result = await apiRequest<{
      secret?: { version: number };
      changeRequest?: { id: string; requiredApprovals: number };
    }>(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}/rollback`, {
      method: "POST",
      body: { version: Number(options.version), env, path: options.path },
    });
    console.log(
      result.changeRequest
        ? `rollback of ${key} submitted for approval (${result.changeRequest.id})`
        : `rolled back ${key} to v${options.version} (new version v${result.secret?.version})`,
    );
  });

program
  .command("export")
  .description("print secrets as dotenv or json")
  .option("--env <env>")
  .option("--format <format>", "dotenv or json", "dotenv")
  .action(async (options) => {
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const format = options.format === "json" ? "json" : "dotenv";
    const body = await apiText(`/api/projects/${projectId}/export?env=${env}&format=${format}`);
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  });

program
  .command("run [command...]")
  .description("run a command with secrets injected as environment variables")
  .option("--env <env>")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (command: string[], options) => {
    if (!command || command.length === 0) {
      fail("usage: opensiel run --env dev -- <command>");
    }
    const projectId = resolveProjectId();
    const env = resolveEnv(options.env as string | undefined);
    const query = new URLSearchParams({ env });
    const { secrets: rows } = await apiRequest<{ secrets: SecretDto[] }>(
      `/api/projects/${projectId}/secrets?${query}`,
    );

    const envVars: Record<string, string> = {};
    for (const secret of rows) {
      if (secret.path === "/") envVars[secret.key] = secret.value;
    }

    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, ...envVars },
    });

    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));

    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  });

program
  .command("whoami")
  .description("show the current session")
  .action(async () => {
    const config = requireConfigWithToken();
    const me = await apiRequest<{
      user: { email: string; name: string; role: string; orgName: string };
    }>("/api/auth/me");
    console.log(`${me.user.name} <${me.user.email}> role=${me.user.role} org=${me.user.orgName}`);
    console.log(`api: ${config.apiUrl}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
