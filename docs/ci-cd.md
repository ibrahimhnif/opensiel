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

## GitHub Actions

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

To use the CLI instead, build it in the job:

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @opensiel/cli build
- name: Run with secrets
  run: |
    TOKEN=$(curl -fsS -X POST "$OPENSIEL_API/api/auth/token" ... | jq -r .accessToken)
    OPENSIEL_TOKEN="$TOKEN" \
      node apps/cli/dist/index.js --api-url "$OPENSIEL_API" \
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
