# NAS deployment rehearsal — Product Intelligence

This is a deployment plan, not authorization to modify the NAS. Current production architecture: UGREEN DXP2800 / UGOS Pro, Docker Compose, `node:22-bookworm-slim`, `/app` working directory, `npm run start:all`, `restart: unless-stopped`, HTTP liveness at `/api/health/live`, and Docker JSON logs limited to 3 × 10 MB.

## PRE-DEPLOY

1. Confirm the NAS host path used by `PERSIST_DIR`; do not guess it.
2. Confirm these mappings exist:

   ```text
   HOST:      ${PERSIST_DIR}/data
   CONTAINER: /app/data
   BACKUP:    ${PERSIST_DIR}/backups/product-intelligence
   ```

3. Confirm the current container is healthy and record its image/commit:

   ```text
   docker compose ps
   docker inspect casamable-agent --format '{{.Config.Image}} {{.Image}}'
   git rev-parse HEAD
   ```

4. Back up Product Intelligence separately:

   ```text
   docker compose exec casamable-agent npm run backup:product-intelligence
   ```

5. Back up the existing SQLite database with its existing command. The Product Intelligence backup does not replace it:

   ```text
   docker compose exec casamable-agent npm run backup
   ```

6. Verify only variable names and presence, never print values:

   ```text
   PRODUCT_INTELLIGENCE_ENABLED
   AUTO_HUNT_ENABLED
   META_AD_LIBRARY_ACCESS_TOKEN
   META_GRAPH_API_VERSION
   META_AD_LIBRARY_COUNTRY
   META_AD_LIBRARY_MAX_PAGES
   META_AD_LIBRARY_MAX_ADS_PER_QUERY
   META_AD_LIBRARY_MAX_CALLS_PER_CYCLE
   META_AD_LIBRARY_MAX_CALLS_PER_HOUR
   META_AD_LIBRARY_TIMEOUT_MS
   META_AD_LIBRARY_MAX_RETRIES
   META_AD_LIBRARY_COOLDOWN_SECONDS
   PRODUCT_INTELLIGENCE_BACKUP_RETENTION_DAYS
   ```

7. First-deploy safe defaults:

   ```text
   PRODUCT_INTELLIGENCE_ENABLED=true
   AUTO_HUNT_ENABLED=false
   META_GRAPH_API_VERSION=v26.0
   ```

8. Build with Node 22. Do not change `.nvmrc` or dependencies to accommodate Node 24.

## DEPLOY

After explicit approval for the real NAS deployment:

```text
cd /volume1/docker/CasamableAgent/repo
git pull
docker compose build casamable-agent
docker compose up -d casamable-agent
```

Use the real repository/volume path instead of the example. Startup is passive: importing Product Intelligence loads no provider, creates no session/query/snapshot and starts no job. Auto Hunt has no scheduler and remains off.

## POST-DEPLOY

1. Wait for the existing container health:

   ```text
   docker compose ps
   curl -fsS http://127.0.0.1:3000/api/health/live
   docker compose logs --tail 100 casamable-agent
   ```

2. Check Product Intelligence without exposing credentials:

   ```text
   docker compose exec casamable-agent npm run product-intelligence -- persistence-health
   docker compose exec casamable-agent npm run product-intelligence -- meta-health
   ```

   Expected before Meta approval: configured `yes`, API `v26.0`, authorization `pending`, research `no`.

3. Open Products and confirm: authorization pending; real research unavailable; fixtures are not production data; Auto Hunt waiting/off.

4. Restart rehearsal:

   ```text
   docker compose restart casamable-agent
   docker compose ps
   docker compose exec casamable-agent npm run product-intelligence -- persistence-health
   ```

   Record session count, stop/restart once, and confirm the same count, persisted watchlist and no duplicate session. Confirm `AUTO_HUNT_ENABLED=false` by variable name/policy without printing the entire environment.

5. Recreation rehearsal:

   ```text
   docker compose up -d --force-recreate casamable-agent
   docker compose exec casamable-agent npm run product-intelligence -- persistence-health
   ```

   The files must survive because `/app/data` is a NAS bind mount.

6. Crash-recovery rehearsal must use a non-production `DATA_DIR` and TEST_FIXTURE provider only. Start a Safe Test, terminate that disposable process/container after a checkpoint, restart it with the same isolated directory, and verify completed queries are skipped while pending queries continue. Never point this test at `/app/data` or Meta.

7. Optional periodic Product Intelligence backup through the existing NAS scheduler:

   ```text
   15 4 * * * docker exec casamable-agent npm run backup:product-intelligence
   ```

   This is intentionally separate from the existing 04:00 SQLite backup.

## ROLLBACK

Fast isolation requires no data deletion:

1. Set `PRODUCT_INTELLIGENCE_ENABLED=false` in the NAS environment.
2. Keep `AUTO_HUNT_ENABLED=false`.
3. Restart only `casamable-agent`.
4. Confirm the main `/api/health/live`, Orders and WhatsApp remain operational.
5. Do not delete `/app/data/product-intelligence*.json`.

If code rollback is required, redeploy the previously recorded commit/image. Product Intelligence code consists of `src/lib/product-intelligence/`, its two API routes, `ProductIntelligencePanel.tsx`, the Products navigation additions, its scripts and configuration names. Restore code through Git/image rollback, never by deleting persistent data.

## AFTER META APPROVAL

1. Meta approves identity/authorization.
2. Generate a fresh token.
3. Update only the NAS secret `META_AD_LIBRARY_ACCESS_TOKEN`.
4. Restart `casamable-agent`.
5. Run `npm run product-intelligence -- meta-health` inside the container.
6. Require `CONNECTED` before continuing.
7. Run `npm run product-intelligence -- meta-smoke-test "almohada cervical"`.
8. Inspect normalized real data and persistence.
9. Explicitly enable and run Auto Hunt Safe Test manually.
10. Review scoring and resource use.
11. Only after human approval consider a separate future 24/7 phase. Do not enable it during this deployment.

## Rollback acceptance criteria

- Main health stays healthy.
- No Product Intelligence provider call occurs while feature-off.
- Existing Meta Ads, economics, campaigns, WhatsApp and orders remain unchanged.
- Persistent Product Intelligence data remains recoverable.
