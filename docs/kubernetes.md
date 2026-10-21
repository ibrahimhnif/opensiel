# Kubernetes

The manifests in [`deploy/k8s`](https://github.com/ibrahimhnif/opensiel/tree/main/deploy/k8s) run the API and a single PostgreSQL instance.
The API serves both `/api/*` and the web UI.

## Deploy

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/postgres.yaml
```

Create the database credentials and the app secret (use the same password in both):

```bash
DB_PASSWORD="$(openssl rand -hex 16)"

kubectl -n opensiel create secret generic postgres-credentials \
  --from-literal=POSTGRES_USER=opensiel \
  --from-literal=POSTGRES_PASSWORD="$DB_PASSWORD" \
  --from-literal=POSTGRES_DB=opensiel

kubectl -n opensiel create secret generic opensiel-secrets \
  --from-literal=DATABASE_URL="postgres://opensiel:$DB_PASSWORD@postgres.opensiel.svc.cluster.local:5432/opensiel" \
  --from-literal=OPENSIEL_MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=OPENSIEL_JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OPENSIEL_PUBLIC_URL="https://opensiel.example.com" \
  --from-literal=OPENSIEL_ALLOW_SIGNUP="true"
```

Edit `deploy/k8s/app.yaml` and `deploy/k8s/ingress.yaml`:

- replace `ghcr.io/OWNER/opensiel:latest` with your image,
- replace `opensiel.example.com` with your hostname,
- adjust `storageClassName` if `local-path` is not available.

Then apply:

```bash
kubectl apply -f deploy/k8s/app.yaml -f deploy/k8s/ingress.yaml
kubectl -n opensiel rollout status deploy/opensiel
```

Open the URL, create the owner account, then set `OPENSIEL_ALLOW_SIGNUP=false` in the secret and
restart (`kubectl -n opensiel rollout restart deploy/opensiel`).

If your image is private, create a pull secret and reference it from the Deployment:

```bash
kubectl -n opensiel create secret docker-registry ghcr-creds \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<token>
```

## TLS

Terminate TLS at the ingress. With cert-manager and Traefik:

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [opensiel.example.com]
      secretName: opensiel-tls
```

Set `OPENSIEL_PUBLIC_URL` to the HTTPS URL so cookies are `Secure` and SSO callbacks match.

## Injecting secrets into pods

There is no Kubernetes operator yet. The simplest pattern is an init container that exchanges
a machine identity for a token and writes a dotenv file into a shared `emptyDir`.

The published image includes the CLI at `/app/apps/cli/dist/index.js`.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: opensiel-client
  namespace: default
type: Opaque
stringData:
  OPENSIEL_API: https://opensiel.example.com
  OPENSIEL_CLIENT_ID: osl_xxxxxxxx
  OPENSIEL_CLIENT_SECRET: oss_xxxxxxxx
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      securityContext:
        runAsUser: 1001
        runAsGroup: 1001
        fsGroup: 1001
      initContainers:
        - name: fetch-secrets
          image: ghcr.io/OWNER/opensiel:latest
          command: ["sh", "-c"]
          args:
            - |
              set -eu
              TOKEN=$(node -e 'fetch(process.env.OPENSIEL_API + "/api/auth/token", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  clientId: process.env.OPENSIEL_CLIENT_ID,
                  clientSecret: process.env.OPENSIEL_CLIENT_SECRET
                })
              }).then((r) => { if (!r.ok) process.exit(1); return r.json(); })
                .then((d) => process.stdout.write(d.accessToken))')
              OPENSIEL_TOKEN="$TOKEN" node /app/apps/cli/dist/index.js \
                --api-url "$OPENSIEL_API" \
                export --env prod --format dotenv > /secrets/app.env
          envFrom:
            - secretRef: { name: opensiel-client }
          volumeMounts:
            - { name: secrets, mountPath: /secrets }
      containers:
        - name: web
          image: ghcr.io/OWNER/web:latest
          command: ["sh", "-c"]
          args: ["set -a; . /secrets/app.env; set +a; exec node server.js"]
          volumeMounts:
            - { name: secrets, mountPath: /secrets }
      volumes:
        - name: secrets
          emptyDir: {}
```

Notes:

- The identity is `viewer` and scoped to `prod`; the token lives 15 minutes and is only used
  during startup.
- Secrets are fetched once per pod start. Restart the pod to pick up changes, or use the SDK
  from your app if you need on-demand reads.
- For long-running workloads that need fresh secrets, run a sidecar that refreshes the file or
  call the SDK with a renewed token.
- Node.js apps can skip the CLI and use `@opensiel/sdk` at startup.

## Scaling and availability

- The API is stateless; run multiple replicas behind the Service if needed.
- Rate limits are per process.
- The bundled PostgreSQL StatefulSet is a single replica. For production, use a managed or
  operator-managed PostgreSQL and disable `postgresql` in the chart/manifests.
- Sessions and machine tokens are database/JWT-based, so replicas do not need shared state.

## Upgrades

```bash
kubectl -n opensiel set image deploy/opensiel opensiel=ghcr.io/OWNER/opensiel:v0.2.0
kubectl -n opensiel rollout status deploy/opensiel
```

Migrations run at startup (`OPENSIEL_AUTO_MIGRATE=true` by default). Back up the database and
master key before upgrading. See [Operations](operations.md).
