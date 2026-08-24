# Runbook — Orquestador de llamadas (E7) y ciclo de vida de pedidos

Operativa diaria del sistema tras el cierre de fase (24-08-2026). Todo lo
operativo se controla desde el panel → pestaña **Llamadas** (sin deploy).
Los secretos (`RETELL_API_KEY`, `RETELL_FROM_NUMBER`, `RETELL_AGENT_ID`)
viven SOLO en el `.env` del NAS.

## Los cuatro interruptores (no se mezclan)

| Llave | Qué hace | Default |
|---|---|---|
| `ai_calls_enabled` (kill switch) | Sin esto en ON no sale NINGUNA llamada real | **OFF** |
| `calls_shadow_mode` | Calcula candidatos y payload y los registra, sin contactar a Retell | **ON** |
| `calls_allowlist` | Si tiene teléfonos, solo se llama a esos | vacío |
| `calls_daily_cap` | Tope de llamadas reales/día; al llegar, alerta y para | 30 |

`TEST_MODE` (WhatsApp) es un concepto DISTINTO y no afecta a las llamadas.

## Cómo…

**Apagar TODAS las llamadas ya** → pestaña Llamadas → kill switch OFF.
(Equivalente por DB: `settings.ai_calls_enabled='0'`. `EMERGENCY_STOP=1`
en el `.env` también frena el resto del sistema.)

**Activar shadow para validar** → shadow ON + kill switch OFF. El panel y
los eventos (`call_shadow_candidate`) enseñan a quién llamaría y cuándo.
Comparar contra Shopify a mano ANTES de encender nada.

**Primeras llamadas reales** → allowlist con tu móvil → kill switch ON →
shadow OFF. Verificada la llamada de prueba, ampliar allowlist o vaciarla.

**Revisar una llamada** → pestaña Llamadas → "Últimos resultados" (resultado,
contacto, si consumió cupo) y "Revisión manual" (motivo exacto:
`missing_data: localidad`, `attempts_exhausted`, `unknown_retell_result`,
`provider_unknown_state`, `closure_conflict`, `provider_error_exhausted`).

**Resolver un caso de revisión manual** → corregir la causa (p. ej. la
dirección en el pedido) y decidir a mano. Mientras un pedido tenga un
intento en `manual_review`, el sistema NO vuelve a llamarlo solo (a
propósito). Para reactivarlo: resolver y borrar/actualizar ese intento
(`call_attempts.state`) — de momento por SQL, `npm run db:health` enseña la DB.

**"No volver a llamar"** → automático con el resultado `no_volver_a_llamar`:
el teléfono normalizado entra en `call_dnc` y queda bloqueado GLOBALMENTE
(también pedidos futuros). Alta manual: `INSERT INTO call_dnc (phone, source)
VALUES ('34600...','manual');`

**Volver a reconciliar Shopify** → automático cada `RECONCILE_INTERVAL_HOURS`
(6 h). A mano: reiniciar el bot la dispara a los 2 min, o
`npm run shopify:backfill` (dry-run) para ver el estado del histórico
completo y `-- --apply` para aplicarlo.

**Detectar un webhook perdido** → señales: evento `order_missed_create`
(warning) en el feed; `closure_conflict`; o la reconciliación reparando
(`[RECONCILE] ... reparados=N` en logs). Ver también
`npm run shopify:webhooks` (¿siguen las 4 suscripciones?).

**Suscripciones de Shopify** → `npm run shopify:webhooks` lista y compara;
`-- --ensure` crea las que falten (no duplica, no borra; URL cambiada = aviso).

**Detener TODO** → `EMERGENCY_STOP=1` en el `.env` del NAS + reiniciar
contenedor. Llamadas: kill switch OFF basta y no corta WhatsApp.

## Cadencia y franjas (referencia)

- Entra en cola: 15 min sin respuesta al WhatsApp (`call_trigger_minutes`),
  o 60 min sin que el WhatsApp inicial haya podido salir (`CALL_FALLBACK_MINUTES`).
- Franjas: L–S 09:00–13:00 / 17:00–20:00 Europe/Madrid (DST automático).
  Nunca domingo ni festivo nacional (calculados; extras:
  `settings.call_holidays_extra` = `YYYY-MM-DD,...`).
- 5 contactos máx. (inicial + 4), cadencia 2 h/4 h/8 h/24 h → siguiente
  franja legal. `rellamar` no consume y respeta `momento_rellamada`.
  3 fallos técnicos seguidos → revisión (no castigan el cupo).
- Resultados y efectos: tabla única en `src/lib/calls/results.ts`.

## Reglas que protegen el dinero

- Un pedido = un intento vivo (índice único). Dos workers no pueden marcar
  el mismo pedido. Un crash a mitad de marcación deja la fila en `dialing`
  → revisión manual, JAMÁS se re-marca sola.
- La elegibilidad se reevalúa JUSTO antes de marcar: confirmación por
  WhatsApp, cancelación o fulfillment de Shopify a último segundo → no call.
- `confirmado` por llamada NUNCA marca entregado: la entrega la dicta el
  proveedor (Dropea) o el marcado manual, y un terminal no se pisa.
