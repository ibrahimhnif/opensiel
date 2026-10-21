# Troubleshooting

## The UI says "The API is unreachable"

- Check the server is running: `curl http://localhost:8787/api/health`.
- If you use `pnpm dev`, confirm the Vite proxy target matches the API port (`.env`'s `PORT`).
- In Kubernetes, check the Service/Ingress and the pod logs.

## Login loops or the session does not stick

- `OPENSIEL_PUBLIC_URL` is HTTPS but you access the app over HTTP (or the reverse). Cookies are
  `Secure` for HTTPS URLs. Use the same scheme as `OPENSIEL_PUBLIC_URL`.
- Accessing through a proxy: the server trusts `X-Forwarded-*`; make sure your proxy sets them.
- Private browsing or a cookie blocker may drop the session cookie.

## `401 unauthorized`

- User session expired (7 days) → log in again.
- Machine token expired (15 minutes) → exchange the client credentials again.
- Revoked identity → create a new one.
- Wrong `OPENSIEL_JWT_SECRET` after a restart invalidates machine tokens and SSO state.

## `403 forbidden`

- `role is read-only`: the user or identity is a `viewer`. Use a `member`/`admin`/`owner`.
- `identity is not scoped to this environment`: add the environment to the identity.
- `you cannot approve your own change request`: ask another owner/admin.
- `owner or admin role required`: project/env/identity management needs an admin.

## `404 not found` across organizations

Projects are scoped to an organization; another organization's project returns `404` instead
of `403` on purpose.

## Invites

- `invite not found`: the link was revoked, used, or the token is wrong.
- `invite expired`: invites last 7 days; create a new one.
- `this account already belongs to an organization`: one user belongs to one organization in
  v0; use a different email.
- The email in the invite cannot be changed; revoke and create a new invite.

## Approvals

- A write returned `202` and "submitted for approval": that is expected. The secret is not
  changed until the required approvals arrive.
- `this change request is no longer pending`: it was approved, rejected, or cancelled.
- `an organization must keep at least one owner`: promote another owner before demoting the
  last one.
- Importing into an approval-enabled environment returns `409`; create changes one at a time.

## Import, references, and scanning

- `line N: expected KEY=VALUE`: fix the dotenv line or use `format: "json"`.
- `no secrets found`: the file only contained comments/blank lines.
- `too many secrets`: the limit is 200 keys per import.
- A reference stays as `${KEY}`: the target key is missing, or the reference forms a cycle.
  References resolve after imports are merged.
- `409 approval_required` on import: expected for protected environments.
- Scan finds nothing: it only matches stored values and the built-in credential patterns.

## Dynamic credentials

- `502 the target database rejected the credential creation statement`: check the admin URL,
  network access, and that the admin role can `CREATEROLE` and grant the intended privileges.
- `502 ... revocation statement`: the role may have been dropped manually, or the statement is
  invalid. Revoke again after fixing it.
- `409 this lease is already revoked`: nothing to do.
- The password is returned once. If you lose it, revoke the lease and create a new one.
- Only PostgreSQL is supported.

## Webhooks

- `401` on your endpoint: verify the HMAC over the **raw** body with the signing secret. Do not
  re-serialize the JSON before checking.
- Deliveries failing: the UI shows the last HTTP status/error. Check that the endpoint is
  reachable from the cluster (not `localhost` of your laptop).
- Deliveries are retried three times with a 5-second timeout, then the failure count increases.
- The signing secret is shown once; recreate the webhook if it is lost.

## OIDC

- `could not reach the OIDC provider`: the server cannot reach the issuer; check DNS/egress.
- `OIDC discovery failed`: the issuer URL must serve `/.well-known/openid-configuration`.
- `state mismatch` / `SSO session expired`: the login took too long or cookies were blocked.
- `nonce mismatch`: the provider did not return the nonce; check the client configuration.
- `email domain '…' is not allowed`: update `OPENSIEL_OIDC_ALLOWED_DOMAINS`.
- `no account or invite exists`: with auto-create off, invite the email first.
- Redirect URI mismatch: use exactly `<OPENSIEL_PUBLIC_URL>/api/auth/oidc/callback` at the
  provider.

## SAML

- `SAML login failed: Invalid signature`: the `OPENSIEL_SAML_IDP_CERT` does not match the
  signing certificate, or the assertion is not signed.
- `Invalid audience`: `OPENSIEL_SAML_AUDIENCE` (default: issuer) must match the assertion.
- `Invalid recipient`: the ACS URL configured in the IdP must match
  `OPENSIEL_SAML_CALLBACK_URL`.
- `NotBefore/NotOnOrAfter` errors: clock skew; sync the server clock (5 minutes is tolerated).
- Metadata: `GET /api/auth/saml/metadata`; use it to configure the IdP.
- Email comes from `email`, `mail`, or `NameID`; name from `name`, `displayName`, or `cn`.

## Keys and KMS

- `master key version N is not configured`: the project uses a key version not present in the
  environment. Restore the old key or finish rotation.
- `could not verify / decrypt`: the master key does not match the wrapped data keys. Restore the
  correct key; do not rotate by replacing the env var without the rotation flow.
- AWS KMS errors: check the key id/region, IAM permissions (`kms:Decrypt`), and that the
  plaintext is 32 bytes.
- Back up the master key. Losing it is not recoverable.

## Database and migrations

- `ECONNREFUSED` on startup: the database is not running or `DATABASE_URL` is wrong. With the
  Compose dev database use port `55432`.
- Migration errors: the database user needs DDL permissions. Check `_migrations` and the server
  logs; restore from a backup if a migration failed midway.
- Integration tests drop the `public` schema. Never point `TEST_DATABASE_URL` at real data.

## Ports

| Port  | Used by        | Conflict fix                                    |
| ----- | -------------- | ----------------------------------------------- |
| 8787  | API            | set `PORT` in `.env`; the Vite proxy follows it |
| 5173  | Vite           | Vite picks 5174+ automatically                  |
| 55432 | dev PostgreSQL | change the compose mapping and `DATABASE_URL`   |

## Reset a local instance

```bash
pnpm db:down
docker volume rm deploy_opensiel-db
pnpm db:up
pnpm dev
```

If you changed the Compose project name, the volume name differs.
