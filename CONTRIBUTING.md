# Contributing to opensiel

Thanks for taking the time to contribute. opensiel is a small TypeScript monorepo; the
fastest way to get productive is to run the test suite and the local stack.

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for PostgreSQL) or an existing PostgreSQL 16 database

## Setup

```bash
git clone https://github.com/ibrahimhnif/opensiel.git
cd opensiel
pnpm install
pnpm db:up                 # PostgreSQL on localhost:55432

cp .env.example .env
# set OPENSIEL_MASTER_KEY and OPENSIEL_JWT_SECRET
pnpm dev                   # API on :8787, web on :5173
```

The API auto-migrates on startup in development.

## Commands

| Command                        | What it does                                 |
| ------------------------------ | -------------------------------------------- |
| `pnpm dev`                     | Run the API and Vite dev server in parallel. |
| `pnpm build`                   | Build every package.                         |
| `pnpm typecheck`               | TypeScript across the monorepo.              |
| `pnpm lint`                    | ESLint.                                      |
| `pnpm format` / `format:check` | Prettier.                                    |
| `pnpm test`                    | Unit and integration tests.                  |

Integration tests need a disposable database and **drop the `public` schema**:

```bash
docker compose -f deploy/docker-compose.yml up -d db
psql postgres://opensiel:opensiel@localhost:55432/opensiel -c 'create database opensiel_test'
TEST_DATABASE_URL=postgres://opensiel:opensiel@localhost:55432/opensiel_test pnpm test
```

Never point `TEST_DATABASE_URL` at a database with data you care about.

## Code style

- TypeScript strict mode.
- Prettier for formatting; ESLint for correctness and React hooks.
- Keep route handlers thin; put reusable logic in services (`secrets-service`,
  `approvals-service`, `webhooks`, `dynamic`, `provisioning`).
- Never log secret values, passwords, admin URLs, or tokens.
- Add tests for behavior changes, especially authorization boundaries.

## Commits and pull requests

- Use clear, imperative commit messages (`feat: add webhook retries`,
  `fix(web): handle empty bodies`). Conventional Commits prefixes are appreciated.
- Keep pull requests focused; include a short description, screenshots for UI changes, and
  the commands you ran.
- Update the README or `docs/` when behavior or configuration changes.
- Report security issues privately per [SECURITY.md](SECURITY.md), not in a public issue.

## Project layout

```
apps/server       Fastify API, database, crypto, auth
apps/web          React UI (Tailwind + shadcn-style components)
apps/cli          opensiel CLI
packages/shared   zod schemas and DTOs
packages/sdk      typed client
deploy/           Dockerfile, compose, Kubernetes manifests
docs/             architecture and screenshots
```

## Releasing

Maintainers: see [RELEASING.md](RELEASING.md) for the tag, GHCR, and npm checklist.
