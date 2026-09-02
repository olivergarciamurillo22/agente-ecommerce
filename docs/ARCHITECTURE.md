# Arquitectura — Casamable Control Center

El sistema entero en dos páginas. Detalle por pieza: `docs/README.md`.

## El flujo

```
Shopify (COD, formulario Releasit)
   │ webhook orders/create (HMAC, dedupe por webhook-id)
   ▼
SQLite local (orders) ── 4 ejes de estado independientes:
   │   · status          → máquina de confirmación (CHECK SQL, frágil)
   │   · closure_*       → verdad de NEGOCIO (delivered/refused/cancelled;
   │                       terminales inabandonables, fecha de la FUENTE)
   │   · supplier_*      → eje logístico (tracking normalizado)
   │   · beeping_*       → liberación al almacén (claim atómico)
   │   + atribución v17 (UTM/fbclid, latch de solo-huecos)
   ▼
WhatsApp Cloud API (proveedor actual; Baileys = fallback de rollback)
   │   1º mensaje FUERA de ventana = plantilla REAL de la WABA, resuelta
   │   por mapping lógico→proveedor y VERIFICADA por doctor (132001).
   │   Botones → máquina determinista de confirmación (sin IA en el flujo).
   ▼
¿No responde? → needs_call → Retell (Lucía) — MANUAL-ONLY
   │   preflight: 11 variables seguras (unsafe_dynamic_variable bloquea),
   │   RETELL_AGENT_VERSION fijada, prompt versionado en config/retell/.
   ▼
Confirmado → fulfillment
   │   · Beeping (futuro cercano): la app de Shopify crea el pedido
   │     retenido; Casamable OBSERVA → CONFIRMA → LIBERA (mark-to-send,
   │     gate de 14 condiciones) → RECONCILIA (polling). Todo fail-closed.
   │   · Dropea: su app crea; nosotros read-only + webhooks firmados.
   │   · Dropi: SIN API — manual.
   ▼
Tracking (webhooks Dropea / polling Beeping)
   │   processSupplierUpdate: terminales protegidos, avisos con claim
   │   DESPUÉS del gate y datos completos o nada.
   ▼
Cierre (closure) → Finanzas
       ingreso = SOLO entregados reales · costes al enviar · ROAS bruto/neto
       Meta Ads read-only (snapshots) + atribución por campaña con
       COBERTURA declarada · Calculadora COD (modelo Pedro + modelo real)
```

## Procesos

- **Bot** (`scripts/start-bot.ts`): schedulers de pedidos, tracking,
  reconciliación Shopify, llamadas (manual-only), Beeping y Meta Ads —
  todos con lease en SQLite (dos procesos jamás duplican trabajo) y
  fail-closed sin credenciales.
- **Web** (Next.js): panel + rutas API + webhooks
  (`/api/webhooks/{shopify,whatsapp,dropea,dropi,retell}` — HMAC/firma,
  idempotencia, orden cronológico). Basic Auth con `DASHBOARD_PASSWORD`.
- **Outbox**: todo WhatsApp saliente pasa por cola con claim at-most-once;
  los safety gates se reevalúan al entregar.

## Seguridad operativa (no negociable)

`EMERGENCY_STOP` y `TEST_MODE` fail-closed (sin definir = activos) ·
allowlist de teléfonos + rampa determinista `whatsapp_rollout_percent` ·
escrituras externas con doble cerrojo (flag + kill switch, comprobado en
la capa HTTP) · DNC de llamadas · PII enmascarada en logs/paneles ·
secretos solo en `.env` (jamás repo/logs/UI).

## Dónde vive cada cosa

`src/lib/orders` confirmación+atribución · `src/lib/shopify` webhooks/
backfill · `src/lib/whatsapp` Cloud+plantillas (`src/lib/baileys`
fallback) · `src/lib/calls` Retell · `src/lib/beeping` · `src/lib/suppliers`
Dropea/Dropi · `src/lib/tracking` · `src/lib/meta-ads` · `src/lib/system`
salud/finanzas/alertas · `src/lib/cod-calculator` · `src/lib/db.ts`
esquema v17 (migraciones incrementales, jamás renumerar) ·
`config/whatsapp-templates.json` catálogo+mappings · `config/retell/`
prompt vigente · `tests/run-tests.ts` suite única (557).
