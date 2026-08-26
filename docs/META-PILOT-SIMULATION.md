# Simulación del piloto de Meta

`npm run meta:pilot:simulate` — reproduce el flujo COMPLETO del día del
piloto en una DB temporal, con credenciales falsas y fetch falso: **cero
red, cero WhatsApps, cero datos reales**.

## Qué comprueba (12 pasos)

1–5 · Pedido nuevo → fuera de ventana → el scheduler encola **PLANTILLA**
(`order_confirmation_request`) → sale por el proveedor → `provider_message_id`
persistido.
6–7 · El cliente responde (webhook firmado) → la **ventana de 24 h se abre**.
8–9 · Segundo pedido → ahora sale **interactivo con botones**.
10 · Botón **✅ Confirmar** (payload, no texto) → pedido `confirmed`.
11–12 · Webhooks de estado → `delivered_at` y `read_at` estampados, sin
regresiones.

## Cómo leerlo

- **12/12 verde** = nuestro flujo está bien; lo único que el piloto real
  puede descubrir son diferencias del **contrato de Meta** (payloads reales
  vs documentados).
- Cualquier ✗ = NO ir al piloto: es un bug nuestro y se arregla en local.

Se ejecuta en segundos y conviene pasarlo **la mañana del piloto** como
última comprobación.
