# Auto-despacho tras cooldown + IA de intención post-confirmación (07-09-2026)

**Estado: implementado, DESACTIVADO por defecto** (dos flags a 0). La FAQ
ya está aprobada por Pedro (07-09); falta su decisión de activar los flags. Con los flags a 0 el sistema se comporta exactamente
como antes: confirmar dispara el hook inmediato de Beeping y todo texto libre
post-confirmación va a una persona.

## Objetivo de negocio

Hoy un pedido confirmado no se despacha solo. Con esto: el cliente confirma,
pasan 6 h (`AUTO_DISPATCH_DEFAULT_HOURS`, confirmado por Pedro el 07-09) sin que diga nada que suene a cancelación, y el pedido se marca
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

### Auto-cancelación por IA en casos inequívocos (07-09, cambio de diseño de Pedro)

Umbral propio **`AI_CANCEL_MIN_CONFIDENCE = 0,85`** (`src/lib/orders/ai-cancellation.ts`),
más estricto que el de la FAQ (0,75) porque aquí la acción es sobre el pedido.

- `cancelacion` con confianza **≥ 0,85** → el sistema, sin esperar a nadie:
  1. **cancela el pedido** en el eje operativo local (`orders.status`
     confirmed → cancelled, como el resultado de una llamada). **Shopify y
     el proveedor no se tocan**: siguen siendo acciones humanas con sus
     gates (`beeping/cancel.ts`, `DROPEA_WRITE_ENABLED`). El tag
     WA_CONFIRMED no se retira.
  2. **para el cooldown** de auto-despacho (`dispatch_cooldowns.status =
     cancelled`); «Despachar ahora» también queda rechazado.
  3. **avisa a una persona de inmediato** (para revertir rápido, no para
     aprobar antes): work_item «Cancelación automática por IA: revisar y
     revertir si es incorrecta» + modo HUMAN en la bandeja, y WhatsApp a
     `ALERT_WHATSAPP` por el outbox (pasa por los safety gates: en SAFE MODE
     queda en el log) con el texto «Pedido #X cancelado automáticamente por
     IA (confianza N). Revisar y revertir si es incorrecto», cliente, mensaje
     y **enlaces directos** a la ficha (`/?order=<id>`) y a la conversación
     (`/trabajo?conversationId=<id>`).
  4. **audita** en `ai_cancellations` (migración 25): mensaje original,
     confianza, modelo, estado previo, estado y vencimiento del cooldown
     antes, vía de aviso, timestamp; y en `intent_classifications` como
     hasta ahora. Eventos `ai_cancellation_executed` (critical),
     `ai_cancellation_notified`, `ai_cancellation_alert_not_sent`.
  5. responde al cliente con el texto fijo `MSG_CANCELLED_AUTO` («Hecho ✅
     Tu pedido queda cancelado…»), nunca con `respuesta_sugerida`.
- `cancelacion` con confianza **< 0,85** (ambiguo): **nada cambia** respecto
  a lo anterior: petición estampada, escalada a persona, cooldown retenido,
  acuse `MSG_CANCEL_RECEIVED`. No se cancela nada.
- La auto-cancelación **no procede** (y cae al camino de escalada, evento
  `ai_cancellation_skipped`) si el pedido ya no está `confirmed`, ya está
  cerrado, **ya se despachó** (cooldown `executed`) o ya está creado en el
  proveedor (`supplier_sync_status` syncing/synced): cancelar «en local» un
  pedido que ya salió sería mentir; eso lo gestiona una persona con el
  proveedor. Es idempotente: una segunda cancelación no duplica ni re-avisa.

**Reversión desde el panel** (ficha → bloque rojo «CANCELADO AUTOMÁTICAMENTE
POR IA» → **«Revertir cancelación»**; API `POST /api/orders/:id/action`
`{ "action": "revert_ai_cancellation", "note"? }`, propietario): el pedido
vuelve a `confirmed`, la solicitud de cancelación se borra (deja de bloquear
el despacho), el work_item se cierra y el **cooldown se REINICIA** desde ese
momento (6 h nuevas) si `AUTO_DISPATCH_COOLDOWN_ENABLED=1`. **Decisión
técnica**: reiniciar en vez de reanudar donde estaba, porque tras un
«cancelar» del cliente y una corrección humana una ventana entera es más
prudente, y no exige contabilizar tiempo pausado. La conversación sigue en
HUMAN (quien revierte ya la atiende). Queda en `audit_log`
(`revert_ai_cancellation`) y en `ai_cancellations.reverted_*`. Revertir dos
veces se rechaza (409). Insignia **CANCELADO POR IA** en el listado.

Con `POST_CONFIRMATION_AI_ENABLED=0` (default) nada de esto existe: el flujo
determinista de siempre.

### Base de FAQ (`config/faq-post-confirmacion.json`) — APROBADA por Pedro (07-09-2026)

Siete entradas con el **texto literal de Pedro** (`status: APROBADA_PEDRO_2026-09-07`),
en su formato `id / disparadores / respuesta [/ escala]` (el loader también
acepta el formato antiguo). Cambiar la FAQ no requiere desplegar código: se lee
del fichero (caché por mtime).

| id | disparadores (resumen) | ¿escala a persona? |
|---|---|---|
| `tiempo_entrega` | cuánto tarda, cuándo llega, plazo de entrega | no: responde y el cooldown sigue |
| `forma_pago` | cómo pago, contrareembolso, pago al recibir | no |
| `cambio_direccion` | cambiar dirección, dirección equivocada | **sí** (decisión técnica de Fable: el cambio tras confirmar lo aplica una persona y retiene el despacho; Pedro puede quitar `escala`) |
| `garantia_devolucion` | garantía, devolución, no me gusta | **sí** |
| `seguimiento_pedido` | dónde está mi pedido, tracking | **sí** |
| `contacto_humano` | hablar con alguien, atención al cliente | **sí** |
| `especificaciones_producto` | medidas, tamaño, material, qué trae el pack, peso, colores… | **sí** |

**`escala: true` = escalada REAL, no solo el mensaje.** Cuando el modelo
elige una de esas entradas (confianza ≥ 0,75), el cliente recibe su texto fijo
**y además** se abre exactamente la misma escalada que cualquier otro caso a
humano: work_item «FAQ '<id>': te paso con atención al cliente», modo HUMAN,
`needs_call`, despacho automático retenido hasta que la persona resuelva,
evento `post_confirmation_faq_escalated`, y en `intent_classifications`
`auto_replied=1, escalated=1`. Test: «FAQ · entradas con escala=true…».

**Regla explícita: una pregunta sobre una característica técnica del
producto** (medidas, materiales, compatibilidad, funcionamiento, contenido
del pack, garantía) **acaba SIEMPRE en persona.** O bien coincide con
`especificaciones_producto` (texto fijo «te paso con atención al cliente» +
escalada real), o bien no coincide con nada y es `duda_no_reconocida` →
persona. Nunca se genera una respuesta libre: el modelo solo puede elegir un
id existente (un id inventado → `duda_conocida_id_desconocida` → persona) y
el texto que sale es siempre el del fichero. Está en el prompt
(`buildIntentSystemPrompt`, «REGLA ESTRICTA») y en tests («FAQ · pregunta
técnica de producto…»).

Con la FAQ aprobada, lo que falta para `POST_CONFIRMATION_AI_ENABLED=1` es
solo la decisión de Pedro y `OPENAI_API_KEY` en el `.env` del NAS.

## Pieza 2 · Cooldown de auto-despacho (`src/lib/orders/auto-dispatch.ts`)

- Al confirmarse el pedido (`confirmOrder`, con `AUTO_DISPATCH_COOLDOWN_ENABLED=1`)
  se programa una fila en `dispatch_cooldowns` con `due_at = ahora + 6 h`
  (`AUTO_DISPATCH_COOLDOWN_HOURS`). **No** se llama al hook inmediato.
- El scheduler (`runSchedulerTick`, paso 6) evalúa los vencidos. Se despacha
  **por el canal del producto** (ver «Router de canal») **solo si TODAS**:
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

### Router de canal: Beeping O Dropea, según el producto, nunca ambos

Aclaración explícita de Pedro (07-09): cada producto se despacha por un solo
canal, y **quién lo decide es Pedro, producto a producto**. El sistema no
adivina.

- **Configuración:** tabla `dispatch_channels` (migración 24), una fila por
  SKU, variante o producto de Shopify → `channel: beeping | dropea`. **Nace
  vacía** y sigue vacía hasta que Pedro la rellene:
  `npm run dispatch:channels -- --list` ·
  `--set --sku ORG-01 --channel beeping --apply` (dry-run sin `--apply`) ·
  `--unset --sku ORG-01 --apply`. Ningún producto actual (organizador, etc.)
  tiene canal asignado: no se ha asumido nada.
- **Resolución por pedido** (`src/lib/orders/dispatch-channel.ts`): todas las
  líneas de producto físico deben resolver al mismo canal (prioridad variante
  > SKU > producto; el SKU no distingue mayúsculas). Sin fila para alguna
  línea, o con líneas en canales distintos → `null`.
- **Al vencer el cooldown**, tras las cuatro condiciones de arriba:
  - `beeping` → `markOrderToSend` (`suppliers/beeping.ts`, `PUT
    /api/order/mark-to-send/{external_id}`, contrato documentado y probado).
  - `dropea` → `confirmDropeaOrder` (`suppliers/dropea/create-order.ts`).
    **Contrato real encontrado**: `POST /dropshipper/orders/{id}/confirm`
    (`docs/DROPEA-API-CONTRACT.md` §4, «Confirmar → llega al proveedor»), ya
    implementado con clave de idempotencia y claim. Exige que el pedido
    exista ya en Dropea (adoptado desde su app oficial:
    `supplier_external_order_id`) y `DROPEA_WRITE_ENABLED=1`. **Esa llave está
    a 0 por política** (`CLAUDE.md` §2, `env-schema` la fuerza a 0 en todos
    los perfiles locales): mientras siga así, un producto en `dropea` queda
    **RETENIDO** con el motivo `Dropea: … (write_disabled)`. Nunca se salta la
    llave ni se desvía el pedido a Beeping. Dropi PRO no tiene API pública
    (`docs/DROPI-API-CONTRACT.md`): no hay adaptador posible, y un producto
    de Dropi solo puede marcarse a mano desde su panel.
  - `null` (sin configurar o mezclado) → **no se despacha**: `blocked` con
    `pendiente de configurar canal de despacho: <SKUs que faltan>`, insignia
    DESPACHO RETENIDO, y «Despachar ahora» también lo rechaza hasta que
    exista el canal.
- **Nunca dos canales para el mismo pedido**: el router elige uno o ninguno;
  el fallo de un adaptador jamás desvía al otro (test «CANAL · producto en
  Dropea…»). La columna `dispatch_cooldowns.channel` deja constancia de por
  cuál salió (o iba a salir).

### Aviso de despacho al cliente (07-09, propuesta)

Al ejecutarse el despacho por cualquiera de los dos canales se intenta el
«recordatorio de envío» (`src/lib/orders/dispatch-notice.ts`, plantilla
`dispatch_notice`), **apagado por defecto** (`DISPATCH_NOTICE_WHATSAPP_ENABLED=0`)
y con el mapping deshabilitado hasta que Pedro apruebe el texto y Meta la
apruebe: `docs/WHATSAPP-TEMPLATES.md` § Plantillas de recordatorio. El aviso
del día de entrega ya existe (`reparto_hoy`); no hay fecha estimada en Beeping.

### Cómo desbloquea una persona un despacho retenido

1. Resolver la causa: la escalada en la bandeja de atención (`/trabajo`), la
   cancelación en Acciones, o la `ALERTA_DIRECCION` en la ficha.
2. En la ficha del pedido, bloque violeta «DESPACHO RETENIDO» → **«Despachar
   ahora»**. No espera otro ciclo de 6 h. Las condiciones se vuelven a
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
| `AUTO_DISPATCH_COOLDOWN_HOURS` | `6` | horas de espera (1–168); la constante citable es `AUTO_DISPATCH_DEFAULT_HOURS` en `auto-dispatch.ts` |
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

Migraciones 23 (`migrateAutoDispatch`: `dispatch_cooldowns`,
`intent_classifications`), 24 (`migrateDispatchChannels`: `dispatch_channels` +
columna `dispatch_cooldowns.channel`) 25 (`migrateAiCancellations`:
`ai_cancellations`) y 26 (`migrateDispatchNotice`: `orders.dispatch_notice_sent_at`).
Aditivas; cubiertas por el fixture realista `scripts/test-migration-v43.ts` (17→26).

## Tests (`tests/run-tests.ts`, bloque «Auto-despacho tras cooldown + IA de intención»)

Cancelación detectada → escalada y cooldown retenido · duda conocida con
confianza alta → auto-respuesta con texto fijo y el cooldown sigue y
despacha · duda no reconocida / otro / confianza < 0,75 / id desconocida /
JSON inválido / fallo / timeout → persona (7 casos) · despacho automático a
las 6 h sin incidencias → se ejecuta una sola vez · bloqueado por
`ALERTA_DIRECCION` abierta → no se ejecuta, visible en panel, «despachar
ahora» rechazado hasta cerrarla y aceptado después · flags apagados →
comportamiento anterior · FAQ aprobada (7 entradas, texto literal; las de escala=true responden Y escalan) ·
**router de canal**: sin canal nunca se despacha (ni manual); Beeping → solo Beeping;
Dropea → solo Dropea (éxito inyectado despacha; adaptador real con llave cerrada
queda retenido); líneas en canales distintos → retenido; en ningún caso se
llaman los dos adaptadores. Todo sin red (completer, mark-to-send y confirm de
Dropea inyectados). **Auto-cancelación**: confianza ≥ 0,85 → se cancela sola,
cooldown parado, aviso (bandeja + WhatsApp retenido por gates), auditoría,
cero llamadas externas, idempotente · confianza 0,84/0,6/0,3 o pedido ya
despachado → escalada sin cancelar · «Revertir cancelación» por la API del
panel → confirmed, cooldown reiniciado, audit_log; segunda reversión 409.

## Fuera de alcance

No se cambia la FAQ sin aprobación de Pedro. La IA no redacta respuestas
libres. No se toca `platform-companies`.
