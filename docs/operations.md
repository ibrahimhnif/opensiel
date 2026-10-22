# Operations

## Backups

The PostgreSQL database contains encrypted secrets, wrapped project keys, users, audit logs,
leases, and webhooks. The master key (or AWS KMS key) is stored separately.

```bash
# Docker Compose
docker compose --env-file .env -f deploy/docker-compose.yml exec db \
  pg_dump -U opensiel opensiel | gzip > opensiel-$(date +%F).sql.gz

# one-command installer
docker compose -f ~/.opensiel/docker-compose.yml exec -T db \
  pg_dump -U opensiel opensiel | gzip > opensiel-$(date +%F).sql.gz

# Kubernetes
kubectl -n opensiel exec postgres-0 -- pg_dump -U opensiel opensiel \
  | gzip > opensiel-$(date +%F).sql.gz
```

Store the dump and the master key in different places. Without the master key, a restored
database cannot be decrypted.

### Restore

1. Stop the app so it cannot write during the restore.
2. Restore into an empty database.
3. Restore `OPENSIEL_MASTER_KEY` (with the matching `OPENSIEL_MASTER_KEY_VERSION`).
4. Start the app and check `/api/health` and a secret read.

```bash
gunzip -c opensiel-2026-10-21.sql.gz | \
  kubectl -n opensiel exec -i postgres-0 -- psql -U opensiel -d opensiel
```

## Upgrades

- Back up first.
- Docker Compose: `docker compose --env-file .env -f deploy/docker-compose.yml up -d --build`.
- Kubernetes: update the image tag and wait for the rollout.
- Pin image tags in production; avoid `latest`.
- Migrations run at startup and are append-only. Downgrades are not supported; restore from a
  backup instead.

## Key rotation

Secret values are encrypted with per-project data keys; only those keys are wrapped by the
master key. Rotation rewraps the data keys.

1. Generate a new key: `openssl rand -base64 32`.
2. Set `OPENSIEL_MASTER_KEY_NEXT` (optionally `OPENSIEL_MASTER_KEY_NEXT_VERSION`) and restart.
3. As an owner, **Members → Encryption key → rotate keys** or `POST /api/admin/rotate-key`.
4. Promote the new key: set `OPENSIEL_MASTER_KEY` to it, bump `OPENSIEL_MASTER_KEY_VERSION`,
   remove the `_NEXT` variables, and restart.

Keep the old key until step 4. Projects on an unknown key version fail closed with
`missing_key_version`. New projects use the current key version.

When using AWS KMS, wrap the new master key with KMS and update
`OPENSIEL_KMS_WRAPPED_MASTER_KEY` after rewrapping projects.

## Dynamic credential leases

- The API drops roles at expiry with a sweep every 60 seconds.
- Admins can revoke a lease earlier in **Dynamic → Leases → revoke**.
- A failed revocation is retried on the next sweep; check the server logs for
  `failed to revoke expired dynamic lease`.
- Deleting a configuration does not drop roles from earlier leases; revoke them first.

## Webhooks

- Deliveries time out after 5 seconds and retry up to three times.
- The UI shows the last HTTP status, error, and consecutive failure count.
- Use the **test** button to verify the endpoint and signature.
- Verify `x-opensiel-signature: sha256=<hmac>` over the raw request body.
- Payloads never include secret values.

## Monitoring

- `GET /api/health` returns `200` with `{"status":"ok"}` when the database is reachable.
- Ship container logs; the server redacts authorization headers and cookies, and never logs
  secret values.
- Watch database size, especially `audit_logs` and `secret_versions`.
- Key events in the log: migrations applied, lease reaper failures, webhook delivery errors.

### Audit retention

There is no automatic pruning. To keep 90 days:

```sql
delete from audit_logs where created_at < now() - interval '90 days';
```

Run it deliberately; audit history is part of the product.

## Disaster recovery checklist

- [ ] `OPENSIEL_MASTER_KEY` (or KMS key + wrapped blob) available offline.
- [ ] Recent `pg_dump` restored successfully in a test environment.
- [ ] `OPENSIEL_JWT_SECRET` stored with the deployment configuration (rotating it logs out
      machine tokens).
- [ ] SSO secrets and IdP metadata documented.
- [ ] Restore procedure tested end to end at least once.
