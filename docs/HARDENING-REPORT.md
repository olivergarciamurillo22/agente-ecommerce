# Informe de hardening — Casamable

> Rama `fix/hardening-casamable`, 25-08-2026. **No desplegado.**
> Tests: 313 → **370**. Typecheck y build en verde. Esquema 5 → **7**.

## Bugs encontrados y corregidos

### 1. El outbox podía duplicar WhatsApps · CORREGIDO
`markOutboxSent` hacía `UPDATE ... WHERE id = ?`, **sin condición sobre el
estado anterior**. Con un solo proceso no se nota; con dos bots vivos (dos
contenedores, reinicio solapado) ambos leen la misma fila, ambos "reclaman"
con éxito y **el cliente recibe el mismo mensaje dos veces**. El comentario
del código prometía at-most-once y no se sostenía. Ahora lleva `AND sent = 0`
y el loop no envía si pierde el claim.

### 2. Los estados terminales de tracking retrocedían · CORREGIDO
`returned`, `cancelled` e `incident` valían -1 en la tabla de orden, así que
quedaban fuera de la comparación de retrocesos. Comprobado antes de arreglarlo:
`returned → shipped`, `cancelled → delivered` y `returned → delivered` pasaban
sin problema. Un webhook atrasado convertía una devolución en un envío vivo.

### 3. Los dos ejes de estado nunca se encontraban · CORREGIDO
E8 escribía `closure_status`; las métricas leían `supplier_status_normalized`.
Podía haber entregas confirmadas guardadas y la tarjeta seguir diciendo "sin
datos". Es la razón de que el `dropea:reconcile --apply` del 24-08 no moviera
la tasa de entrega.

### 4. `REFUSED` y `REFUSED_LOST_DAMAGED` se contaban igual · CORREGIDO
Los dos normalizan a `returned`, y la traducción a cierre partía de ahí. Pero
uno es el cliente rechazando el COD y el otro un paquete perdido o roto.
Contar el segundo como rehúse **infla la métrica que decide si la publicidad
es rentable**. Ahora el segundo no cierra y va a revisión humana.

### 5. El webhook en vivo de Dropea no escribía el eje de cierre · CORREGIDO
Solo lo hacía el reconciliador, cuando alguien lo ejecutaba a mano.

### 6. `fulfillment_status` global es estructuralmente falso aquí · CORREGIDO
La línea `Seguro de Envío` no se despacha nunca, así que Shopify deja el
pedido en `partial` para siempre. Causa probable del `in_progress = 0`.

### 7. `raw_payload` no sirve para inferir fulfillment · DOCUMENTADO
Se escribe una vez en el INSERT de `orders/create` y nunca se refresca: en ese
instante nada está despachado. Cualquier inferencia sobre él habría devuelto
`not_started` para todos los pedidos, para siempre, **pareciendo un dato**.

### 8. `deliveredToday` no contaba "hoy" · CORREGIDO
Hacía `new Date()` sin poner la hora a cero: contaba "entregados en este
instante". Salía casi siempre 0 y parecía un dato.

### 9. El huso horario dependía del proceso · CORREGIDO
`setHours(0,0,0,0)` y `date(...,'localtime')` usan el huso del proceso. El host
del NAS está en Europe/Brussels. A las 23:30 UTC en verano ya es el día
siguiente en Madrid: los pedidos de la noche contaban en el día equivocado.

### 10. Las ventanas 7d/30d dependían de la hora de consulta · CORREGIDO
Eran "ahora menos N×86400". Ahora van alineadas a medianoche de Madrid y
sobreviven a los días de 23 h y 25 h.

### 11. Métricas que devolvían ceros plausibles ante un fallo · CORREGIDO
`catch { return 0 }`. Ahora toda métrica declara `ok | partial | unknown |
error`, y `value` es `null` cuando hay error.

### 12. `/api/health` publicaba el teléfono del negocio · CORREGIDO
Endpoint público sin credenciales. Ahora enmascarado.

### 13. `dropea-doctor` decía "(ninguno suscrito)" con 6 activos · CORREGIDO
Leía `hooks.items` y la API los devuelve en `data.webhooks`.

### 14. `dropea:mapping:inspect` paraba en la página 10 de 83 · CORREGIDO
El Cortaúñas estaba en la 46, así que "no lo encontraba".

### 15. El normalizador no reconocía nuestro propio vocabulario · CORREGIDO
`delivery_attempted` y `at_pickup_point` caían en `unknown` en silencio salvo
que llegaran por Dropea.

### 16. Los schedulers solo estaban protegidos en memoria · CORREGIDO
`if (timer) return` no protege de un segundo proceso. Ahora hay leases en
SQLite, atómicos y con recuperación tras crash.

### 17. Dos tablas con PII crecían sin límite · CORREGIDO
`messages` y `orders.raw_payload`. Retención configurable, con reducción de
PII en vez de borrado (borrarlo entero rompería el costeo del histórico).

### 18. `.env.example`: 7 variables vivas sin documentar · CORREGIDO

## Correcciones a mi propia auditoría

Dos veces me equivoqué y lo corregí verificando:

- **"No hay autenticación en la API".** Sí la hay, en `src/proxy.ts` — Next 16
  renombró `middleware` a `proxy` y yo busqué el nombre viejo.
- **"25 variables de entorno muertas".** Falsos positivos: se leen
  dinámicamente (`process.env[nombre]`), no como literal. Muerta de verdad
  había **una**, y tampoco se borró: es `[FUTURA]`.

## Lo auditado y correcto (no se tocó)

Pragmas de SQLite (WAL, `busy_timeout`, `foreign_keys`) · PII enmascarada en
logs · los cuatro verificadores de firma comparan en tiempo constante · nada
envía por Baileys directo · un estado desconocido no pisa ni avisa · pedidos
mixtos y sin mapping van a revisión · Dropea sigue en `external_app` sin
escritura · Dropi falla cerrado · ningún backfill puede inventar un
`delivered` (lo impide el tipo) · no hay secretos en el repo.

## Garantías reales del outbox

**At-most-once, no exactly-once.** Baileys no ofrece clave de idempotencia
remota, así que no se puede prometer más.

| Escenario | Qué pasa |
|---|---|
| Dos procesos, misma fila | Uno gana el claim, el otro no envía |
| Crash tras reclamar, antes de enviar | El mensaje **se pierde**. Lo recogen los recordatorios / `needs_call` |
| Crash tras enviar, antes de persistir | No se duplica: la marca va **antes** del envío |
| Fallo blando de Baileys | Se revierte y se reintenta en el siguiente tick |
| Mensaje retenido demasiado tiempo | No se envía solo nunca (`outbox:inspect`) |

El compromiso es deliberado: **perder un mensaje es recuperable, duplicarlo
no.**

## Riesgos residuales

1. **Nada verificado contra datos reales.** La tabla sub-estado → cierre y los
   campos de fulfillment por línea salen de contratos documentados, no de
   payloads de Casamable. Todo falla cerrado, pero es lo menos comprobado.
2. **Puede haber `refused` mal puestos** del `--apply` del 24-08 con la regla
   vieja. Son terminales: **no se corrigen solos**.
3. **Requiere despliegue.** Esquema 7 pendiente.
4. **La retención no es automática.** Se ejecuta a mano, a propósito.
5. **`baileys/handler.ts` mezcla dos responsabilidades**: confirmación COD y
   agente IA del kit. Tocar una puede afectar a la otra.
6. **Los leases no se han probado con dos contenedores reales**, solo con dos
   dueños simulados en tests.
