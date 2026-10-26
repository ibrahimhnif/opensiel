# Configuration

opensiel reads configuration from the environment (and from `.env` in development). Env
changes require a restart.

## Core

| Variable                | Default       | Description                                                                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | required      | PostgreSQL connection string.                                                                                     |
| `NODE_ENV`              | `development` | `development`, `production`, or `test`.                                                                           |
| `PORT`                  | `8787`        | HTTP port.                                                                                                        |
| `HOST`                  | `0.0.0.0`     | Bind address.                                                                                                     |
| `OPENSIEL_PUBLIC_URL`   | –             | Public base URL. Used for SSO callbacks and to decide whether session cookies are `Secure`. Set it in production. |
| `OPENSIEL_WEB_DIR`      | –             | Directory with the built web app. The Docker image uses `apps/web/dist`.                                          |
| `OPENSIEL_ALLOW_SIGNUP` | `false`       | Allow new signups after the first account. The first account is always allowed.                                   |
| `OPENSIEL_AUTO_MIGRATE` | `true`        | Run database migrations on startup.                                                                               |
| `OPENSIEL_RATE_LIMIT`   | `true`        | Enable in-process rate limits.                                                                                    |

## Keys and KMS

| Variable                           | Default     | Description                                      |
| ---------------------------------- | ----------- | ------------------------------------------------ |
| `OPENSIEL_MASTER_KEY`              | required\*  | 32 bytes, base64. Wraps each project's data key. |
| `OPENSIEL_MASTER_KEY_VERSION`      | `1`         | Version of the current master key.               |
| `OPENSIEL_MASTER_KEY_NEXT`         | –           | Next key for rotation.                           |
| `OPENSIEL_MASTER_KEY_NEXT_VERSION` | current + 1 | Version for the next key.                        |
| `OPENSIEL_KMS_KEY_ID`              | –           | AWS KMS key id/ARN.                              |
| `OPENSIEL_KMS_WRAPPED_MASTER_KEY`  | –           | Base64 ciphertext blob of the master key.        |
| `OPENSIEL_KMS_REGION`              | `us-east-1` | AWS region.                                      |
| `OPENSIEL_KMS_ENDPOINT`            | –           | Custom KMS endpoint (tests, VPC endpoints).      |
| `OPENSIEL_KMS_ACCESS_KEY_ID`       | –           | Optional explicit AWS access key.                |
| `OPENSIEL_KMS_SECRET_ACCESS_KEY`   | –           | Optional explicit AWS secret key.                |

\* not required when AWS KMS is configured.

```bash
openssl rand -base64 32          # OPENSIEL_MASTER_KEY
openssl rand -hex 32             # OPENSIEL_JWT_SECRET
openssl rand -out master.key 32  # source for AWS KMS
```

> Back up `OPENSIEL_MASTER_KEY` (or the KMS key) separately from the database. Without it,
> stored secrets cannot be decrypted. Changing it without rotating data keys bricks existing
> secrets.

### AWS KMS

```bash
WRAPPED=$(aws kms encrypt --key-id "$KEY_ID" --plaintext fileb://master.key \
  --query CiphertextBlob --output text)

OPENSIEL_KMS_KEY_ID="$KEY_ID"
OPENSIEL_KMS_WRAPPED_MASTER_KEY="$WRAPPED"
OPENSIEL_KMS_REGION="us-east-1"
```

The wrapped key is decrypted once at startup and kept in memory. IAM credentials come from the
standard AWS chain (environment, instance profile, IRSA) unless the explicit variables are set.

## Authentication

| Variable              | Default  | Description                                           |
| --------------------- | -------- | ----------------------------------------------------- |
| `OPENSIEL_JWT_SECRET` | required | 32+ characters. Signs machine tokens and SSO cookies. |

Sessions are httpOnly cookies with a 7-day expiry. Machine identities exchange client
credentials for a 15-minute token.

## OIDC

| Variable                        | Default                               | Description                                                                           |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `OPENSIEL_OIDC_ISSUER`          | –                                     | Issuer URL, e.g. `https://accounts.google.com`.                                       |
| `OPENSIEL_OIDC_CLIENT_ID`       | –                                     | OAuth client id.                                                                      |
| `OPENSIEL_OIDC_CLIENT_SECRET`   | –                                     | OAuth client secret.                                                                  |
| `OPENSIEL_OIDC_REDIRECT_URI`    | `<PUBLIC_URL>/api/auth/oidc/callback` | Registered redirect URI.                                                              |
| `OPENSIEL_OIDC_SCOPES`          | `openid email profile`                | Requested scopes.                                                                     |
| `OPENSIEL_OIDC_ALLOWED_DOMAINS` | –                                     | Comma-separated email domains.                                                        |
| `OPENSIEL_OIDC_AUTO_CREATE`     | `true`                                | Create an organization on first login. When `false`, only invited emails can sign in. |

The issuer, client id, and client secret must all be set to enable OIDC. Login uses the
authorization code grant with PKCE, state, and nonce.

## SAML

| Variable                        | Default                               | Description                                                |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `OPENSIEL_SAML_ENTRY_POINT`     | –                                     | IdP SSO URL.                                               |
| `OPENSIEL_SAML_IDP_CERT`        | –                                     | IdP signing certificate in PEM. `\n` escapes are accepted. |
| `OPENSIEL_SAML_ISSUER`          | `OPENSIEL_PUBLIC_URL`                 | SP entity id.                                              |
| `OPENSIEL_SAML_CALLBACK_URL`    | `<PUBLIC_URL>/api/auth/saml/callback` | Assertion Consumer Service URL.                            |
| `OPENSIEL_SAML_AUDIENCE`        | issuer                                | Expected audience.                                         |
| `OPENSIEL_SAML_ALLOWED_DOMAINS` | –                                     | Comma-separated email domains.                             |
| `OPENSIEL_SAML_AUTO_CREATE`     | `true`                                | Same behavior as OIDC.                                     |

Register the SP in the IdP with the ACS URL above and the issuer as entity id. Metadata is at
`GET /api/auth/saml/metadata`. Assertions must be signed.

With either SSO method: a matching pending invite is joined first; otherwise, if auto-create
is on, a new organization is created with the user as owner.

## Audit sink

Streams new `audit_logs` rows to an external system. One sink at a time; disabled by default.

| Variable                                | Default          | Description                                       |
| --------------------------------------- | ---------------- | ------------------------------------------------- |
| `OPENSIEL_AUDIT_SINK`                   | `off`            | `http`, `splunk`, `datadog`, or `s3`.             |
| `OPENSIEL_AUDIT_SINK_URL`               | –                | Destination URL for http/splunk/datadog.          |
| `OPENSIEL_AUDIT_SINK_TOKEN`             | –                | Bearer token, Splunk HEC token, or Datadog key.   |
| `OPENSIEL_AUDIT_SINK_INTERVAL_SECONDS`  | `60`             | Poll interval.                                    |
| `OPENSIEL_AUDIT_SINK_BATCH`             | `200`            | Rows per delivery.                                |
| `OPENSIEL_AUDIT_SINK_BUCKET`            | –                | S3 bucket (required for `s3`).                    |
| `OPENSIEL_AUDIT_SINK_PREFIX`            | `opensiel-audit` | S3 key prefix.                                    |
| `OPENSIEL_AUDIT_SINK_REGION`            | `us-east-1`      | S3 region.                                        |
| `OPENSIEL_AUDIT_SINK_ENDPOINT`          | –                | Custom S3 endpoint (S3-compatible stores).        |
| `OPENSIEL_AUDIT_SINK_ACCESS_KEY_ID`     | –                | Explicit AWS access key (else the default chain). |
| `OPENSIEL_AUDIT_SINK_SECRET_ACCESS_KEY` | –                | Explicit AWS secret key.                          |

The worker checkpoints on `audit_logs.seq`, so restarts and multiple replicas do not duplicate
rows. A failed delivery is retried with exponential backoff (capped at 15 minutes) and recorded
in `audit_sink_state`. Exports never include secret values.

Payloads:

- `http` → `{ "events": [...] }` with an optional bearer token.
- `splunk` → newline-delimited HEC events with `sourcetype: opensiel:audit` and
  `Authorization: Splunk <token>`.
- `datadog` → array of log objects with `ddsource`/`service` and a `dd-api-key` header.
- `s3` → NDJSON object per day at `<prefix>/<YYYY-MM-DD>/<first-event-id>.ndjson`.

## Rate limits

In-process limits (per instance):

| Endpoint                                   | Limit               |
| ------------------------------------------ | ------------------- |
| Global                                     | 300 requests/minute |
| `POST /api/auth/signup`, `/api/auth/login` | 10/minute           |
| `POST /api/auth/token`                     | 20/minute           |
| `POST /api/projects/:id/scan`              | 30/minute           |
| `POST /api/auth/saml/callback`             | 30/minute           |

Set `OPENSIEL_RATE_LIMIT=false` only for tests or trusted single-user instances.

## Example: local development

```dotenv
DATABASE_URL=postgres://opensiel:opensiel@localhost:55432/opensiel
OPENSIEL_MASTER_KEY=<openssl rand -base64 32>
OPENSIEL_JWT_SECRET=<openssl rand -hex 32>
OPENSIEL_PUBLIC_URL=http://localhost:8787
OPENSIEL_WEB_DIR=apps/web/dist
OPENSIEL_ALLOW_SIGNUP=true
PORT=8787
```

## Example: production (Docker or Kubernetes)

```dotenv
DATABASE_URL=postgres://opensiel:<password>@postgres:5432/opensiel
OPENSIEL_MASTER_KEY=<32-byte base64 key, or use KMS>
OPENSIEL_JWT_SECRET=<32+ random characters>
OPENSIEL_PUBLIC_URL=https://opensiel.example.com
OPENSIEL_ALLOW_SIGNUP=false
```

Use HTTPS in front of the app. The server trusts proxy headers (`X-Forwarded-*`), so terminate
TLS at your ingress, load balancer, or tunnel.

## Key rotation

1. Generate a new key and set `OPENSIEL_MASTER_KEY_NEXT` (plus an optional
   `OPENSIEL_MASTER_KEY_NEXT_VERSION`) and restart.
2. As an owner, open **Members → Encryption key** and click **rotate keys**, or call
   `POST /api/admin/rotate-key`.
3. Promote: set `OPENSIEL_MASTER_KEY` to the new key, `OPENSIEL_MASTER_KEY_VERSION` to the new
   version, remove the `_NEXT` variables, and restart.

Rotation rewraps project data keys; secret ciphertext is not re-encrypted. See
[Operations](operations.md#key-rotation).

## SSO checklist

- `OPENSIEL_PUBLIC_URL` matches the URL users open.
- OIDC redirect URI / SAML ACS URL exactly match the provider configuration.
- HTTPS is used in production (secure cookies).
- Test with `GET /api/status` / `/api/auth/config` to confirm the provider is enabled.
