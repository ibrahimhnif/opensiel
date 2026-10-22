# SDK

`@opensiel/sdk` is a typed, dependency-free Node client, published to npm.

## Install

```bash
npm install @opensiel/sdk
```

Requires Node.js 20+.

To work on the SDK in this repository, build the workspace package and install it from the
checkout:

```bash
pnpm --filter @opensiel/sdk build
npm install /path/to/opensiel/packages/sdk
```

## Quick start

```ts
import { OpensielClient } from "@opensiel/sdk";

const client = new OpensielClient({ apiUrl: "http://localhost:8787" });

await client.login("you@example.com", "password");

const { projects } = await client.listProjects();
const projectId = projects[0].id;

const { secrets } = await client.listSecrets(projectId, "dev");
for (const secret of secrets) {
  console.log(secret.key, secret.value);
}
```

## Machine identities (recommended for apps and CI)

```ts
const client = new OpensielClient({ apiUrl: "https://opensiel.example.com" });

await client.loginWithClientCredentials(
  process.env.OPENSIEL_CLIENT_ID!,
  process.env.OPENSIEL_CLIENT_SECRET!,
);

const { secrets } = await client.listSecrets(projectId, "prod");
const env = Object.fromEntries(
  secrets.filter((secret) => secret.path === "/").map((secret) => [secret.key, secret.value]),
);
```

Tokens live for 15 minutes. Call `loginWithClientCredentials` again to renew.

## Methods

| Method                                                       | Purpose                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `login(email, password)`                                     | User login; stores the session token on the client.       |
| `loginWithClientCredentials(clientId, clientSecret)`         | Machine identity login; stores a 15-minute JWT.           |
| `setToken(token)`                                            | Use an existing session or machine token.                 |
| `me()`                                                       | Current user.                                             |
| `listProjects()` / `createProject(name)`                     | Projects.                                                 |
| `listSecrets(projectId, env, path?, recursive?)`             | Decrypted secrets for an environment.                     |
| `getSecret(projectId, env, key, path?)`                      | One secret value.                                         |
| `setSecret(projectId, env, key, value, { path?, comment? })` | New version; returns `{ secret }` or `{ changeRequest }`. |
| `deleteSecret(projectId, env, key, path?)`                   | Soft delete; may return a change request.                 |
| `listSecretVersions(projectId, env, key, path?)`             | Version metadata.                                         |
| `rollbackSecret(projectId, env, key, version, path?)`        | Roll back to a version.                                   |
| `exportSecrets(projectId, env, "json" \| "dotenv")`          | Object of root-path secrets.                              |

### Behavior to know

- `setSecret`, `deleteSecret`, and `rollbackSecret` return `{ changeRequest }` when the
  environment requires approvals, instead of applying immediately.
- Secret values are decrypted by the server and sent over TLS; the SDK never talks to the
  database.
- `exportSecrets` includes root-folder secrets only.

## Errors

```ts
import { OpensielError } from "@opensiel/sdk";

try {
  await client.getSecret(projectId, "prod", "DATABASE_URL");
} catch (error) {
  if (error instanceof OpensielError) {
    console.error(error.status, error.message); // e.g. 403, "identity is not scoped to this environment"
  }
}
```

The client does not retry requests. Handle `401` by refreshing a machine token and `429` with
a backoff if you hit the rate limit.
