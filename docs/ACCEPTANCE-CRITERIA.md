# ACCEPTANCE CRITERIA — cuándo Casamable "funciona"

Criterios binarios. Cada uno tiene su verificación automática (test, simulador
o script) o está marcado **[REAL]**: solo verificable en producción con datos
reales. Un criterio sin verificación no es un criterio, es un deseo.

## A. Entrada de pedidos

| # | Criterio | Verificación |
|---|----------|--------------|
| A1 | Un webhook sin firma válida jamás escribe nada (401; 500 si falta el secreto) | tests HMAC |
| A2 | El mismo webhook reintentado no duplica el pedido (dedupe por `X-Shopify-Webhook-Id`) | tests idempotencia |
| A3 | Un pedido más viejo que `MAX_ORDER_AGE_MINUTES` entra como `ignored_old` y no genera NINGÚN contacto ni trabajo | tests + Acciones lo excluye |
| A4 | Dos pedidos idénticos del mismo teléfono en la ventana quedan marcados como posible duplicado SIN bloquear ninguno | test `duplicate_suspected_on_create` + simulate flujo 6 |

## B. Confirmación por WhatsApp

| # | Criterio | Verificación |
|---|----------|--------------|
| B1 | Todo pedido COD nuevo recibe exactamente UN WhatsApp de confirmación (at-most-once, sobrevive reinicios y dos procesos) | tests outbox/claim + reinicio |
| B2 | "1" confirma, "2" captura dirección, "3" captura nota (y la nota NO confirma: hace falta el "1") | tests + simulate flujos 1-3 |
| B3 | Sin respuesta: un recordatorio y después `needs_call`, nunca más mensajes | simulate flujo 4 |
| B4 | Con varios pedidos, elegir por número ("1097") funciona y "todo correcto" confirma EL elegido | tests bug real + simulate flujo 5 |
| B5 | Una conversación caótica nunca entra en bucle: o resuelve o escala a humano | test cliente difícil |
| B6 | El agente JAMÁS cancela un pedido: registra la petición y la pone la primera en Acciones | tests cancelación |
| B7 | Tras escalar a humano, un "cancelar" del cliente no se pierde: queda estampado | test operador/cliente difícil |

## C. Estados y cierre

| # | Criterio | Verificación |
|---|----------|--------------|
| C1 | `fulfilled` de Shopify = `in_progress`, jamás `delivered` | tests E2 |
| C2 | `delivered`/`refused`/`cancelled` son terminales: nadie los pisa (tampoco `llamada_ia`) | tests E1/E7 |
| C3 | Webhooks fuera de orden: el timestamp de la fuente decide, el más viejo se descarta | tests E2 + simulate flujo 8 |
| C4 | La tasa de entrega solo cuenta `delivered/(delivered+refused)`; sin datos = "sin datos", no 0 % | tests métricas |

## D. Panel y operación (Pedro)

| # | Criterio | Verificación |
|---|----------|--------------|
| D1 | Todo lo que requiere acción humana está en la pestaña Acciones, ordenado por urgencia, con qué hacer en imperativo | tests Action Center |
| D2 | Resolver una acción no borra ni cambia nada del pedido; deja nota y fecha | test resoluciones |
| D3 | Cancelaciones/duplicados sin resolver disparan warning del watchdog que apunta a Acciones | tests watchdog |
| D4 | Cada avería del sistema dice QUÉ HACER (Retell sin key, Meta sin credenciales, HMAC malo, backup viejo) | tests operador difícil |
| D5 | Ningún teléfono completo sale por el panel ni por endpoints públicos | tests privacidad |

## E. Robustez

| # | Criterio | Verificación |
|---|----------|--------------|
| E1 | Reiniciar el contenedor no pierde estado ni reenvía nada (todo deriva de la DB) | test reinicio + simulate flujo 9 |
| E2 | Dos procesos sobre el mismo SQLite: cada envío/llamada lo gana exactamente uno | test dos procesos |
| E3 | Las migraciones corren de cero a `SCHEMA_VERSION` y repetirlas es un no-op | readiness + tests migraciones |
| E4 | TEST_MODE sin definir = ACTIVO en todas las capas (fail-closed) | tests safety |

## F. Solo verificable en real **[REAL]**

| # | Criterio | Dónde |
|---|----------|-------|
| F1 | El WhatsApp llega de verdad al teléfono del cliente | piloto con el número de Pedro |
| F2 | La plantilla de Meta está aprobada y abre conversación fuera de 24 h | WABA real |
| F3 | La llamada de Retell suena, habla español y el resultado escribe el estado correcto | piloto shadow→allowlist |
| F4 | Dropea acepta la API key y los webhooks firman | `dropea:doctor` en el NAS |
| F5 | El backfill cubre TODO el histórico (scope `read_all_orders` verificado) | NAS |

**Regla final:** `npm run readiness` en verde = "LOCAL READY". Los F# son la
diferencia entre eso y producción; ver `docs/REAL-WORLD-VALIDATION.md`.
