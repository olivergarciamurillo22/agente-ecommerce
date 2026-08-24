# Estado de producción — Casamable™

Documento vivo. Describe **lo que está corriendo de verdad en el NAS**, cómo está configurado y qué se ha medido sobre datos reales. Se actualiza en cada sesión de operación.

**Última actualización: 24-08-2026** (cierre de fase: ciclo de vida Shopify + orquestador de llamadas — pendiente de desplegar en el NAS, ver § 9).

---

## 1 · Qué corre hoy

| | |
|---|---|
| Commit desplegado | **`a2e4e83`** (rama `main`, Fase A integrada) |
| Esquema SQLite | `user_version = 3` |
| Contenedor | `casamable-agent`, healthy, `restart: unless-stopped` |
| NAS | UGREEN DXP2800, `192.168.2.109`, UGOS 1.18.1.0098 |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | Baileys, `+34 641 308 254`, reconecta sin QR |
| Modo | `TEST_MODE=1` con allowlist de 2 teléfonos — **pero se autorizan pedidos reales a mano** (`pilot_authorized=1`), así que el sistema **sí está sirviendo a clientes reales** |

---

## 2 · Integraciones configuradas

### Shopify
- Tienda `qmbr1z-vf.myshopify.com` (alias antiguo `pedroshop-9968.myshopify.com`, **misma tienda**).
- Webhook activo: **solo `orders/create`** — `https://agente.casamable.es/api/webhooks/shopify/orders-create`.
- Escrituras habilitadas (tag `WA_CONFIRMED`).
- ⚠️ **No hay webhooks de cancelación ni de fulfillment.** Es la causa del problema descrito en § 4.

### Dropea — conectada de punta a punta (23-08-2026)
- API key `casamable-nas` con **permisos mínimos**: `issues:read`, `orders:read`, `products:read`, `stores:read`, `users:read`, `webhooks:read`, `webhooks:write`.
  **Deliberadamente SIN `orders:create` / `confirm` / `cancel` / `update`**: es la red de seguridad contra duplicados a nivel de credencial, no solo de código.
- `store_id = 18307`, cuenta `45468`, mercado `es`, base `https://es.public-api.dropea.com`.
- Flags: `DROPEA_API_ENABLED=1` (lectura), `DROPEA_WRITE_ENABLED=0`, `DROPEA_CREATE_MODE=external_app`, `DROPEA_LEGACY_CREATE_ACTIVE=1`.
- **6 webhooks suscritos y activos** — `https://agente.casamable.es/api/webhooks/dropea`
  (`order.created`, `order.status.changed`, `order.cancelled`, `issue.created`, `issue.status.changed`, `issue.resolved`).
- `DROPEA_WEBHOOK_SECRET` configurado. Verificado: petición sin firma → **401**, no 503.

### Mapping de producto
Una fila en `supplier_product_mapping`:

| Shopify | Dropea |
|---|---|
| SKU `10428` · product `15964094660938` · variant `62950185173322` | `variant_id = 15896` · 7,70 € |

El SKU coincide en ambos sistemas, pero **el emparejado automático no lo encontraba**: el script recorre 10 páginas (500 productos) y el catálogo de Dropea tiene **4.142**. El producto estaba en la página 46. *Mejora pendiente: paginar hasta el final o filtrar por SKU en la consulta.*

Nota: el metafield `dropea.product_id` de Shopify (`a3f618c76fb450ce890e7189`) **no es** el `variant_id` de Dropea. No sirve para mapear.

### Dropi PRO — congelado
Su app de Shopify está **rota** (`Application Error` en "Sincronizar pedidos pendientes" e "Importar productos"). Su sincronización automática se ha **desactivado** para evitar que, al arreglarla, despache de golpe la cola acumulada.

Decisión estratégica: **Dropi y Dropea son proveedores de transición**. El destino es fulfillment propio (Beeping → Lopi). No se invierte más esfuerzo en la API de Dropi.

---

## 3 · Enrutado real (Fase A1, funcionando)

La regla ya no es por palabras clave sino por `supplier_product_mapping`:

```
[SUPPLIER] #1067 routing → dropea | blocked_address: localidad vacía o inválida
```

Doble validación operativa: primero identifica proveedor, después frena si la dirección no es válida. Los pedidos antiguos (anteriores a que Releasit capturara "Localidad") se bloquean correctamente; los nuevos llegan con ciudad real (`Almería`, `Mérida`, `Mutxamel`) y pasan.

---

## 4 · ⚠️ Hallazgo crítico: la base local no refleja la realidad

**Medido el 23-08-2026 contra la API de Shopify.**

El panel muestra **10 pedidos "pendientes de llamada"** (`needs_call`). Estado real de esos mismos 10 en Shopify:

| Estado real | Cuántos |
|---|---|
| Anulados | **4** |
| En curso de fulfillment | **5** |
| Realmente pendientes | **1** |

**Causa:** el agente solo escucha `orders/create`. Se entera de que un pedido nace y después queda ciego — no sabe si se anuló, se preparó o salió a envío.

**Consecuencias medidas:**
- El agente conoce **20 pedidos**; la tienda tiene **84**.
- La tasa de respuesta calculada era **41%** (7 de 17). Excluyendo anulados es **54%** — un 30% mejor.
- Cuando la tasa de entrega tenga datos, estará contaminada por la misma causa.

**Principio de diseño afectado:** un panel que dice 10 cuando la realidad es 1 enseña a ignorarlo, y entonces tampoco se cree el día que dice algo verdadero. Es el mismo criterio de "alertas limpias" aplicado a los datos.

---

## 5 · Métricas reales medidas (23-08-2026)

| Métrica | Valor | Fiabilidad |
|---|---|---|
| Tasa de respuesta al WhatsApp | **54%** (excluyendo anulados) | Muestra de 13. Orientativa |
| Tasa de entrega | Sin datos | El histórico `order_status_history` se creó hoy. Fiable en ~1 semana |
| Coste producto (Cortaúñas) | 7,70 € + 1,00 € fulfillment | Confirmado en ficha de Dropea |
| Coste de un rehusado en Dropea | 1,00 € de fulfillment + envío | Confirmado |

Contexto de negocio (contabilidad real de agosto, 2 días): margen **6,24%**, ROAS bruto 4,39 / neto 3,05, tasa de entrega 69,58%, **break-even en 62,9% de entrega**. Cada punto de tasa de entrega vale ~0,34 € por pedido enviado.

---

## 6 · Lo que viene

**Objetivo: que la base local sea un espejo del histórico de Shopify**, no solo de lo creado desde el despliegue. Sin eso, ni las métricas son fiables ni el futuro agente de llamadas puede funcionar (llamaría a clientes cuyo pedido ya está anulado o en camino).

1. **Estados de cierre** — `cancelled` y `fulfilled`; salen de todas las colas operativas y no cuentan en las métricas.
2. **Webhooks de Shopify** — `orders/cancelled`, `orders/fulfilled`, `orders/updated`.
3. **Backfill del histórico** — `npm run shopify:backfill`, con el mismo normalizador que el webhook, idempotente por `shopify_order_id`, `--dry-run` por defecto.
   ⚠️ **Salvaguarda innegociable: no puede enviar ni un WhatsApp.** Importar 84 pedidos como `awaiting_reply` dispararía 84 mensajes a clientes reales.
4. **Enlace con Dropea vía tag** — los pedidos creados por su app llevan `dropea_id:NNNNNNN` en los tags de Shopify (verificado: `#35010814` → `dropea_id:1366919`). La correspondencia pedido↔proveedor **ya está escrita**; basta leerla para rellenar `supplier_external_order_id` sin llamar a su API.
5. **Reconciliación periódica** — job que sincroniza con Shopify los pedidos abiertos. Cubre webhooks perdidos: el sistema estuvo caído durante los despliegues.

Después de eso: agente de llamadas (cubre el ~46% que no responde al WhatsApp), API oficial de WhatsApp, y Beeping cuando el ROAS se estabilice.

---

## 7 · Lo que no se toca

`DROPEA_CREATE_MODE=external_app` · `DROPEA_WRITE_ENABLED=0` · `DROPIPRO_WEBHOOK_ENABLED=0` · `LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0` · defaults fail-closed · safety gates en toda ruta nueva.

Y la API key de Dropea **sin permisos de escritura**, que es la capa que protege aunque el software falle.

---

## 9 · Preparado para desplegar (24-08-2026, aún NO en el NAS)

En `main` tras el merge de la fase final (esquema **5**, 260 tests):

- **E1** eje de cierre (`closure_status/source/at`; terminales imborrables).
- **E2** webhooks `orders/cancelled` / `orders/fulfilled` / `orders/updated`
  en `/api/webhooks/shopify/orders-events` (HMAC + dedupe por webhook-id +
  protección fuera de orden). `fulfilled` → `in_progress`, jamás `delivered`.
- **E3** backfill del histórico con verificación de scopes: sin
  `read_all_orders` verificado, el informe dice `last_60_days_only` /
  `unverified` y NUNCA afirma histórico completo.
- **E5** reconciliación cada 6 h (repara webhooks perdidos; creates
  perdidos → `ignored_old` + aviso; conflictos → evento, sin pisar).
- **Elegibilidad central** (`isConfirmationEligible`): scheduler, panel,
  alertas y llamadas comparten la misma verdad — el hallazgo 4/5/1 queda
  estructuralmente impedido.
- **E7** orquestador de llamadas Retell: kill switch OFF y shadow ON por
  defecto → desplegar NO llama a nadie. Ver `docs/RUNBOOK-LLAMADAS.md`.
- `npm run shopify:webhooks` para auditar/crear las 4 suscripciones.

**Orden de despliegue seguro** (fuera de 10:00–21:00):
1. `git pull --ff-only origin main && docker compose build && docker compose up -d`
   (migración v5 aditiva; backup previo con el procedimiento habitual).
2. Panel → Sistema: esquema 5, tarjetas sanas, WhatsApp reconecta sin QR.
3. `npm run shopify:webhooks -- --ensure` (alta de los 3 topics nuevos).
4. `npm run shopify:backfill` (dry-run) → revisar cobertura de scopes y el
   desglose → `-- --apply`.
5. Comparar panel: `needs_call` debe quedarse solo con candidatos reales
   (hallazgo esperado: 4 cancelados y 5 en fulfillment fuera; ~1 real).
6. E7 en shadow unos días → validar candidatos → allowlist → llamadas.

**Verificación pendiente que SOLO puede hacerse con el token del NAS:**
el scope `read_all_orders` (paso 4 lo enseña). Sin él, pedir el scope en la
app de Shopify antes de dar el histórico por completo.

## 8 · Deuda técnica anotada

- `scripts/dropea-doctor.ts` línea 115 lee las suscripciones en `hooks.items`, pero la API las devuelve en **`data.webhooks`**. Resultado: dice "(ninguno suscrito)" con 6 activas. Solo diagnóstico.
- `dropea:mapping:inspect` recorre 10 páginas de 500 productos sobre un catálogo de 4.142.
- La alerta `tracking_notify_failures` cuenta bloqueos deliberados de `TEST_MODE` como fallos (PR `fix/alertas-notificacion` en marcha).
- El WAL de SQLite no se compacta al reiniciar (comportamiento normal; umbral ya bajado a 2 MB).
