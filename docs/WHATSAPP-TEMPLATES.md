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
