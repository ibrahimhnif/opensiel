# opensiel Helm chart

Deploys opensiel and an optional single-node PostgreSQL 16 StatefulSet.

## Install

From the OCI registry (published by the release workflow):

```bash
helm install opensiel oci://ghcr.io/ibrahimhnif/charts/opensiel \
  --version 0.1.0 \
  --namespace opensiel --create-namespace
```

Or from the chart archive attached to a GitHub release:

```bash
helm install opensiel https://github.com/ibrahimhnif/opensiel/releases/download/v0.1.0/opensiel-0.1.0.tgz \
  --namespace opensiel --create-namespace
```

With ingress:

```bash
helm install opensiel oci://ghcr.io/ibrahimhnif/charts/opensiel \
  --version 0.1.0 \
  --namespace opensiel --create-namespace \
  --set ingress.enabled=true \
  --set ingress.className=traefik \
  --set ingress.hosts[0].host=secrets.example.com \
  --set ingress.tls[0].secretName=opensiel-tls \
  --set ingress.tls[0].hosts[0]=secrets.example.com
```

The chart sets `OPENSIEL_PUBLIC_URL` from the first ingress host, or from
`env.OPENSIEL_PUBLIC_URL` when set. The first signup becomes the owner.

## Secrets

With the default `postgresql.enabled=true`, the chart creates one Secret containing:

- `OPENSIEL_MASTER_KEY` (generated once and preserved on upgrade)
- `OPENSIEL_JWT_SECRET` (generated once and preserved on upgrade)
- `DATABASE_URL`
- `POSTGRES_PASSWORD`

Set `secrets.masterKey` / `secrets.jwtSecret` to supply your own values. Back up the master key
separately from the database; without it, stored secrets cannot be decrypted:

```bash
kubectl -n opensiel get secret opensiel -o jsonpath='{.data.OPENSIEL_MASTER_KEY}' | base64 -d
```

## External database

```bash
--set postgresql.enabled=false \
--set externalDatabase.url='postgres://opensiel:password@db.example.com:5432/opensiel'
```

The chart still generates the master key and JWT secret unless you provide them.

To use a pre-existing Secret instead:

```bash
--set secrets.existingSecret=opensiel-secrets \
--set postgresql.enabled=false \
--set externalDatabase.url=''   # not used when existingSecret is set
```

The existing Secret must contain `DATABASE_URL`, `OPENSIEL_MASTER_KEY`, and
`OPENSIEL_JWT_SECRET`. `secrets.existingSecret` cannot be combined with the bundled PostgreSQL.

## Important values

| Value                                 | Default                        | Description                                            |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `image.repository`                    | `ghcr.io/ibrahimhnif/opensiel` | App image.                                             |
| `image.tag`                           | chart `appVersion`             | Pin a release tag in production.                       |
| `replicaCount`                        | `1`                            | The API is stateless; rate limits are per pod.         |
| `service.port`                        | `8787`                         | Service and container port.                            |
| `env.OPENSIEL_PUBLIC_URL`             | derived                        | Public origin for cookies and SSO.                     |
| `env.OPENSIEL_ALLOW_SIGNUP`           | `true`                         | Set to `false` after creating the owner.               |
| `env.OPENSIEL_AUTO_MIGRATE`           | `true`                         | Run migrations at startup.                             |
| `extraEnv`                            | `[]`                           | OIDC, SAML, KMS, or other app environment variables.   |
| `postgresql.enabled`                  | `true`                         | Bundle PostgreSQL. Disable for an external database.   |
| `postgresql.persistence.size`         | `8Gi`                          | PVC size.                                              |
| `postgresql.persistence.storageClass` | cluster default                | Storage class for the PVC.                             |
| `externalDatabase.url`                | –                              | Required when `postgresql.enabled=false`.              |
| `ingress.enabled`                     | `false`                        | Create an Ingress.                                     |
| `ingress.className`                   | –                              | Ingress class, e.g. `traefik` or `nginx`.              |
| `ingress.annotations`                 | `{}`                           | For example cert-manager annotations.                  |
| `secrets.existingSecret`              | –                              | Use an existing Secret; requires an external database. |

## Upgrade and uninstall

```bash
helm upgrade opensiel oci://ghcr.io/ibrahimhnif/charts/opensiel \
  --version 0.1.0 --namespace opensiel --reuse-values

helm test opensiel -n opensiel
helm uninstall opensiel -n opensiel
```

`helm uninstall` deletes the Secret and the StatefulSet's PVCs depending on cluster policy.
Back up the database and the master key first.

## Notes

- The image must be public, or the cluster must have an image pull secret for GHCR.
- The bundled PostgreSQL is a single replica. Use a managed database for high availability.
- The chart does not create a ServiceMonitor; point Prometheus at `/api/health`.
