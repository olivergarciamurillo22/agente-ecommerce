# Espacio de atención al cliente — modelo de acceso

Documento **versionado**. Describe quién llega a dónde y por qué, tal como
quedó validado el 05-09-2026 sobre `feat/workspace-atencion-cliente`.

## Las tres clases de ruta

El proxy (`src/proxy.ts`) decide **una sola cosa**: quién puede *llegar* al
handler. El permiso fino por acción vive en el handler.

| Clase | Rutas | Quién entra |
|---|---|---|
| **PÚBLICA** | `/api/webhooks/*`, `/api/health*` | cualquiera (los webhooks se autentican por firma HMAC) |
| **LOGIN** | `/login`, `/api/auth/*` | cualquiera (si no, no habría forma de entrar) |
| **STAFF** | `/trabajo`, `/api/workspace`, `/api/workspace/action`, `/api/mode/{id}`, `/api/messages/{id}`, `/api/orders/{id}/action` | `owner` + `agent` |
| **PROPIETARIO** | todo lo demás | solo `owner` |

## Por qué la lista STAFF es de patrones exactos

Un prefijo cómodo como `/api/messages/` valdría también para
`/api/messages/{id}/image`, que **no tiene guard propio** (sube un fichero a
disco y encola un envío de WhatsApp). Cada patrón de la lista se corresponde
con un handler que tiene `requireStaff`.

**Regla al añadir una ruta STAFF:** comprueba primero que su handler tenga
guard propio. Aquí no se concede acceso a rutas sin autoridad detrás.

## La autoridad del rol vive en el handler

`/api/orders/{id}/action` deja entrar a un agente y **dentro** solo le permite
`resend`. `call_now`, `cancel`, `authorize_pilot`, `revoke_pilot` y
`notify_delay` responden 403 «No tienes permiso para esta acción».

Ese reparto es deliberado: el proxy no conoce el negocio y no debe duplicar
reglas que ya están en el handler. Cuando las dos capas opinan, se
contradicen — que es exactamente el fallo que se corrigió el 05-09 (el
handler decía «staff» y el proxy contestaba 403 antes de llegar, así que **un
agente no podía responder a un cliente**).

## El permiso de la acción y la forma de la respuesta son cosas distintas

Un agente puede ejecutar `resend`, pero **no recibe la ficha completa** del
pedido: la respuesta se proyecta con `safeOrder()`, la misma lista blanca que
usa el espacio de trabajo (sin `email`, `raw_payload`, `marketing_*`,
`supplier_*` ni `beeping_*`). El propietario sigue recibiendo la fila entera,
que es lo que consume su panel.

Sin esa proyección, abrir la ruta a staff filtraría PII por la respuesta
aunque la acción en sí estuviera permitida.

## Cookie de sesión: `Secure` no se baja

La cookie se emite con `httpOnly: true, secure: true, sameSite: "lax"`.

**Consecuencia operativa:** `http://192.168.2.109:3000` **no es un camino de
login soportado en navegador**. Una cookie `Secure` no viaja por HTTP plano,
así que el login parece funcionar y la siguiente petición vuelve al `/login`
en bucle. No es un bug: es la cookie haciendo su trabajo.

`localhost` / `127.0.0.1` sí funcionan — los navegadores los tratan como
contexto seguro aunque el esquema sea `http`.

**Qué NO hacer:** poner `secure: false` por comodidad de LAN. Eso expone la
sesión del panel a cualquiera que escuche la red.

**Qué hacer si hace falta acceso por LAN:** ponerlo detrás de HTTPS — proxy
inverso con certificado, o un túnel. El acceso normal es
`https://agente.casamable.es`.

## Auditoría

`audit_log` guarda `user_name` **desnormalizado** a propósito. Al borrar un
usuario, `user_id` pasa a `NULL` por la clave foránea pero el nombre
sobrevive: un registro de auditoría que se borra solo no sirve de nada.
Verificado el 05-09: 12 entradas conservaron «Ana Agente» tras eliminar la
usuaria, y sus sesiones se invalidaron en el acto.
