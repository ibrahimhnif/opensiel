# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Secret version diff (`GET .../secrets/:key/diff`) and point-in-time environment restore,
  exposed as `opensiel secrets diff` and `opensiel secrets restore`.
- Transit crypto API: encrypt/decrypt with named project keys, context-bound with AAD,
  plus key rotation (`/api/projects/:id/crypto/*`) and SDK helpers.
- Audit log export as JSONL or CSV with date/action/project filters, streamed in pages.
- Machine identity token policy: per-identity TTL, IP allowlist (CIDR), hourly issuance cap,
  and immediate revocation via token versions.
- `PATCH /api/projects/:id/identities/:identityId` to update role, scopes, and token policy.
- CLI: `opensiel crypto encrypt|decrypt` and `opensiel crypto keys list|create|rotate`.
- Web UI: version diff and a point-in-time restore panel in the secrets view.
- Audit sink worker: stream new audit events to HTTP, Splunk HEC, Datadog, or S3 with a
  monotonic checkpoint and exponential backoff.
- TOTP multi-factor authentication: enrollment with QR/otpauth, ten single-use recovery codes,
  challenge-based login, replay rejection, and a per-organization `mfa_required` policy.
- CLI/SDK/web support for MFA: code prompt on `opensiel login`, `MfaRequiredError` +
  `loginMfa` in the SDK, challenge and enrollment flows in the web UI, and a Security tab.
- Machine identity JWT auth: exchange a trusted JWT (Kubernetes service-account token, CI OIDC
  token) for a machine token via `/api/auth/token/jwt`, with per-identity issuer, audience,
  JWKS, and subject allowlists.
- Static secret rotation: policies with PostgreSQL-role and HTTP providers, encrypted configs,
  dual-phase current/previous credentials, grace-window revocation, advisory-locked scheduler,
  manual rotate, and failure backoff.
- Scoped RBAC: one permission matrix for built-in roles, custom roles, and project/environment/
  path grants with optional expiry; secret writes check built-in permission plus active grants.
- Web UI: rotation policies can be created, paused, rotated, and deleted from the dashboard;
  status, next run, grace window, and last error are shown inline.
- Web UI: Access tab for custom roles and scoped grants (member, role, environment/path,
  optional expiry) with revoke.
- Web UI: sonner toasts replace transient inline notices, and destructive actions confirm
  through a shadcn alert dialog instead of `window.confirm`.
- Secret syncs: scheduled delivery to webhooks, Vercel, Cloudflare Workers, and GitHub Actions
  secrets with encrypted provider configs, per-run status, manual runs, and backoff.
- Additional sync providers: AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, and
  Kubernetes Secrets, plus a Syncs tab in the dashboard.
- Machine identity AWS auth: exchange a SigV4 `GetCallerIdentity` request for a token with an
  ARN allowlist, a five-minute window, and single-use signatures; add `/api/auth/token/universal`
  as an alias and a UI for managing JWT/AWS auth methods.

### Changed

- Secret fingerprints are now HMAC-SHA256 keyed with the project DEK instead of plain SHA-256;
  existing rows are marked `fingerprint_version = 1` and new rows use version 2.
- Machine tokens are validated against the identity row on every request, so revocation and
  policy changes take effect immediately.

## [0.1.1] - 2026-10-22

### Changed

- `@liostech/opensiel-sdk` and `@liostech/opensiel-cli` publish from tags with OIDC trusted
  publishing and provenance; no long-lived npm token is used.

[0.1.1]: https://github.com/ibrahimhnif/opensiel/releases/tag/v0.1.1

## [0.1.0] - 2026-10-21

### Added

- Projects, environments, folder paths, and secret CRUD with immutable versions and rollback.
- Per-environment approval workflows with N-of-M approvals for owners/admins.
- Team invites, roles (`owner`, `admin`, `member`, `viewer`), and last-owner protection.
- Machine identities with client credentials, 15-minute tokens, and environment scopes.
- `${KEY}` / `${/path/KEY}` references and cross-environment imports.
- Bulk import from `.env` or flat JSON, with dry-run preview.
- OIDC SSO (authorization code + PKCE) and SAML SSO (signed assertions).
- Secret scanning for stored values and common credential patterns.
- Dynamic PostgreSQL credentials with leases, revoke, and an expiry reaper.
- HMAC-signed webhooks with retries and delivery status.
- Master key rotation with versioned project DEKs and optional AWS KMS.
- Audit log for reads, writes, rollbacks, SSO logins, leases, and webhooks.
- `opensiel` CLI (`login`, `init`, `secrets`, `import`, `export`, `run`), published as
  `@liostech/opensiel-cli`, and the `@liostech/opensiel-sdk` client.
- Reusable GitHub Action (`uses: ibrahimhnif/opensiel@v0.1.0`) for CI secret injection.
- One-command Docker Compose installer and a Helm chart published as an OCI package.
- Docker Compose and Kubernetes deployment manifests.

[0.1.0]: https://github.com/ibrahimhnif/opensiel/releases/tag/v0.1.0
