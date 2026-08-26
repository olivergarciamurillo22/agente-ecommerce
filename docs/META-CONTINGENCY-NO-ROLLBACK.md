# Plan de contingencia — si el rollback a Baileys resulta imposible

> Este documento asume lo peor: que tras el alta de Coexistencia en Meta,
> Baileys **no se puede volver a vincular** (la documentación de WhatsApp
> dice que el alta desvincula todos los dispositivos companion, y que solo
> WhatsApp para Windows y WearOS se pueden re-enlazar después — Baileys es
> un companion más, y no hay garantía de que reaparezca como opción de
> vinculación). Si eso pasa, el Paso 11 del runbook del piloto (`WHATSAPP_PROVIDER=baileys`
> y reiniciar) no te devuelve nada: el proceso arranca, pero no hay sesión
> que recuperar y el QR no vincula.
>
> Conclusión de partida: **el alta en Meta hay que tratarla como una
> decisión de un solo sentido, no como un experimento reversible.** Todo lo
> de abajo se prepara ANTES de tocar Meta, no después.

## Qué significa "no hay vuelta atrás" en la práctica

- `WHATSAPP_PROVIDER=baileys` sigue siendo una opción técnica en el `.env`,
  pero si Baileys no puede re-vincularse, poner esa variable **apaga el
  envío de WhatsApp por completo** (Baileys arranca, no hay sesión, no
  envía nada) — no es un rollback, es un apagón.
- El único camino que sigue funcionando es quedarse en `cloud_api`, sea
  cual sea el estado en que se esté (plantillas aprobadas o no, allowlist
  abierta a cuántos clientes sea).
- Por tanto: el "piloto" deja de ser un experimento con vuelta atrás
  garantizada y pasa a ser, de facto, el **lanzamiento**, aunque se llame
  piloto. Hay que prepararlo con esa seriedad.

## Qué tiene que estar listo ANTES de dar de alta nada en Meta

Esta lista es la condición para que "quedarnos en cloud_api sin vuelta
atrás" sea una situación viable y no una crisis:

1. **Las 6 plantillas de `config/whatsapp-templates.json` en estado
   APPROVED en WhatsApp Manager — no "enviadas a revisión", APROBADAS.**
   Ver la sección siguiente sobre por qué esto es la pieza que más importa.
2. **Un procedimiento escrito de apertura gradual de la allowlist**, no
   improvisado el día que haga falta (ver más abajo). Con quién se amplía
   primero, con qué cadencia, y qué se vigila entre cada ampliación.
3. **Aceptación explícita de Pedro** de que esto es de un solo sentido,
   ANTES del alta — no como sorpresa si algo sale mal el día del piloto.
4. **Un plan de contacto manual de emergencia**: si una plantilla se
   rechaza o un envío falla y hay un cliente real esperando confirmación,
   ¿quién le escribe y desde qué número mientras se resuelve? (Hoy la
   respuesta tiene que ser "Pedro desde su móvil personal, a mano" — no hay
   alternativa automática si Baileys no vuelve.)
5. **Vigilancia del estado de las plantillas los días siguientes al
   envío a revisión** — Meta puede tardar de minutos a horas, y puede
   RECHAZAR una plantilla y obligar a reenviarla con cambios. Esto tiene que
   estar resuelto con margen, no el mismo día que se necesita.
6. Revisar que el uso cumple las políticas de mensajería de la WhatsApp
   Business Platform (opt-in, ventana de 24 h, límites de calidad de la
   cuenta) — una cuenta con mala "calidad" puede perder capacidad de
   plantillas, que es justo el mecanismo del que se depende si no hay
   Baileys de respaldo.

## Por qué las plantillas son la pieza crítica (qué se rompe si no lo están)

El primer mensaje a un cliente nuevo (la confirmación del pedido COD)
**siempre sale fuera de la ventana de 24 h** — el cliente nunca ha escrito
antes, así que no hay ventana abierta que aprovechar. Fuera de ventana, la
Cloud API de Meta **rechaza cualquier mensaje que no sea una plantilla
aprobada** (ver `src/lib/whatsapp/meta-cloud.ts`, la comprobación
`outside_24h_window` antes de intentar el envío).

Sin plantillas aprobadas y sin Baileys de respaldo:

- **Cero pedidos nuevos reciben confirmación.** No hay mecanismo alternativo:
  el mensaje falla TERMINAL (`retryable: false`) y queda marcado, no
  reintenta solo.
- Esto no es un fallo silencioso — el pedido se queda en `pending_send` sin
  moverse, y el Control Center lo mostraría como fallo de envío. Pero el
  EFECTO de negocio es real: nadie confirma, nadie recibe su pedido COD a
  tiempo, y no hay forma automática de recuperarlo salvo que alguien lo
  vea y actúe a mano.
- Es exactamente el escenario que `TEST_MODE=1` existe para evitar durante
  el piloto — pero si el piloto se convierte en definitivo sin querer
  (por la imposibilidad del rollback) y alguien sube `TEST_MODE=0` sin
  las plantillas aprobadas, el efecto es una interrupción total del canal
  de confirmación de pedidos, no un fallo parcial.

## Plan: quedarse en cloud_api, abrir la allowlist poco a poco

Si el rollback resulta imposible, el camino seguro NO es "todo o nada" —
es ampliar `TEST_PHONE_ALLOWLIST` en pasos controlados, cada uno validado
antes del siguiente, exactamente igual que cualquier lanzamiento gradual:

1. **Paso 0 (donde ya se está)**: allowlist con Pedro y Óliver únicamente,
   `TEST_MODE=1`. No cambia nada de esto hasta que el punto 1 de la lista
   de arriba (plantillas APROBADAS) esté cumplido.
2. **Paso 1 — un puñado de pedidos reales, elegidos a mano**: añadir a la
   allowlist un pedido real (que sea el propio Pedro, un familiar, o un
   cliente que ya haya dado el visto bueno explícitamente a ser el
   primero) — nunca automático, siempre añadido a mano al `.env` y
   reiniciando. Validar el ciclo completo: confirmación con botones,
   `delivered`/`read`, y que una respuesta de texto normal (fuera de
   botón) también funciona.
3. **Paso 2 — un día de pedidos reales de bajo volumen**: quitar el
   `TEST_MODE` para una franja horaria corta y de poco tráfico (recomendado:
   una tarde entre semana, nunca un fin de semana ni una campaña activa),
   con el watchdog y el Control Center vigilados en directo por alguien
   mientras dura.
4. **Paso 3 — apertura completa**: solo tras al menos un ciclo completo sin
   incidencias en el paso 2, y con las plantillas todavía en APPROVED
   (Meta puede revocar la aprobación de una plantilla si empieza a generar
   quejas — hay que seguir vigilando después de la apertura, no solo antes).

Entre cada paso: parar y revisar, nunca encadenar ampliaciones el mismo
día. Cada ampliación es una decisión de Pedro, no algo que se automatice.

## Qué NO cambia con este plan

- Nada de esto toca Shopify ni a los proveedores (Dropea/Dropi): sigue
  fuera del alcance de WhatsApp por completo, como siempre.
- El resto de salvaguardas (`EMERGENCY_STOP`, `WHATSAPP_SEND_ENABLED`,
  la ventana horaria) siguen funcionando exactamente igual con
  `cloud_api` que con Baileys — no dependen del proveedor activo.
- Si en algún momento posterior Baileys SÍ se puede volver a vincular
  (por ejemplo, dando de alta un número de WhatsApp Business NUEVO y
  distinto, sin coexistencia, dedicado solo a Baileys de respaldo), este
  plan se abandona y se vuelve al runbook normal — pero eso es una decisión
  nueva, no algo que se pueda dar por hecho hoy.
