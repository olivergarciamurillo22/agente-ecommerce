# Configurar Dropea y Dropi — guía para Pedro

Qué hay que crear en cada panel y dónde va cada cosa. **Ninguna credencial se
manda por chat ni por WhatsApp: se pegan directamente en el `.env` del NAS.**

---

## Dos credenciales que NO son lo mismo

Es el error más fácil de cometer, así que conviene tenerlo claro:

| | **API key** | **Secreto de webhook (HMAC)** |
|---|---|---|
| ¿Para qué sirve? | Que *nosotros* llamemos a su API (crear pedidos, consultar estados) | Comprobar que un aviso que llega *de ellos* es auténtico |
| ¿Quién la usa? | Nuestro servidor, al salir | Nuestro servidor, al recibir |
| ¿Dónde se crea? | Panel de API keys | Pantalla de webhooks |
| Variable en el `.env` | `DROPEA_API_KEY` | `DROPEA_WEBHOOK_SECRET` |

Si se cruzan, no funciona ninguna de las dos cosas.

---

## Dropea

### 1 · Crear la API key

En **https://v2.app.dropea.com/es/dropshipper/api-keys** crea una clave y
pégala en el `.env` del NAS:

```env
DROPEA_API_KEY=...
```

> ⚠️ Todavía **no podemos usarla**: nos falta su documentación oficial para
> saber a qué URL llamar y con qué formato. Ver `docs/HANDOFF-PROVEEDORES.md`.
> Tener la clave puesta no activa nada.

### 2 · El secreto del webhook

En la pantalla **Webhooks for "Casamable"** (la de *"Subscribing to webhooks
delivers HMAC-signed POSTs"*) estará el secreto de firma. Va a:

```env
DROPEA_WEBHOOK_SECRET=...
```

### 3 · La URL del webhook

Cuando toque, la URL de destino será:

```text
https://agente.casamable.es/api/webhooks/dropea
```

Y los topics a suscribir:

```text
ORDER_STATUS_CHANGED     ← el importante: dispara los avisos al cliente
ORDER_CREATED
ORDER_CANCELLED
ISSUE_CREATED            ← incidencias (no escriben al cliente, solo avisan a Pedro)
ISSUE_RESOLVED
ISSUE_STATUS_CHANGED
```

### 4 · ⛔ Cuándo NO suscribirlo todavía

**No suscribas el webhook hasta que se cumplan las tres cosas:**

1. El secreto está puesto en el `.env` del NAS y el contenedor reiniciado.
2. Tenemos la documentación de Dropea y hemos confirmado el nombre exacto de
   la cabecera de la firma y su codificación.
3. Está resuelto el asunto de la integración antigua (ver más abajo).

Si se suscribe antes, sus avisos llegarán y serán rechazados. No es grave
—no se pierde nada, ellos reintentan— pero no sirve de nada.

---

## Dropi PRO

### 1 · La URL de notificaciones

En el panel de Dropi, en **"URL para Notificaciones de actualizaciones pedido
(POST)"**, la URL será:

```text
https://agente.casamable.es/api/webhooks/dropi
```

**Ya sabemos qué manda Dropi** en ese POST y está implementado (número de
seguimiento, transportista, estado…). Pero **todavía no lo configures.**

### 2 · ⛔ Lo que falta antes de activarlo

**No sabemos si Dropi firma esas notificaciones.** Si no lo hace, cualquiera
que conozca la URL podría inventarse estados de envío y provocar que
mandemos WhatsApps falsos a clientes. Por eso nuestro receptor está
deshabilitado y responde 503.

**Necesitamos que mires en esa misma pantalla de Dropi si aparece:**

- Un **secreto** o *secret key*.
- Un **token** que incluyan en el POST.
- Cualquier mención a **firma** o **HMAC**.
- Una **lista de IPs** desde las que envían (con eso podríamos filtrar).
- Un enlace a **documentación** o un botón tipo *"Ver estructura"*.

Con cualquiera de esas cosas podemos activarlo con seguridad.

### 3 · Los estados de Dropi

Dropi manda `status_id` (un número) y `status_name` (un texto). **Necesitamos
la lista completa**: qué número corresponde a cada situación del envío.

Lo más importante: **cuál significa "salió a reparto"**, porque es el que
dispara el mensaje recordando al cliente que tenga el efectivo preparado.

Mientras no lo sepamos, todos los estados se guardan pero se tratan como
desconocidos: se registra el tracking y se avisa de que el pedido está en
camino, pero **nunca** se dice que está en reparto. Es lo correcto: peor
sería avisar de un reparto que no está ocurriendo.

Cuando los tengas, se configuran sin tocar código:

```env
DROPI_STATUS_MAP=4:out_for_delivery,7:delivered
```

---

## ⚠️ Lo que hay que resolver antes de crear ningún pedido

Los pedidos de Shopify ya llegan con los tags `dropea_error` y
`🚫 Sync ERROR - Dropi PRO`. Eso significa que **ya existe algo sincronizando
Shopify con los proveedores**, y que además está fallando.

Antes de que nuestro sistema cree un solo pedido hay que saber qué es, por
qué falla, y si se apaga o convive con el nuestro. Si las dos cosas crean
pedidos, **cada compra se enviaría dos veces al cliente**.

Por eso existe este candado en el `.env`, que bloquea la creación de pedidos
aunque todo lo demás esté abierto:

```env
LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0
```

Solo se pone a `1` cuando se confirme que la integración antigua está
desactivada.

---

## Cómo apagar Dropea o Dropi al instante

Si algo va mal, cualquiera de estas vale, y ninguna requiere tocar código:

```env
EMERGENCY_STOP=1              # corta TODO: WhatsApps, Shopify y proveedores
SUPPLIER_SYNC_ENABLED=0       # corta solo los proveedores
DROPEA_WRITE_ENABLED=0        # corta solo la escritura en Dropea
DROPIPRO_WEBHOOK_ENABLED=0    # deja de aceptar avisos de Dropi
```

Después, en el NAS: `docker compose restart casamable-agent`.
