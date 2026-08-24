# Métricas de negocio — qué es real, qué es configurado, qué falta

Fase A (23-08-2026). Todo lo que sale en la pestaña **Sistema → Negocio**
del panel y en `/api/system` (`business`). Principio único: **nada se
estima**. Cada cifra es real (contada en la base de datos), configurada
(la ha metido Pedro a mano) o `null`/"incompleto" con el motivo.

Código: `src/lib/system/delivery-metrics.ts`, `business-alerts.ts`,
`unit-economics.ts`. Tablas: `order_status_history`, `product_costs`,
`daily_ad_spend` (todas nuevas, migración aditiva; esquema v3).

---

## 1 · Histórico de estados (`order_status_history`)

Una fila por **transición real** del estado normalizado de un envío
(`unknown → shipped`, `out_for_delivery → delivered`…). La escribe un solo
sitio: `processSupplierUpdate()` en `src/lib/tracking/service.ts`.

| Campo | Contenido |
|---|---|
| `previous_status` / `new_status` | Estados nuestros (`TrackingStatus`) |
| `raw_status` / `raw_sub_status` | Lo que dijo el proveedor, sin tocar (Dropea: `status` + `sub_status`; Dropi: `status_name` + `status_id`) |
| `source` | `webhook` · `polling` · `manual` · `reconciliation` |
| `event_id` | Del proveedor si lo manda (`dropea:<uuid>`); para Dropi se deriva de `order_id + status_id + event_date` |
| `occurred_at` | Momento del hecho según el proveedor (`event_at` / `event_date`); si no lo hay, el de recepción |
| `recorded_at` | Cuándo lo guardamos nosotros |

**Dedupe** (un reintento nunca crea dos filas):
1. Con `event_id`: índice único parcial. Un webhook reenviado no repite.
2. Sin `event_id`: misma `(pedido, de, a, raw_status)` en los últimos 10
   minutos = el mismo hecho (dos pollings seguidos).
3. Además, `processSupplierUpdate` solo llama al histórico cuando el estado
   **cambia**: un polling que devuelve lo mismo no genera nada.

## 2 · Tasa de entrega

```
enviados   = pedidos con alguna transición a {shipped, in_transit,
             out_for_delivery, delivery_attempted, at_pickup_point,
             delivered, returned}. Ventana asignada por la fecha de la
             PRIMERA de esas transiciones (shipped_at).
entregados = enviados cuyo estado actual es delivered
devueltos  = enviados cuyo estado actual es returned
resueltos  = entregados + devueltos
tasa       = entregados / resueltos × 100      (null si resueltos = 0)
pendientes = enviados − resueltos  (en curso o con incidencia: NO cuentan)
```

Por qué no cuentan los pendientes: un paquete que salió ayer y sigue en
tránsito no ha fallado; meterlo en el denominador hunde la tasa de forma
artificial justo los días de más envíos.

Cancelados antes de enviar no entran en `enviados`. Un cancelado *después*
de enviar quedaría como pendiente (no resuelto); hoy no existe en los
proveedores reales y se revisará si aparece.

Ventanas: **hoy** (día local del servidor), **7 días** y **30 días**
móviles. Desgloses por **producto** (primera línea de producto del pedido,
`SKU · título`), **proveedor** (`supplier_platform`) y **transportista**
(`carrier` reportado por el proveedor).

`avgHoursToDeliver` = media de `delivered_at − shipped_at` en horas, solo
sobre entregados.

**Muestra mínima** (`DELIVERY_RATE_MIN_SAMPLE`, 10): por debajo, la tasa se
muestra pero las alertas la tratan como "sin datos".

### Fuente de cada dato

| Dato | Fuente | Real / config |
|---|---|---|
| Transiciones | webhooks Dropea (firmados), polling (`TRACKING_POLL_*`), reconciliación | **real** |
| Transiciones Dropi | webhook Dropi — **receptor apagado** (`DROPIPRO_WEBHOOK_ENABLED=0`) hasta confirmar su firma; mapa de estados vacío | **no hay datos todavía** |
| Transportista | campo `carrier` del proveedor | real (si lo mandan) |
| Producto | `raw_payload.line_items` del webhook de Shopify | real |

## 3 · Alertas (Control Center → Negocio)

Categoría **negocio**:

| Alerta | Regla | Nivel | Env |
|---|---|---|---|
| Tasa de entrega 7 d | < 70 % | warning | `DELIVERY_RATE_WARN` |
| Tasa de entrega 7 d | < 65 % (break-even 62,9 %) | **critical** | `DELIVERY_RATE_CRIT` |
| (ambas) | resueltos < muestra mínima | unknown (no alerta) | `DELIVERY_RATE_MIN_SAMPLE` |

Categoría **operativa**:

| Alerta | Regla | Nivel | Env |
|---|---|---|---|
| Pendientes de llamada | alguno con `needs_call_at` > 12 h | warning | `NEEDS_CALL_STALE_HOURS` |
| Pendientes de llamada | ≥ 5 atrasados | critical | `NEEDS_CALL_CRIT_COUNT` |
| Incidencias abiertas | ≥ 1 envío en `incident` | warning | `OPEN_INCIDENTS_WARN` |
| Fallos de proveedor | ≥ 3 eventos `order_create_failed`/`api_error` en 24 h | warning | `SUPPLIER_FAILURES_WARN` |
| Envíos sin noticias | activos sin comprobación > `TRACKING_STALE_HOURS` | warning | — |
| Avisos de envío fallidos | > 5 eventos `notification_failed` en 24 h | warning | `TRACKING_NOTIFY_FAIL_WARN` |

Nota: en el NAS con `TEST_MODE=1`, los avisos a teléfonos fuera de la
allowlist se bloquean **por diseño** y se registran como
`notification_skipped_by_gate` — se guardan para trazabilidad pero NO
cuentan para esta alerta. Solo un fallo real al encolar (excepción, error de
envío) genera `notification_failed` y cuenta para el umbral.

El peor nivel de estas alertas es la tarjeta **Negocio** del resumen y
arrastra el `overall` como cualquier otra tarjeta.

## 4 · Unit economics (básico)

Regla contable (la de la hoja de Pedro, correcta): el cobro COD depende de
que se **entregue**; producto y envío se pagan al **enviar**.

```
grossRevenue     = Σ total_price de ENVIADOS en la ventana        real
deliveredRevenue = Σ total_price de ENTREGADOS                    real
productCost      = Σ product_cost(SKU) × cantidad, enviados       config
shippingCost     = Σ shipping_cost(SKU) × cantidad, enviados      config
codFees          = Σ cod_fee(SKU) × cantidad, entregados          config
adSpend          = Σ daily_ad_spend.amount en la ventana          manual
estimatedMargin  = deliveredRevenue − productCost − shippingCost − codFees − adSpend
estimatedMarginPct = estimatedMargin / grossRevenue × 100
grossRoas        = grossRevenue / adSpend
netRoas          = deliveredRevenue / adSpend
```

**`complete = false`** (y `missing[]` con la lista exacta) si:
- algún SKU enviado no está en `product_costs` o le falta un campo;
- algún pedido enviado no tiene líneas legibles (sin `raw_payload`);
- ningún día de la ventana tiene gasto en ads.

En ese caso los derivados (`productCost`, `estimatedMargin`, `netRoas`…)
son `null`. Los reales (`grossRevenue`, `deliveredRevenue`, recuentos)
salen siempre.

Entrada de datos: pestaña Negocio → "Costes (entrada manual)", o
`POST /api/system/costs` `{sku, title, product_cost, shipping_cost, cod_fee}`
y `POST /api/system/ad-spend` `{day: "YYYY-MM-DD", amount}`. Son escrituras
locales en SQLite (no son acciones externas: no pasan por safety gates);
quedan detrás del Basic Auth del panel.

### Qué falta para un ROAS neto REAL

1. **Gasto en ads automático**: hoy es manual por día. Meta Marketing API
   necesita un token de Pedro y decidir la atribución (cuenta/campaña →
   tienda). Hasta entonces `adSpend` es lo que se teclee.
2. **Costes por SKU**: los 5 productos activos (coste de producto, envío y
   comisión COD por proveedor). Los mete Pedro desde el panel.
3. **Tasa de entrega con muestra**: hace falta que los webhooks de Dropea
   lleguen al NAS (`DROPEA_WEBHOOK_SECRET` guardado) y unos días de
   volumen para superar la muestra mínima.
4. **Dropi**: sin mapa de estados ni webhook activo, sus envíos no
   resuelven nunca → no entran en la tasa ni en ingresos entregados. Se
   verán como "pendientes" indefinidamente hasta que soporte confirme.
5. **Coste de retornos**: con 3PL propio (Beeping) será una línea más
   (picking ida + envío + retorno + picking vuelta). Hoy el proveedor la
   absorbe y no se modela.
