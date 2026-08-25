# Estado de producción — Casamable™

Documento vivo. Describe **lo que está corriendo de verdad en el NAS**, cómo está configurado y qué se ha medido sobre datos reales. Se actualiza en cada sesión de operación.

Para el diagnóstico detallado de una sesión concreta (hallazgos, cifras, decisiones del momento), ver el `docs/CONTEXTO-YYYY-MM-DD.md` correspondiente — este documento es el snapshot actual, no el historial de cómo se llegó a él.

> ⚠️ **25-08-2026 · hay una rama de hardening SIN desplegar**
> (`fix/hardening-casamable`, esquema **7**). Lo que hay debajo describe el
> NAS, que sigue en esquema 5. Ver `docs/HARDENING-REPORT.md` y
> `docs/PEDRO-NAS-TODO.md`.

**Última actualización: 25-08-2026** (E8 desplegado y `dropea:reconcile --apply` corrido; después, tanda de arreglos de fidelidad — fulfillment parcial, orden del panel y dos herramientas de diagnóstico que mentían. **Esa tanda está en `main`, aún NO en el NAS.**)

---

## 1 · Qué corre hoy

| | |
|---|---|
| Commit desplegado | **`7fa41c8`** (rama `main`, al día) |
| Esquema SQLite | `user_version = 5` |
| Contenedor | `casamable-agent`, healthy, `restart: unless-stopped` |
| NAS | UGREEN DXP2800, `192.168.2.109`, UGOS 1.18.1.0098 |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | Baileys, `+34 641 308 254`, reconecta sin QR |
| Modo | `TEST_MODE=1` a propósito (decisión de Pedro, hasta que el sistema esté funcional) — solo escribe a la allowlist de 2 teléfonos; los pedidos de clientes reales se ignoran. **Mientras siga así, `needs_call` no mide nada real.** |
| Llamadas (E7) | Desplegado y **APAGADO**: `ai_calls_enabled=0`, `calls_shadow_mode=1` por defecto. Ver `docs/RUNBOOK-LLAMADAS.md`. |

Desplegado en dos tandas:

- **24-08 (noche)** — **E1** (eje de cierre) · **E2** (webhooks `orders/cancelled`/`fulfilled`/`updated`) · **E3** (backfill del histórico) · **E4** (enlace con Dropea por tag) · **E5** (reconciliación periódica) · **E7** (orquestador de llamadas Retell, apagado) · PR #5 (cadencia de reintentos anclada a días de calendario).
- **25-08** — **E8** (reconciliador de Dropea por API) desplegado y `npm run dropea:reconcile -- --apply` corrido. Sin cambio de esquema: E8 no añade migración, solo dos consultas nuevas en `db.ts`.

---

## 2 · Integraciones configuradas

### Shopify
- Tienda `qmbr1z-vf.myshopify.com` (alias antiguo `pedroshop-9968.myshopify.com`, **misma tienda**).
- **4 webhooks, todos en propiedad de la app** (migrados el 24-08; antes eran 2 manuales, uno apuntando a un túnel de Cloudflare muerto):

  | Topic | Endpoint |
  |---|---|
  | `orders/create` | `/api/webhooks/shopify/orders-create` |
  | `orders/cancelled` | `/api/webhooks/shopify/orders-events` |
  | `orders/fulfilled` | `/api/webhooks/shopify/orders-events` |
  | `orders/updated` | `/api/webhooks/shopify/orders-events` |

- Escrituras habilitadas (tag `WA_CONFIRMED`).
- Scope **`read_all_orders`** concedido (24-08): el backfill corre con cobertura completa del histórico, no solo los últimos 60 días.

### Dropea — conectada de punta a punta; el hueco de enlace, corregido el 25-08
- API key `casamable-nas` con **permisos mínimos**: `issues:read`, `orders:read`, `products:read`, `stores:read`, `users:read`, `webhooks:read`, `webhooks:write`.
  **Deliberadamente SIN `orders:create` / `confirm` / `cancel` / `update`**: es la red de seguridad contra duplicados a nivel de credencial, no solo de código.
- `store_id = 18307`, cuenta `45468`, mercado `es`, base `https://es.public-api.dropea.com`.
- Flags: `DROPEA_API_ENABLED=1` (lectura), `DROPEA_WRITE_ENABLED=0`, `DROPEA_CREATE_MODE=external_app`, `DROPEA_LEGACY_CREATE_ACTIVE=1`.
- **6 webhooks suscritos y activos**, firma verificándose correctamente (cero rechazos desde que se puso el secreto).
- **El hueco de enlace (24-08): 3 de 21 pedidos con actividad de Dropea estaban enlazados, 18 huérfanos.** No era firma ni pedidos perdidos: Dropea sí los procesaba, la base local no sabía emparejarlos. Diagnóstico completo en `docs/CONTEXTO-2026-08-24.md` §4.
- **Corregido con E8 (25-08):** `npm run dropea:reconcile -- --apply` empareja por `DropeaOrder.external_order_id` contra las dos claves locales posibles (`shopify_order_id` y `shopify_order_number`) y, tras enlazar, rellena el eje de cierre con el estado actual de Dropea. Nunca pisa un enlace ni un terminal existente; solo lectura de Dropea.
- 🔲 **PENDIENTE DE REGISTRAR: el desglose real del `--apply`.** Cuántos enlazó por cada clave, cuántos ambiguos y cuántos conflictos. Pegar aquí la salida del comando. **Hasta entonces no se puede afirmar que el eje de cierre ya tenga entregas y rehúses reales**, que era el objetivo de E8.

### Mapping de producto
Una fila en `supplier_product_mapping`:

| Shopify | Dropea |
|---|---|
| SKU `10428` · product `15964094660938` · variant `62950185173322` | `variant_id = 15896` · 7,70 € |

El emparejado automático no lo encontraba: el script recorre 10 páginas (500 productos) y el catálogo de Dropea tiene 4.142; el producto estaba en la página 46. *Mejora pendiente: paginar hasta el final o filtrar por SKU en la consulta.*

Nota: el metafield `dropea.product_id` de Shopify (`a3f618c76fb450ce890e7189`) **no es** el `variant_id` de Dropea. No sirve para mapear.

### Dropi PRO — congelado
Su app de Shopify está **rota** (`Application Error` en "Sincronizar pedidos pendientes" e "Importar productos"), y su API sigue sin documentar. Su sincronización automática se ha **desactivado** para evitar que, al arreglarla, despache de golpe la cola acumulada.

Decisión estratégica: **Dropi y Dropea son proveedores de transición**. El destino es fulfillment propio (Beeping → Lopi). No se invierte más esfuerzo en su API — salvo que entren 300 unidades nuevas con alta manual, lo que hace urgente conseguir su documentación (pendiente de soporte).

---

## 3 · Enrutado real (funcionando)

La regla es por `supplier_product_mapping`, nunca por palabras clave:

```
[SUPPLIER] #1067 routing → dropea | blocked_address: localidad vacía o inválida
```

Doble validación operativa: primero identifica proveedor, después frena si la dirección no es válida. Los pedidos antiguos (anteriores a que Releasit capturara "Localidad") se bloquean correctamente; los nuevos llegan con ciudad real y pasan. **3 pedidos siguen bloqueados por ciudad `"-"` hoy** — pendiente comprobar si son anteriores al arreglo del formulario o si ha vuelto a fallar (ver `docs/CONTEXTO-2026-08-24.md` §6).

---

## 4 · El eje de cierre — E1 a E5, desplegado y con datos reales

**El problema original (medido el 23-08-2026) ya está resuelto por el código:** el agente solo escuchaba `orders/create` y quedaba ciego después — el panel decía 10 "pendientes de llamada" cuando la realidad eran 4 anulados, 5 en curso y 1 de verdad pendiente. E1 (eje `closure_status`/`closure_source`/`closure_at`, independiente de la máquina de confirmación) + E2 (webhooks de cierre) + E3 (backfill) + E5 (reconciliación periódica) cierran ese hueco estructuralmente.

**Backfill aplicado el 24-08 con cobertura completa** (`read_all_orders` verificado): de 93 pedidos, 6 pasaron a `cancelled`, 0 a `in_progress`, 87 sin cambios (69 sin señal de cierre todavía, 18 ya tenían fuente propia de un webhook). Detalle en `docs/CONTEXTO-2026-08-24.md` §3.

**El dato de entrega real estaba en cero** — no por el eje de cierre, sino por el hueco de enlace con Dropea descrito en §2. E8 lo cierra estructuralmente y ya se aplicó el 25-08, pero **mientras no se registre el desglose de esa ejecución, ni la tasa de entrega ni el coste real por pedido pueden darse por fiables**. Es un dato que falta apuntar, no un hueco de código.

Dos huecos adicionales medidos el 24-08, sin explicar todavía:
- **~14 cancelaciones que el backfill no recoge** (hay ~20 anulados en Shopify, solo 6 transicionaron): están detrás de los 24 "ya tenía fuente propia" — no se sabe qué escribió esa fuente.
- **`in_progress` en cero** pese a haber pedidos "En curso"/con seguimiento añadido en Shopify (`#35010824`, `#35010814`). **Causa probable encontrada el 25-08 leyendo el código:** solo se contaba `fulfillment_status = "fulfilled"`, y los pedidos de Casamable llevan una línea `Seguro de Envío` que no es mercancía y que el proveedor nunca despacha — así que Shopify los deja en **`partial` para siempre** y nunca llegan a `fulfilled`. Corregido en `main` (`partial` también cuenta; `restocked` no). **Se confirma o se descarta al desplegar y volver a correr el backfill**: si era eso, esos pedidos pasarán a `in_progress`.

---

## 5 · Métricas reales medidas (23-08-2026, antes del despliegue de E1-E5)

| Métrica | Valor | Fiabilidad |
|---|---|---|
| Tasa de respuesta al WhatsApp | **54%** (excluyendo anulados) | Muestra de 13. Orientativa, y contaminada por `TEST_MODE` (ver §1) |
| Tasa de entrega | Sin datos fiables **todavía** | El hueco de enlace se cerró con E8 (25-08); falta registrar el resultado del `--apply` para poder medirla (§2) |
| Coste producto (Cortaúñas) | 7,70 € + 1,00 € fulfillment | Confirmado en ficha de Dropea |
| Coste de un rehusado en Dropea | 1,00 € de fulfillment + envío | Confirmado |

Contexto de negocio (contabilidad real de agosto, 2 días): margen **6,24%**, ROAS bruto 4,39 / neto 3,05, tasa de entrega 69,58%, **break-even en 62,9% de entrega**. Cada punto de tasa de entrega vale ~0,34 € por pedido enviado.

---

## 6 · Lo que viene

**Prioridad 1 — registrar el resultado de E8.** No es código: es pegar en §2 el desglose del `dropea:reconcile -- --apply` del 25-08 y comprobar en el panel si el eje de cierre ya tiene entregas y rehúses reales. Todo lo económico depende de ese dato.

**Prioridad 2 — qué significa el tag `dropea_error`.** Lo llevan 90 de 93 pedidos y Dropea sí los está procesando, así que **no** significa "no se creó el pedido". Se resuelve abriendo un pedido y leyendo la nota de la app. Es la incógnita más barata de cerrar y la que más cambia la lectura de todo lo demás.

**Resto abierto** (detalle y contexto en `docs/CONTEXTO-2026-08-24.md` §6):
1. ~13 pedidos anulados de 0,00 € con clientes reales — comprobar si son duplicados de Releasit o ventas perdidas.
2. 3 pedidos bloqueados por ciudad `"-"`.
3. ~14 cancelaciones que el backfill no recoge (§4 arriba).
4. `in_progress` en cero pese a fulfillments reales — **causa probable identificada y corregida en `main`**, pendiente de confirmar desplegando (§4 arriba).
5. ~~Lista de pedidos del panel sin ordenar por fecha de llegada~~ — ✓ resuelto el 25-08. No era el `ORDER BY`, que ya existía: era que ordenaba por `created_at`, que es la hora de INSERTAR la fila, y el backfill insertó los 93 pedidos en el mismo instante. Ahora ordena por `shopify_order_number`, que sí es la llegada real. Sin migración de esquema.
6. ~~`.env.example` desactualizado~~ — ✓ resuelto el 25-08: `CALL_RETRY_DELAYS_MINUTES` (que no leía nadie) sustituido por `CALL_FIRST_RETRY_MINUTES`, con la nota de que del 2º al 4º reintento la cadencia es por día de calendario y vive fija en el código.

**Bloqueado por terceros:**
- Número de Twilio en revisión regulatoria — sin él, E7 no puede hacer ninguna llamada real aunque se active.
- Dropi PRO: app rota + API sin documentar, soporte pendiente de responder.

Después: desactivar `TEST_MODE`, activar E7 (shadow → allowlist → real), API oficial de WhatsApp, y Beeping cuando el ROAS se estabilice.

---

## 7 · Lo que no se toca

`DROPEA_CREATE_MODE=external_app` · `DROPEA_WRITE_ENABLED=0` · `DROPIPRO_WEBHOOK_ENABLED=0` · `LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0` · defaults fail-closed · safety gates en toda ruta nueva · `ai_calls_enabled=0` hasta el estreno controlado de E7.

Y la API key de Dropea **sin permisos de escritura**, que es la capa que protege aunque el software falle.

---

## 8 · Deuda técnica anotada

- ~~`scripts/dropea-doctor.ts` decía "(ninguno suscrito)" con 6 webhooks activos~~ — ✓ resuelto el 25-08. Ahora prueba todas las formas conocidas (`data.webhooks`, `webhooks`, `items`, array plano) y, si no reconoce ninguna, **enseña la respuesta cruda en vez de afirmar que no hay nada**: "no lo sé" y "no hay ninguno" ya no se pintan igual.
- ~~`dropea:mapping:inspect` recorría 10 páginas de 500 productos sobre un catálogo de 4.142~~ — ✓ resuelto el 25-08. Recorre el catálogo entero (páginas de 100 hasta que una venga incompleta) y, si alguna vez tocara el tope de seguridad de 200 páginas, **lo dice** en vez de callarlo. Era la razón de que el Cortaúñas "no apareciera": estaba en la página 46.
- El WAL de SQLite no se compacta al reiniciar (comportamiento normal; umbral ya bajado a 2 MB).
- Las franjas horarias de llamadas (`CALL_WINDOWS`) están hardcodeadas; deberían acabar en `settings` como el resto de ajustes de llamadas, para poder probar franjas distintas sin desplegar (anotado en la revisión del PR #5).
