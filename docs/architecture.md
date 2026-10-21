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
4. Rows store ciphertext, IV, auth tag, and a SHA-256 fingerprint. Values are never logged.
5. Rotation rewraps DEKs to `OPENSIEL_MASTER_KEY_NEXT` and bumps `kek_version`; secret
   ciphertext is untouched.

AAD binding prevents moving ciphertext between secrets or versions. A missing key version
fails closed with `missing_key_version`.

## Authentication

### Users

- argon2id password hashes.
- 32-byte session token; only SHA-256 is stored, 7-day expiry.
- httpOnly, SameSite=Lax cookie; also returned to the CLI on login.

### Machine identities

- `clientId` + generated secret; only SHA-256 of the secret is stored.
- `POST /api/auth/token` exchanges credentials for a 15-minute HS256 JWT with project,
  role, and environment scopes.
- Tokens are stateless; revoking blocks new tokens, existing ones expire within 15 minutes.

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

## Secret writes and approvals

`POST /projects/:id/secrets` calls `applySecretWrite`, which finds or revives the secret,
encrypts the new version, inserts an immutable version row, and updates `latest_version` in a
transaction.

When `environments.approval_required` is true, the route stores a `change_request` instead.
Owners/admins approve or reject; requesters cannot approve their own request. Once the
required number of distinct approvals is reached, the payload is decrypted and applied, and
an audit entry records the approver.

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
