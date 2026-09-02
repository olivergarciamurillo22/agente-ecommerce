> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

# Clasificación del código heredado

> Auditado el 25-08-2026. El repo nació como un kit genérico de agente de
> WhatsApp y se convirtió en el sistema de pedidos COD de Casamable. Queda
> código de aquella etapa. **No se ha borrado nada:** todo lo listado como
> DORMANT o LEGACY sigue importado por alguien, y borrarlo rompería el build.

## Leyenda

| Etiqueta | Significa |
|---|---|
| **ACTIVE** | Casamable depende de esto todos los días |
| **DORMANT** | Funciona y está enganchado, pero apagado por configuración |
| **LEGACY** | Del kit original. Sigue importado, no aporta a Casamable |
| **SAFE_TO_REMOVE** | Nadie lo importa. Se puede borrar |

## Inventario

| Módulo | Estado | Quién lo importa | Nota |
|---|---|---|---|
| `orders/*` | **ACTIVE** | todo | El corazón: confirmación, cierre, fulfillment, elegibilidad |
| `shopify/*` | **ACTIVE** | webhooks, backfill, reconcile | |
| `suppliers/dropea/*` | **ACTIVE** | routing, tracking, E8 | Solo lectura |
| `tracking/*` | **ACTIVE** | schedulers, webhooks | |
| `calls/*` | **ACTIVE** (apagado) | `start-bot` | Kill switch OFF, shadow ON |
| `system/*` | **ACTIVE** | Control Center | |
| `baileys/*`, `whatsapp.ts`, `safety.ts` | **ACTIVE** | envío | |
| `time.ts`, `leases.ts`, `retention.ts`, `errors.ts` | **ACTIVE** | nuevos del hardening | |
| `suppliers/dropi/*` | **DORMANT** | router, provider | Andamiaje completo, `isConfigured()=false`. Espera documentación de su soporte |
| `watchdog.ts` | **DORMANT** | `baileys/client` | Se activa con `ALERT_WHATSAPP` |
| `openrouter.ts` | **LEGACY** | `watchdog`, `baileys/handler` | Agente conversacional del kit. **Doble opt-in**: necesita `OPENROUTER_API_KEY` **y** `AI_AGENT_ENABLED=1`. Sin las dos, no se llama |
| `system-prompt.ts`, `tools/` | **LEGACY** | `openrouter` | Solo tienen sentido con el agente IA |
| `humanize.ts` | **LEGACY** | `baileys/handler` | Trocea respuestas del agente IA |
| `vision.ts`, `transcribe.ts` | **LEGACY** | `baileys/handler` | Imágenes y notas de voz. Casamable recibe "1/2/3" |
| `memory.ts` | **LEGACY** | `tools/`, `baileys/handler` | Memoria del agente conversacional |
| `insights.ts` | **LEGACY** | `/api/analytics` | Analítica del kit, distinta del Control Center |
| `airtable.ts` | **LEGACY** | `tools/guardar-lead` | Captura de leads. Casamable no la usa |
| `guardrails.ts` | **ACTIVE** | `baileys/handler` | Filtra entrada aunque el agente IA esté apagado |
| **(ninguno)** | SAFE_TO_REMOVE | — | Nada está huérfano |

## Por qué no se borra

**Nada está huérfano.** Los once módulos del kit siguen importados por
`baileys/handler.ts`, que es el receptor de mensajes: hace falta para el flujo
de confirmación COD y arrastra el resto por sus ramas de agente IA.

Borrarlos exige antes **desenredar `baileys/handler.ts`**, separando el camino
"responder 1/2/3 a un pedido" del camino "conversar con un agente IA". Es una
tarea propia, con su rama y sus tests, no algo que se cuele en una limpieza.

Mientras tanto **no molestan y no gastan**: el agente IA tiene doble opt-in
(`OPENROUTER_API_KEY` + `AI_AGENT_ENABLED=1`) y sin las dos no se llama a
ninguna API ni se gasta un euro.

## Riesgo real de lo heredado

Bajo, con una excepción que conviene tener presente: `baileys/handler.ts`
mezcla dos responsabilidades muy distintas en un fichero. Si alguien toca la
rama del agente IA sin querer, puede afectar al camino de confirmación de
pedidos, que sí es crítico. **Recomendación:** separarlo antes de reactivar
nada del agente conversacional.
