# RUNBOOK DE ÓLIVER — desarrollo y cierre local

## Los cuatro comandos que gobiernan todo

```bash
npm run readiness            # ¿está TODO lo local en verde? (typecheck+tests+simulate+esquema+env)
npm run casamable:simulate   # los 10 flujos operativos contra una DB desechable
npm test                     # suite completa (493 tests) — 100% verde, sin skips
npm run typecheck            # limpio siempre
```

`readiness` es el veredicto: **LOCAL READY — PRODUCTION VALIDATION PENDING**
es lo máximo que se puede afirmar desde el Mac. "PRODUCTION READY" no existe
sin validar en el NAS (ver `docs/REAL-WORLD-VALIDATION.md`).

## El contrato

- `docs/GOLDEN-PATH.md` — la secuencia canónica y sus invariantes. Si cambias
  el contrato, cambia primero el doc y después el test `golden-path-order-confirmation`.
- `docs/ACCEPTANCE-CRITERIA.md` — criterios binarios con su verificación.
- `docs/MODELO-ESTADOS.md` — los 4 ejes de estado. No se cruzan.

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| DB, migraciones, esquema (v11) | `src/lib/db.ts` (una función por migración, idempotente) |
| Máquina de confirmación WhatsApp | `src/lib/orders/confirmation.ts` + `multi-order.ts` |
| Scheduler (colas, at-most-once) | `src/lib/orders/scheduler.ts` + `src/lib/system/leases.ts` |
| Elegibilidad central | `src/lib/orders/eligibility.ts` — TODO consumidor pregunta ahí |
| Webhooks Shopify | `src/lib/shopify/webhook.ts` (create) + `orders-events-webhook.ts` (cancel/fulfill/update) |
| Eje de cierre | `src/lib/orders/closure.ts` (terminales inmutables) |
| Proveedores | `src/lib/suppliers/` (router, service; dropea real, dropi fail-closed) |
| WhatsApp dual | `src/lib/whatsapp/` (provider flag `WHATSAPP_PROVIDER`: baileys/cloud_api) |
| Llamadas Retell | `src/lib/calls/` (kill switch OFF, shadow ON por defecto) |
| Action Center | `src/lib/system/action-center.ts` + `/api/action-center` + `ActionCenter.tsx` |
| Watchdog de negocio | `src/lib/system/business-alerts.ts` |
| Salud del sistema | `src/lib/system/health-*.ts` (mensajes SIEMPRE con qué hacer) |
| Esquema de entorno | `src/lib/config/env-schema.ts` (única fuente; perfiles) |

## Reglas que no se negocian (resumen de CLAUDE.md)

- Una tarea = una rama = un PR. Tres verdes antes de abrir PR.
- `status` (eje operativo con CHECK SQL) no se toca salvo tarea explícita.
- Migraciones idempotentes, extraídas a función, backfill neutro.
- Webhooks: HMAC + idempotencia por delivery-id + fuera-de-orden. Tres tests.
- Scripts de datos: `--dry-run` por defecto, desglose por transición,
  jamás pisar lo que escribió un webhook, sin imports de WhatsApp (test estructural).
- TEST_MODE sin definir = ACTIVO. En todas las capas, `!== "0"`.
- Cero efectos externos sin permiso: ni deploy, ni webhooks reales, ni APIs.

## Trampas conocidas (te ahorran una tarde cada una)

- `read_all_orders` ausente = solo 60 días, EN SILENCIO. Verifica scope.
- Producción (NAS) puede correr una RAMA, no main — `git fetch` y compara antes de nada.
- Las plantillas de Meta no se transfieren entre WABAs.
- El alta de coexistencia de Meta puede desvincular Baileys irreversiblemente.
- `raw_payload` está congelado al insert: inútil para fulfillment posterior.
- `closure_at` lleva la fecha de la FUENTE, jamás `now()`.
- SQLite no entiende timezones con nombre: `src/lib/time.ts` (Europe/Madrid vía Intl).
- Dropi NO tiene API pública (confirmado por soporte 25-08): todo fail-closed.

## Flujo de cierre de una tarea

1. Rama desde el último estado real (¡mira qué corre el NAS!).
2. Código + tests dedicados por protección (capas por separado).
3. `npm run readiness` en verde.
4. Commits pequeños, push, PR con decisiones y límites explícitos.
5. Actualizar CLAUDE.md §11 al mergear.
