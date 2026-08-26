# Migración de Baileys a la Cloud API de Meta

> Investigado y preparado el 25-08-2026, rama `fix/hardening-casamable`.
> **Nada de esto está desplegado ni se ha tocado la cuenta de Meta.**

## La respuesta a la pregunta clave: SÍ se puede conservar el número

Meta ofrece **Coexistencia** ("API Solutions for Business App Users"): el
mismo número funcionando **a la vez** en la app WhatsApp Business del móvil
de Pedro y en la Cloud API, con sincronización bidireccional en tiempo real.

**Disponibilidad verificada (fuentes de agosto 2026):** la UE entró en el
despliegue en octubre de 2025 y desde mayo de 2026 está soportada en todos
los países. España está cubierta.

### Requisitos (según guías de integradores; verificar en el alta real)

| Requisito | Detalle |
|---|---|
| App WhatsApp Business | versión **≥ 2.24.17** en el móvil de Pedro |
| Meta Business Portfolio | hace falta (verificación de empresa incluida) |
| Alta | *Embedded Signup* + **escanear un QR desde la app** del móvil |
| Historial | elección **única e irreversible** en el alta: importar hasta 6 meses de chats 1:1, o empezar de cero |
| **Regla de los 14 días** | el móvil debe abrir la app al menos una vez cada ~14 días o la conexión API se corta (desde mayo 2026 la reconexión es automática al re-registrar) |

### Qué cambia en la app del móvil al activar coexistencia

- Los chats existentes **se quedan en la app**; los nuevos mensajes se
  sincronizan en ambas direcciones desde la activación.
- Los **grupos** se quedan solo en la app (no llegan a la API). Bien para
  nosotros: el bot ya ignora grupos.
- Se desactivan en la app: listas de difusión, mensajes temporales, "ver una
  vez" y ubicación en tiempo real (en chats 1:1).
- Los dispositivos vinculados se desvinculan durante el alta y hay que
  volver a vincularlos. WhatsApp para Windows (Store) no está soportado.
- El nombre visible puede no aparecer para clientes nuevos hasta completar
  la verificación del display name.

### Downtime y rollback

- El alta no debería cortar el número (la app sigue funcionando), pero hay
  una ventana de re-vinculación de dispositivos.
- **Rollback del lado nuestro:** `WHATSAPP_PROVIDER=baileys` y reiniciar —
  cero cambios de negocio. ⚠️ **Ojo**: si la coexistencia desvincula los
  dispositivos companion, la sesión de Baileys (que ES un dispositivo
  vinculado) **puede caerse y pedir QR de nuevo**. Por eso el plan es
  activar coexistencia y pilotar la Cloud API ANTES de retirar Baileys, con
  el QR a mano por si hay que re-vincular.

### ⚠️ Provenance de estos datos

Lo anterior sale de guías de integradores de 2026
([YCloud](https://www.ycloud.com/blog/whatsapp-business-app-coexistence-meta-update),
[Chakra](https://chakrahq.com/article/whatsapp-business-app-api-coexistence-2026/),
[whautomate](https://whautomate.com/whatsapp-coexistence)), no de un documento
first-party de Meta que hayamos leído entero. Los detalles finos (qué versión
mínima exacta, qué pasa con Baileys como dispositivo vinculado) **se
verifican durante el propio Embedded Signup**, que enseña las condiciones
antes de confirmar. Nada del alta se hace sin Pedro delante.

## Arquitectura

```
                    lógica de negocio (sin cambios)
                              │
                        OUTBOX (SQLite)          ← único punto de salida
                              │
              ┌───── WHATSAPP_PROVIDER ─────┐
              │                             │
     baileys/outbox.ts              whatsapp/cloud-outbox.ts
      (WhatsApp Web)                 (Graph API /messages)
              │                             │
              └────── LEASE_OUTBOX ─────────┘
              (un único drenador, SIEMPRE — aunque
               alguien arrancara los dos por error)

   entrada baileys/handler.ts        entrada /api/webhooks/whatsapp
              │                             │
              └────── InboundWhatsAppMessage / handleOrderReply ──────┘
                       (la MISMA máquina de estados COD)
```

- `src/lib/whatsapp/provider.ts` — la interfaz y la selección por env.
- `src/lib/whatsapp/meta-cloud.ts` — el proveedor de Meta. Fail-closed:
  sin `META_WHATSAPP_API_ENABLED=1` + credenciales, ni una llamada de red.
- El loop de Baileys **no se ha tocado**: es el camino probado en
  producción. El de cloud es su gemelo y solo arranca en modo cloud.

## La regla de la ventana de 24 horas

Meta solo permite mensajes **libres** dentro de las 24 h siguientes al
último mensaje **del cliente**. Fuera de ventana: solo **plantillas
aprobadas** (categoría *utility* para lo nuestro; las responde el cliente y
la ventana se abre).

La decisión vive en el proveedor, no repartida por el negocio: un texto
libre fuera de ventana falla **terminal** con motivo
`outside_24h_window` — visible en la cola de envíos, nunca un intento ciego
que Meta tiraría. Las 6 plantillas necesarias están especificadas en
`config/whatsapp-templates.json` (borradores: Meta las revisa una a una).

## Estados de mensaje (lo que Baileys nunca pudo dar)

`encolado → enviado (provider_message_id) → entregado → leído`, y `fallado`
con motivo. Los webhooks de estado de Meta actualizan el outbox por
`provider_message_id`; los estados solo avanzan (un `delivered` atrasado no
borra un `read`) y son idempotentes.

## Qué NO hacer hasta estar seguros

1. No iniciar el Embedded Signup "para probar": la elección del historial es
   irreversible y el alta desvincula dispositivos.
2. No registrar el número contra la Cloud API por la vía clásica (sin
   coexistencia): eso SÍ desconecta la app del móvil.
3. No borrar `auth/` de Baileys hasta semanas después del corte definitivo.
4. No activar `WHATSAPP_PROVIDER=cloud_api` en el NAS sin haber pasado el
   piloto con TEST_MODE=1 y la allowlist.

## Políticas fijadas en la auditoría pre-piloto (25-08-2026)

**Outbox mixto — proveedor resuelto AL ENVIAR, no al encolar.** El loop
activo drena todo lo pendiente. Un interactivo encolado en modo cloud y
drenado por Baileys tras un rollback sale como su texto de fallback (el
flujo 1/2/3), porque `content` ES el fallback y el loop de Baileys no conoce
`message_type`. Nada se pierde, nada cambia de significado, y el claim
atómico es el mismo — no puede duplicarse. Se eligió así porque fijar el
proveedor al encolar dejaría mensajes atascados para siempre tras un
rollback.

**Resultado ambiguo = no reintentar.** Un timeout o un reset pueden ocurrir
DESPUÉS de que la petición llegara a Meta: reintentar podría mandar el mismo
WhatsApp dos veces. Solo se reintenta lo que garantiza que la petición nunca
salió (DNS caído, conexión rechazada). Un `200` con cuerpo ilegible cuenta
como ENVIADO sin id. Perder un mensaje es recuperable (recordatorios,
`needs_call`); duplicarlo no. **At-most-once, nunca exactly-once** — Meta no
ofrece clave de idempotencia de envío.

**Claves de dedupe por tipo de evento del webhook:**

| Evento | Dedupe |
|---|---|
| Mensajes entrantes (texto/botón/lista/audio/imagen) | `claimWebhookEvent("meta:" + wamid)` |
| Estados (sent/delivered/read/failed) | sin claim: idempotentes por efecto (`COALESCE`, solo-avanzan, `failed` no pisa `delivered`) |
| Cross-provider (coexistencia) | los ids NO coinciden entre Baileys y Meta → lo cubre el **gate de proveedor**: el webhook de Meta solo actúa con `WHATSAPP_PROVIDER=cloud_api` |

**La ventana de 24 h se abre con CUALQUIER entrante**, también notas de voz
e imágenes: el webhook registra todo entrante en `messages` (es además lo
que el panel enseña). Frontera conservadora: a las 24 h exactas ya cuenta
como fuera.

**Carrera conocida y aceptada:** un webhook de estado puede llegar en los
milisegundos entre que Meta acepta el envío y que persistimos su
`provider_message_id`; ese estado se pierde (cosmético: el mensaje salió una
vez y bien). Y si el proceso muere entre el claim y el envío, el mensaje se
pierde y lo recoge la red de recordatorios — el mismo compromiso documentado
del loop de Baileys.
