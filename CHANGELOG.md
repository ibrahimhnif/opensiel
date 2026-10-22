# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- `opensiel` CLI (`login`, `init`, `secrets`, `import`, `export`, `run`) and `@liostech/opensiel-sdk`.
- Docker Compose and Kubernetes deployment manifests.

[0.1.0]: https://github.com/ibrahimhnif/opensiel/releases/tag/v0.1.0
