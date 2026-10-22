export interface OpensielClientOptions {
  apiUrl?: string;
  token?: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  environments: { id: string; name: string; slug: string; position: number }[];
}

export interface Secret {
  key: string;
  value: string;
  path: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecretVersion {
  version: number;
  comment: string | null;
  fingerprint: string;
  fingerprintVersion: number;
  createdByType: string;
  createdById: string;
  createdAt: string;
  current: boolean;
}

export interface SecretDiff {
  key: string;
  path: string;
  env: string;
  changed: boolean;
  revealed: boolean;
  from: { version: number; value: string; createdAt: string };
  to: { version: number; value: string; createdAt: string };
}

export type PointInTimeAction = "restore" | "revive" | "delete" | "none";

export interface PointInTimeEntry {
  key: string;
  path: string;
  action: PointInTimeAction;
  currentVersion: number;
  targetVersion: number | null;
}

export interface PointInTimePreview {
  at: string;
  env: string;
  secretCount: number;
  changes: PointInTimeEntry[];
}

export interface PointInTimeRestoreResult {
  at: string;
  env: string;
  dryRun: boolean;
  restored: number;
  revived: number;
  deleted: number;
  changes: PointInTimeEntry[];
}

export interface TransitKey {
  id: string;
  name: string;
  version: number;
  createdAt: string;
}

export interface TransitEncryptResult {
  ciphertext: string;
  key: string;
  keyVersion: number;
  algorithm: string;
}

export interface ChangeRequestSummary {
  id: string;
  status: string;
  requiredApprovals: number;
  approvals: number;
}

export interface MutationResult {
  secret?: { key: string; version: number };
  changeRequest?: ChangeRequestSummary;
}

export interface ImportResult {
  dryRun: boolean;
  keys: string[];
  created: number;
  updated: number;
  imported: { key: string; version: number }[];
}

export class OpensielError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpensielError";
  }
}

export class MfaRequiredError extends Error {
  constructor(public readonly challengeToken: string) {
    super("multi-factor authentication required");
    this.name = "MfaRequiredError";
  }
}

export class OpensielClient {
  private apiUrl: string;
  private token?: string;

  constructor(options: OpensielClientOptions = {}) {
    this.apiUrl = (options.apiUrl ?? "http://localhost:8787").replace(/\/+$/, "");
    this.token = options.token;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  async login(email: string, password: string): Promise<{ token: string }> {
    const result = await this.request<{
      token?: string;
      mfaRequired?: boolean;
      challengeToken?: string;
    }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    if (result.mfaRequired && result.challengeToken) {
      throw new MfaRequiredError(result.challengeToken);
    }
    if (!result.token) throw new OpensielError(500, "login did not return a token");
    this.token = result.token;
    return { token: result.token };
  }

  async loginMfa(challengeToken: string, code: string): Promise<{ token: string }> {
    const result = await this.request<{ token: string }>("/api/auth/mfa/login", {
      method: "POST",
      body: { challengeToken, code },
    });
    this.token = result.token;
    return { token: result.token };
  }

  async loginWithClientCredentials(
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const result = await this.request<{ accessToken: string; expiresIn: number }>(
      "/api/auth/token",
      { method: "POST", body: { clientId, clientSecret } },
    );
    this.token = result.accessToken;
    return result;
  }

  me(): Promise<{ user: { id: string; email: string; name: string; role: string } }> {
    return this.request("/api/auth/me");
  }

  listProjects(): Promise<{ projects: Project[] }> {
    return this.request("/api/projects");
  }

  createProject(name: string): Promise<{ project: Project }> {
    return this.request("/api/projects", { method: "POST", body: { name } });
  }

  listSecrets(
    projectId: string,
    env: string,
    path = "/",
    recursive = false,
  ): Promise<{ secrets: Secret[] }> {
    const query = new URLSearchParams({ env, path, recursive: String(recursive) });
    return this.request(`/api/projects/${projectId}/secrets?${query}`);
  }

  async getSecret(projectId: string, env: string, key: string, path = "/"): Promise<string> {
    const query = new URLSearchParams({ env, path });
    const result = await this.request<{ secret: Secret }>(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(key)}?${query}`,
    );
    return result.secret.value;
  }

  setSecret(
    projectId: string,
    env: string,
    key: string,
    value: string,
    options: { path?: string; comment?: string } = {},
  ): Promise<MutationResult> {
    return this.request(`/api/projects/${projectId}/secrets`, {
      method: "POST",
      body: { key, value, env, path: options.path, comment: options.comment },
    });
  }

  importSecrets(
    projectId: string,
    env: string,
    contents: string,
    options: {
      path?: string;
      comment?: string;
      format?: "env" | "json";
      dryRun?: boolean;
    } = {},
  ): Promise<ImportResult> {
    return this.request(`/api/projects/${projectId}/secrets/import`, {
      method: "POST",
      body: {
        env,
        contents,
        format: options.format ?? "env",
        path: options.path,
        comment: options.comment,
        dryRun: options.dryRun,
      },
    });
  }

  deleteSecret(
    projectId: string,
    env: string,
    key: string,
    path = "/",
  ): Promise<{ ok?: boolean; changeRequest?: ChangeRequestSummary }> {
    const query = new URLSearchParams({ env, path });
    return this.request(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}?${query}`, {
      method: "DELETE",
    });
  }

  listSecretVersions(
    projectId: string,
    env: string,
    key: string,
    path = "/",
  ): Promise<{ versions: SecretVersion[] }> {
    const query = new URLSearchParams({ env, path });
    return this.request(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(key)}/versions?${query}`,
    );
  }

  diffSecret(
    projectId: string,
    env: string,
    key: string,
    options: { path?: string; from?: number; to?: number; reveal?: boolean } = {},
  ): Promise<{ diff: SecretDiff }> {
    const query = new URLSearchParams({ env });
    if (options.path) query.set("path", options.path);
    if (options.from !== undefined) query.set("from", String(options.from));
    if (options.to !== undefined) query.set("to", String(options.to));
    if (options.reveal) query.set("reveal", "true");
    return this.request(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(key)}/diff?${query}`,
    );
  }

  previewPointInTime(projectId: string, env: string, at: string): Promise<PointInTimePreview> {
    const query = new URLSearchParams({ env, at });
    return this.request(`/api/projects/${projectId}/point-in-time?${query}`);
  }

  restorePointInTime(
    projectId: string,
    env: string,
    at: string,
    dryRun = false,
  ): Promise<PointInTimeRestoreResult> {
    return this.request(`/api/projects/${projectId}/point-in-time/restore`, {
      method: "POST",
      body: { env, at, dryRun },
    });
  }

  encrypt(
    projectId: string,
    plaintext: string,
    options: { key?: string; context?: string } = {},
  ): Promise<TransitEncryptResult> {
    return this.request(`/api/projects/${projectId}/crypto/encrypt`, {
      method: "POST",
      body: { plaintext, key: options.key, context: options.context },
    });
  }

  decrypt(
    projectId: string,
    ciphertext: string,
    options: { context?: string } = {},
  ): Promise<{ plaintext: string; key: string; keyVersion: number }> {
    return this.request(`/api/projects/${projectId}/crypto/decrypt`, {
      method: "POST",
      body: { ciphertext, context: options.context },
    });
  }

  listTransitKeys(projectId: string): Promise<{ keys: TransitKey[] }> {
    return this.request(`/api/projects/${projectId}/crypto/keys`);
  }

  createTransitKey(projectId: string, name: string): Promise<{ key: TransitKey }> {
    return this.request(`/api/projects/${projectId}/crypto/keys`, {
      method: "POST",
      body: { name },
    });
  }

  rotateTransitKey(projectId: string, name: string): Promise<{ key: TransitKey }> {
    return this.request(
      `/api/projects/${projectId}/crypto/keys/${encodeURIComponent(name)}/rotate`,
      { method: "POST" },
    );
  }

  rollbackSecret(
    projectId: string,
    env: string,
    key: string,
    version: number,
    path = "/",
  ): Promise<MutationResult> {
    return this.request(`/api/projects/${projectId}/secrets/${encodeURIComponent(key)}/rollback`, {
      method: "POST",
      body: { version, env, path },
    });
  }

  async exportSecrets(
    projectId: string,
    env: string,
    format: "dotenv" | "json" = "json",
  ): Promise<Record<string, string>> {
    const query = new URLSearchParams({ env, format });
    const response = await fetch(`${this.apiUrl}/api/projects/${projectId}/export?${query}`, {
      headers: this.headers(),
    });
    if (!response.ok) throw new OpensielError(response.status, await response.text());
    if (format === "json") return (await response.json()) as Record<string, string>;
    const text = await response.text();
    return Object.fromEntries(
      text
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers = this.headers();
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(`${this.apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        if (text) message = text.slice(0, 300);
      }
      throw new OpensielError(response.status, message);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export default OpensielClient;
