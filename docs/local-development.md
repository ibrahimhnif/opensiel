# Local development

## Requirements

- Node.js 22+ (`.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the development PostgreSQL) or your own PostgreSQL 16 instance
- `openssl` for generating keys

## Setup

```bash
git clone https://github.com/ibrahimhnif/opensiel.git
cd opensiel
pnpm install

pnpm db:up                 # PostgreSQL on localhost:55432
cp .env.example .env
```

Set the two required secrets in `.env`:

```bash
openssl rand -base64 32    # OPENSIEL_MASTER_KEY
openssl rand -hex 32       # OPENSIEL_JWT_SECRET
```

Then start the API and web dev server:

```bash
pnpm dev
```

- API: `http://localhost:$PORT` (from `.env`, 8787 by default; this repo's `.env.example`
  uses 8787 and the dev database uses 55432).
- Web: Vite on <http://localhost:5173>, proxying `/api` to the API port.

`pnpm dev` loads the root `.env` for both processes. If port `8787` is busy, set another
`PORT` in `.env`; the Vite proxy follows it. Vite picks the next free port if `5173` is taken.

## Useful commands

| Command                             | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                          | API (`tsx watch`) + Vite dev server.                 |
| `pnpm build`                        | Build every package (server, web, CLI, SDK, shared). |
| `pnpm typecheck`                    | TypeScript across the monorepo.                      |
| `pnpm lint`                         | ESLint (flat config).                                |
| `pnpm format` / `pnpm format:check` | Prettier.                                            |
| `pnpm test`                         | Unit and integration tests.                          |
| `pnpm db:up` / `pnpm db:down`       | Start/stop the development PostgreSQL container.     |

## Tests

Integration tests need a disposable database. They **drop and recreate the `public`
schema**, so never point them at data you care about.

```bash
pnpm db:up
psql postgres://opensiel:opensiel@localhost:55432/opensiel -c 'create database opensiel_test'
TEST_DATABASE_URL=postgres://opensiel:opensiel@localhost:55432/opensiel_test pnpm test
```

The suite covers crypto, dotenv parsing, KMS resolution, and the API: auth, RBAC, secret
versioning, approvals, references/imports, scanning, dynamic credentials, webhooks, SSO
(mock OIDC/SAML providers), and key rotation.

## Seed demo data

`scripts/seed-demo.mjs` creates a demo account and project through the public API. The
instance must allow signup unless the account already exists.

```bash
API_URL=http://localhost:8787 \
EMAIL=demo@opensiel.dev PASSWORD=demo-password-123 \
node scripts/seed-demo.mjs
```

It creates `web-app` with dev/staging/prod secrets, approvals on prod, a machine identity, a
webhook, and a pending change request. Safe to re-run; it logs in if the account exists.

## Reset the local database

```bash
pnpm db:down
docker volume rm deploy_opensiel-db   # removes the development database
pnpm db:up
pnpm dev                              # migrations run automatically
```

The volume name may differ if you changed the Compose project name.

## Run the production build locally

```bash
pnpm build
set -a; . ./.env; set +a
NODE_ENV=production OPENSIEL_WEB_DIR=apps/web/dist node apps/server/dist/index.js
```

The server serves `/api/*` and the built web app on the same port.

## Ports

| Service              | Default | Notes                                              |
| -------------------- | ------- | -------------------------------------------------- |
| API                  | 8787    | `PORT` in `.env`; used by the Vite proxy.          |
| Web dev server       | 5173    | Vite falls back to 5174+ if busy.                  |
| PostgreSQL (compose) | 55432   | `pnpm db:up`; `DATABASE_URL` in `.env` must match. |

## Project layout

```
apps/server       Fastify API, database, crypto, auth, webhooks, dynamic credentials
apps/web          React UI (Tailwind v4 + shadcn-style components)
apps/cli          opensiel CLI
packages/shared   zod schemas and DTOs
packages/sdk      typed Node client
deploy/           Dockerfile, compose, Kubernetes manifests
docs/             documentation
scripts/          demo seeding
```
