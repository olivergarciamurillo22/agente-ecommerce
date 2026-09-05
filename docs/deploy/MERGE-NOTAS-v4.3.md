# Notas de merge de scripts · Casamable v4.3

Comparación reproducible: `package.json` de `release/casamable-v4.3` frente a `origin/release/casamable-v4.2`. Este inventario no inspecciona `feat/landing-ultima-milla` ni anticipa su contenido.

## Scripts heredados de v4.2

- Aplicación: `dev`, `dev:all`, `build`, `start`, `start:bot`, `start:all`, `clean`, `test`, `typecheck`.
- Diagnóstico y operación: `check`, `doctor`, `wizard`, `backup`, `db:health`, `env:doctor`, `env:init`, `local:doctor`, `local:reset`, `readiness`, `readiness:runtime`, `deploy:precheck`, `deploy:guard`, `redteam`.
- Pedidos y mensajería: `supplier:simulate`, `outbox:inspect`, `outbox:clear-safe`, `shopify:backfill`, `shopify:webhooks`, `retention`, `orders:backfill-ordered-at`, `orders:investigate-skipped-backfill`, `casamable:simulate`, `notify:delay-ultras`, `whatsapp:templates:doctor`.
- Proveedores: `dropi:webhook:simulate`, `dropi:diagnose`, `dropea:doctor`, `dropea:mapping:inspect`, `dropea:reconcile`.
- Llamadas y servicios externos: `calls:validate-prompt`, `calls:mode`, `calls:simulate`, `retell:doctor`, `retell:pilot`, `retell:reconcile-call`, `beeping:auth:init`, `beeping:doctor`, `beeping:sync`, `meta-ads:doctor`, `meta-ads:sync`, `test:airtable`.

## Scripts añadidos en v4.3

| Script | Propósito | Decisión de integración |
|---|---|---|
| `doctor:v43` | Doctor unificado de release | Mantener. Es específico de la release y no sustituye al `doctor` general. |
| `trace` | Trazabilidad redactada de un pedido | Mantener. No solapa los inspectores del outbox. |
| `fixture:pedido` | Pedido sintético seguro y reproducible | Mantener. No sustituye a `casamable:simulate`. |
| `users:create` | Alta local de usuarios del workspace | Mantener. No existe equivalente en v4.2. |
| `hunter:add` | Alta de candidatos del Cazador | Mantener dentro del namespace `hunter:*`. |
| `hunter:score` | Recalcular puntuación de candidatos | Mantener dentro del namespace `hunter:*`. |
| `landing:build` | Construir el HTML de una landing | Mantener, pero reservar `landing:*` para este pipeline. |
| `landing:sections` | Convertir el blueprint en secciones Liquid | Mantener como etapa explícita del pipeline. |
| `landing:lint` | Validar el bundle de landing | Mantener; no equivale al `typecheck` del repositorio. |
| `landing:e2e` | Ejecutar build, secciones y lint | Mantener como entrada canónica de validación integral. |

## Regla para un merge posterior

`package.json` no debe resolverse aceptando un lado completo: hay que conservar los scripts base y estos diez añadidos. Si otra rama aporta comandos con el mismo propósito, se recomienda conservar un único ejecutor canónico y hacer que el alias antiguo lo delegue durante una transición; solo renombrar cuando exista una colisión real. En particular, no crear otro `landing:build`, `landing:lint` o `landing:e2e` con semántica distinta bajo el mismo nombre.

No hay dependencias nuevas ni cambios de versión entre ambos `package.json`; el único cambio observado está en `scripts`.
