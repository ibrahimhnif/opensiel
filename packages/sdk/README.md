# @liostech/opensiel-sdk

Typed, dependency-free Node client for [opensiel](https://github.com/ibrahimhnif/opensiel), a
self-hosted secrets manager with approvals, versioning, SSO, dynamic credentials, and audit
logs.

Requires Node.js 20+.

## Install

```bash
npm install @liostech/opensiel-sdk
```

```ts
import { OpensielClient } from "@liostech/opensiel-sdk";

const client = new OpensielClient({ apiUrl: "https://opensiel.example.com" });
await client.login("you@example.com", "password");

const { projects } = await client.listProjects();
const { secrets } = await client.listSecrets(projects[0].id, "dev");
```

## Machine identities

Use a scoped machine identity in services and CI, not a user session:

```ts
await client.loginWithClientCredentials(
  process.env.OPENSIEL_CLIENT_ID!,
  process.env.OPENSIEL_CLIENT_SECRET!,
);

const { secrets } = await client.listSecrets(projectId, "prod");
```

Machine tokens expire after 15 minutes. Call `loginWithClientCredentials` again to renew.

## Methods

| Method                                                       | Purpose                               |
| ------------------------------------------------------------ | ------------------------------------- |
| `login(email, password)`                                     | User login; stores the session token. |
| `loginWithClientCredentials(clientId, clientSecret)`         | Machine identity login.               |
| `setToken(token)`                                            | Use an existing token.                |
| `me()`                                                       | Current user.                         |
| `listProjects()` / `createProject(name)`                     | Projects.                             |
| `listSecrets(projectId, env, path?, recursive?)`             | Decrypted secrets.                    |
| `getSecret(projectId, env, key, path?)`                      | One secret value.                     |
| `setSecret(projectId, env, key, value, { path?, comment? })` | New version.                          |
| `importSecrets(projectId, env, contents, options?)`          | Bulk import with dry-run.             |
| `deleteSecret(projectId, env, key, path?)`                   | Soft delete.                          |
| `listSecretVersions(projectId, env, key, path?)`             | Version history.                      |
| `rollbackSecret(projectId, env, key, version, path?)`        | Roll back.                            |
| `exportSecrets(projectId, env, "json" \| "dotenv")`          | Root-folder secrets.                  |

`setSecret`, `deleteSecret`, and `rollbackSecret` return `{ changeRequest }` when the environment
requires approvals.

## Errors

```ts
import { OpensielError } from "@liostech/opensiel-sdk";

try {
  await client.getSecret(projectId, "prod", "DATABASE_URL");
} catch (error) {
  if (error instanceof OpensielError) {
    console.error(error.status, error.message);
  }
}
```

The client does not retry. Handle `401` by renewing a machine token and `429` with a backoff.

## Links

- [Documentation](https://opensiel.liostech.id/docs/)
- [SDK guide](https://opensiel.liostech.id/docs/sdk)
- [Issues](https://github.com/ibrahimhnif/opensiel/issues)
- [License](https://github.com/ibrahimhnif/opensiel/blob/main/LICENSE) (MIT)
