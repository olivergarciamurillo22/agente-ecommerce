# Beeping: marcar para enviar tras confirmar

Cuando un cliente confirma un pedido por WhatsApp y supera la validacion de
direccion, Casamable conserva primero la confirmacion local y lanza en segundo
plano `PUT /api/order/mark-to-send/{external_id}`. La app nativa de Beeping ya
ha creado previamente el pedido desde Shopify, por lo que no se crea ni se
duplica ningun pedido.

El `external_id` usado por Beeping es el numero de pedido de Shopify (por
ejemplo, `35011394`). La llamada es best-effort: un 404, un error HTTP o un
timeout queda registrado en `integration_events`, pero nunca revierte la
confirmacion ni retrasa la respuesta al cliente.

## Activacion

El automatismo queda fail-closed con `BEEPING_INTEGRATION_ENABLED=0`. En ese
modo no hay trafico HTTP y se registra `beeping_mark_to_send_simulado`.

Antes de habilitarlo hay que:

1. Resolver con Dropea que proveedor procesa cada pedido; ambas apps nativas
   estan conectadas a la misma tienda.
2. Configurar `BEEPING_ACCOUNT_EMAIL` y `BEEPING_ACCOUNT_PASSWORD` con las
   credenciales que facilite Pedro.
3. Dejar `BEEPING_API_BASE_URL=https://app.gobeeping.com`, salvo que Beeping
   indique otro host.
4. Poner `BEEPING_INTEGRATION_ENABLED=1` solo durante el piloto autorizado.

Las credenciales se convierten localmente en la cabecera HTTP Basic y nunca se
incluyen en logs ni en eventos.
