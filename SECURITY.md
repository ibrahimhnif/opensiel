# Security

## Reporting

This is a lab project. Please open a private security advisory or contact the
maintainer instead of filing a public issue for vulnerabilities.

## Design

### Encryption at rest

- Every project gets a random 32-byte data encryption key (DEK).
- The DEK is wrapped with AES-256-GCM under the instance master key (`OPENSIEL_MASTER_KEY`).
- Secret values are encrypted with the project DEK using AES-256-GCM, with
  `AAD = <secretId>:<version>`. A ciphertext cannot be moved between secrets or versions
  without failing authentication.
- The database only stores ciphertext, IV, auth tag, a SHA-256 fingerprint, and metadata.
- Version rows are append-only; rollback copies a previous plaintext into a new version.

### Keys

- `OPENSIEL_MASTER_KEY` must be 32 random bytes, base64 encoded. Losing it makes every
  stored secret unrecoverable. Back it up separately from the database.
- `OPENSIEL_JWT_SECRET` signs machine-identity tokens (HS256, 15 minutes). Rotating it
  invalidates all outstanding machine tokens.

### Authentication

| Principal | Mechanism | Storage |
| --- | --- | --- |
| User | argon2id password hash | 32-byte session token, only SHA-256 stored, 7-day expiry, httpOnly cookie |
| Machine identity | client id + client secret | secret stored as SHA-256, exchanged for a 15-minute JWT |

Machine tokens are stateless; revoking an identity blocks new token issuance, but an
already-issued token stays valid until it expires (max 15 minutes).

### Authorization

- Users belong to one organization; projects are scoped to the organization.
- Roles: `owner` (delete project, manage everything), `admin` (projects, environments,
  identities), `member` (read/write secrets), `viewer` (read secrets).
- Machine identities have `viewer` or `member` and an explicit environment allowlist.
  Cross-environment access returns 403; cross-organization access returns 404.

### Audit

All writes, rollbacks, identity operations, token issuance, and secret reads produce an
`audit_logs` row with actor, action, resource id, metadata, IP, and timestamp. Stored
metadata contains key names and paths, never values.

## Known limitations (v0)

- No SSO/SAML, MFA, approval workflows, or invite flow. Set `OPENSIEL_ALLOW_SIGNUP=false`
  on any public instance and create the first account immediately.
- No rate limiting across multiple instances (in-process only, via `@fastify/rate-limit`).
- No secret scanning, dynamic credentials, PKI, or external KMS/HSM.
- No key rotation tooling yet. Rotating `OPENSIEL_MASTER_KEY` requires rewrapping DEKs.
- TLS must be terminated in front of the app (reverse proxy, ingress, or tunnel). Do not
  serve the app directly over plain HTTP on the public internet.
- The reference deployment uses a single Postgres instance and a single app replica; it is
  not highly available.
