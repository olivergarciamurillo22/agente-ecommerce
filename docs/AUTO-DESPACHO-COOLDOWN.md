# Auto-despacho tras cooldown + IA de intención post-confirmación (07-09-2026)

**Estado: implementado, DESACTIVADO por defecto** (dos flags a 0) hasta que
Pedro apruebe el contenido de `config/faq-post-confirmacion.json` y decida
activar el cooldown. Con los flags a 0 el sistema se comporta exactamente
como antes: confirmar dispara el hook inmediato de Beeping y todo texto libre
post-confirmación va a una persona.

## Objetivo de negocio

Hoy un pedido confirmado no se despacha solo. Con esto: el cliente confirma,
pasan 8 h sin que diga nada que suene a cancelación, y el pedido se marca
para enviar automáticamente. Si en ese margen escribe algo, la IA distingue
«cancelación o duda seria» (se para el despacho y va a persona) de «pregunta
simple de la FAQ» (se responde con un texto fijo y el cooldown sigue).

## Pieza 1 · IA de intención (`src/lib/orders/intent-ai.ts`)

Se activa sobre texto libre que llega **después** de confirmar y que el flujo
determinista no entiende (el punto de entrada existente de `fix/whatsapp-
confirmacion-bugs`, que hoy manda ese texto a persona: esto lo refina). Los
casos que el flujo determinista ya resuelve (un "1" repetido, "solo he pedido
uno", cancelación inequívoca por `free-text-intent.ts`) siguen igual y no
gastan llamada.

- Salida estructurada (`json_schema`, `strict`) con el esquema exacto de la spec:

```json
{ "intencion": "cancelacion|duda_conocida|duda_no_reconocida|otro",
  "duda_conocida_id": "string|null", "confianza": 0.0, "respuesta_sugerida": "string|null" }
```

- **Regla fail-closed.** Solo `duda_conocida` **con** `confianza ≥ 0,75` **y**
  una `duda_conocida_id` que exista en la FAQ se responde sola — y con el
  **texto fijo de la FAQ**, nunca con `respuesta_sugerida` (el modelo no
  redacta). Todo lo demás → persona con el mecanismo de siempre
  (`escalateUnknownText` / `executeCancellation`) y el acuse fijo al
  cliente: cancelación, duda no reconocida, otro, confianza baja, id
  desconocida, JSON inválido, fallo de red, timeout (8 s).
- **Una sola respuesta al cliente.** La clasificación es asíncrona: el flujo
  devuelve `followUp` en vez de `reply`, y el caller (Meta o Baileys) envía
  por el outbox lo que devuelva. Nunca "te paso con atención" + FAQ.
- **Auditoría** en `intent_classifications`: mensaje, intención, id de FAQ,
  confianza, si se auto-respondió o se escaló, modelo y respuesta cruda.
  Eventos: `post_confirmation_auto_reply`, `post_confirmation_ai_escalated`,
  `post_confirmation_ai_cancellation`.

### Base de FAQ (`config/faq-post-confirmacion.json`)

Cinco entradas **propuestas por Fable 5.1**, marcadas
`PROPUESTA_PENDIENTE_APROBACION_PEDRO`: plazo de entrega, cambiar la
dirección, forma de pago, seguimiento, contacto. **Pedro debe revisar y
aprobar cada respuesta antes de poner `POST_CONFIRMATION_AI_ENABLED=1`.**
Las cifras (24-48 h, 1-3 días, horario 9:00-18:00) son plantillas a
confirmar, no datos verificados. Cambiar la FAQ no requiere desplegar código:
se lee del fichero (caché por mtime).

## Pieza 2 · Cooldown de auto-despacho (`src/lib/orders/auto-dispatch.ts`)

- Al confirmarse el pedido (`confirmOrder`, con `AUTO_DISPATCH_COOLDOWN_ENABLED=1`)
  se programa una fila en `dispatch_cooldowns` con `due_at = ahora + 8 h`
  (`AUTO_DISPATCH_COOLDOWN_HOURS`). **No** se llama al hook inmediato.
- El scheduler (`runSchedulerTick`, paso 6) evalúa los vencidos. Se despacha
  (`markOrderToSend`, `suppliers/beeping.ts`) **solo si TODAS**:
  1. no hay escalada a persona abierta (`work_items` sin resolver para ese
     pedido, salvo la propia `ALERTA_DIRECCION`, que cuenta aparte);
  2. no hay solicitud de cancelación del cliente sin resolver;
  3. no hay `ALERTA_DIRECCION` abierta (`docs/VALIDACION-DIRECCION-IA.md`);
  4. el pedido sigue `confirmed` y no está cancelado/cerrado por otra vía.
- Si falla una → `status='blocked'` con `blocked_reason`, evento
  `auto_dispatch_blocked`, insignia **DESPACHO RETENIDO** en la lista y bloque
  en la ficha. Nunca se despacha por defecto ante la duda.
- Si Beeping rechaza (404/5xx/timeout) también queda `blocked` con el motivo
  técnico: una persona decide.
- Idempotente: un pedido se despacha una vez (`executed`); repetir el tick no
  lo reenvía.
- **Auditoría** por fila: `scheduled_at`, `due_at`, `evaluated_at`,
  `executed_at`, `executed_via` (`cooldown`|`manual`), `blocked_reason`,
  `outcome`; más eventos `auto_dispatch_scheduled/blocked/executed/manual`.

### Cómo desbloquea una persona un despacho retenido

1. Resolver la causa: la escalada en la bandeja de atención (`/trabajo`), la
   cancelación en Acciones, o la `ALERTA_DIRECCION` en la ficha.
2. En la ficha del pedido, bloque violeta «DESPACHO RETENIDO» → **«Despachar
   ahora»**. No espera otro ciclo de 8 h. Las condiciones se vuelven a
   comprobar (fail-closed): si sigue abierta una, se rechaza con el motivo
   (HTTP 409). Queda en `audit_log` (`dispatch_now`) con nombre y resultado.
   Por API: `POST /api/orders/:id/action` `{ "action": "dispatch_now" }`.

Con el cooldown activo, cerrar una `ALERTA_DIRECCION` **no** despacha por sí
solo: lo decide el temporizador (si aún no venció) o «Despachar ahora». Con el
cooldown apagado, cerrarla libera el hook inmediato que se retuvo.

## Variables

| Variable | Default | Uso |
|---|---|---|
| `AUTO_DISPATCH_COOLDOWN_ENABLED` | `0` | 1 activa el cooldown (local-safe exige 0) |
| `AUTO_DISPATCH_COOLDOWN_HOURS` | `8` | horas de espera (1–168) |
| `POST_CONFIRMATION_AI_ENABLED` | `0` | 1 activa la IA de intención (local-safe exige 0; **no activar sin FAQ aprobada**) |
| `POST_CONFIRMATION_AI_MODEL` | `gpt-4o-mini` | modelo |
| `POST_CONFIRMATION_AI_TIMEOUT_MS` | `8000` | timeout; al vencer → persona |
| `OPENAI_API_KEY` | — | compartida con la validación de direcciones |

## Coste estimado

Una llamada por mensaje de texto libre post-confirmación no resuelto por el
flujo determinista: prompt ≈ 450 tokens (incluye el catálogo de la FAQ) +
≈ 50 de salida. Con `gpt-4o-mini` (0,15 $/M entrada, 0,60 $/M salida):
**≈ 0,0001 $ por mensaje**. Solo una fracción de los pedidos escribe tras
confirmar, así que el coste por pedido es menor aún; con `gpt-4o` sería ~30×
y seguiría siendo despreciable.

## Esquema

Migración 23 (`migrateAutoDispatch`): `dispatch_cooldowns`,
`intent_classifications`. Aditiva; cubierta por el fixture realista
`scripts/test-migration-v43.ts` (17→23).

## Tests (`tests/run-tests.ts`, bloque «Auto-despacho tras cooldown + IA de intención»)

Cancelación detectada → escalada y cooldown retenido · duda conocida con
confianza alta → auto-respuesta con texto fijo y el cooldown sigue y
despacha · duda no reconocida / otro / confianza < 0,75 / id desconocida /
JSON inválido / fallo / timeout → persona (7 casos) · despacho automático a
las 8 h sin incidencias → se ejecuta una sola vez · bloqueado por
`ALERTA_DIRECCION` abierta → no se ejecuta, visible en panel, «despachar
ahora» rechazado hasta cerrarla y aceptado después · flags apagados →
comportamiento anterior · FAQ con 4-6 entradas y estado pendiente de
aprobación. Todo sin red (completer y mark-to-send inyectados).

## Fuera de alcance

No se cambia la FAQ sin aprobación de Pedro. La IA no redacta respuestas
libres. No se toca `platform-companies`.
