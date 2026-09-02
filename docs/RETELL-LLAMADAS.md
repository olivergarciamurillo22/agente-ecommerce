# Llamadas de confirmación con IA (Retell)

Documento de referencia del subsistema de llamadas.

> **⚠️ Nota de reconciliación (24-08-2026).** Este documento se escribió como
> diseño *antes* de que E7 se implementara. Tras el merge de E7, se ha
> contrastado línea a línea contra el código real
> (`src/lib/calls/retell.ts`, `results.ts`, `config.ts`, `schedule.ts`,
> `payload.ts`, `scheduler.ts`, y la ruta del webhook) y se ha corregido lo
> que había cambiado durante la implementación. La operativa del día a día
> vive en **`docs/RUNBOOK-LLAMADAS.md`** — este documento es el contrato
> técnico y el porqué de las reglas, no el manual de uso.
>
> Lo que cambió respecto al diseño original:
> 1. **No existe `RETELL_WEBHOOK_SECRET`.** La firma de los webhooks se
>    verifica con `RETELL_API_KEY` (la misma clave que crea las llamadas).
> 2. **El interruptor no es una variable de entorno.** Son cuatro ajustes en
>    la tabla `settings`, editables desde el panel sin desplegar.
> 3. El endpoint también acepta `call_started` (se registra), aunque solo
>    `call_analyzed` aporta datos de análisis.
> 4. `resultado_llamada` tiene explícitos `buzon_de_voz` y `fallo_tecnico`
>    (antes agrupados implícitamente bajo "reintentan").
> 5. La cadencia de reintentos es un retraso configurable desde el último
>    contacto (2 h → 4 h → 8 h → 24 h por defecto), no la tabla fija de
>    "inicial + mismo día + día siguiente" del diseño original.
> 6. El orquestador y el endpoint **ya existen** — este documento se escribió
>    cuando aún no había ni una línea de código.
>
> Todo lo demás (franjas horarias, validación previa obligatoria, escritura
> en el eje de cierre, protección de terminales, campos de corrección,
> restricciones legales, lecciones de las pruebas) se ha verificado igual
> que se diseñó.

---

## 1. Para qué existe

El 46 % de los clientes no responde al WhatsApp de confirmación. Cada pedido recuperado son **21,89 €** de beneficio; cada rehúse cuesta **9,37 €**. El agente de voz llama a quien no contesta, verifica la dirección y le recuerda que debe tener el efectivo preparado.

Objetivo de la llamada, en este orden: **verificar dirección** → **recordar el pago en efectivo y el importe**. No es una llamada de venta y no puede serlo (ver punto 6).

---

## 2. Piezas y dónde vive cada una

| Pieza | Dónde | Estado |
|---|---|---|
| Agente de voz "Lucía" | Panel de Retell, `agent_2621dfae9b867f171ef8966e1e` | Configurado y probado |
| Prompt del agente | Panel de Retell | v3 |
| Base de conocimiento | Panel de Retell | v2, sin precios |
| Número saliente | Twilio (bundle España/Individual/Mobile) | En revisión regulatoria |
| Orquestador de llamadas | `src/lib/calls/` (config, provider, retell, payload, results, schedule, scheduler, calendar, spanish) | **Implementado (E7)** |
| Endpoint del webhook | `src/app/api/webhooks/retell/call-events/route.ts` | **Implementado (E7)** |

**Retell no consulta nuestra base de datos.** Nosotros le pasamos todos los datos del pedido al crear la llamada, en `retell_llm_dynamic_variables` (`src/lib/calls/payload.ts`). Si un dato no se envía, el agente usa un valor por defecto **sin avisar**: de ahí que la validación previa sea obligatoria (§7).

---

## 3. Configuración

### Secretos (`.env` del NAS, `/volume1/docker/CasamableAgent/repo/.env`)

```
RETELL_API_KEY       # crea llamadas Y verifica la firma de los webhooks (misma clave para ambas cosas)
RETELL_AGENT_ID=agent_2621dfae9b867f171ef8966e1e
RETELL_FROM_NUMBER   # vacía hasta que Twilio apruebe el número
```

No existe `RETELL_WEBHOOK_SECRET`: Retell firma con la propia API key.

### Interruptores operativos (tabla `settings`, panel → pestaña **Llamadas**, sin deploy)

| Ajuste | Qué hace | Default |
|---|---|---|
| `ai_calls_enabled` | Kill switch: sin esto en ON no sale ninguna llamada real | **OFF** |
| `calls_shadow_mode` | Calcula candidatos y payload y los registra, sin contactar a Retell | **ON** |
| `calls_allowlist` | Si tiene teléfonos, solo se llama a esos | vacío |
| `calls_daily_cap` | Tope de llamadas reales/día | 30 |
| `call_trigger_minutes` | Minutos sin respuesta al WhatsApp antes de entrar en cola | 15 |
| `call_max_contacts` | Contactos máximos por pedido (inicial + reintentos) | 5 |
| `call_retry_delays_minutes` | Retraso en minutos tras cada contacto sin resolución | `120,240,480,1440` |

Cada ajuste admite un *fallback* por variable de entorno en mayúsculas (`AI_CALLS_ENABLED`, `CALLS_SHADOW_MODE`, …) si no hay valor en `settings`, pero la fuente de verdad operativa es el panel.

**Reutilizadas, no duplicadas:** `EMERGENCY_STOP` (interruptor general del sistema, el orquestador lo respeta) y `TEST_PHONE_ALLOWLIST` de WhatsApp son conceptos **distintos** de `calls_allowlist` — no se mezclan.

---

## 4. Contrato del webhook (verificado contra `docs.retellai.com`, 24-08-2026)

**Endpoint:** `POST /api/webhooks/retell/call-events`
**Eventos que llegan:** `call_started`, `call_ended`, `call_analyzed`. El endpoint registra los tres (patrón inbox: guarda el evento parseado y responde 200 de inmediato), pero **solo `call_analyzed` decide algo**, porque es el único que trae `call_analysis.custom_analysis_data`.

- `call_started`/`call_ended` → se guardan para trazabilidad. **No disparan ninguna acción de negocio.**
- `call_analyzed` → llega segundos después y **es el único que trae los campos extraídos**. Actuar sobre `call_ended` clasificaría todas las llamadas con campos vacíos.

### Estructura

```
{
  "event": "call_analyzed",
  "call": {
    "call_id": "call_...",                 // CLAVE DE IDEMPOTENCIA (junto al evento y su fecha)
    "call_type": "web_call" | "phone_call",
    "start_timestamp": 1787566029728,      // epoch MILISEGUNDOS
    "end_timestamp":   1787566119021,      // usar para closure_at y para el orden
    "duration_ms": 89293,
    "disconnection_reason": "agent_hangup",
    "collected_dynamic_variables": { ... },      // función en vivo (RESPALDO)
    "call_analysis": {
      "in_voicemail": false,
      "user_sentiment": "Positive",
      "call_successful": true,
      "call_summary": "...",
      "custom_analysis_data": { ... }            // ← FUENTE DE VERDAD
    },
    "recording_url": "https://...?Expires=...",  // CADUCA en 24 h
    "call_cost": { "combined_cost": 24.75 }      // en CÉNTIMOS
  },
  "event_timestamp": 1787566126401
}
```

### Verificación de firma

Cabecera **`x-retell-signature`**, formato `v={timestamp_ms},d={hmac_hex}`.

`d` = `HMAC-SHA256(raw_body + timestamp, RETELL_API_KEY)`, codificado en **hexadecimal** (no base64). Comparación en tiempo constante. El `v=` se usa para rechazar peticiones con más de **5 minutos** de antigüedad. **401 si falla la firma o el timestamp está caducado.**

Existe además un *fallback* defensivo: si la cabecera no trae el formato `v=,d=`, se acepta `HMAC-SHA256(raw_body, RETELL_API_KEY)` en hex sin timestamp (formato de una versión anterior del SDK de Retell).

### Protecciones obligatorias

1. Verificación de firma → 401 si falla.
2. **Idempotencia por `call_id` + `event` + fecha del evento.** Retell reintenta.
3. **Descarte de eventos fuera de orden** comparando `end_timestamp` con lo almacenado.
4. **Responder 200 de inmediato.** El webhook solo guarda el evento parseado (sin PII de más); el procesamiento de negocio lo hace el orquestador en su siguiente tick, no dentro de la misma petición. El timeout de Retell es de 5 s; superarlo provoca reintento y doble procesamiento.

### Reglas de interpretación

- **`custom_analysis_data` manda** sobre `collected_dynamic_variables`. La función en vivo puede dispararse antes del final y congelar datos incompletos.
- **Las señales objetivas ganan al modelo.** Si el modelo clasifica `confirmado` pero `in_voicemail` es `true`, gana `in_voicemail`. Igual con `disconnection_reason`.
- **`recording_url` no se almacena nunca** — lleva firma con caducidad. Guardar `call_id` y regenerar cuando haga falta.
- **`combined_cost` viene en céntimos.** Guardarlo por llamada permite calcular el coste real por pedido recuperado.

### Escritura en el eje de cierre (E1)

| `resultado_llamada` | Efecto |
|---|---|
| `cancelado`, `no_reconoce_pedido` | `closure_status = cancelled`, `closure_source = 'llamada_ia'` |
| `confirmado`, `confirmado_con_correccion` | Marca confirmación del pedido. **No toca el eje de cierre** |
| Resto | Solo afecta a la cola de llamadas |

- `closure_at` = `end_timestamp` convertido, **nunca** `now()`.
- `closure_source = 'llamada_ia'` — **jamás pisa `shopify` ni `dropea`**: si el pedido ya tiene un cierre terminal de otra fuente, la escritura se rechaza (`canTransitionClosure`, E1) y el intento pasa a revisión manual con el motivo `closure_conflict`, en vez de perder el resultado en silencio.
- **`pidio_no_llamar: true` → bloqueo permanente y automático de ese número** (tabla `call_dnc`). Es obligación legal, no una preferencia.

### Correcciones de datos

Campos: `direccion_corregida`, `localidad_corregida`, `codigo_postal_corregido`, `telefono_alternativo`.

- **Campo vacío = no cambió**, nunca "bórralo". Solo se aplica si viene un valor no vacío.
- El código postal llega como **texto**: se conserva el cero inicial, nunca se convierte a número (`05005`, `08001`).

---

## 5. Valores de `resultado_llamada`

`confirmado` · `confirmado_con_correccion` · `cancelado` · `no_reconoce_pedido` · `numero_equivocado` · `no_volver_a_llamar` · `incidencia_precio` · `no_disponible` · `rellamar` · `no_contesta` · `buzon_de_voz` · `fallo_tecnico`

Cualquier valor fuera de esta lista (parseo estricto, sin "algo parecido") → revisión manual.

**Reintentan y consumen uno de los 5 contactos:** `no_contesta`, `buzon_de_voz`.
**Reintenta SIN consumir contacto:** `fallo_tecnico` (tiene su propio contador: 3 fallos técnicos seguidos → revisión manual, sin gastar cupo del cliente) y `rellamar` (se reprograma según `momento_rellamada` en vez de la cadencia estándar).
**No reintentan (pasan a revisión o cierran):** `numero_equivocado`, `incidencia_precio`, `no_disponible` → revisión manual · `no_volver_a_llamar` → DNC · `cancelado`, `no_reconoce_pedido` → cierre.

---

## 6. Restricciones legales (no son opinables)

**AI Act, artículo 50 — en vigor desde el 2/08/2026.** Hay que declarar que se habla con una IA. El agente lo dice en su segunda frase. **Esa frase no se toca al iterar el prompt.**

**LGT art. 66.1.a.** Las llamadas automatizadas **con fin comercial** exigen consentimiento previo. Confirmar un pedido que el cliente hizo es ejecución del contrato, no publicidad — pero **en cuanto el agente ofrece, recomienda o da precio de otro producto, la llamada pasa a ser comercial**. Por eso:

- No hay precios en la base de conocimiento.
- El único importe pronunciable es el del pedido en curso.
- Ante una discrepancia de precio: derivar a WhatsApp, sin dar cifras ni hablar de promociones.

**Nunca consejo sanitario.** Son productos de cuidado personal y los clientes preguntan por diabetes, hongos o vista. El agente deriva al médico y no afirma que el producto trate ni mejore nada.

**RGPD.** Retención en Retell limitada, redacción de datos bancarios y de identidad activada, y las grabaciones no se almacenan en nuestro lado.

---

## 7. Cadencia

**Disparador:** `call_trigger_minutes` (15 min por defecto) sin respuesta al WhatsApp.
**Franjas:** 09:00–13:00 y 17:00–20:00, Europe/Madrid con cambio de hora automático (vía `Intl`, sin offsets fijos), de lunes a sábado. Nunca domingos ni festivos (calendario inyectable, `src/lib/calls/calendar.ts`).
**Encaje:** si el momento calculado cae fuera de franja, se traslada al primer instante ≥ ese momento dentro de una franja legal. Nunca antes.

**Hasta `call_max_contacts` contactos** (5 por defecto: inicial + reintentos). Cadencia entre contactos: `call_retry_delays_minutes` — **2 h → 4 h → 8 h → 24 h** por defecto, contados desde el último contacto y encajados en la siguiente franja legal. (El resultado práctico coincide a menudo con "el mismo día si hay franja, si no la apertura siguiente"; el mecanismo real es el retraso configurable, no una tabla fija de días.)

**Validación previa obligatoria:** si falta `nombre_cliente`, `producto`, `importe_total`, `direccion`, `localidad` o `telefono` → **no se marca la llamada**, el intento pasa a revisión manual con la lista exacta de lo que falta (`missing_data: ...`). El centinela del prompt es la red de seguridad, no el mecanismo — la validación real está en `src/lib/calls/payload.ts`.

---

## 8. Lecciones de las pruebas (por qué las reglas son como son)

Cada una viene de un fallo real observado en llamadas de prueba:

- **El modelo importa.** Con modelos más baratos el agente se saltó la comprobación de datos, le leyó al cliente un mensaje interno del sistema y le preguntó el precio al propio cliente. Con GPT-4.1 la latencia bajó a la mitad y las reglas se cumplieron. **No cambiar de modelo sin repasar los tests adversariales.**
- **Corregir no es terminar.** El agente daba por cerrada la llamada tras corregir la dirección y se saltaba el recordatorio del efectivo — que es justo el objetivo de la llamada.
- **Un dato en la base de conocimiento acaba saliendo por la voz.** El agente vendió el cortaúñas porque su precio estaba en la KB. La solución fue quitar el dato, no añadir otra regla.
- **Nunca negociar precios.** Ante un "yo lo vi por 34", el agente se contradijo y confirmó una cifra que no tenía.
- **Ceder la palabra siempre.** En una prueba pasó por encima del cliente cuatro veces seguidas; en una llamada real eso es un cuelgue.

---

## 9. Pendiente

1. Twilio: bundle regulatorio **en revisión**. Sin número no hay llamadas.
2. Configurar el número en Twilio: trunk SIP con termination en región europea y **origination hacia `sip:sip.retellai.com`** (sin eso, las llamadas devueltas por el cliente no las coge nadie).
3. Revertir los valores por defecto de las variables dinámicas de Retell a los centinelas antes de la primera llamada real.
4. Huecos de la base de conocimiento: envíos fuera de la península, quién paga la devolución, reembolso de un pago en efectivo, y las características físicas de los dos productos.
5. Rollout operativo (kill switch OFF → shadow → allowlist con móvil propio → real): ver `docs/RUNBOOK-LLAMADAS.md`.

---

## Contrato del `analysis` — canónico vs. compatibilidad live (03-09-2026)

**CANONICAL CONTRACT = el repo.** `config/retell/casamable-agent-prompt.md`
declara `resultado` y las correcciones como campos **planos**:
`direccion_corregida`, `localidad_corregida`, `codigo_postal_corregido`,
`telefono_alternativo`, `momento_rellamada`, `pidio_no_llamar`.
**Ese fichero no se reescribe** porque el agente publicado haya derivado: es
la fuente de verdad y lo valida `npm run calls:validate-prompt`.

**LIVE COMPATIBILITY = alias aceptados.** El agente publicado en Retell
entrega hoy `resultado_llamada`, un contenedor `datos_corregidos` y
`pidio_no_llamar`. Para no romper ninguno de los dos, todo se traduce en un
único punto —`normalizeRetellAnalysis()` en `src/lib/calls/analysis.ts`,
función pura, sin DB ni red— y `applyCallAnalysis()` consume **solo** lo
normalizado:

| Campo canónico | Alias aceptados (en orden de precedencia) |
|---|---|
| `resultado` | `resultado_llamada` → `resultado` → `result` |
| correcciones | `datos_corregidos.<canónico>` → campo plano `<canónico>` |
| `momento_rellamada` | dentro de `datos_corregidos` o plano |
| `pidio_no_llamar` | dentro de `datos_corregidos` o plano |

Reglas que **no** cambian: el resultado sigue pasando por `parseCallResult`
(los 12 valores válidos no se amplían, sin coincidencias aproximadas); un
valor vacío del contenedor nunca pisa un campo plano válido; el teléfono
conserva su sanitización a dígitos; `pidio_no_llamar` añade a DNC **aunque el
resultado sea otro** (un cliente puede confirmar el pedido y aun así pedir que
no se le llame más), y solo cuentan booleanos inequívocos — `"false"` es
`false`.

### ⚠️ PENDIENTE de confirmación de Pedro

Las **subclaves exactas** dentro de `datos_corregidos` no están documentadas
en el repo. Se aceptan los nombres **canónicos** dentro del contenedor
(`direccion_corregida`, …). Si el agente publicado escribiera formas cortas
(`direccion`, `localidad`, `codigo_postal`, `telefono`), **no se están
leyendo**: no se han añadido porque no hay evidencia — inventarlas sería
adivinar. Pedro debe pegar un `analysis` real de una llamada con corrección
para confirmarlo.

**RETELL LIVE CONTRACT VALIDATION PENDING**: `scripts/retell-doctor.ts` no
inspecciona hoy el contrato de `analysis` (solo agente, versión y tools), así
que esta comprobación no está automatizada. No se ha ampliado el doctor para
no inventar una validación sobre un contrato sin evidencia.

**Las llamadas siguen MANUAL-ONLY.** Nada de esto activa automatismo.
