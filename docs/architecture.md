# Architecture

## Components

| Component | Path              | Responsibility                                                                              |
| --------- | ----------------- | ------------------------------------------------------------------------------------------- |
| API       | `apps/server`     | Fastify routes, auth, authorization, crypto, audit, webhooks, dynamic credentials.          |
| Web       | `apps/web`        | React 19 + Vite, Tailwind v4 with shadcn-style components. Served by the API in production. |
| CLI       | `apps/cli`        | `opensiel` binary: login, init, secrets, import, export, run.                               |
| SDK       | `packages/sdk`    | Typed fetch client for Node 20+.                                                            |
| Shared    | `packages/shared` | Zod schemas and DTO types used by server, CLI, web, and SDK.                                |

In production the server serves `/api/*` and the built web app from the same origin.
PostgreSQL is the only required external dependency.

## Data model

```
users ─┬─ org_members ─ orgs ─┬─ projects ─┬─ environments ─┬─ secrets ── secret_versions
       │                     │            │                └─ identity_scopes
       │                     │            ├─ identities
       │                     │            ├─ change_requests ── change_request_approvals
       │                     │            ├─ dynamic_secret_configs ── dynamic_secret_leases
       │                     │            └─ webhooks
       └─ sessions           └─ org_invites
audit_logs (org-scoped, optional project)
```

- `projects` stores a wrapped data key (`dek_*`) and the master key version (`kek_version`).
- `secrets` is the identity of a key at `(project, environment, path, name)`; a partial unique
  index ignores soft-deleted rows.
- `secret_versions` is append-only. Rollback copies a previous plaintext into a new version.
- `change_requests` stores an encrypted proposed value (AES-GCM, AAD `change:<id>`).
- `dynamic_secret_configs` stores an encrypted admin connection string.
- `webhooks` stores an encrypted signing secret.

## Crypto

1. `OPENSIEL_MASTER_KEY` (or KMS-decrypted plaintext) is the KEK.
2. Each project gets a random 32-byte DEK, stored wrapped with AES-256-GCM under the KEK.
3. Secret values are encrypted with the project DEK, AES-256-GCM, `AAD = <secretId>:<version>`.
4. Rows store ciphertext, IV, auth tag, and an HMAC-SHA256 fingerprint keyed with the project
   DEK. Values are never logged.
5. Rotation rewraps DEKs to `OPENSIEL_MASTER_KEY_NEXT` and bumps `kek_version`; secret
   ciphertext is untouched.

AAD binding prevents moving ciphertext between secrets or versions. A missing key version
fails closed with `missing_key_version`.

## Transit keys

`transit_keys` holds named 32-byte keys, each wrapped with the project DEK under
`AAD = transit-key:<project>:<name>:<version>`. Version rows are kept on rotation so old
ciphertext keeps decrypting.

Ciphertext envelopes are `osl1.<name>.<version>.<iv>.<tag>.<ciphertext>`, encrypted with
AES-256-GCM and `AAD = transit:<project>:<name>:<version>:<context>`. The context is supplied
by the caller, so a payload cannot be decrypted under a different context. The server never
logs plaintext; only a truncated hash of the context is audited.

## Authentication

### Users

- argon2id password hashes.
- 32-byte session token; only SHA-256 is stored, 7-day expiry.
- httpOnly, SameSite=Lax cookie; also returned to the CLI on login.

### MFA

- TOTP (RFC 6238, SHA-1, 6 digits, 30s) with a ±1 step window and replay rejection through
  `user_mfa.last_used_step`.
- Enrollment returns an `otpauth://` URL and a manual secret; the secret is stored encrypted
  with the master key under `AAD = mfa:<userId>`.
- Ten recovery codes are returned once, stored as SHA-256 hashes, and marked used on
  redemption.
- Password logins for enrolled users return a 5-minute `mfa` challenge token instead of a
  session. `POST /api/auth/mfa/login` exchanges a code or recovery code for a session.
- `orgs.mfa_required` forces enrollment: an unenrolled password login returns
  `mfa_enrollment_required` with a 5-minute enrollment token that only works for
  `/api/auth/mfa/setup` and `/api/auth/mfa/verify`. Disabling MFA is refused while the policy
  is on.
- SSO sign-ins rely on the identity provider's MFA.

### Machine identities

- `clientId` + generated secret; only SHA-256 of the secret is stored.
- `POST /api/auth/token` exchanges credentials for an HS256 JWT with project, role,
  environment scopes, and the identity's token version. TTL defaults to 15 minutes and is
  configurable per identity (60s–24h).
- Each machine request reloads the identity and its scopes, so revoking an identity or
  changing its role, scopes, or token policy invalidates outstanding tokens immediately.
- Optional IP allowlist (addresses or CIDR ranges, checked at issuance) and hourly issuance
  cap; denials produce `identity.token.denied` audit entries.
- `POST /api/auth/token/jwt` exchanges a trusted JWT (a Kubernetes projected service-account
  token, a CI OIDC token, or any OIDC-issued JWT) for a machine token using
  `clientId` + `jwt`. Auth methods are configured per identity with an issuer, audience, JWKS
  URL, and an optional subject allowlist; signatures are verified against the cached JWKS and
  asymmetric algorithms only.
- `POST /api/auth/token/aws` accepts a SigV4-signed STS `GetCallerIdentity` request
  (`clientId`, `authorization`, `amzDate`, optional `securityToken`). The server forwards it to
  STS, checks the returned ARN against an allowlist (exact or `*` suffix, accepting the
  assumed-role session ARN or its IAM role ARN), enforces a five-minute clock window, and
  rejects reused signatures through `aws_auth_nonces`.
- `POST /api/auth/token/universal` is an alias for the client-credentials endpoint, so clients
  can use a consistent `/token/:method` shape.

### OIDC

Authorization code + PKCE, state and nonce, discovery + JWKS verification, issuer/audience
checks. The email must be present and not marked unverified. `OPENSIEL_OIDC_ALLOWED_DOMAINS`
limits domains.

### SAML

SP-initiated login with HTTP-POST assertions. Assertions must be signed and are validated
against the IdP certificate, audience, recipient, and timeframe. The email comes from
`email`, `mail`, or `NameID`.

### Provisioning

OIDC and SAML share `provisionUser`:

1. Existing user with a membership → use that organization.
2. Pending invite for the email → create/attach the user and accept the invite.
3. Otherwise, if auto-create is on → create a user and a new organization (owner) with a
   default project. If off → reject.

Passwords for SSO-created users are random and unknown, so password login cannot be used
until a password is set (not implemented in v0).

## Authorization

Permissions are defined once in `permissions.ts` and every access check derives from that
matrix.

- Built-in roles map to permissions: `owner` (all, including `org:manage` and
  `project:delete`), `admin` (everything except those two), `member` (secret read/write/delete,
  project read, audit read), `viewer` (secret read, project read, audit read).
- Machine identities map to secret read (`viewer`) or secret read/write (`member`) and are
  additionally restricted by their environment scopes.
- `custom_roles` hold a set of scope-aware permissions (`secret:read`, `secret:write`,
  `secret:delete`, `project:read`, `audit:read`).
- `role_grants` attach a custom role to a user at organization, project, environment, or path
  scope, optionally with `expires_at`. Grants are additive: they never remove a built-in
  permission, and a grant for one environment or path cannot authorize another.
- Secret write, delete, rollback, and import check the built-in permission first, then active
  grants for the exact project/environment/path. Expired grants are ignored at evaluation time.

## Secret writes and approvals

`POST /projects/:id/secrets` calls `applySecretWrite`, which finds or revives the secret,
encrypts the new version, inserts an immutable version row, and updates `latest_version` in a
transaction.

When `environments.approval_required` is true, the route stores a `change_request` instead.
Owners/admins approve or reject; requesters cannot approve their own request. Once the
required number of distinct approvals is reached, the payload is decrypted and applied, and
an audit entry records the approver.

## List APIs

Collection endpoints (`/secrets`, `/audit`, `/identities`, `/webhooks`, dynamic secrets,
change requests, members, invites, secret versions, and scanning) paginate on the server:

- `limit` (1–200, default 25), `offset` (default 0)
- `q` for a server-side text filter
- `sort` and `order` (`asc`/`desc`)

Responses keep the resource key (for example `secrets`) and add `total`, `limit`, and
`offset`, so clients never need to fetch and slice the full dataset.

## Secret syncs

`secret_syncs` pushes the secrets at one environment/path to an external provider.

- Providers: `webhook` (POST `{ projectId, environment, path, secrets }`), `vercel` (project env
  variables with `upsert=true`), `cloudflare` (Worker secrets), `github` (Actions secrets,
  sealed with the repository public key via libsodium), `aws` (Secrets Manager, one secret per
  key with an optional prefix), `gcp` (Secret Manager with a new version per run), `azure`
  (Key Vault secrets), and `kubernetes` (create or update a Secret through the cluster API).
- Secret names are provider-safe: underscores become dashes.
- Provider configs contain tokens and are encrypted with the project DEK under
  `AAD = sync:<id>:config`.
- A scheduler runs every 60 seconds, takes a `pg_try_advisory_xact_lock` so replicas do not
  double-run, and processes due syncs in order. `intervalSeconds` is between 60s and 24h.
- Each run resolves the environment (including imports and references), keeps only keys at the
  configured path, and sends them. Every key is upserted; removing a secret locally does not
  delete it remotely.
- Failures are recorded on the sync with exponential backoff (capped at one hour) and audited
  as `sync.fail`; successful runs are audited as `sync.run` with a key count, never values.
- `POST /api/projects/:id/syncs/:syncId/run` triggers a run immediately.

## Static secret rotation

`rotation_policies` schedules rotation for a single secret at `(environment, path, key)`.

- Providers: `postgres` (rotate a password for one of two named roles and render the secret
  through `valueTemplate`) and `http` (call a `createUrl`, optionally `revokeUrl`).
- Dual-phase: each successful run writes a new secret version, keeps the credential that was
  active in an encrypted `previous` slot with `previousRevokeAfter = now + graceSeconds`, and
  revokes it when the grace window ends. The `current` credential is stored encrypted so the
  next run can demote it.
- Config and credentials are encrypted with the project DEK under
  `AAD = rotation:<id>:(config|current|previous)`.
- The scheduler runs every 60 seconds, takes a `pg_try_advisory_xact_lock` so replicas do not
  double-run, revokes due credentials, and rotates due policies. `intervalSeconds` must be
  greater than `graceSeconds`.
- Failures are recorded on the policy with exponential backoff (capped at one hour) and leave
  the current credential and secret value untouched.
- `POST /api/projects/:id/rotations/:rotationId/rotate` runs a rotation immediately.

The HTTP provider posts `{ projectId, environment, path, key }` to `createUrl` and expects
`{ value }` or `{ username, password }`; the stored credential is posted to `revokeUrl`.
The PostgreSQL provider runs `ALTER ROLE … PASSWORD` through the admin connection and
randomizes the retired role's password on revocation.

## End-to-end encryption (opt-in)

A project can switch to `encryption_mode = 'e2ee'` while it has no secrets. In that mode the
server only stores ciphertext.

- Each user publishes an X25519 identity: the public key plus a private key wrapped with an
  Argon2id-derived key from their password (`user_keys`).
- A project key is generated client-side and wrapped for each member's public key
  (`project_member_keys`, X25519 + HKDF + AES-256-GCM sealed box). The server cannot unwrap it.
- Secrets are encrypted client-side with the project key and `AAD =
e2ee:<project>:<environment>:<path>:<key>`, then written through
  `POST /projects/:id/secrets/ciphertext`. Reads use
  `GET /projects/:id/secrets/ciphertext`, which never decrypts.
- The shared package exposes `generateIdentity`, `unlockIdentity`, `generateProjectKey`,
  `wrapProjectKey`, `unwrapProjectKey`, `encryptSecret`, and `decryptSecret`.
- Plaintext routes (`/secrets`, export, diff, point-in-time restore, scanning, rotation, and
  syncs) return `feature_unavailable_in_e2ee` for these projects. Approvals and server-side
  reference resolution are unavailable; resolve references client-side.
- The audit log records key names, paths, versions, and key versions, never plaintext or
  ciphertext.
- Not available in `e2ee` mode: web UI secret editing, dynamic credentials, server-side
  rotation/syncs, and shared reference resolution. Use the SDK and the crypto helpers from the
  workspace `@opensiel/shared` package.

## Version diff and point-in-time restore

`GET /projects/:id/secrets/:key/diff` decrypts two versions and returns them masked unless
`reveal=true`; every comparison is audited.

`GET /projects/:id/point-in-time` resolves, for every secret in an environment (including
soft-deleted rows), the newest version created at or before a timestamp. A restore plan has
three actions:

- `restore` — a newer version exists than the one at the timestamp; a new version is created
  from the old ciphertext, so history is never rewritten.
- `revive` — the secret was deleted after the timestamp.
- `delete` — the secret did not exist yet at the timestamp.

Restores require owner/admin, are audited as `secret.restore`, and are refused when the
environment requires approvals. A pre-revival deletion timestamp is not tracked, so a
delete → recreate cycle only considers the current row.

## References and imports

- `${KEY}` resolves at the root of the same environment; `${/path/KEY}` inside a folder.
- `\${KEY}` is literal. Missing references and cycles are left as written.
- `environment_imports` links a target environment to one source. The loader merges own
  values first, then imports, and resolves references over the merged set.
- Machine identities only see imports from environments in their scope.

## Dynamic credentials

1. An admin stores an encrypted PostgreSQL admin URL plus creation/revocation statement
   templates (`{{username}}`, `{{password}}`, `{{expires}}`).
2. Creating a lease generates a random role name/password, runs the creation statement, and
   records the lease with its expiry.
3. The password is returned once and never stored.
4. Revocation runs the revocation statement and marks the lease. A background reaper runs
   every minute and revokes expired leases.

## Webhooks

Events are dispatched after the audit write, fire-and-forget. Each delivery:

- payload: id, event, project/org ids, actor, resource metadata, timestamp;
- headers: `x-opensiel-event`, `x-opensiel-delivery`, `x-opensiel-signature`
  (`sha256=` HMAC over the raw body with the webhook secret);
- three attempts with a 5s timeout; last status/error/failure count stored.

## External KMS

With `OPENSIEL_KMS_*` configured, the wrapped master key is decrypted with AWS KMS once at
startup and kept in memory. `OPENSIEL_MASTER_KEY` is not required in that mode. IAM
credentials come from the standard AWS chain (or the explicit
`OPENSIEL_KMS_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`).

## Threat model and limitations

- Assumes the server host and PostgreSQL are trusted; database access alone does not reveal
  secrets, but an attacker with the KEK and database can.
- TLS must be terminated in front of the app.
- No MFA, PKI/SSH issuance, SCIM, or provider plugins yet.
- The reference deployment is a single API replica and a single PostgreSQL instance.
- The SAML test fixture key in `apps/server/test/fixtures` is test-only and never used at
  runtime.
