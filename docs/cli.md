# CLI

The `opensiel` CLI fetches secrets and injects them into a child process. It is published as
`@liostech/opensiel-cli`.

## Install

```bash
npm install -g @liostech/opensiel-cli
opensiel --version
```

Without a global install:

```bash
npx @liostech/opensiel-cli --help
```

To work on the CLI from this repository:

```bash
pnpm install
pnpm --filter @liostech/opensiel-cli build
export PATH="$PWD/apps/cli/dist:$PATH"
```

## Configuration files

| File                       | Contents                                  | Permissions         |
| -------------------------- | ----------------------------------------- | ------------------- |
| `~/.opensiel/config.json`  | API URL and session/machine token         | created with `0600` |
| `.opensiel.json` (project) | `projectId` and default `env`, no secrets | safe to commit      |

Resolution order for the token: `--token` → `OPENSIEL_TOKEN` → config file.
The API URL can be set with `--api-url` or by logging in to an instance.

## Login

```bash
opensiel login --api-url https://opensiel.example.com
# prompts for email and password, or:
opensiel login --api-url https://opensiel.example.com --email you@example.com --password '...'

# store a machine token instead (a JWT; valid for 15 minutes)
opensiel login --api-url https://opensiel.example.com --token "$TOKEN"
```

`opensiel login` stores a session token in the config file. For automation, prefer machine
identities (see below).

If TOTP is enabled on the account, login prompts for a 6-digit code (or a recovery code)
before storing the token. Accounts in an organization with a required MFA policy must enroll
in the web UI first.

## Link a project

```bash
opensiel init                    # interactive org/project picker
opensiel init --project web-app --env dev
```

`init` writes `.opensiel.json` in the current directory.

## Secrets

```bash
opensiel secrets list --env dev
opensiel secrets list --env dev --reveal
opensiel secrets get DATABASE_URL --env dev
opensiel secrets set DATABASE_URL=postgres://localhost/app --env dev
opensiel secrets set FEATURE_FLAG=on --env dev --comment "enable checkout"

opensiel secrets versions DATABASE_URL --env dev
opensiel secrets diff DATABASE_URL --from 2 --to 4 --env dev --reveal
opensiel secrets rollback DATABASE_URL --version 1 --env dev
opensiel secrets delete OLD_KEY --env dev
```

### Version diff and point-in-time restore

```bash
# compare two versions (values are masked unless --reveal is passed)
opensiel secrets diff DATABASE_URL --from 1 --to 3 --env dev

# preview the environment as it was at a timestamp
opensiel secrets restore --at 2026-10-22T10:00:00Z --env prod

# apply it: creates a new version for every changed key, revives deleted keys,
# and deletes keys that did not exist yet at that time
opensiel secrets restore --at 2026-10-22T10:00:00Z --env prod --apply
```

Restores are additive: history is never rewritten. The command is a dry run unless `--apply`
is passed, and only owners/admins can apply a restore. Environments with approvals enabled
refuse bulk restores — restore secrets one at a time there.

Values may use references (`${OTHER_KEY}`). Folder paths are supported with `--path /backend`;
`secrets list` shows the path in the key column.

If an environment requires approvals, `set`/`delete`/`rollback` print a "submitted for
approval" message and return without changing the secret until an owner/admin approves.

## Import and export

```bash
opensiel secrets import .env --env dev --dry-run
opensiel secrets import .env --env dev
cat .env.prod | opensiel secrets import - --env prod
opensiel export --env prod --format dotenv > .env.production
opensiel export --env dev --format json
```

Imports accept dotenv (comments, `export KEY=`, quoted values) and up to 200 keys. Existing
keys get a new version. Importing into an approval-required environment is refused; create
changes one at a time there.

`export` only includes root-folder secrets.

## Encryption with transit keys

Encrypt application data without managing keys yourself. The plaintext is read from stdin by
default, so it does not land in shell history:

```bash
echo -n "card=4111" | opensiel crypto encrypt --context user:42
opensiel crypto decrypt 'osl1.default.1.…' --context user:42

opensiel crypto keys list
opensiel crypto keys create billing
opensiel crypto keys rotate billing
```

The context is bound to the ciphertext; decrypting with a different context fails with
`decrypt_failed`. Named keys default to `default` and are created on first use.
`keys create` and `keys rotate` require an owner or admin.

## Run a command with secrets

```bash
opensiel run --env dev -- npm run dev
opensiel run --env dev -- node scripts/migrate.js
```

- Secrets from the environment root are injected as environment variables on top of
  `process.env`.
- The child's exit code is propagated; `SIGINT`/`SIGTERM` are forwarded.
- Folder secrets are not injected (environment variables have no path).
- Use `--env` (or the `.opensiel.json` default) to choose the environment.

## Machine identities

Create an identity in the UI (**Identities → New identity**), scoped to the environments it
needs. Exchange the client credentials for a short-lived token:

```bash
TOKEN=$(curl -s -X POST "$OPENSIEL_API/api/auth/token" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\"}" \
  | jq -r .accessToken)

OPENSIEL_TOKEN="$TOKEN" opensiel run --projectId <uuid> --env prod -- node server.js
```

Machine tokens expire after 15 minutes; request a new one in each job.

### JWT auth (Kubernetes, CI OIDC)

If the identity has a trusted-JWT auth method configured, exchange a workload token (for
example a projected Kubernetes service-account token) instead of a client secret:

```bash
TOKEN=$(curl -s -X POST "$OPENSIEL_API/api/auth/token/jwt" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"jwt\":\"$WORKLOAD_JWT\"}" \
  | jq -r .accessToken)

OPENSIEL_TOKEN="$TOKEN" opensiel run --env prod -- node server.js
```

The token must be issued by the configured issuer for the configured audience and, when an
allowlist is set, match an allowed subject. See
[Kubernetes → workload identity](kubernetes.md#workload-identity-with-service-account-tokens).

## Other commands

```bash
opensiel whoami     # current user, role, organization, API URL
opensiel logout     # remove the stored token
```

## Exit codes

`run` exits with the child's exit code (1 if the child is killed by a signal). Other commands
exit non-zero with a message on stderr.
