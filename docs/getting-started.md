# Getting started

This guide runs opensiel with Docker Compose, creates the owner account, and connects the CLI.
For a development checkout, see [Local development](local-development.md).

## Requirements

- Docker with the Compose plugin (or a PostgreSQL 16 database if you run the app manually)
- Node.js 20+ only if you want to use the CLI or SDK
- A free port for the app (default `8787`)

## 1. Start the stack

```bash
git clone https://github.com/ibrahimhnif/opensiel.git
cd opensiel

cp .env.example .env
```

Generate the two required secrets and put them in `.env`:

```bash
openssl rand -base64 32   # OPENSIEL_MASTER_KEY
openssl rand -hex 32      # OPENSIEL_JWT_SECRET
```

Then start PostgreSQL and the app:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
curl http://localhost:8787/api/health
```

Open <http://localhost:8787>. The first signup becomes the instance owner.

> **Back up `OPENSIEL_MASTER_KEY`.** It is the only thing that decrypts your secrets. Store it
> outside the database and outside the repository. Losing it makes existing secrets
> unrecoverable.

## 2. Close signup

Once the owner account exists, set `OPENSIEL_ALLOW_SIGNUP=false` in `.env` and restart:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

New members now join through invites (**Members → Invite by email**) or SSO (see
[Configuration](configuration.md#oidc)).

## 3. Create a project and secrets

In the UI:

1. **New project** in the sidebar (for example `web-app`). Projects start with `dev`,
   `staging`, and `prod`; add QA/UAT in **Approvals → Environments**.
2. Pick an environment and add a secret, or use **Import .env** to paste/upload a file.

## 4. Use the CLI

```bash
pnpm --filter @opensiel/cli build
export PATH="$PWD/apps/cli/dist:$PATH"

opensiel login --api-url http://localhost:8787
opensiel init --project web-app --env dev
opensiel secrets list --reveal
opensiel run --env dev -- npm run dev
```

`opensiel run` fetches the environment and injects each secret as an environment variable for
the child process. See [CLI](cli.md) for every command.

## 5. Use the SDK

```ts
import { OpensielClient } from "@opensiel/sdk";

const client = new OpensielClient({ apiUrl: "http://localhost:8787" });
await client.loginWithClientCredentials(clientId, clientSecret);

const { secrets } = await client.listSecrets(projectId, "dev");
console.log(secrets.find((secret) => secret.key === "DATABASE_URL")?.value);
```

See [SDK](sdk.md).

## Next steps

- [Configuration](configuration.md) — SSO, KMS, key rotation, signup policy.
- [Use cases](use-cases.md) — CI/CD, Kubernetes, dynamic database credentials.
- [Operations](operations.md) — backups, upgrades, monitoring.
