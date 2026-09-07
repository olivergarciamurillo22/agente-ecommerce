# Plantillas de WhatsApp — inventario REAL de la WABA (fuente de verdad)

WABA `1065198445907064` · Phone Number ID `1319154041274175` · +34 641 308 254
· API v23.0. Inventario verificado contra la Graph API por Pedro la noche del
01-09-2026. **Seis plantillas (🔄) estaban en `PENDING` tras editarlas ese
día: hasta que `npm run whatsapp:templates:doctor` las vea `APPROVED`, el
código las retiene con motivo visible (`template_not_ready`).**

| Clave lógica (código) | Plantilla REAL | Idioma | Variables (orden real) | Botones (orden = payload) | Estado 01-09 |
|---|---|---|---|---|---|
| `order_confirmation_request` | `confirmacion_pedido_cod` | es | nombre, numero_pedido, producto, importe | Confirmar→`confirm_order` · Cambiar dirección→`change_address` · Dejar una nota→`delivery_note` | 🔄 nueva |
| `order_reminder` | `recordatorio_confirmacion` | es | nombre, numero_pedido | confirm_order · change_address | 🔄 nueva |
| `tracking_available` | `pedido_confirmado_casamable` (¡pese al nombre, es la de ENVÍO!) | es | nombre, numero_pedido, transportista, numero_seguimiento, tracking_url | — | 🔄 editada |
| `out_for_delivery_cod` | `reparto_hoy` | es | nombre, numero_pedido, transportista, importe | — | 🔄 editada |
| `delivery_attempt_failed` | `entrega_fallida` | es | nombre, numero_pedido | retry_delivery · need_help (sin flujo completo: **no activar**) | 🔄 editada |
| `order_delay_restock` | `retraso_pedido` | es | nombre, numero_pedido, producto, fecha_reposicion | delay_ok:<id> · delay_cancel:<id> | APPROVED ⛔ no editar |
| `order_cancelled_ack` | `pedido_cancelado` | **en** (literal) | nombre, numero_pedido | "Necesito ayuda" **sin payload ni handler → BLOQUEADA** | 🔄 editada |
| `order_confirmed_ack_out_of_window` | `pedido_confirmado` | es | nombre, numero_pedido, importe | — | APPROVED · **nunca como 1.º mensaje** |
| — | `pedido`, `hello_world` | — | — | — | **NO USAR** (ejemplos de Meta; no borrar: bloquea el nombre 30 días) |

`manual_attention_required` **no tiene plantilla real**: solo dentro de ventana.

## Incidentes que explican el diseño

- **132001 en la confirmación (01-09):** el código enviaba `pedido` (ejemplo
  de Meta, 5 vars, botón URL). Corregido a `confirmacion_pedido_cod` con 4
  variables — el nº de pedido va **en 2.ª posición** con `#`.
- **132001 en reparto (02-09, 07:13 y 08:14):** el mapping era correcto;
  `reparto_hoy` estaba **en PENDING** por la edición del día anterior. Dos
  clientes recibieron el paquete sin saber el importe. Desde v4 los avisos
  de tracking pasan por la misma verificación: una plantilla en revisión
  queda **retenida sin consumir el sello**, y sale sola al reaprobarse.

## Reglas aprendidas de Meta (01-09)

- Nombre e idioma **no se cambian** tras crear: plantilla nueva.
- **Editar una aprobada la devuelve a PENDING** y no se puede enviar. Hay
  límite mensual de ediciones: agrupar cambios. **Nunca editar en Meta una
  plantilla en uso diario sin asumir horas de indisponibilidad.**
- Sin emojis en el texto de los botones (en el cuerpo sí).
- Los payloads de quick reply **no se definen en la plantilla**: van en el
  envío; la plantilla fija texto y **orden**.
- **TTL por defecto = 10 min**: con el móvil apagado el mensaje se descarta
  y el cliente nunca lo ve (y contaba como "no responde"). Toda plantilla
  operativa necesita **TTL de 12 h**.

## Comprobación obligatoria antes de dar por bueno cualquier mapeo

```bash
npm run whatsapp:templates:doctor   # donde estén META_WHATSAPP_ACCESS_TOKEN + BUSINESS_ACCOUNT_ID (el NAS)
```


## Plantillas de recordatorio (envío + día de entrega) — PROPUESTA 07-09-2026, pendiente de Pedro

**Nada de esto está activo ni enviado a Meta.** Una plantilla aprobada no se
puede editar sin volver a revisión: Pedro aprueba primero el texto, luego se
crea en WhatsApp Manager, luego el doctor la verifica, y solo entonces se
habilita el mapping y el flag.

### 1 · Recordatorio de ENVÍO → clave lógica `dispatch_notice` (nueva)

- **Cuándo se dispara:** al pasar el pedido a despachado por el **router de
  canal** (`executeDispatch` → `executed`, sea por Beeping mark-to-send o por
  el confirm de Dropea). Es el evento `auto_dispatch_executed` del Bloque 7.
- **Qué hay en ese momento:** la orden de preparar acaba de llegar al
  almacén. **No existe todavía número de seguimiento** (Beeping lo devuelve
  cuando el pedido pasa a `status = 4 Enviado`; Dropea, al recogerlo el
  transportista). Por eso la plantilla **no lleva enlace**: prometerlo sería
  mentir. El enlace llega con la plantilla ya existente `tracking_available`
  (`pedido_confirmado_casamable`) cuando el polling ve el número.
- **Nombre real propuesto:** `pedido_en_preparacion_casamable` · es · UTILITY · sin botones.
- **Variables (3):** `{{1}}` nombre · `{{2}}` nº de pedido (`#1042`) · `{{3}}` importe (`34,99 €`).
- **Texto propuesto (a aprobar por Pedro tal cual o corregido antes de crearlo en Meta):**

> Hola {{1}}, tu pedido {{2}} de Casamable ya está en preparación y saldrá del almacén en las próximas horas 📦
>
> En cuanto el transportista lo recoja te enviaremos por aquí el número de seguimiento.
>
> Recuerda que es un pedido contra reembolso y deberás abonar {{3}} en efectivo al repartidor.
>
> Gracias por confiar en Casamable.

- **Código:** `src/lib/orders/dispatch-notice.ts`, mismas reglas que
  `tracking/notifications.ts`: gates de seguridad ANTES del claim, plantilla
  real verificada y APPROVED (si no, `template_not_ready` sin consumir sello),
  claim atómico del sello `orders.dispatch_notice_sent_at` (migración 26), todo
  por el outbox, un aviso por pedido. Un fallo al encolar devuelve el sello.
- **Estado hoy:** `DISPATCH_NOTICE_WHATSAPP_ENABLED=0` (default) y el mapping
  `dispatch_notice` → `pedido_en_preparacion_casamable` con `enabled: false`
  en `config/whatsapp-templates.json`. Con cualquiera de los dos cerrados no
  sale nada. Checklist para activarla: (1) Pedro aprueba el texto; (2) se crea
  en WhatsApp Manager con ese nombre; (3) Meta la aprueba; (4)
  `npm run whatsapp:templates:doctor` en el NAS la ve APPROVED con 3
  variables y 0 botones; (5) `enabled: true` en el mapping; (6)
  `DISPATCH_NOTICE_WHATSAPP_ENABLED=1`.

### 2 · Recordatorio del DÍA DE ENTREGA → ya existe como `out_for_delivery_cod` (`reparto_hoy`); una versión por «fecha estimada» NO es viable hoy

**Informe de campos de fecha de entrega realmente disponibles (07-09):**

| Fuente | Campos de fecha/estado que expone | ¿Fecha estimada de entrega? |
|---|---|---|
| Beeping `GET /api/get_orders` (`docs/BEEPING-API-CONTRACT.md` §5, `src/lib/beeping/types.ts`) | `date` (alta), `date_tracking_update` (último cambio), `tracking_stage` (1 sin estado · 2 en tránsito · **3 en reparto** · 4 punto de recogida · 5 entregado · 6 devuelto · 7 cancelado · 8 dañado), `tracking_number`, `courier_id` (1 = Correos Express, 3 = Correos, 5/9/10/11 = GLS) | **NO.** No hay ningún campo de fecha prevista, ETA ni ventana horaria |
| Correos Express | **No hay integración directa en el repo** (solo aparece como `courier_id = 1` dentro de Beeping). Su API propia (con fecha prevista) exigiría contrato y credenciales nuevas | No disponible |
| Dropea / Dropi (`docs/DROPEA-API-CONTRACT.md`, `DROPI-API-CONTRACT.md`) | estado y sub-estado del pedido, tracking; sin fecha prevista | **NO** |
| Nuestro modelo (`SupplierUpdate`, `tracking/types.ts`) | `rawStatus`, `trackingNumber`, `trackingUrl`, `carrier`, `rawSubStatus` | No existe el campo: no se inventa |

**Consecuencia:** el único dato real de «día de entrega» es `tracking_stage = 3`
(**en reparto**), que llega el mismo día en que el repartidor sale con el
paquete. Ese aviso **ya está implementado**: evento `OUT_FOR_DELIVERY` →
plantilla `reparto_hoy` («tu pedido está hoy en reparto… recuerda abonar
{{4}} en efectivo»), con el sello `out_for_delivery_notification_sent_at` y
el polling de Beeping cada 5 min en reparto (`TRACKING_POLL_OUT_FOR_DELIVERY_MIN`).
Está **PENDING en Meta** desde la edición del 01-09: en cuanto el doctor la vea
APPROVED, sale sola. **No se crea una segunda plantilla para lo mismo.**

Un recordatorio *anticipado* («mañana recibirás tu pedido») **queda
pendiente del dato**: exigiría que Beeping exponga una fecha prevista o una
integración directa con Correos Express/GLS. Hasta entonces no hay plantilla
ni código para él, para no inventar una fecha. Si Pedro consigue ese dato,
el texto propuesto para cuando exista sería:

> Hola {{1}}, tu pedido {{2}} de Casamable tiene prevista la entrega para {{3}} por {{4}}. Recuerda tener {{5}} en efectivo para el repartidor. Si ese día no vas a estar, respóndenos a este mensaje.

(5 variables: nombre, nº pedido, fecha, transportista, importe. **No crear en Meta todavía.**)
