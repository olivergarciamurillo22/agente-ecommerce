# Lo que necesito de Pedro (y cómo pasarlo sin riesgo)

> Nada de esto bloquea el desarrollo local: todo lo demás sigue avanzando.
> Pasar SIEMPRE por un canal privado y SANITIZADO como se indica.

| # | Qué | Por qué | Cómo pasarlo |
|---|---|---|---|
| 1 | **META_WHATSAPP_VERIFY_TOKEN** (solo ese valor del `.env` del NAS) | Óliver lo necesita en su `.env.local` para el perfil cloud-pilot | Canal privado (no chat con IA). Es UN valor, no el `.env` entero |
| 2 | **Desglose del `dropea:reconcile --apply`** del 25-08 | Desbloquea dar por fiable la tasa de entrega | Copiar la salida del comando: no lleva PII |
| 3 | **Salida de `npm run shopify:backfill` (dry-run)** tras el fix del HMAC | Detectar cancelaciones/fulfillments perdidos durante el bug | La salida entera: son contadores, sin PII |
| 4 | **Salida de `npm run dropi:diagnose`** | Confirmar qué productos siguen con vendor mal | Salida entera: productos, no clientes |
| 5 | **Estado de la plantilla** `order_confirmation_request` en WhatsApp Manager (APPROVED y categoría) | El piloto no puede empezar sin ella | Una frase ("APPROVED, Utility") o captura sin tokens |
| 6 | **Confirmación de pago en Retell** | Sin método de pago las llamadas pararán en seco | "hecho/no hecho" |
| 7 | **Confirmación de que borró el endpoint de webhook.site** | Sigue público | "hecho" |
| 8 | **Salida de `npm run db:health`** tras el próximo despliegue | Verificar esquema 10 y salud | Salida entera: sin PII |

## Qué NO pasar nunca

El `.env` completo del NAS · cualquier token pegado en un chat con IA ·
capturas donde se vea un secreto. Si un valor sensible tiene que viajar,
viaja SOLO ese valor y por canal privado — y si ya se expuso, se regenera.
