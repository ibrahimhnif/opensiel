# CI/CD

The recommended pattern is one machine identity per pipeline, scoped to the environments it
needs.

## 1. Create a machine identity

In the UI: **Identities → New identity**.

- Name: `github-actions-web`, `gitlab-deploy`, …
- Role: `viewer` to read secrets, `member` to write them.
- Environments: only the ones the pipeline uses (for example `prod`).

Copy the **client id** and **client secret**; the secret is shown once.

## 2. Store credentials

Store `OPENSIEL_CLIENT_ID` and `OPENSIEL_CLIENT_SECRET` as masked CI variables, plus
`OPENSIEL_API` (for example `https://opensiel.example.com`) and `OPENSIEL_PROJECT_ID`.

Never commit the client secret or the master key.

## 3. Fetch secrets in the job

The dependency-free approach uses the export API:

```bash
TOKEN=$(curl -fsS -X POST "$OPENSIEL_API/api/auth/token" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$OPENSIEL_CLIENT_ID\",\"clientSecret\":\"$OPENSIEL_CLIENT_SECRET\"}" \
  | jq -r .accessToken)

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$OPENSIEL_API/api/projects/$OPENSIEL_PROJECT_ID/export?env=prod&format=dotenv" \
  > .env.ci

set -a
. ./.env.ci
set +a

# $DATABASE_URL etc. are now available for the rest of the job
```

`export` includes root-folder secrets only. Tokens expire after 15 minutes; request another
one for long jobs.

## Reusable GitHub Action

The repository ships a composite action, so a workflow does not need curl or the CLI:

```yaml
- uses: ibrahimhnif/opensiel@v0.1.0
  with:
    api-url: https://opensiel.example.com
    project: web-app
    env: prod
    client-id: ${{ secrets.OPENSIEL_CLIENT_ID }}
    client-secret: ${{ secrets.OPENSIEL_CLIENT_SECRET }}
```

The action resolves the project (ID or slug), fetches the environment, masks values in the log,
and exports every root-folder secret to `GITHUB_ENV` for subsequent steps.

To run a command with the secrets directly:

```yaml
- uses: ibrahimhnif/opensiel@v0.1.0
  with:
    api-url: https://opensiel.example.com
    project: web-app
    env: prod
    client-id: ${{ secrets.OPENSIEL_CLIENT_ID }}
    client-secret: ${{ secrets.OPENSIEL_CLIENT_SECRET }}
    command: npm run deploy
```

### Inputs

| Input           | Required | Default | Description                                         |
| --------------- | -------- | ------- | --------------------------------------------------- |
| `api-url`       | yes      | –       | Instance base URL.                                  |
| `project`       | yes      | –       | Project ID or slug.                                 |
| `env`           | yes      | –       | Environment slug (`dev`, `prod`, …).                |
| `client-id`     | *        | –       | Machine identity client ID.                         |
| `client-secret` | *        | –       | Machine identity client secret.                     |
| `token`         | *        | –       | Existing token; skips the credentials exchange.     |
| `output-file`   | no       | `""`    | Optional dotenv path, e.g. `.env.opensiel`.         |
| `export-env`    | no       | `true`  | Export to `GITHUB_ENV`.                             |
| `mask`          | no       | `true`  | Mask values in the workflow log.                    |
| `command`       | no       | `""`    | Command to run with the secrets in its environment. |

\* provide `token`, or both `client-id` and `client-secret`.

### Outputs

| Output         | Description                       |
| -------------- | --------------------------------- |
| `env-file`     | Absolute path of the dotenv file. |
| `project-id`   | Resolved project UUID.            |
| `secret-count` | Number of exported secrets.       |

Notes:

- Pin a release tag (`@v0.1.0`), not `@main`. The repository must be public for `uses:`.
- The runner needs Node.js 20+; GitHub-hosted runners include it.
- Use a `viewer` machine identity scoped to the environment the job needs.
- The action exports root-folder secrets only. If you set `output-file`, add it to `.gitignore`
  and never upload it as an artifact.

## GitHub Actions (manual)

```yaml
name: deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      OPENSIEL_API: ${{ vars.OPENSIEL_API }}
      OPENSIEL_PROJECT_ID: ${{ vars.OPENSIEL_PROJECT_ID }}
      OPENSIEL_CLIENT_ID: ${{ secrets.OPENSIEL_CLIENT_ID }}
      OPENSIEL_CLIENT_SECRET: ${{ secrets.OPENSIEL_CLIENT_SECRET }}
    steps:
      - uses: actions/checkout@v4

      - name: Load secrets
        run: |
          TOKEN=$(curl -fsS -X POST "$OPENSIEL_API/api/auth/token" \
            -H 'content-type: application/json' \
            -d "{\"clientId\":\"$OPENSIEL_CLIENT_ID\",\"clientSecret\":\"$OPENSIEL_CLIENT_SECRET\"}" \
            | jq -r .accessToken)
          curl -fsS -H "Authorization: Bearer $TOKEN" \
            "$OPENSIEL_API/api/projects/$OPENSIEL_PROJECT_ID/export?env=prod&format=dotenv" \
            > .env
          set -a; . ./.env; set +a

      - name: Deploy
        run: ./deploy.sh
```

To use the CLI instead:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm install -g @liostech/opensiel-cli
- name: Run with secrets
  run: |
    TOKEN=$(curl -fsS -X POST "$OPENSIEL_API/api/auth/token" ... | jq -r .accessToken)
    OPENSIEL_TOKEN="$TOKEN" \
      opensiel --api-url "$OPENSIEL_API" \
      run --projectId "$OPENSIEL_PROJECT_ID" --env prod -- ./deploy.sh
```

## GitLab CI

```yaml
deploy:
  image: alpine:3.20
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      TOKEN=$(curl -fsS -X POST "$OPENSIEL_API/api/auth/token" \
        -H 'content-type: application/json' \
        -d "{\"clientId\":\"$OPENSIEL_CLIENT_ID\",\"clientSecret\":\"$OPENSIEL_CLIENT_SECRET\"}" \
        | jq -r .accessToken)
      curl -fsS -H "Authorization: Bearer $TOKEN" \
        "$OPENSIEL_API/api/projects/$OPENSIEL_PROJECT_ID/export?env=prod&format=dotenv" \
        > .env
      set -a; . ./.env; set +a
      ./deploy.sh
  variables:
    OPENSIEL_API: https://opensiel.example.com
  # Set OPENSIEL_CLIENT_ID / OPENSIEL_CLIENT_SECRET / OPENSIEL_PROJECT_ID as masked variables.
```

## Best practices

- One identity per pipeline; name it after the consumer.
- Use `viewer` unless the job must write secrets.
- Scope identities to the minimum environments; cross-environment reads return `403`.
- Keep `prod` behind approvals and let pipelines read only.
- Rotate client secrets by creating a new identity, switching the CI variable, then revoking
  the old one.
- Never print secrets, even masked; export to an env file with `umask 077`.
- Do not use a user session token in CI when a machine identity works.
