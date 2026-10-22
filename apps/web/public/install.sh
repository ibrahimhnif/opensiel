#!/usr/bin/env bash
set -euo pipefail

VERSION="${OPENSIEL_VERSION:-latest}"
PORT="${OPENSIEL_PORT:-8787}"
INSTALL_DIR="${OPENSIEL_HOME:-$HOME/.opensiel}"
IMAGE="${OPENSIEL_IMAGE:-}"
PUBLIC_URL="${OPENSIEL_PUBLIC_URL:-}"
START=1

usage() {
  cat <<'EOF'
Install opensiel with Docker Compose.

Usage:
  curl -fsSL https://opensiel.liostech.id/install.sh | bash
  curl -fsSL https://opensiel.liostech.id/install.sh | bash -s -- --port 9000

Options:
  --port <port>       Host port for the web UI (default: 8787)
  --dir <path>        Install directory (default: ~/.opensiel)
  --version <tag>     Image tag (default: latest)
  --image <ref>       Full image reference (overrides --version)
  --url <url>         Public URL, used for cookies and SSO callbacks
  --no-start          Write the files but do not start containers
  -h, --help          Show this help

Environment:
  OPENSIEL_HOME, OPENSIEL_PORT, OPENSIEL_VERSION, OPENSIEL_IMAGE,
  OPENSIEL_PUBLIC_URL

Examples:
  OPENSIEL_VERSION=v0.1.0 curl -fsSL https://opensiel.liostech.id/install.sh | bash
  curl -fsSL https://opensiel.liostech.id/install.sh | bash -s -- --url https://secrets.example.com
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$#" -ge 2 ] || die "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --image)
      [ "$#" -ge 2 ] || die "--image requires a value"
      IMAGE="$2"
      shift 2
      ;;
    --url)
      [ "$#" -ge 2 ] || die "--url requires a value"
      PUBLIC_URL="$2"
      shift 2
      ;;
    --no-start)
      START=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

[ -n "$PORT" ] || die "--port cannot be empty"
case "$PORT" in
  *[!0-9]*) die "port must be a number between 1 and 65535" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die "port must be a number between 1 and 65535"
fi

[ -n "$INSTALL_DIR" ] || die "--dir cannot be empty"
[ -n "$VERSION" ] || die "--version cannot be empty"
if [ -z "$IMAGE" ]; then
  IMAGE="ghcr.io/ibrahimhnif/opensiel:$VERSION"
fi
if [ -z "$PUBLIC_URL" ]; then
  PUBLIC_URL="http://localhost:$PORT"
fi
case "$PUBLIC_URL" in
  *[[:space:]]*) die "--url cannot contain whitespace" ;;
esac

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon; is Docker running?"
docker compose version >/dev/null 2>&1 ||
  die "Docker Compose v2 is required (docker compose, not docker-compose)"

mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
chmod 700 "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ ! -f .env ] && docker volume inspect opensiel_opensiel-db >/dev/null 2>&1; then
  die "found an existing opensiel database volume but no .env; restore the key file before reinstalling"
fi

read_env() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | head -n 1 | tr -d '\r'
}

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^$key=" .env 2>/dev/null; then
    awk -v key="$key" -v value="$value" 'BEGIN { FS = OFS = "=" } $1 == key { print key "=" value; next } { print }' .env > .env.tmp
    mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

gen_base64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

gen_hex() {
  local bytes="${1:-16}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

OLD_MASTER_KEY="$(read_env OPENSIEL_MASTER_KEY)"
OLD_JWT_SECRET="$(read_env OPENSIEL_JWT_SECRET)"
OLD_DB_PASSWORD="$(read_env OPENSIEL_DB_PASSWORD)"
OLD_ALLOW_SIGNUP="$(read_env OPENSIEL_ALLOW_SIGNUP)"

MASTER_KEY="${OLD_MASTER_KEY:-$(gen_base64)}"
JWT_SECRET="${OLD_JWT_SECRET:-$(gen_hex 32)}"
DB_PASSWORD="${OLD_DB_PASSWORD:-$(gen_hex 16)}"
ALLOW_SIGNUP="${OLD_ALLOW_SIGNUP:-true}"

[ -n "$MASTER_KEY" ] || die "could not generate OPENSIEL_MASTER_KEY"
[ -n "$JWT_SECRET" ] || die "could not generate OPENSIEL_JWT_SECRET"
[ -n "$DB_PASSWORD" ] || die "could not generate the database password"

umask 077
touch .env
set_env OPENSIEL_VERSION "$VERSION"
set_env OPENSIEL_PORT "$PORT"
set_env OPENSIEL_IMAGE "$IMAGE"
set_env OPENSIEL_PUBLIC_URL "$PUBLIC_URL"
set_env OPENSIEL_ALLOW_SIGNUP "$ALLOW_SIGNUP"
set_env OPENSIEL_MASTER_KEY "$MASTER_KEY"
set_env OPENSIEL_JWT_SECRET "$JWT_SECRET"
set_env OPENSIEL_DB_PASSWORD "$DB_PASSWORD"
chmod 600 .env

cat > docker-compose.yml <<'YAML'
name: opensiel

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: opensiel
      POSTGRES_PASSWORD: ${OPENSIEL_DB_PASSWORD:?}
      POSTGRES_DB: opensiel
    volumes:
      - opensiel-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opensiel -d opensiel"]
      interval: 5s
      timeout: 5s
      retries: 20

  app:
    image: ${OPENSIEL_IMAGE:?}
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: "8787"
      HOST: 0.0.0.0
      DATABASE_URL: postgres://opensiel:${OPENSIEL_DB_PASSWORD:?}@db:5432/opensiel
      OPENSIEL_MASTER_KEY: ${OPENSIEL_MASTER_KEY:?}
      OPENSIEL_JWT_SECRET: ${OPENSIEL_JWT_SECRET:?}
      OPENSIEL_PUBLIC_URL: ${OPENSIEL_PUBLIC_URL:?}
      OPENSIEL_WEB_DIR: apps/web/dist
      OPENSIEL_ALLOW_SIGNUP: ${OPENSIEL_ALLOW_SIGNUP:-true}
      OPENSIEL_AUTO_MIGRATE: "true"
    ports:
      - "${OPENSIEL_PORT:?}:8787"

volumes:
  opensiel-db:
YAML

if [ "$START" -eq 0 ]; then
  cat <<EOF

Wrote:
  $INSTALL_DIR/.env
  $INSTALL_DIR/docker-compose.yml

Start it with:
  cd $INSTALL_DIR && docker compose up -d

EOF
  exit 0
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Using local image $IMAGE"
else
  echo "Pulling $IMAGE..."
  if ! docker compose pull; then
    die "could not pull $IMAGE. Set OPENSIEL_IMAGE to a reachable image or see https://opensiel.liostech.id/docs/getting-started"
  fi
fi

echo "Starting opensiel..."
docker compose up -d

health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
  else
    docker compose exec -T app node -e \
      "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
      >/dev/null 2>&1
  fi
}

READY=0
for _ in $(seq 1 60); do
  if health; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "opensiel did not become healthy in time." >&2
  docker compose logs --tail=50 app >&2 || true
  exit 1
fi

cat <<EOF

opensiel is running.

  URL:    $PUBLIC_URL
  Data:   $INSTALL_DIR
  Image:  $IMAGE

First signup becomes the owner.
After creating your account, close signup:
  1. set OPENSIEL_ALLOW_SIGNUP=false in $INSTALL_DIR/.env
  2. run: cd $INSTALL_DIR && docker compose up -d

Back up $INSTALL_DIR/.env separately from the database. Without
OPENSIEL_MASTER_KEY, existing secrets cannot be decrypted.

Docs:  https://opensiel.liostech.id/docs/
Data:  docker compose -f $INSTALL_DIR/docker-compose.yml down      # stop
       docker compose -f $INSTALL_DIR/docker-compose.yml down -v   # delete data

EOF
