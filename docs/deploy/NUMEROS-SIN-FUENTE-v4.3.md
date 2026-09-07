# Auditoría de números sin fuente · Casamable v4.3

Alcance cerrado: `src/lib/orders/**`, `src/lib/calls/**` y `config/**`. Auditoría realizada sobre el código de la release; no cambia ningún valor. “Sin fuente” significa que el repositorio no enlaza una decisión fechada, contrato oficial o evidencia externa suficiente para justificar el número.

## Decisiones de negocio pendientes de Pedro

| Archivo:línea | Valor actual | Qué controla | Evidencia encontrada | Decisión de Pedro |
|---|---:|---|---|---|
| `src/lib/orders/scheduler.ts:71` | 30 min | Primer recordatorio | Solo default de código | Confirmar, cambiar o documentar origen |
| `src/lib/orders/scheduler.ts:72` | 120 min | Escalado a llamada | Solo default de código | Confirmar, cambiar o documentar origen |
| `src/lib/orders/confirmation.ts:300` | 45 min | Vigencia del pedido seleccionado | Comentario contradictorio: también dice “media hora” | Elegir duración y corregir la documentación en otra fase |
| `src/lib/orders/confirmation.ts:305` | 2 repeticiones | Derivación humana ante el mismo selector | Solo default de código | Confirmar o cambiar |
| `src/lib/orders/multi-order.ts:34` | 48 h | Ventana para considerar pedidos duplicados | Solo default de código | Confirmar o cambiar |
| `src/lib/orders/messages.ts:138` | 5 pedidos | Máximo mostrado en selector | Solo implementación | Confirmar o cambiar |
| `src/lib/orders/notify-delay.ts:237` | 3 s | Ritmo de la campaña de retrasos | Solo default de código | Confirmar contra límite real de Meta/proveedor |
| `src/lib/orders/notify-delay.ts:238` | 3 fallos | Corte por fallos consecutivos | Solo default de código | Confirmar o cambiar |
| `src/lib/calls/config.ts:38-39` | 30/día | Tope diario de llamadas reales | Solo default de código | Confirmar capacidad y presupuesto |
| `src/lib/calls/config.ts:95-96` | 15 min | Espera antes de activar llamadas | Solo default de código | Confirmar o cambiar |
| `src/lib/calls/config.ts:101-102` | 5 contactos | Máximo total por pedido | Comentario de intención, sin aprobación enlazada | Confirmar cumplimiento y política comercial |
| `src/lib/calls/config.ts:116-117` | 120 min | Primer reintento | Comentario “decisión 24-08-2026”, sin acta enlazada | Confirmar que sigue vigente |
| `src/lib/calls/schedule.ts:15-16` | 09–13 y 17–20, lun–sáb | Franjas legales de llamada | Afirmación en comentario, sin fuente legal enlazada | Validar para España y uso comercial vigente |
| `src/lib/calls/scheduler.ts:74` | 3 fallos | Envío a revisión por errores técnicos | Solo constante | Confirmar o cambiar |
| `src/lib/calls/scheduler.ts:76` | 10 min | Intento `reserved/dialing` considerado atascado | Solo constante | Confirmar contra latencia de Retell |
| `src/lib/calls/scheduler.ts:78` | 30 min | Espera del análisis de llamada | Solo constante | Confirmar contra SLA de Retell |
| `src/lib/calls/scheduler.ts:108` | 60 min | Fallback si WhatsApp inicial no salió | Solo default | Confirmar interacción con el escalado de 120 min |
| `src/lib/calls/scheduler.ts:504` | −5 min / +30 días | Rango aceptado de una rellamada solicitada | Solo implementación | Confirmar tolerancia y horizonte |

## Límites técnicos que conviene ratificar

No son decisiones comerciales directas, pero tampoco tienen una fuente enlazada en el alcance auditado.

| Archivo:línea | Valor actual | Función | Decisión de Pedro |
|---|---:|---|---|
| `src/lib/orders/scheduler.ts:75` | mínimo 3 s; default 20 s | Poll de pedidos | Mantener salvo restricción operativa del NAS |
| `src/lib/orders/scheduler.ts:78` | 10 min | Backoff de tags Shopify | Confirmar contra rate limits/SLA |
| `src/lib/orders/scheduler.ts:95-96` | 20 acciones / scan 500 | Equidad y carga por tick | Ratificar tras medir backlog real |
| `src/lib/orders/attribution.ts:54` | 250 caracteres | Recorte de atribución | Ratificar según límites de almacenamiento/analítica |
| `src/lib/orders/normalize.ts:279,294` | 300 / 500 caracteres | Resumen de productos / nota | Ratificar para evitar truncar datos útiles |
| `src/lib/calls/scheduler.ts:115,222` | scan 500 / due 500 | Lectura de colas de llamadas | Ratificar tras medir backlog real |
| `src/lib/calls/scheduler.ts:718` | mínimo 15 s; default 60 s | Poll de llamadas | Mantener salvo SLA medido |
| `src/lib/calls/retell.ts:124` | 15 s | Timeout HTTP de creación | Confirmar contra documentación/SLA de Retell |
| `src/lib/calls/schedule.ts:47-90` | 60 días | Guardia de búsqueda de hueco | Mantener como límite defensivo o documentar otro horizonte |

## Números revisados que sí tienen fundamento explícito

- `src/lib/calls/retell-webhook.ts`: frescura de 5 minutos y digest SHA-256 de 64 hex se atribuyen en el propio archivo al SDK oficial de Retell revisado el 03-09-2026.
- `src/lib/calls/payload.ts`: E.164 de 8–15 dígitos y código postal español de 5 dígitos son validaciones de formato, no métricas de negocio.
- `src/lib/calls/calendar.ts`: constantes del cálculo de Pascua y fechas festivas son datos algorítmicos/calendario, no umbrales ajustables.
- `src/lib/orders/closure.ts`: `10000 / 100` conserva dos decimales en un porcentaje; no introduce una tasa ficticia.
- `config/whatsapp-templates.json`: aridades, ventanas de 24 h, TTL de 12 h, estados y códigos son contratos/incidentes anotados; no se usan para inventar resultados económicos.
- Identificadores, códigos HTTP, fechas, conversiones de segundos, longitudes criptográficas, índices, cardinalidad gramatical y valores booleanos `0/1` no se consideran decisiones numéricas de negocio.

## Conclusión

No se encontraron precios, porcentajes de conversión, márgenes, probabilidades ni costes inventados dentro del alcance. Sí quedan 18 decisiones de negocio y 9 límites técnicos que Pedro debe ratificar o respaldar con una fuente. Hasta entonces deben tratarse como defaults operativos, no como datos validados.

---

## Ampliación 07-09-2026 · código nuevo de la semana (Bloque 3, auditoría sin cambiar valores)

Alcance: `src/lib/orders/address-assessment.ts`, `address-ai.ts`, `address-validation.ts`, `intent-ai.ts`, `auto-dispatch.ts`, `dispatch-channel.ts` y sus variables en `env-schema.ts`. Las constantes económicas de Hunter (`src/lib/hunter/scoring.ts`: 7,77 € CPA, 62,9 % entrega, 9,37 € rechazo, 1,40 € picking, tramos 3,80–4,00 €, pesos 40/35/0/10/10/5) ya tienen su fuente o su marca «supuesto» en `docs/HUNTER-SPEC.md` y no se repiten aquí.

Clasificación: **CRITERIO** = criterio de ingeniería documentado en el propio archivo, no toca resultados de negocio, se puede cambiar sin decisión de Pedro; **PEDRO** = afecta a qué pedidos se despachan, se retienen o se responden solos, y necesita su validación (o una medición que la sustituya).

### Necesitan validación de Pedro

| Archivo:línea | Valor actual | Qué controla | Evidencia encontrada | Clasificación · decisión pendiente |
|---|---:|---|---|---|
| `src/lib/orders/auto-dispatch.ts:30` | 6 h | Cooldown entre confirmar y despachar (`AUTO_DISPATCH_DEFAULT_HOURS`) | Comentario «confirmado por Pedro (07-09-2026)» en el propio archivo, sin acta enlazada | **PEDRO** · ya decidido verbalmente; solo falta enlazar la decisión (ratificado, sin cambio) |
| `src/lib/orders/address-ai.ts:20` | 0,60 | Confianza mínima de la capa 2 para aceptar el veredicto del modelo; por debajo → `dudosa` (fail-closed) | Solo constante + doc `VALIDACION-DIRECCION-IA.md`. No hay medición sobre pedidos reales | **PEDRO** (o medición) · bajar deja pasar más veredictos del modelo; subir manda más pedidos a alerta. Con el flag a 0 no tiene efecto |
| `src/lib/orders/intent-ai.ts:26` | 0,75 | Confianza mínima para auto-responder una FAQ; por debajo → persona | Solo constante + `AUTO-DESPACHO-COOLDOWN.md`. Más estricto que 0,60 a propósito (responder solo al cliente es más sensible que abrir una alerta interna) | **PEDRO** (o medición) · con el flag a 0 no tiene efecto; revisar junto con la FAQ |
| `src/lib/orders/address-validation.ts:229` | 3 días | Antigüedad máxima de un pedido para pasarlo por la capa 2 | Solo default de código. Intención: no gastar llamadas en pedidos viejos que ya se resolvieron por otra vía | **PEDRO** (leve) · si un pedido tarda más de 3 días en confirmarse, su dirección ya no pasa por IA. Coincide de forma aproximada con el escalado a llamada + rellamadas, pero nadie lo ha cruzado con el ciclo real |
| `src/lib/orders/address-assessment.ts:36` | 6 caracteres | Dirección más corta que se considera plausible (capa 1) | Solo constante. «Mayor 5» tiene 7; nada de 5 o menos es una dirección entregable en España | **PEDRO** (leve) · criterio razonable; ratificar que no bloquea ningún formato real del histórico |
| `src/lib/orders/address-assessment.ts:145-159` | listas de relleno («test», «asd», «qwerty», `aaaa`, solo dígitos…) | Qué se considera dirección basura en la capa 1 | Solo listas en código, sin contraste contra el histórico de pedidos rechazados | **PEDRO** (o medición) · falso positivo = alerta innecesaria (no bloquea la confirmación, sí retiene el despacho automático) |
| `src/lib/orders/address-assessment.ts:79-104` | tabla prefijo CP → provincia (INE) | Coherencia CP/provincia | Fuente pública (codificación INE de provincias, 2 primeros dígitos del CP). No enlazada en el archivo | **CRITERIO** con fuente externa conocida · añadir el enlace al INE en otra fase; no requiere decisión |

### Criterio de ingeniería documentado (no requiere decisión)

| Archivo:línea | Valor actual | Función | Por qué es criterio y no decisión |
|---|---:|---|---|
| `address-ai.ts:21`, `intent-ai.ts:27` | 8 000 ms | Timeout por llamada a OpenAI (`*_TIMEOUT_MS`); al vencer → fail-closed | Latencia típica de `gpt-4o-mini` con salida estructurada es de 1–3 s; 8 s deja margen sin bloquear el tick del scheduler (20 s de poll). Configurable por env dentro de 1 000–60 000 |
| `address-ai.ts:101`, `intent-ai.ts:106` | 1 000–60 000 ms | Rango aceptado del timeout por env; fuera de rango → default | Defensivo: evita un timeout de 0 (todo falla) o de minutos (bloquea el scheduler) |
| `address-ai.ts:157`, `intent-ai.ts:179` | +500 ms | Margen del temporizador propio sobre el timeout del SDK | Deja que el timeout del SDK gane primero (mensaje más claro); el nuestro es la red de seguridad |
| `address-validation.ts:229,250`, `scheduler.ts:360` | 5 pedidos/tick | Máximo de llamadas a la capa 2 por tick del scheduler | Acota coste y duración del tick (5 × 8 s máximo = 40 s en el peor caso, serializado). Con el poll de 20 s, un backlog se vacía a 15 pedidos/min: sobrado para el volumen actual (116 pedidos en la muestra histórica). Ratificar si el volumen se multiplica por 10 |
| `address-validation.ts:235` | 200 filas | Barrido de candidatos antes de filtrar por hash | Cota de lectura: 3 días de pedidos rara vez superan 200; si lo hicieran, los más antiguos esperarían al siguiente tick, sin pérdida |
| `address-validation.ts:61` | sha256 → 32 hex | Clave de caché por contenido de la dirección | «TTL por hash» significa **sin TTL temporal**: la caché es por contenido, se invalida solo cuando cambia la dirección. Es la elección correcta (una misma dirección no se reevalúa nunca; una corrección sí). 32 hex = 128 bits, colisión despreciable |
| `address-validation.ts:136` | 4 problemas | Problemas citados en el texto del `work_item` | Legibilidad del panel; la lista completa queda en `address_validations.problems` |
| `address-validation.ts:147-152` | 120 / 500 / 120 caracteres | Recorte de `resolved_by`, nota de resolución y texto del evento | Límites de almacenamiento/legibilidad, no de negocio |
| `address-ai.ts:128,167,175`, `intent-ai.ts:171,178,190` | 200 / 2 000 caracteres | Recorte de cada problema, de la respuesta cruda auditada y del texto del cliente enviado al modelo | Coste de tokens y tamaño de la auditoría; 2 000 caracteres es más que cualquier mensaje real de WhatsApp de un cliente |
| `intent-ai.ts:110` | 3 ejemplos por FAQ | Ejemplos incluidos en el prompt por entrada | Coste del prompt (~450 tokens con 5 entradas); más ejemplos no mejoran la clasificación de forma medible |
| `intent-ai.ts:74-89` | caché por `mtime` | Recarga de `faq-post-confirmacion.json` | Sin TTL: se relee solo cuando cambia el fichero. Cambiar la FAQ no requiere desplegar |
| `auto-dispatch.ts:51` | 1–168 h | Rango aceptado de `AUTO_DISPATCH_COOLDOWN_HOURS`; fuera → 6 h | Defensivo: 0 h anularía el cooldown; > 7 días no tiene sentido operativo |
| `auto-dispatch.ts:168` | 20 vencidos/tick | Máximo de cooldowns evaluados por tick | Cada evaluación puede llamar a Beeping/Dropea (timeouts propios); 20 acota el tick. Mismo criterio que las «20 acciones/tick» ya auditadas del scheduler |
| `db.ts:2686` (`getRecentConfirmedOrdersByPhone`) | 30 días | Ventana de pedidos confirmados por teléfono para cancelación/texto libre post-confirmación | Es de la línea del 05-09 (`6466f69`), no de esta semana; se cita porque el intent-ai lo reutiliza. Criterio: fuera de 30 días un pedido está entregado o cerrado |

### Números revisados que sí tienen fundamento explícito

- `address-assessment.ts:130`: CP español de 5 dígitos y 2 primeros dígitos = provincia (INE); formato, no umbral.
- `address-ai.ts` / `intent-ai.ts`: esquema `json_schema` `strict`, `confianza` en 0..1; contrato de salida, no métrica.
- `dispatch-channel.ts`: no contiene ningún número ajustable (prioridad variante > SKU > producto es orden de especificidad, y la tabla nace vacía por decisión explícita de Pedro).
- `env-schema.ts`: `ADDRESS_AI_MODEL` / `POST_CONFIRMATION_AI_MODEL` = `gpt-4o-mini` con «~0,0001 € por pedido»: la cifra sale de la tarifa pública de OpenAI (0,15 $/M entrada, 0,60 $/M salida) × ~500 tokens; es una estimación de coste, no un dato de negocio.

### Conclusión de la ampliación

Nada del código nuevo inventa precios, márgenes ni tasas. Quedan **3 umbrales que sí condicionan el negocio** (6 h ya decidido por Pedro, 0,60 y 0,75 sin medir) y **4 criterios leves** (3 días, 6 caracteres, listas de relleno, tabla INE sin enlace). Todos están detrás de flags a 0 salvo la capa 1 (6 caracteres y relleno), que hoy solo abre alertas visibles y no bloquea nada por sí sola. Ningún valor se ha cambiado en esta auditoría.
