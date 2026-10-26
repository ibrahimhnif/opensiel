# Use cases

Recipes for common ways to use opensiel. Every recipe assumes you have an instance running and
a project with at least one environment.

## Inject secrets into a local app

```bash
opensiel init --project web-app --env dev
opensiel run --env dev -- npm run dev
```

The command fetches root-folder secrets and adds them to the child process environment. Use
`.opensiel.json` to commit the project id and default environment (no secrets are stored).

If you prefer a file:

```bash
opensiel export --env dev --format dotenv > .env.local
```

## CI/CD pipelines

Create a machine identity scoped to the environment the pipeline needs, store its client id
and secret in your CI secret store, then exchange them for a 15-minute token. See
[CI/CD](ci-cd.md) for GitHub Actions and GitLab examples.

## Kubernetes workloads

Use an init container to fetch a dotenv file at pod startup, or call the SDK from your app.
See [Kubernetes](kubernetes.md#injecting-secrets-into-pods).

## Short-lived database credentials

Instead of storing a long-lived database password, configure a dynamic secret and request a
lease per job or per pod.

1. **Dynamic → new configuration**: admin PostgreSQL URL plus creation/revocation templates.
2. Request a lease:

```bash
curl -s -X POST "$API/api/projects/$PROJECT/dynamic-secrets/$CONFIG/leases" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "username": "opensiel_ab12cd34ef56",
  "password": "…",
  "host": "db.internal",
  "database": "app",
  "lease": { "id": "…", "expiresAt": "…", "status": "active" }
}
```

3. Connect with those credentials. Revoke when done, or let the one-minute reaper drop the
   role at expiry.

Only PostgreSQL is supported in v0. The admin role needs `CREATEROLE` (and grants if your
creation statement assigns them).

## Require approvals for production

1. **Approvals → Environments → policies**: enable approvals for `prod` and choose how many
   approvals are needed.
2. A write to `prod` becomes a change request; the secret is not changed yet.
3. A different owner/admin approves. Once the threshold is reached, the change is applied and
   audited.

Requesters cannot approve their own changes. The CLI prints "submitted for approval" for these
writes.

## Share values between environments

- **References**: store `DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@host/db`.
  `${KEY}` resolves in the same environment, `${/backend/KEY}` in a folder.
- **Imports**: in **Approvals → Environment imports**, make `staging` import `dev`. Values
  defined in `staging` still win; imported rows are labelled in the UI.

Machine identities only resolve imports from environments in their scope.

## Check a log or file for leaked secrets

Open **Scan**, paste the text or upload a file. The scan reports:

- values matching secrets stored anywhere in the project (key, environment, path, line),
- common credential patterns (AWS, GitHub, Slack, Stripe, Google, private keys, JWTs).

Findings are masked. The submitted text is never stored or written to the audit log.

## Notify other systems

Create a webhook for `secret.created`, `change_request.approved`, and friends. Deliveries are
signed with HMAC-SHA256:

```js
const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
if (!timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-opensiel-signature"]))) {
  return res.status(401).end();
}
```

Payloads contain actor and resource metadata, never secret values.

## Sign in with your identity provider

Configure OIDC or SAML (see [Configuration](configuration.md#oidc)). On first login, a
matching invite is joined; otherwise a new organization is created (unless auto-create is
disabled). Existing accounts keep their organization.

## Audit access

Every mutation, secret read, rollback, SSO login, lease, and webhook operation is recorded in
**Audit**. Metadata includes key names and paths, never values. Filter by project and page
through the log in the UI; the API returns up to 100 entries per request with a cursor.
