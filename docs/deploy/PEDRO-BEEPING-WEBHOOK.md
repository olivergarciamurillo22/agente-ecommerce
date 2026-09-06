# Webhooks de Beeping — qué poner en el panel

**Fecha:** 06-09-2026 · **Para:** Pedro

---

## ⚠️ Antes de nada: HOY TODAVÍA NO SE PUEDE ACTIVAR

El endpoint está construido y probado, pero **responde `503` a propósito** y
no procesa ningún evento. No es un fallo: es la decisión de seguridad.

**Por qué.** Beeping ofrece webhooks en su panel, pero **no los documenta en
ninguna parte**. Su documentación pública de API lista 46 endpoints y ni uno
solo de webhooks. Eso significa que **no sabemos cómo firman o autentican sus
entregas**.

Y esa URL es pública: cualquiera que la conozca puede mandarle un POST. Si la
aceptáramos sin verificar, cualquiera podría inventar que un pedido está
"entregado" — cerrarlo en el panel, falsear la tasa de entrega y disparar
WhatsApps a clientes reales. Un pedido perdido cuesta ~9,37 €; una tasa de
entrega falseada cuesta bastante más, porque decide dónde se mete la
publicidad.

Así que el orden correcto es: **primero preguntamos cómo autentican, luego lo
abrimos.** Mientras tanto, el polling actual sigue trayendo los estados igual
que hasta ahora. No se pierde nada.

---

## 1 · Lo que hay que preguntarle a Beeping

Escríbeles (o pregúntalo en el chat de soporte) esto tal cual:

> Hola. Vamos a usar los webhooks desde nuestro panel y necesitamos
> verificarlos por seguridad. ¿Podéis confirmarnos:
>
> 1. ¿Cómo autenticáis las entregas? ¿Firmáis el cuerpo del mensaje (¿con qué
>    algoritmo y en qué cabecera?) o mandáis un secreto/token fijo?
> 2. ¿Mandáis un identificador único por entrega, para que podamos ignorar
>    reintentos duplicados?
> 3. ¿Cuántas veces reintentáis si nuestro servidor falla?
> 4. ¿Nos garantizáis que los eventos llegan en orden cronológico?
> 5. ¿Podéis pasarnos un ejemplo del cuerpo de cada uno de los cuatro eventos?

**Cuando te respondan, pásame la respuesta** y lo dejo abierto en una sesión
corta. No hace falta que entiendas la respuesta técnica: cópiala tal cual.

---

## 2 · Qué poner en el panel de Beeping (cuando toque)

### Nombre del endpoint

```
Casamable Producción
```

### URL

```
https://agente.casamable.es/api/webhooks/beeping
```

### Eventos a marcar — los cuatro

```
order.created
order.status_changed
order.logistics_status_changed
order.updated
```

Son exactamente los cuatro que ofrece la pantalla, y el código entiende los
cuatro. Márcalos todos: sobra información antes que falte, y los que no
aporten nada se descartan solos sin efectos.

### Secreto

**Si el panel te deja poner un secreto o token**, genera uno largo y
aleatorio. Puedes sacarlo en la terminal del Mac con:

```bash
openssl rand -hex 32
```

Ese valor va **en dos sitios y solo en dos**: el campo del panel de Beeping y
el `.env` del NAS. **Nunca lo pegues en un chat**, ni en este documento, ni en
un correo.

---

## 3 · Qué añadir al `.env` del NAS

Nada de esto es necesario hasta que Beeping conteste. Cuando lo haga:

| Variable | Qué es |
|---|---|
| `BEEPING_WEBHOOK_AUTH_MODE` | `token` si mandan un secreto fijo · `hmac_sha256` si firman el cuerpo |
| `BEEPING_WEBHOOK_SECRET` | el secreto generado arriba (el MISMO que en el panel) |
| `BEEPING_WEBHOOK_AUTH_HEADER` | la cabecera donde llega. En modo `token` por defecto es `authorization`; en `hmac_sha256` es **obligatoria** y la dice Beeping |

Ejemplo del caso más probable (secreto compartido):

```
BEEPING_WEBHOOK_AUTH_MODE=token
BEEPING_WEBHOOK_SECRET=<el que generaste>
BEEPING_WEBHOOK_AUTH_HEADER=authorization
```

`BEEPING_ENABLED` ya tiene que estar a `1` (es el mismo interruptor que usa
el polling). Si está a `0`, el endpoint también responde `503`: un webhook no
puede encender la integración por sorpresa.

---

## 4 · Comprobar que quedó bien

En el NAS:

```bash
npm run beeping:doctor
```

Fíjate en el bloque **`1.b WEBHOOKS ENTRANTES`** y en las dos últimas líneas:

| Lo que ves | Qué significa |
|---|---|
| `WEBHOOK=NOT_CONFIGURED` | **lo normal hoy.** El endpoint rechaza todo. Correcto |
| `WEBHOOK=READY` | configurado y verificando. Ya puede recibir |
| `WEBHOOK=FAIL` | mal configurado (falta el secreto o la cabecera). **Arreglar**: mientras tanto rechaza todo |
| `POLLING=READY` | la reconciliación por sondeo funciona (esto ya funcionaba antes) |

El doctor **nunca imprime el secreto**, ni entero ni a trozos.

Después, en el panel de Beeping, mira el registro de entregas del webhook:

- **`200`** → llegó y se aplicó (o era un duplicado ya conocido: también `200`)
- **`401`** → el secreto del panel y el del `.env` no coinciden. Repásalos
- **`503`** → falta configurarlo en el NAS, o `BEEPING_ENABLED` está a `0`

---

## 5 · El polling NO se quita

Aunque los webhooks funcionen, la reconciliación por sondeo sigue corriendo.

Es deliberado: si una entrega se pierde, si el NAS estaba reiniciándose, o si
el evento de un pedido llega antes de que el pedido exista en local, el
sondeo lo corrige después. Las dos vías pasan por el mismo código, así que
**no pueden duplicar avisos ni contradecirse**: si el webhook ya aplicó un
cambio, el sondeo lo ve aplicado y no hace nada.

Los webhooks aportan **velocidad** (el aviso de "sale a reparto" deja de
esperar al ciclo de sondeo), no fiabilidad. La fiabilidad la sigue poniendo
el sondeo.

---

## 6 · Recordatorio de despliegue

- Esto **no está desplegado**. Requiere el despliegue normal del NAS.
- **Fuera de la franja 10:00–21:00** — reiniciar corta WhatsApp.
- Tras desplegar: contenedor *healthy*, WhatsApp reconecta sin pedir QR, y
  `npm run beeping:doctor` con `POLLING=READY`.
