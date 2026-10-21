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
- **SSO (OIDC + SAML)** — authorization code + PKCE for OIDC and signed assertions for SAML,
  with invite-based or automatic organization provisioning.
- **External KMS** — wrap the master key with AWS KMS and decrypt it once at startup.
- **Secret scanning** — check pasted text or files for project secrets and common credential
  patterns; every UI surface is built with Tailwind CSS v4 and shadcn-style components.
- **Dynamic database credentials** — issue short-lived PostgreSQL roles with a TTL, revoke
  them manually, and let the background sweep drop expired roles.
- **Master key rotation** — rewrap every project data key to a new KEK without re-encrypting
  secrets.
- **Webhooks** — signed event deliveries for secret and approval changes, with retries and
  delivery status.
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
| GET | `/auth/saml/metadata` | service-provider metadata |
| GET | `/auth/saml/start` | begin SAML login (redirect) |
| POST | `/auth/saml/callback` | SAML assertion consumer |
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
| POST | `/projects/:id/scan` | scan text for leaked secrets |
| GET/POST | `/projects/:id/dynamic-secrets` | list / create dynamic DB configs |
| DELETE | `/projects/:id/dynamic-secrets/:configId` | delete a config |
| GET | `/projects/:id/dynamic-secrets/leases` | list leases |
| POST | `/projects/:id/dynamic-secrets/:configId/leases` | issue credentials |
| POST | `/projects/:id/dynamic-secrets/leases/:leaseId/revoke` | revoke a lease |
| GET | `/admin/key` | key version status |
| POST | `/admin/rotate-key` | rewrap project DEKs to the next key |
| GET/POST | `/projects/:id/webhooks` | list / create webhooks |
| PATCH/DELETE | `/projects/:id/webhooks/:webhookId` | toggle / delete |
| POST | `/projects/:id/webhooks/:webhookId/test` | send a test delivery |
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

## SSO (OIDC and SAML)

### OIDC

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

### SAML

| Variable | Purpose |
| --- | --- |
| `OPENSIEL_SAML_ENTRY_POINT` | IdP SSO URL (HTTP-Redirect/POST entry point) |
| `OPENSIEL_SAML_IDP_CERT` | IdP signing certificate (PEM, `\n` escapes allowed) |
| `OPENSIEL_SAML_ISSUER` | SP entity id; defaults to `OPENSIEL_PUBLIC_URL` |
| `OPENSIEL_SAML_CALLBACK_URL` | defaults to `<PUBLIC_URL>/api/auth/saml/callback` |
| `OPENSIEL_SAML_AUDIENCE` | expected audience; defaults to the issuer |
| `OPENSIEL_SAML_ALLOWED_DOMAINS` | optional comma-separated email domains |
| `OPENSIEL_SAML_AUTO_CREATE` | defaults to `true`; `false` means invited emails only |

Create the service provider in the IdP with the ACS URL above and the entity id as issuer
(`GET /api/auth/saml/metadata` returns the metadata XML). Assertions must be signed; the email
comes from the `email`, `mail`, or `NameID` attribute and the name from `name`, `displayName`,
or `cn`. Provisioning matches OIDC: a pending invite is joined first, otherwise a new
organization is created unless auto-create is off.

## External KMS

Instead of keeping the master key in an environment variable, wrap it with AWS KMS and let the
server decrypt it once at startup:

```bash
openssl rand -out master.key 32
WRAPPED=$(aws kms encrypt --key-id "$KEY_ID" --plaintext fileb://master.key \
  --query CiphertextBlob --output text)
```

Set `OPENSIEL_KMS_KEY_ID`, `OPENSIEL_KMS_WRAPPED_MASTER_KEY=$WRAPPED`, and
`OPENSIEL_KMS_REGION` (optional `OPENSIEL_KMS_ENDPOINT`, or explicit
`OPENSIEL_KMS_ACCESS_KEY_ID` / `OPENSIEL_KMS_SECRET_ACCESS_KEY`). When KMS is configured,
`OPENSIEL_MASTER_KEY` is not required; the plaintext key only exists in memory. IAM credentials
can also come from the standard AWS environment, instance profile, or IRSA. Rotation still
uses `OPENSIEL_MASTER_KEY_NEXT`: wrap the new key with KMS and update the variables after
rewrapping projects.

## Secret scanning

The **Scan** tab checks pasted text or an uploaded file for:

- values that match secrets stored anywhere in the project (reported by key, environment,
  path, and line),
- common credential patterns: AWS access keys, GitHub/Slack/Stripe/Google tokens, private
  key headers, and JWTs.

Matches are masked in the response, and neither the submitted text nor the secret values are
stored or written to the audit log. Scans run as a user session (machine identities cannot
scan), cover every environment in the project, and resolve imports and references first.

## Dynamic database credentials

An owner or admin configures a PostgreSQL admin connection string per project (the password
in that URL needs `CREATEROLE`). Creating a lease:

- generates an `opensiel_<random>` role with a random password and a `VALID UNTIL` expiry,
- runs the configurable creation statement (placeholders `{{username}}`, `{{password}}`,
  `{{expires}}`; defaults to `CREATE ROLE … WITH LOGIN …`),
- returns the credentials once and records the lease with the configured TTL,
- drops the role when the lease is revoked; a background sweep revokes expired leases every
  minute using the configured revocation statement (default `DROP ROLE IF EXISTS …`).

The admin connection string is encrypted with the project data key and never returned by the
API. Deleting a configuration does not drop roles created by its earlier leases. Only
PostgreSQL is supported in v0.

## Master key rotation

Secrets are encrypted with per-project data keys; only those keys are wrapped by the master
key. Rotation therefore rewraps DEKs and leaves secret ciphertext untouched.

1. Generate a new key: `openssl rand -base64 32`.
2. Set `OPENSIEL_MASTER_KEY_NEXT` to it (optionally `OPENSIEL_MASTER_KEY_NEXT_VERSION`, which
   defaults to the current version + 1) and restart the server.
3. Owners open **Members → Encryption key** and click *rotate keys*, or call
   `POST /api/admin/rotate-key`. Every project moves to the new key version.
4. Promote the new key: set `OPENSIEL_MASTER_KEY` to the next key,
   `OPENSIEL_MASTER_KEY_VERSION` to the new version, remove the `_NEXT` variables, and
   restart.

Keep the old key until step 4 finishes; projects on an unknown version fail to decrypt with
`missing_key_version`. New projects always use the current `OPENSIEL_MASTER_KEY_VERSION`.

## Webhooks

Owners and admins can register HTTPS endpoints (the **Webhooks** tab) for project events:

`secret.created`, `secret.updated`, `secret.deleted`, `secret.rollback`, `secret.import`,
`change_request.created`, `change_request.approved`, `change_request.rejected`.

Each delivery is a JSON `POST` with:

- `x-opensiel-event` — event name,
- `x-opensiel-delivery` — unique delivery id,
- `x-opensiel-signature` — `sha256=<hex>` HMAC-SHA256 of the raw body using the signing
  secret shown once at creation.

Payloads contain the actor and resource metadata (key, path, environment, version, change
request id) but **never** secret values. Deliveries time out after 5 seconds and retry up to
three times; the last status, error, and consecutive failure count are stored and shown in
the UI. The test button sends a `webhook.test` delivery.

```js
const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
if (!timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-opensiel-signature"]))) {
  return res.status(401).end();
}
```

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

v1: MFA, PKI/SSH certificate issuance, SCIM, and provider plugins.

## License

MIT.
