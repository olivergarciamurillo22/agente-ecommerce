# Estado de producción — Casamable™

Documento vivo: **lo que corre de verdad en el NAS**. Se actualiza en cada
sesión de operación. El detalle de cómo se llegó a cada estado vive en
`docs/archive/` — este es el snapshot, no el historial.

**Última actualización: 03-09-2026 (segundo despliegue del día, con
evidencia real — `docs/CONTEXTO-2026-09-03.md`).**

---

## 1 · Qué corre hoy

| | |
|---|---|
| Rama desplegada | `release/casamable-v4.2` |
| Commit desplegado | **`92cfd3e`** (deploy #2 del 03-09, 20:49 · verificado por Pedro en el NAS) |
| Esquema SQLite | **17** |
| Contenedor | `casamable-agent` (`repo-v3c`), healthy, imagen `181a9e0d7839` |
| NAS | UGREEN DXP2800, `192.168.2.109` |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | **Cloud API oficial de Meta** (`WHATSAPP_PROVIDER=cloud_api`), número `+34 641 308 254` · plantillas 7 ACTIVE / 1 DISABLED / 0 FAIL · **V4.2_WHATSAPP_PRODUCTION_READY = SÍ** |
| Modo | `APP_MODE=production` · `TEST_MODE=1` (solo allowlist) · `WHATSAPP_SEND_ENABLED=1` · rampa de envío en **PILOTO** (ningún cliente real recibe confirmaciones automáticas todavía) |
| Llamadas (Retell) | Agente V19 publicada, prompt sincronizado byte a byte por API, **firma de webhook VERIFICADA con llamada real** (antes rota: la key en `.env` no era la que firma — ver §2). `ai_calls_enabled=0`, allowlist vacía, shadow off → automáticas imposibles hoy |
| Watchdog | Vivo (revivido hoy tras 6 días sin latido — arrancaba solo dentro de Baileys, y con `cloud_api` Baileys no arranca) |
| Dropea | read-only, `DROPEA_WRITE_ENABLED=0`, creación vía su app oficial |
| Dropi | sin API (solo diagnóstico), sincronización de su app desactivada |
| Beeping | **apagado** (sin credencial; todo fail-closed) |
| Meta Ads | read-only, funcionando (cuenta `act_1365655995103103`, EUR, Europe/Madrid) |

## 2 · Incidentes cerrados hoy (03-09), con evidencia

1. **Retell — firma de webhooks (P1).** Causa raíz: la cuenta de Retell
   tiene DOS API keys y solo una (con badge "Webhook") firma de verdad; el
   `.env` tenía la otra. El HMAC no podía coincidir nunca, y todo lo demás
   (algoritmo, reloj, auth, red) era correcto — por eso costó encontrarlo.
   Arreglado (`183617f`): verificación extraída a
   `src/lib/calls/retell-webhook.ts`, alineada con `retell-sdk@5.64.0`, más
   rotación de `RETELL_API_KEY` a la key badged. **Cerrado con evidencia
   real:** llamada entrante 21:07, 3 webhooks aceptados, 0
   `call_webhook_bad_signature` (por la mañana: 8 de 8 rechazados).
2. **Watchdog muerto (P2)** — arreglado (`cace21e`), vivo y avanzando.
3. **Botón manual sin gates (P3)** — `manualDialOrder` se saltaba kill
   switch/shadow/allowlist; arreglado (`6259040`), política centralizada en
   `src/lib/calls/gates.ts`.
4. **`readiness` fallaba en producción por no tener `tsc`/tests (P5)** —
   separado en `readiness` (release) y `readiness:runtime` (`2a7771a`).
5. **WhatsApp 132001** (mapping a una plantilla que no existía en la WABA) y
   **tracking claim-antes-del-gate** — arreglados en sesiones previas
   (`docs/CONTEXTO-2026-09-01.md`, `docs/WHATSAPP-TEMPLATES.md`), y
   confirmados en producción con este despliegue: WhatsApp ya está marcado
   `PRODUCTION_READY`.

Detalle completo, cronología y los aprendizajes operativos del NAS:
`docs/CONTEXTO-2026-09-03.md`.

## 3 · Sigue abierto

1. **Saldo de Retell: 3,57 $, sin auto-recharge** (~25 llamadas). El
   `retell:doctor` no consulta saldo — nadie avisará si se agota. Activar
   auto-recharge antes de ampliar el piloto de llamadas.
2. `DASHBOARD_PASSWORD` sin cambiar.
3. Falta una llamada **saliente** real con el código nuevo (la entrante
   validó la firma; la saliente validaría además los gates de negocio de
   punta a punta) — solo posible en franja legal (L–S 9–13 y 17–20).
4. Subir la rampa de WhatsApp cuando se decida encender campañas (25% →
   100%, o directo a 100% ahora que el watchdog vigila).

## 4 · Lo que no se toca

`DROPEA_WRITE_ENABLED=0` · `BEEPING_*=0` · defaults fail-closed ·
`EMERGENCY_STOP` semántica fail-closed · llamadas MANUAL-ONLY hasta piloto
verificado · franja de despliegue: nunca 10:00–21:00 (corta WhatsApp).
