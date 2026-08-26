# Contrato de Dropi PRO — lo confirmado y lo que falta

> ⛔ **DROPI NO DISPONE DE API PÚBLICA SEGÚN SU SOPORTE (videollamada,
> 25-08-2026). NO CONSTRUIR INTEGRACIÓN API SIN NUEVA EVIDENCIA.**
> La vía real es su app de Shopify: el vínculo producto↔Dropi se hace con el
> campo **vendor** del producto en Shopify (debe decir `Dropi PRO`), no con
> metafields ni SKUs. El andamiaje de `src/lib/suppliers/dropi/` se conserva
> solo porque el router lo importa y falla cerrado.

## Clasificación del código (auditoría 26-08-2026)

| Fichero | Clasificación | Por qué se conserva |
|---|---|---|
| `types.ts` | **useful model** | Tipos que usan el router y los tests |
| `webhook.ts` | **webhook-only** | Receptor apagado (`DROPIPRO_WEBHOOK_ENABLED=0`, 503); si Dropi algún día notifica, entra por aquí |
| `index.ts` (provider) | **useful model** | `isConfigured()=false` es lo que hace el fail-closed del router |
| `create-gate.ts` | **useful model** | El gate que impide crear: se queda |
| `client.ts` | **dead API scaffold** | ⛔ ninguna API que llamar; solo lanza ProviderNotConfiguredError |
| `create-order.ts` | **dead API scaffold** | ⛔ ídem |
| `mapper.ts` | **dead API scaffold** | ⛔ mapea a un esquema que no existe |
| `status-map.ts` | **dead API scaffold** | ⛔ catálogo vacío de una API inexistente |

Ninguno se borra: todos tienen imports activos y el borrado sin desenredar
el router rompería el build. Lo que NO puede pasar es que una sesión futura
los "termine".

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

## 5 · Lo que YA está preparado del lado nuestro (Fase A, 23-08-2026)

Dropi PRO es el proveedor donde **sí queremos crear pedidos nosotros**
(su app Dropify PRO está rota y Pedro los mete a mano). Sin la API no se
puede hacer la llamada, pero el andamiaje está listo y probado:

- **Routing**: `supplier_product_mapping` con `supplier_platform='dropi'`
  → el pedido se enruta a Dropi (`src/lib/suppliers/router.ts`). Mientras
  no sepamos cómo identifica Dropi sus productos, `supplier_variant_id`
  lleva el SKU de Shopify como identificador provisional.
- **Gate propio** (`dropi/create-gate.ts`, fail-closed): exige cliente
  implementado + `LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=1` +
  `SUPPLIER_SYNC_ENABLED=1` + `DROPIPRO_WRITE_ENABLED=1` +
  `DROPIPRO_CREATE_ENABLED=1` + pedido confirmado, enrutado a dropi, sin
  id externo, aprobado para el piloto y con `TEST_MODE=1`.
- **Creación idempotente** (`dropi/create-order.ts`): clave estable
  `casamable-shopify-<id>-dropi-create`, reclamo atómico de fase, borrador
  construido desde el mapping (una línea sin mapping impide crear). Hoy el
  gate corta en `client_not_implemented` antes de reclamar nada.
- **Histórico de estados**: el webhook (cuando se active) persiste cada
  transición con `event_id` derivado de `order_id + status_id + event_date`.

Cuando llegue la documentación: implementar `dropiRequest()` en
`client.ts`, el mapper real en `mapper.ts`, `isConfigured()` en `index.ts`
y rellenar `status-map.ts`. Nada más tiene que cambiar.

## Resumen de estado

| Parte | Estado |
|---|---|
| Webhook de actualizaciones: estructura | ✅ Confirmada e implementada |
| Webhook: autenticación | ⛔ Desconocida → endpoint deshabilitado (503) |
| Catálogo de estados | ⛔ Desconocido → todo `unknown`, sin avisos de reparto |
| API de creación de pedidos | ⛔ Sin documentar → bloqueada |
| Tracking (número, URL, transportista) | ✅ Implementado desde el webhook |
