# Contrato de Dropi PRO — lo confirmado y lo que falta

Este documento recoge **solo hechos verificados**. Todo lo que no esté aquí
sigue sin implementarse, a propósito.

---

## 1 · Webhook de actualizaciones de pedido ✅ CONFIRMADO

**Fuente:** panel de Dropi, sección *"URL para Notificaciones de
actualizaciones pedido (POST)"*. Estructura mostrada por el propio panel.

Dropi permite configurar una URL a la que envía actualizaciones por **POST**.

### Estructura del cuerpo (literal, según el panel)

```json
{
  "order_id": "Integer",
  "event_date": "String (ISO 8601 datetime)",
  "status_id": "Integer",
  "status_name": "String",
  "details": "String",
  "tracking_code": "String",
  "tracking_url": "String | null",
  "shopify_order_id": "Integer | null",
  "shipping_company": "String",
  "total": "String"
}
```

### Cómo lo usamos

| Campo Dropi | Nuestro campo | Notas |
|---|---|---|
| `order_id` | `supplier_external_order_id` | Id del pedido en Dropi |
| `shopify_order_id` | (para localizar el pedido) | Vía **preferente** de emparejado |
| `status_name` | `supplier_status_raw` | Se guarda tal cual, sin interpretar |
| `status_id` | (referencia) | Se registra junto al nombre |
| `tracking_code` | `tracking_number` | Dispara el aviso al aparecer |
| `tracking_url` | `tracking_url` | Puede ser `null` |
| `shipping_company` | `carrier` | Transportista |
| `total` | — | No se usa: nuestro importe manda |
| `details` | (log sanitizado) | Texto libre; puede traer datos personales |
| `event_date` | `supplier_last_checked_at` | Momento del evento |

### Emparejado con nuestro pedido

1. **Preferente:** `shopify_order_id` → nuestro `shopify_order_id`.
2. **Alternativa:** `order_id` → nuestro `supplier_external_order_id`.

Nunca por nombre, teléfono ni dirección: sería frágil y peligroso.

---

## 2 · ⛔ Autenticación del webhook: SIN CONFIRMAR

**No sabemos** si Dropi firma estas notificaciones. No hay evidencia de HMAC,
secreto compartido, token ni lista de IPs.

**Decisión: fail-closed.** El endpoint `/api/webhooks/dropi` responde **503**
mientras `DROPIPRO_WEBHOOK_ENABLED=0` (valor por defecto). Aceptar POSTs sin
autenticar permitiría a cualquiera en internet inventar estados de envío y
disparar WhatsApps a clientes reales.

**No se ha reutilizado el mecanismo HMAC de Dropea**: son plataformas
distintas y no hay ninguna evidencia de que Dropi use el mismo esquema.

### Lo que hay que preguntar a Dropi (o buscar en su panel)

En la misma pantalla de la URL de notificaciones, ¿aparece alguno de estos?

- Un **secreto** o *secret key* para firmar.
- Un **token** que viaje en una cabecera.
- Mención a **firma HMAC** o similar.
- Una **lista de IPs** desde las que envían (permitiría filtrar por origen).
- Un enlace a **documentación** o un botón tipo *"Ver estructura"*.
- Cualquier cabecera personalizada que incluyan en el POST.

Si no existe ninguna, la alternativa es aceptar el webhook **solo** como
disparador para *consultar por API* el estado real (que sí va autenticada),
en vez de fiarnos del contenido del POST.

---

## 3 · ⛔ Estados: SIN CONFIRMAR

Conocemos los campos `status_id` y `status_name`, pero **no el catálogo de
valores posibles**. El mapa `DROPI_STATUS_MAP` está deliberadamente **vacío**:
mientras un estado no esté confirmado, se normaliza a `unknown`, se guarda el
texto original y **no se dispara ningún aviso de reparto**.

**Lo que necesitamos de Pedro:** la lista de estados que puede tener un pedido
en Dropi, con su `status_id`, su `status_name` y qué significa cada uno. En
particular, cuál significa *"salió a reparto / en entrega"*, que es el que
dispara el recordatorio del efectivo al cliente.

Se pueden ir añadiendo sin tocar código con la variable
`DROPI_STATUS_MAP` (ver `.env.example`), y confirmarlos después en código.

---

## 4 · ⛔ API para CREAR pedidos: SIN DOCUMENTAR

Esta información confirma **solo el canal de actualizaciones/tracking**. No
dice nada sobre cómo crear un pedido en Dropi. Sigue pendiente:

1. URL base de la API y si hay entorno de pruebas.
2. Método de autenticación y nombre exacto de la cabecera.
3. Endpoint de creación de pedido y esquema JSON completo.
4. Cómo se identifican los productos (SKU nuestro o id de su catálogo).
5. Si admite una referencia externa / clave de idempotencia.
6. Endpoints de consulta de pedido y de tracking.
7. Si permite anular pedidos.
8. Límites de peticiones.
9. Códigos de error.

`createOrder` sigue lanzando `ProviderNotConfiguredError`. **No se ha tocado.**

---

## Resumen de estado

| Parte | Estado |
|---|---|
| Webhook de actualizaciones: estructura | ✅ Confirmada e implementada |
| Webhook: autenticación | ⛔ Desconocida → endpoint deshabilitado (503) |
| Catálogo de estados | ⛔ Desconocido → todo `unknown`, sin avisos de reparto |
| API de creación de pedidos | ⛔ Sin documentar → bloqueada |
| Tracking (número, URL, transportista) | ✅ Implementado desde el webhook |
