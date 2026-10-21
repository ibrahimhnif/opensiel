# opensiel

Self-hosted secrets manager with the features other tools put behind a paywall:
secret versioning, point-in-time rollback, audit logs, and scoped machine
identities. MIT licensed, single service, Postgres-backed.

- **Web UI** — projects, environments, folders, secret editor, history, audit.
- **CLI** — `opensiel run --env dev -- npm run dev` injects secrets as env vars.
- **SDK** — `@opensiel/sdk` for Node 20+.
- **Versioning** — every write is an immutable version; rollback creates a new version.
- **Team management** — email invites (link shown once), roles `owner/admin/member/viewer`,
  owner-only escalation, and last-owner protection.
- **Approvals** — opt-in per environment: writes become change requests that need
  `requiredApprovals` approvals from owners/admins before they are applied.
- **References & imports** — `${KEY}` / `${/path/KEY}` resolution and cross-environment
  imports, resolved at read time.
- **Bulk import** — paste or upload a `.env` file (or JSON) instead of creating keys one by
  one; existing keys get a new version.
- **SSO (OIDC)** — authorization code + PKCE against any OIDC provider, with invite-based
  or automatic organization provisioning.
- **Machine identities** — client credentials, 15-minute tokens, environment scopes,
  `viewer` / `member` roles.
- **Audit** — all mutations and secret reads are recorded, values never included.

## Quickstart (Docker Compose)

```bash
cp .env.example .env
# put a real key in .env:
openssl rand -base64 32   # OPENSIEL_MASTER_KEY
openssl rand -hex 32      # OPENSIEL_JWT_SECRET

docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
open http://localhost:8787
```

The first signup becomes the instance owner. Set `OPENSIEL_ALLOW_SIGNUP=true` while
bootstrapping; turn it off afterwards.

## Local development

```bash
pnpm install
pnpm db:up                 # Postgres on localhost:55432
cp .env.example .env       # then set the two secrets
pnpm dev                   # API on :8787, UI on :5173 (proxied)
```

`pnpm typecheck`, `pnpm build`, `pnpm test`. Integration tests need a disposable
database: `TEST_DATABASE_URL=postgres://opensiel:opensiel@localhost:55432/opensiel_test pnpm test`.
The tests drop and recreate the `public` schema, so never point them at real data.

## CLI

```bash
export PATH="$PWD/apps/cli/dist:$PATH"   # or: pnpm --filter @opensiel/cli build

opensiel login --api-url http://localhost:8787
opensiel init --project default --env dev
opensiel secrets set DATABASE_URL=postgres://localhost/app
opensiel secrets import .env --env dev --dry-run
opensiel secrets import .env --env dev
cat .env.prod | opensiel secrets import - --env prod
opensiel secrets list --reveal
opensiel secrets versions DATABASE_URL
opensiel secrets rollback DATABASE_URL --version 1
opensiel export --format dotenv > .env.local
opensiel run --env dev -- npm run dev
```

Config lives in `~/.opensiel/config.json` (mode 0600); `.opensiel.json` in a repo
stores the project id and default environment (no secrets). For CI, exchange a machine
identity for a 15-minute token and pass it to any command:

```bash
TOKEN=$(curl -s -X POST "$OPENSIEL_API/api/auth/token" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\"}" | jq -r .accessToken)

OPENSIEL_TOKEN="$TOKEN" opensiel run --env prod -- node server.js
```

## SDK

```ts
import { OpensielClient } from "@opensiel/sdk";

const client = new OpensielClient({ apiUrl: "http://localhost:8787" });
await client.loginWithClientCredentials(clientId, clientSecret);

const { secrets } = await client.listSecrets(projectId, "dev");
console.log(secrets.find((secret) => secret.key === "DATABASE_URL")?.value);
```

## API

All routes are under `/api`. Authenticate with `Authorization: Bearer <token>` (session
token from `POST /api/auth/login`, or machine token from `POST /api/auth/token`).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | user sessions |
| GET | `/auth/me`, `/auth/config` | current user / bootstrap info |
| GET | `/auth/invite?token=` | public invite info |
| POST | `/auth/accept-invite` | join an org from an invite |
| GET | `/auth/oidc/start` | begin OIDC login (redirect) |
| GET | `/auth/oidc/callback` | OIDC callback |
| POST | `/auth/token` | client-credentials token (15 min) |
| GET | `/org` | organization + members |
| POST | `/org/invites` | create an invite (owner/admin) |
| GET/DELETE | `/org/invites[/:id]` | list / revoke pending invites |
| PATCH/DELETE | `/org/members/:userId` | change role / remove member |
| GET/POST | `/projects` | list / create projects |
| GET/PATCH/DELETE | `/projects/:id` | project detail / rename / delete |
| GET/POST | `/projects/:id/environments` | environments |
| GET/POST | `/projects/:id/secrets` | list (decrypted) / write new version |
| POST | `/projects/:id/secrets/import` | bulk import .env or JSON |
| GET/DELETE | `/projects/:id/secrets/:key` | read / soft-delete |
| GET | `/projects/:id/secrets/:key/versions` | version history |
| POST | `/projects/:id/secrets/:key/rollback` | roll back to a version |
| GET | `/projects/:id/change-requests?status=` | list change requests |
| POST | `/projects/:id/change-requests/:rid/approve\|reject\|cancel` | decide |
| PATCH | `/projects/:id/environments/:eid/policy` | require approvals / threshold |
| GET | `/projects/:id/environment-imports` | list import links |
| PUT | `/projects/:id/environments/:eid/imports` | set or clear an import source |
| GET | `/projects/:id/export?env=&format=dotenv\|json` | export |
| GET/POST | `/projects/:id/identities` | machine identities |
| POST | `/projects/:id/identities/:id/revoke` | revoke |
| GET | `/audit?projectId=` | audit trail |

## Approvals

An owner or admin enables approvals per environment in the **Approvals** tab (for example
`prod` with 2 approvals). From then on, `POST /secrets`, `DELETE /secrets/:key`, and
rollbacks in that environment return `202` with a change request instead of changing
anything.

- A request is applied only when it collects `requiredApprovals` approvals from distinct
  owners/admins.
- Requesters cannot approve their own request; a rejection closes it immediately.
- Pending requests can be cancelled by the requester or an admin.
- Proposed values are encrypted with the project data key before being stored, so pending
  changes get the same protection as saved secrets.

The CLI prints "submitted for approval (…)" instead of the usual confirmation.

## Secret references and imports

Values may reference other secrets in the same environment. References are resolved when
secrets are read or injected (`list`, `get`, `export`, `opensiel run`); stored values stay
unchanged.

- `${KEY}` — a key at the environment root
- `${/backend/KEY}` — a key inside a folder
- `\${KEY}` — a literal `${KEY}`

Missing references and cycles are left as written. Resolution happens after imports are
merged, so imported values can reference other secrets too.

An owner or admin can make one environment import another in the **Approvals** tab
(`PUT /projects/:id/environments/:eid/imports`). Values defined in the environment itself
win over imported ones, imported rows carry `importedFrom`, and machine identities only see
imports from environments they are scoped to.

## Bulk import

In the UI, **Import .env** accepts a pasted document or an uploaded file. The CLI does the
same with `opensiel secrets import <file>` (or `-` for stdin). Payloads are parsed as
dotenv (`#` comments, `export KEY=`, quoted values, escapes) or as a flat JSON object with
`format: "json"`.

- `dryRun: true` parses and returns the key list without writing.
- Existing keys get a new version; the response reports `created` / `updated` counts.
- Maximum 200 keys per import; values are encrypted individually and the audit log records
  counts and keys, never values.
- Importing into an environment that requires approvals returns `409`; create one secret at
  a time there so each change can be approved.

## SSO (OpenID Connect)

Set these on the instance and restart. When the three required values are present, the login
screen shows a "Continue with …" button.

| Variable | Purpose |
| --- | --- |
| `OPENSIEL_OIDC_ISSUER` | issuer URL, e.g. `https://accounts.google.com` |
| `OPENSIEL_OIDC_CLIENT_ID` | OAuth client id |
| `OPENSIEL_OIDC_CLIENT_SECRET` | OAuth client secret |
| `OPENSIEL_OIDC_REDIRECT_URI` | defaults to `<OPENSIEL_PUBLIC_URL>/api/auth/oidc/callback` |
| `OPENSIEL_OIDC_SCOPES` | defaults to `openid email profile` |
| `OPENSIEL_OIDC_ALLOWED_DOMAINS` | optional comma-separated email domains |
| `OPENSIEL_OIDC_AUTO_CREATE` | defaults to `true`; `false` means invited emails only |

The flow uses the authorization code grant with PKCE, state, and nonce. ID tokens are
verified against the provider JWKS with issuer and audience checks, and the email must be
present and not reported as unverified. On first login the user joins a matching pending
invite; otherwise a new organization is provisioned with them as owner (unless auto-create
is disabled). Existing accounts keep their organization.

Example for Google: add `https://your-host/api/auth/oidc/callback` as an authorized redirect
URI and use `https://accounts.google.com` as the issuer.

## Deployment (Kubernetes)

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/postgres.yaml
# create the real secrets (do not apply secret.example.yaml as-is)
kubectl -n opensiel create secret docker-registry ghcr-creds \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<token>
kubectl -n opensiel create secret generic opensiel-secrets \
  --from-literal=DATABASE_URL='postgres://opensiel:<pw>@postgres.opensiel.svc.cluster.local:5432/opensiel' \
  --from-literal=OPENSIEL_MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=OPENSIEL_JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OPENSIEL_PUBLIC_URL='https://opensiel.example.com' \
  --from-literal=OPENSIEL_ALLOW_SIGNUP='false'
kubectl apply -f deploy/k8s/app.yaml -f deploy/k8s/ingress.yaml
```

The image is published to `ghcr.io/ibrahimhnif/opensiel` by the CI workflow on `main`.

### Lab instance

The reference instance runs at **https://opensiel.liostech.id** (namespace `opensiel`, exposed
through the existing Cloudflare Tunnel). While the GHCR package is private, it uses
`deploy/k8s/app-sourcebuild.yaml`, which clones this repo inside the cluster with the
`opensiel-git` secret, builds it once into a 2Gi PVC, and then runs the server. Bump
`SOURCE_REV` in that manifest to force a rebuild on the next rollout; switch to `app.yaml`
once the package is public (or create a `ghcr-creds` image pull secret).

Invites do not send email (no SMTP in v0): the API returns the invite link once and the UI
shows it for you to copy.

After the first account is created, disable open signup:

```bash
kubectl -n opensiel patch secret opensiel-secrets --type merge \
  -p '{"stringData":{"OPENSIEL_ALLOW_SIGNUP":"false"}}'
kubectl -n opensiel rollout restart deploy/opensiel
```

## Security

See [SECURITY.md](./SECURITY.md). Short version: AES-256-GCM envelope encryption with a
per-project data key wrapped by `OPENSIEL_MASTER_KEY`, argon2id passwords, hashed
session/machine secrets, scoped short-lived machine tokens, and audit logs that never
contain values. No SAML, approvals outside the built-in workflow, dynamic secrets, PKI, or
KMS yet.

## Roadmap

v1: SAML SSO, dynamic database credentials, secret scanning, key rotation, webhook/CI
integrations.

## License

MIT.
