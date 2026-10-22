# Security

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting

Please report vulnerabilities privately through GitHub security advisories:
<https://github.com/ibrahimhnif/opensiel/security/advisories/new>. Do not open a public issue
for a vulnerability. Include reproduction steps and the affected version or commit.

## Test fixtures

`apps/server/test/fixtures/saml.ts` contains a self-signed key pair used only by the test
suite. It is not used at runtime and must not be trusted anywhere else.

## Design

### Encryption at rest

- Every project gets a random 32-byte data encryption key (DEK).
- The DEK is wrapped with AES-256-GCM under the instance master key (`OPENSIEL_MASTER_KEY`).
- Secret values are encrypted with the project DEK using AES-256-GCM, with
  `AAD = <secretId>:<version>`. A ciphertext cannot be moved between secrets or versions
  without failing authentication.
- The database only stores ciphertext, IV, auth tag, a keyed HMAC-SHA256 fingerprint, and
  metadata. The fingerprint is keyed with the project data key, so it cannot be used to
  confirm guesses for stored values.
- Version rows are append-only; rollback copies a previous plaintext into a new version.

### Keys

- `OPENSIEL_MASTER_KEY` must be 32 random bytes, base64 encoded. Losing it makes every
  stored secret unrecoverable. Back it up separately from the database.
- `OPENSIEL_JWT_SECRET` signs machine-identity tokens (HS256, 15 minutes). Rotating it
  invalidates all outstanding machine tokens.

### Authentication

| Principal        | Mechanism                                              | Storage                                                                   |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| User             | argon2id password hash                                 | 32-byte session token, only SHA-256 stored, 7-day expiry, httpOnly cookie |
| Machine identity | client id + client secret                              | secret stored as SHA-256, exchanged for a 15-minute JWT                   |
| Machine identity | trusted JWT (Kubernetes SA, CI OIDC)                   | verified against a configured issuer, audience, and JWKS                  |
| OIDC user        | provider ID token (authorization code + PKCE)          | session cookie as above                                                   |
| SAML user        | signed assertion validated against the IdP certificate | session cookie as above                                                   |

OIDC logins verify the ID token signature against the provider JWKS, check issuer and
audience, require a nonce match, and reject emails the provider marks as unverified.
SAML logins require a signed assertion, validate the audience, recipient, and timeframe, and
extract the email from `email`, `mail`, or `NameID`.
`OPENSIEL_OIDC_ALLOWED_DOMAINS` / `OPENSIEL_SAML_ALLOWED_DOMAINS` can restrict which email
domains may sign in. With auto-create disabled, only emails with a pending invite can sign in.

When AWS KMS is configured, the wrapped master key is decrypted once at startup and never
written to disk or logs; IAM credentials come from the standard AWS chain.

Machine tokens carry a token version and are re-checked against the identity row on every
request, so revoking an identity or changing its role, scopes, or token policy takes effect
immediately. Token TTL defaults to 15 minutes and is configurable per identity, with an
optional IP allowlist (single addresses or CIDR ranges) and an hourly issuance cap.

### Authorization

- Users belong to one organization; projects are scoped to the organization.
- Roles: `owner` (delete project, manage everything), `admin` (projects, environments,
  identities), `member` (read/write secrets), `viewer` (read secrets).
- Built-in roles map to a single permission matrix (`owner` bypasses nothing implicitly;
  `org:manage` and `project:delete` are owner-only).
- Custom roles carry scope-aware permissions and are attached through grants limited to an
  organization, project, environment, or path. Grants are additive, evaluated per request, and
  ignored once `expires_at` passes; a grant cannot authorize a different environment or path.
- Machine identities have `viewer` or `member` and an explicit environment allowlist.
  Cross-environment access returns 403; cross-organization access returns 404.

### Audit

All writes, rollbacks, identity operations, token issuance, and secret reads produce an
`audit_logs` row with actor, action, resource id, metadata, IP, and timestamp. Stored
metadata contains key names and paths, never values.

### Multi-factor authentication

- TOTP follows RFC 6238 (SHA-1, 6 digits, 30-second step) and accepts a ±1 step window.
  A code cannot be reused within its window (`user_mfa.last_used_step`).
- TOTP secrets are encrypted with the instance master key and `AAD = mfa:<userId>`.
- Ten single-use recovery codes are stored as SHA-256 hashes; a used code is marked and
  rejected on reuse.
- Password logins for enrolled users return a 5-minute challenge instead of a session.
  Organizations can require MFA: unenrolled users receive an enrollment token that only
  permits setup and verification.
- SSO logins rely on the identity provider's MFA; the local TOTP factor applies to password
  logins.

## Known limitations (v0)

- PKI/SSH certificate issuance, SCIM, and provider plugins are not implemented yet.
- TLS must be terminated in front of the app (reverse proxy, ingress, or tunnel). Do not
  serve the app directly over plain HTTP on the public internet.
- The reference deployment uses a single Postgres instance and a single app replica; it is
  not highly available.
