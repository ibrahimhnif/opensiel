# SDK

`@liostech/opensiel-sdk` is a typed, dependency-free Node client, published to npm.

## Install

```bash
npm install @liostech/opensiel-sdk
```

Requires Node.js 20+.

To work on the SDK in this repository, build the workspace package and install it from the
checkout:

```bash
pnpm --filter @liostech/opensiel-sdk build
npm install /path/to/opensiel/packages/sdk
```

## Quick start

```ts
import { OpensielClient } from "@liostech/opensiel-sdk";

const client = new OpensielClient({ apiUrl: "http://localhost:8787" });

await client.login("you@example.com", "password");

const { projects } = await client.listProjects();
const projectId = projects[0].id;

const { secrets } = await client.listSecrets(projectId, "dev");
for (const secret of secrets) {
  console.log(secret.key, secret.value);
}
```

## TOTP

```ts
import { MfaRequiredError } from "@liostech/opensiel-sdk";

try {
  await client.login(email, password);
} catch (error) {
  if (error instanceof MfaRequiredError) {
    const { token } = await client.loginMfa(error.challengeToken, "123456");
  }
}
```

`loginMfa` accepts a 6-digit TOTP code or one of the recovery codes created at enrollment.

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

| Method                                                       | Purpose                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `login(email, password)`                                     | User login; stores the session token on the client.                           |
| `loginMfa(challengeToken, code)`                             | Complete a TOTP or recovery-code challenge.                                   |
| `loginWithClientCredentials(clientId, clientSecret)`         | Machine identity login; stores a 15-minute JWT.                               |
| `setToken(token)`                                            | Use an existing session or machine token.                                     |
| `me()`                                                       | Current user.                                                                 |
| `listProjects()` / `createProject(name)`                     | Projects.                                                                     |
| `listSecrets(projectId, env, path?, recursive?)`             | Decrypted secrets for an environment.                                         |
| `getSecret(projectId, env, key, path?)`                      | One secret value.                                                             |
| `setSecret(projectId, env, key, value, { path?, comment? })` | New version; returns `{ secret }` or `{ changeRequest }`.                     |
| `deleteSecret(projectId, env, key, path?)`                   | Soft delete; may return a change request.                                     |
| `listSecretVersions(projectId, env, key, path?)`             | Version metadata.                                                             |
| `diffSecret(projectId, env, key, { from?, to?, reveal? })`   | Compare two versions; masked unless `reveal`.                                 |
| `rollbackSecret(projectId, env, key, version, path?)`        | Roll back to a version.                                                       |
| `previewPointInTime(projectId, env, at)`                     | Preview an environment at an ISO timestamp.                                   |
| `restorePointInTime(projectId, env, at, dryRun?)`            | Restore an environment to that timestamp.                                     |
| `encrypt(projectId, plaintext, { key?, context? })`          | Encrypt with a project transit key.                                           |
| `decrypt(projectId, ciphertext, { context? })`               | Decrypt a transit envelope.                                                   |
| `listTransitKeys` / `createTransitKey` / `rotateTransitKey`  | Manage transit keys (create and rotate need admin).                           |
| `getUserKeys` / `putUserKeys`                                | Fetch or upload your wrapped identity key.                                    |
| `getProjectKeys` / `putProjectKeys`                          | Fetch your wrapped project key and members' public keys; upload wrapped keys. |
| `setEncryptionMode(projectId, "server" \| "e2ee")`           | Switch an empty project to E2EE.                                              |
| `writeE2eeSecret` / `listE2eeSecrets`                        | Store or fetch ciphertext-only secrets.                                       |
| `exportSecrets(projectId, env, "json" \| "dotenv")`          | Object of root-path secrets.                                                  |

### Behavior to know

- `setSecret`, `deleteSecret`, and `rollbackSecret` return `{ changeRequest }` when the
  environment requires approvals, instead of applying immediately.
- Secret values are decrypted by the server and sent over TLS; the SDK never talks to the
  database.
- `exportSecrets` includes root-folder secrets only.
- A point-in-time restore only creates new versions; existing history is never rewritten.

## Transit encryption

Encrypt application data without managing keys yourself. Ciphertext is bound to an optional
context string, so it cannot be replayed under a different context.

```ts
const { ciphertext } = await client.encrypt(projectId, "card=4111", {
  key: "billing",
  context: "user:42",
});

const { plaintext } = await client.decrypt(projectId, ciphertext, {
  context: "user:42",
});
```

Named keys default to `default` and are created on first use; `createTransitKey` and
`rotateTransitKey` require an owner or admin. Rotation keeps old key material so previously
issued ciphertext still decrypts.

## End-to-end encryption

The SDK provides the transport calls; key handling lives in the workspace `@opensiel/shared`
package (`generateIdentity`, `unlockIdentity`, `generateProjectKey`, `wrapProjectKey`,
`unwrapProjectKey`, `encryptSecret`, `decryptSecret`, `secretAad`).

```ts
import {
  encryptSecret,
  generateIdentity,
  generateProjectKey,
  secretAad,
  unlockIdentity,
  unwrapProjectKey,
  wrapProjectKey,
} from "@opensiel/shared";

// 1. publish your identity (the private key is wrapped with your password)
const identity = generateIdentity(password);
await client.putUserKeys({
  publicKey: identity.publicKey,
  wrappedPrivateKey: identity.wrappedPrivateKey.ciphertext,
  privateKeyIv: identity.wrappedPrivateKey.iv,
  privateKeyTag: identity.wrappedPrivateKey.tag,
  kdfSalt: identity.wrappedPrivateKey.salt,
  kdfParams: identity.wrappedPrivateKey.kdf,
});

// 2. switch an empty project to e2ee, create a project key, wrap it for members
await client.setEncryptionMode(projectId, "e2ee");
const projectKey = generateProjectKey();
const { members } = await client.getProjectKeys(projectId);
await client.putProjectKeys(
  projectId,
  members.map((member) => ({
    userId: member.userId,
    ...wrapProjectKey(projectKey, member.publicKey),
    keyVersion: 1,
  })),
);

// 3. write and read ciphertext
const aad = secretAad(projectId, "dev", "/", "DATABASE_URL");
const payload = encryptSecret(projectKey, "postgres://…", aad);
await client.writeE2eeSecret(projectId, "dev", "DATABASE_URL", payload);

const { secrets } = await client.listE2eeSecrets(projectId, "dev");
const { privateKey } = unlockIdentity(password, identity.wrappedPrivateKey);
const wrapped = await client.getProjectKeys(projectId);
const decrypted = decryptSecret(
  unwrapProjectKey(privateKey, wrapped.key!),
  secrets[0],
  secretAad(projectId, "dev", secrets[0].path, secrets[0].key),
);
```

Plaintext APIs return `feature_unavailable_in_e2ee` for these projects, and the server never
receives the project key or plaintext. The published SDK does not re-export the crypto helpers
yet; they are available from the workspace `@opensiel/shared` package.

## Errors

```ts
import { OpensielError } from "@liostech/opensiel-sdk";

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
