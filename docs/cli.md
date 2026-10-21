# CLI

The `opensiel` CLI fetches secrets and injects them into a child process. It is part of this
repository and is not published to npm.

## Install

```bash
pnpm install
pnpm --filter @opensiel/cli build
export PATH="$PWD/apps/cli/dist:$PATH"

opensiel --version
```

You can also symlink `apps/cli/dist/index.js` into `~/.local/bin/opensiel`.

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
opensiel secrets rollback DATABASE_URL --version 1 --env dev
opensiel secrets delete OLD_KEY --env dev
```

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

## Other commands

```bash
opensiel whoami     # current user, role, organization, API URL
opensiel logout     # remove the stored token
```

## Exit codes

`run` exits with the child's exit code (1 if the child is killed by a signal). Other commands
exit non-zero with a message on stderr.
