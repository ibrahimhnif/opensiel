FROM node:24-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runner

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 1001 opensiel \
  && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin opensiel

COPY --from=builder --chown=1001:1001 /app /app

USER 1001:1001
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
