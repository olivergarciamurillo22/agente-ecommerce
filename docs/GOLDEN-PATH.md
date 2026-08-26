# GOLDEN PATH — el contrato operativo de Casamable

Este documento es el **contrato**: la secuencia exacta que un pedido normal
recorre de punta a punta. Todo lo demás (llamadas, duplicados, incidencias,
reconciliación) son **desvíos** de este camino, y cada desvío termina o bien
de vuelta en el camino o bien en la pestaña **Acciones** de Pedro.

El test `golden-path-order-confirmation` (en `tests/run-tests.ts`) ejecuta
esta secuencia literal. Si ese test está verde, este contrato se cumple.
Si alguien cambia el contrato, cambia primero este documento y después el test.

## El camino dorado (pedido feliz)

| # | Qué pasa | Quién | Estado resultante |
|---|----------|-------|-------------------|
| 1 | El cliente compra **contrareembolso** en casamable.es (formulario Releasit) | Cliente | — |
| 2 | Shopify dispara `orders/create` **firmado** (HMAC) | Shopify | — |
| 3 | El agente **guarda el pedido local** (idempotente por webhook; si es sospechoso de duplicado, lo **marca** — jamás lo bloquea) | Agente | `status = pending_send` |
| 4 | El scheduler **encola el WhatsApp de confirmación** (outbox, envío at-most-once) | Agente | `status = awaiting_reply` |
| 5 | El cliente responde **"1 — Todo correcto"** | Cliente | `status = confirmed`, `confirmed_at` estampado |
| 6 | El scheduler **evalúa el routing de proveedor** y lo deja escrito (Dropea / Dropi PRO / revisión humana, con motivo) | Agente | `supplier_platform` + `supplier_sync_status` |
| 7 | El **panel refleja** el pedido: confirmado, routing visible; si algo exige acción humana, aparece en **Acciones** | Panel | — |
| 8 | Shopify marca `fulfilled` (despachado, **no entregado**) | Shopify | `closure_status = in_progress` |
| 9 | El proveedor (Dropea) o Pedro a mano dictan el final real | Dropea/Pedro | `closure_status = delivered` \| `refused` — **terminal, nadie lo pisa** |

## Desvíos previstos (y a dónde llevan)

- **Responde "2" (cambiar dirección)** → `needs_correction`; la dirección
  propuesta espera revisión → **Acciones: ADDRESS_CORRECTION**.
- **Responde "3" (nota al repartidor)** → se guarda la nota → vuelve al camino.
- **No responde** → recordatorio → `needs_call` → llamada IA (cuando esté
  encendida) o **Acciones: NEEDS_CALL**.
- **Pide cancelar y lo confirma** → se estampa la petición, nada se cancela
  solo → **Acciones: CANCEL_REQUEST** (lo primero de la bandeja).
- **Posible duplicado** (mismo teléfono+producto+importe+dirección en la
  ventana) → ambos marcados al llegar → **Acciones: POSSIBLE_DUPLICATE**.
- **Routing sin regla o dirección inválida** → `manual_review` /
  `blocked_address` → **Acciones: SUPPLIER_ERROR**.
- **Incidencia de transporte** (Dropea) → **Acciones: TRACKING_INCIDENT**.
  El bot **no** escribe al cliente solo en incidencias.
- **Pedido más viejo que `MAX_ORDER_AGE_MINUTES`** → `ignored_old`: no entra
  en **ninguna** cola ni bandeja. Es historia, no trabajo.

## Invariantes que ningún cambio puede romper

1. **Nada contacta al cliente dos veces por la misma causa** (outbox
   at-most-once; reevaluación de elegibilidad justo antes de cada llamada).
2. **`fulfilled` nunca es `delivered`.** La entrega/rehúse la dicta el
   proveedor o Pedro, jamás Shopify.
3. **Los cierres terminales no se pisan** (`delivered`/`refused`/`cancelled`).
4. **El agente nunca cancela un pedido por su cuenta.** Cancelar en Shopify
   es siempre una acción humana desde Acciones.
5. **Si requiere acción de Pedro, está en Acciones; si no está, no requiere.**
6. **Todo sobrevive un reinicio**: las colas se derivan de la DB, no de memoria.
