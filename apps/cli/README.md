# @liostech/opensiel-cli

Command-line client for [opensiel](https://github.com/ibrahimhnif/opensiel): log in, inject
secrets into commands, import and export environments.

Requires Node.js 20+.

## Install

```bash
npm install -g @liostech/opensiel-cli
opensiel --version
```

Or run it without a global install:

```bash
npx @liostech/opensiel-cli --help
```

## Quick start

```bash
opensiel login --api-url https://opensiel.example.com
opensiel init --project web-app --env dev
opensiel secrets list --reveal
opensiel run --env dev -- npm run dev
```

`init` writes `.opensiel.json` with the project ID and default environment; it contains no
secrets. The session token is stored in `~/.opensiel/config.json` with mode `0600`.

## Commands

| Command                          | Description                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `login`                          | Log in with email/password, or store a machine token (`--token`). |
| `logout`                         | Remove the stored token.                                          |
| `whoami`                         | Show the current user, role, and API URL.                         |
| `init`                           | Link the current directory to a project and environment.          |
| `secrets list`                   | List secrets; add `--reveal` for values.                          |
| `secrets get` / `set` / `delete` | Read, write, or delete a secret.                                  |
| `secrets versions` / `rollback`  | Inspect history or roll back.                                     |
| `secrets import`                 | Import a `.env` file or stdin; `--dry-run` previews.              |
| `export`                         | Print an environment as `dotenv` or `json`.                       |
| `run`                            | Execute a command with root-folder secrets in its environment.    |

Writes to environments with approvals return a change request instead of applying immediately.

## CI and machine identities

Create a machine identity scoped to the environment, then:

```bash
TOKEN=$(curl -fsS -X POST "$OPENSIEL_API/api/auth/token" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\"}" \
  | jq -r .accessToken)

OPENSIEL_TOKEN="$TOKEN" opensiel run --projectId <uuid> --env prod -- ./deploy.sh
```

For GitHub Actions, use the repository action instead:
`uses: ibrahimhnif/opensiel@v0.1.0`.

## Links

- [CLI guide](https://opensiel.liostech.id/docs/cli)
- [Documentation](https://opensiel.liostech.id/docs/)
- [Issues](https://github.com/ibrahimhnif/opensiel/issues)
- [License](https://github.com/ibrahimhnif/opensiel/blob/main/LICENSE) (MIT)
