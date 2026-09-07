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
