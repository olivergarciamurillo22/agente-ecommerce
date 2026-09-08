# FIXES DE SEGURIDAD 08-09 — PRODUCTION DEPLOY REPORT (08-09-2026, ~23:40)

Despliegue pequeño sobre `22f8013`: los dos hallazgos ALTO de
`docs/AUDITORIA-PROFESIONAL-2026-09-08.md` (§3.1 y §3.2) más un commit de
documentación. Sin cambio de esquema. Ejecutado por Pedro en el NAS.

| Campo | Valor |
|---|---|
| DEPLOYED_SHA | `f2af4940639ec4a051404c3cb72868448d06bf8b` (incluye `f427b9f` Fix 1, `0228ad5` Fix 2, `f2af494` docs) |
| PRE_SCHEMA → POST_SCHEMA | 30 → 30 |
| PRE_COUNTS = POST_COUNTS (orders/conversations/messages) | 136 / 80 / 474, idénticos |
| HEALTH | healthy, 0 reinicios |
| HEALTH_LIVE_BUILD | `f2af4940639ec4a051404c3cb72868448d06bf8b`, confirmado |
| PURGA_SETTING (`adlib_snapshot_tokens_purged_at`) | `{"at":1788903535,"snapshots":0,"jobs":0,"estimates":0}`: 0 filas con token que limpiar (esperado: token caducado sin uso reciente) |
| TOKENS_RESTANTES en `adlib_candidate_snapshots.ads_json` | 0 |
| Fix 1 (Beeping / EMERGENCY_STOP) | No forzado en producción a propósito (habría exigido `EMERGENCY_STOP=1`); cubierto por sus tests |
| Imagen de rollback | `casamable-agent:pre-fixes-0809` |
| ROLLBACK_REQUIRED | No |
| FINAL_VERDICT | **DESPLEGADO Y VERIFICADO** |

## Incidencia menor, resuelta (para todos los runbooks)

`export GIT_SHA=…` seguido de `sudo docker compose build` **no propaga la
variable**: `sudo` no hereda el entorno del usuario por defecto. El primer
build salió con `build: sin_confirmar`. Solución: la variable va inline en
el propio comando con `sudo`:

```
sudo GIT_SHA=<sha completo> docker compose -p repo-v3c build casamable-agent
```

Los scripts que se ejecutan enteros bajo `sudo bash …` (`nas-verify-v43.sh`,
`nas-deploy-cazador.sh`) no tienen el problema porque el `export` y el
`docker compose` corren en el mismo proceso root; aun así, desde el 08-09
pasan la variable inline para que dé igual cómo se invoquen.
