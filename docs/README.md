# opensiel documentation

Guides for self-hosting, developing, and integrating opensiel. If you are new here, start with
[Getting started](getting-started.md).

## Guides

| Guide                                     | What it covers                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)     | Run opensiel with Docker Compose, create the owner account, invite the team, connect the CLI.       |
| [Local development](local-development.md) | Monorepo setup, dev servers, ports, tests, seeding, resetting the database.                         |
| [Configuration](configuration.md)         | Every environment variable, example `.env` files, OIDC/SAML, AWS KMS, key rotation.                 |
| [CLI](cli.md)                             | `opensiel login`, `init`, `secrets`, `import`, `export`, `run`, machine identities in CI.           |
| [SDK](sdk.md)                             | Node client: auth, list/get/set secrets, versions, rollback, export.                                |
| [Use cases](use-cases.md)                 | App env injection, CI/CD, Kubernetes workloads, dynamic credentials, approvals, scanning, webhooks. |
| [CI/CD](ci-cd.md)                         | GitHub Actions and GitLab CI recipes with machine identities and the export API.                    |
| [Kubernetes](kubernetes.md)               | Deploy manifests, ingress/TLS, secret injection into pods, upgrades, scaling.                       |
| [Operations](operations.md)               | Backups, restore, key rotation, KMS, leases, webhooks, monitoring.                                  |
| [Troubleshooting](troubleshooting.md)     | Common errors and how to diagnose them.                                                             |
| [FAQ](faq.md)                             | Licensing, limits, differences from other tools, roadmap.                                           |

## Reference

- [Architecture](architecture.md) — components, data model, crypto, auth flows, threat model.
- [Security policy](../SECURITY.md) — supported versions and private reporting.
- [Contributing](../CONTRIBUTING.md) — development workflow and code style.
- [Changelog](../CHANGELOG.md).

## Live demo

<https://opensiel.liostech.id> — `demo@opensiel.dev` / `demo-password-123` (read-only shared
account). The demo organization is isolated and cannot write secrets.
