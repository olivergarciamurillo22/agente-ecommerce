# Modelo de errores

> `src/lib/system/errors.ts`. Decidido el 25-08-2026 durante el hardening.

## La pregunta que responde la categoría

**¿Quién lo arregla y cuándo?** Nada más. No describe el error técnico:
describe qué hay que hacer con él.

Antes todo llegaba al Control Center como una cadena suelta (`HTTP 401`,
`ECONNRESET`, `localidad vacía`) y se pintaba igual, así que ni Pedro ni el
código podían distinguir lo que se arregla solo de lo que necesita que alguien
toque una credencial.

| Categoría | Qué es | ¿Reintenta? | ¿Humano? | Severidad |
|---|---|---|---|---|
| `retryable` | Red, 5xx, timeouts | ✅ | — | info |
| `rate_limit` | Nos pasamos de peticiones | ✅ (esperando) | — | info |
| `non_retryable` | 404 y equivalentes | — | — | warning |
| `validation_error` | Datos del pedido incompletos | — | corregir el pedido | warning |
| `manual_review` | Necesita una decisión concreta | — | ✅ | warning |
| `external_provider_error` | El tercero dice algo que no entendemos | — | vigilar | warning |
| `configuration_error` | Falta algo en el `.env` | — | ✅ Pedro | **critical** |
| `auth_error` | Credencial inválida o caducada | — | ✅ Pedro, urge | **critical** |
| `internal_error` | Fallo nuestro | — | ✅ es un bug | warning |

## Reglas que importan

**El código HTTP manda sobre el texto.** Un `401` es una señal estable; el
mensaje lo puede cambiar el proveedor cualquier día. Solo cuando no hay código
se mira el texto, y ahí se buscan **códigos de red de Node**
(`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`…), no frases que puedan estar
traducidas.

**Reintentar un `401` eternamente es tan malo como no reintentar un timeout.**
El primero gasta cupo y nunca funcionará; el segundo se habría recuperado solo.
Por eso `isRetryable()` es explícito y no se deduce caso a caso.

**`auth_error` y `configuration_error` son críticas.** Sin credencial no
funciona nada, y el arreglo es de Pedro, no del código. Todo lo demás degrada
sin tumbar el sistema.

## Textos para Pedro

`categoryLabel()` da la frase que va a la UI. Hay un test que **falla si
aparece jerga** (`Bearer`, códigos HTTP sueltos, `null`): la vista de Pedro
dice *"Credencial inválida o caducada"*, no *"Bearer token 401"*.

## Alcance

Aplicado en las fronteras: proveedores, tracking, webhooks, outbox y
schedulers. **No se ha reescrito todo el proyecto** — los `catch` internos que
ya degradaban bien (best-effort de observabilidad) se han dejado como estaban.
