# Configurar Dropea y Dropi — guía para Pedro

Qué hay que crear en cada panel y dónde va cada cosa. **Ninguna credencial se
manda por chat ni por WhatsApp: se pegan directamente en el `.env` del NAS.**

---

## Lo primero: quién crea los pedidos

**Hoy los pedidos en Dropea los crea su app oficial de Shopify, no nosotros.**
Nuestro sistema lee, sigue el envío y avisa al cliente por WhatsApp, pero
**nunca crea un pedido**. Eso lo impone el código, no solo esta guía:

```env
DROPEA_CREATE_MODE=external_app     # la app oficial crea; nosotros no
DROPEA_LEGACY_CREATE_ACTIVE=1       # la app oficial sigue activa
```

Son dos llaves separadas a propósito: aunque alguien cambiara el modo, la
segunda seguiría bloqueando la creación. Si creásemos pedidos mientras su app
también lo hace, **cada compra se enviaría dos veces al cliente**.

---

## Configuración completa del `.env` del NAS

```env
# API de Dropea (solo lectura por ahora)
DROPEA_MARKET=es
DROPEA_API_KEY=            # ⬅ tu API key del panel
DROPEA_API_ENABLED=1       # permite CONSULTAR (seguro: no modifica nada)
DROPEA_WRITE_ENABLED=0     # NO permite crear ni cancelar

# Webhooks (avisos de estado y tracking)
DROPEA_WEBHOOK_SECRET=     # ⬅ el signing secret, NO la API key

# Quién crea los pedidos
DROPEA_CREATE_MODE=external_app
DROPEA_LEGACY_CREATE_ACTIVE=1
```

---

## Dos credenciales que NO son lo mismo

Es el error más fácil de cometer, así que conviene tenerlo claro:

| | **API key** | **Signing secret (webhooks)** |
|---|---|---|
| ¿Para qué sirve? | Que *nosotros* consultemos su API | Comprobar que un aviso que llega *de ellos* es auténtico |
| ¿Quién la usa? | Nuestro servidor, al salir | Nuestro servidor, al recibir |
| ¿Dónde sale? | Panel → Settings → API Keys | Se muestra **al crear la API key**, junto a ella |
| Variable | `DROPEA_API_KEY` | `DROPEA_WEBHOOK_SECRET` |

Ambas se muestran **una sola vez**. Si se pierden, hay que crear otra key.
Un detalle de su contrato: el signing secret **es el mismo para todos los
webhooks** creados con esa API key.

Si se cruzan, no funciona ninguna de las dos cosas.

---

## Primera prueba: diagnóstico de solo lectura

Con la API key puesta y `DROPEA_API_ENABLED=1`, en el NAS:

```bash
docker compose exec casamable-agent npm run dropea:doctor
```

Te dirá si la autenticación funciona y te dará dos datos que necesitamos:

- **`store_id`** de tu tienda (hace falta para crear pedidos algún día).
- **El catálogo con los `variant_id`** de cada producto.

No modifica nada, y no imprime credenciales ni direcciones de clientes.

Después, para emparejar nuestros productos con los suyos:

```bash
docker compose exec casamable-agent npm run dropea:mapping:inspect
```

Solo mira y compara. Con `-- --apply` guarda los emparejados **exactos por
SKU**; los dudosos nunca se guardan solos, porque un emparejado equivocado
enviaría al cliente un producto distinto del que compró.

---

## Los avisos de Dropea (webhooks)

Son los que hacen que el cliente reciba el WhatsApp de "tu pedido va en
camino" sin que nadie mire nada a mano.

**URL a registrar en su panel:**

```text
https://agente.casamable.es/api/webhooks/dropea
```

**Eventos a suscribir:** `order.created`, `order.status.changed`,
`order.cancelled`, y los `issue.*` (incidencias). Cualquier otro evento que
llegue se ignora sin efectos, así que suscribir de más no rompe nada.

### ⏳ Cuándo configurarlo

**No antes de que el sistema esté corriendo en el NAS con `DROPEA_WEBHOOK_SECRET`
puesto.** El orden correcto es:

1. Crear la API key → guardar las **dos** credenciales.
2. Pegarlas en el `.env` del NAS y reiniciar el contenedor.
3. Comprobar con `dropea:doctor` que la API responde.
4. **Entonces** registrar el webhook en su panel.

Si se registra antes, Dropea empieza a mandar avisos que nuestro servidor
rechaza por firma inválida. No es peligroso (rechazar es lo correcto), pero
esos avisos se pierden: no se reintentan solos.

### Qué pasa si la firma no cuadra

Se rechaza con 401 y **no se toca ningún pedido ni se manda ningún WhatsApp**.
Es el comportamiento buscado: preferimos perder un aviso a mandarle a un
cliente un mensaje basado en algo que no sabemos si viene de Dropea.

Si ves 401 repetidos en los logs, casi seguro que `DROPEA_WEBHOOK_SECRET`
tiene la API key en vez del signing secret.

---

## Cómo mirar los logs

Todo lo de proveedores va marcado con `[SUPPLIER]`:

```bash
# Ver en vivo
docker compose logs -f casamable-agent | grep SUPPLIER

# Últimas 200 líneas de todo
docker compose logs --tail 200 casamable-agent
```

Qué esperar de cada cosa:

| Lo que ves | Qué significa |
|---|---|
| `webhook Dropea order.status.changed ...` | Llegó un aviso y se aplicó |
| `event_id repetido — ignorado` | Normal: Dropea reintenta, nosotros no duplicamos |
| `topic desconocido "..." — ignorado` | Un evento que no manejamos. Inofensivo |
| `firma inválida` / 401 | El `DROPEA_WEBHOOK_SECRET` no es el correcto |
| `incidencia de Dropea` | Ese pedido necesita que alguien lo mire |

Los logs **no** imprimen credenciales ni direcciones de clientes: solo el
número de pedido.

Para ver el estado de todos los frenos sin entrar por SSH:
`https://agente.casamable.es/api/suppliers/status`

---

## ⚠️ Antes de reiniciar producción

`docker compose restart` **corta la sesión de WhatsApp durante unos segundos**
mientras Baileys se reconecta. No borra nada (la sesión sobrevive en `auth/`),
pero durante ese hueco no salen mensajes.

Por eso:

- **No reinicies a ciegas** para "ver si se arregla". Mira los logs primero.
- Evita reiniciar entre las 10:00 y las 21:00, que es cuando salen los
  mensajes a clientes.
- Después de reiniciar, comprueba que WhatsApp volvió:
  `https://agente.casamable.es/api/health`

Para apagar algo, cambiar el `.env` y reiniciar es más seguro que tocar
código o borrar el contenedor.

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

---

## Resumen de en qué punto estamos

| | Estado |
|---|---|
| Leer pedidos y estados de Dropea | ✅ listo (solo falta la API key) |
| Recibir avisos de Dropea | ✅ listo (solo falta el signing secret) |
| Avisar al cliente por WhatsApp del envío | ✅ listo |
| **Crear pedidos en Dropea** | ⛔ **bloqueado a propósito** — lo hace su app oficial |
| Recibir avisos de Dropi | ⛔ bloqueado — falta saber si firman |
| Traducir los estados de Dropi | ⛔ falta la lista de `status_id` |

Lo bloqueado no es que falte programarlo: está hecho y probado, pero apagado
hasta tener el dato que falta.
