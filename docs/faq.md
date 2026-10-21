# FAQ

### Is opensiel free?

Yes. The core is MIT licensed. There is no paid tier, license server, or feature flag. Every
feature in the repository is available to everyone.

### How is it different from Infisical or Vault?

- Compared to Infisical: the same project/environment/folder model, approvals, versioning, and
  SSO, but implemented as one MIT service with no enterprise gate.
- Compared to Vault/OpenBao: opensiel is a UI-first application backed by PostgreSQL, not a
  path/token/policy engine. It does not have Vault's plugin ecosystem or transit engine. If you
  need Vault compatibility, use OpenBao.

### Can I have more than three environments?

Yes. New projects start with `dev`, `staging`, and `prod`; add `qa`, `uat`, or anything else in
**Approvals → Environments**. There is no environment limit.

### Can a user belong to multiple organizations?

Not in v0. A user belongs to one organization. SSO provisioning joins a pending invite or
creates a new organization; accepting an invite for an account that already has an organization
returns `409`.

### What are the limits?

| Item                  | Limit                        |
| --------------------- | ---------------------------- |
| Secret value          | 100,000 characters           |
| Secret path           | 200 characters               |
| Bulk import           | 200 keys, 256,000 characters |
| Scan input            | 256,000 characters           |
| SAML/OIDC auto-create | enabled by default           |
| Machine token         | 15 minutes                   |
| Session               | 7 days                       |
| Invite                | 7 days                       |
| Dynamic lease TTL     | 60 seconds – 24 hours        |
| Webhook attempts      | 3, 5-second timeout          |

### Is data encrypted end to end?

No. Secrets are encrypted at rest with AES-256-GCM envelope encryption; the server decrypts
values to serve authorized clients over TLS. The database alone does not reveal secrets, but
someone with the master key and database can.

### Can I use AWS KMS?

Yes. Set `OPENSIEL_KMS_KEY_ID` and `OPENSIEL_KMS_WRAPPED_MASTER_KEY`; the master key is
decrypted once at startup instead of living in an environment variable. IAM can come from the
standard AWS chain.

### Does it support SSO?

OIDC (authorization code + PKCE) and SAML (signed assertions). First login joins a pending
invite or creates an organization, depending on auto-create.

### Is there high availability?

The API is stateless and can run multiple replicas. The bundled PostgreSQL is a single
instance; for production use managed PostgreSQL. Rate limits are enforced per process, so each
replica has its own budget. Back up the database and master key.

### How do I back up?

`pg_dump` the database and store it separately from `OPENSIEL_MASTER_KEY`. Without the key, the
backup cannot be decrypted. See [Operations](operations.md#backups).

### Is there a Kubernetes operator or Helm chart?

Not yet. The repository ships Kubernetes manifests; secret injection into pods uses an init
container with the CLI or the SDK. See [Kubernetes](kubernetes.md).

### Can I run it in production?

It is a small, tested single-service deployment. Before exposing it: use HTTPS, close open
signup, back up the master key and database, create scoped machine identities, and review the
limitations in [SECURITY.md](../SECURITY.md).

### What about the demo account?

<https://opensiel.liostech.id> uses a shared, read-only account:
`demo@opensiel.dev` / `demo-password-123`. It is isolated in its own organization and cannot
write secrets.

### Why does the UI sometimes show a loading screen?

The app waits for the session check and project list before rendering. Refreshing `/app` keeps
the selected project and environment in the URL (`?project=…&env=…`).

### What is on the roadmap?

MFA, PKI/SSH certificate issuance, SCIM, and provider plugins. See the
[changelog](../CHANGELOG.md) for what shipped.

### How can I contribute?

Read [CONTRIBUTING.md](../CONTRIBUTING.md). Bug reports and feature requests use the GitHub
templates; security issues go through a private advisory.
