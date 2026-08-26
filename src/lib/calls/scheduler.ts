// ============================================================
// Orquestador de llamadas de confirmación (E7).
//
// ESTE módulo decide a quién llamar, cuándo y cuántas veces. El proveedor
// de voz (Retell) solo ejecuta la conversación; jamás consulta nuestra DB.
//
// Sin setTimeout por llamada: todo el estado vive en SQLite (call_attempts)
// y cada tick deriva de la DB qué toca. Un reinicio no pierde nada.
//
// FRONTERA DE CÓDIGO: aquí no se importa NADA de WhatsApp/Baileys ni de
// proveedores de fulfillment (test de código fuente lo vigila). El dominio
// compartido entra por db.ts y orders/eligibility.
//
// Cadena de seguridad antes de CADA marcación, en orden:
//   kill switch → shadow → elegibilidad (re-evaluada) → DNC → allowlist →
//   tope diario → franja horaria → validación de datos → claim atómico →
//   DNC otra vez (carrera) → persistir 'dialing' → proveedor.
// ============================================================

import pino from "pino";
import { acquireLease, LEASE_CALLS } from "../system/leases";
import {
  addDncPhone,
  hasManualReviewCallAttempt,
  claimCallAttempt,
  countCallsStartedSince,
  countConsumedContacts,
  countRecentTechFailures,
  getActiveCallAttemptForOrder,
  getCallAttemptByProviderId,
  getOrderById,
  insertCallAttempt,
  isDncPhone,
  listDueCallAttempts,
  listCallAttemptsByState,
  listUnprocessedCallEvents,
  markCallEventProcessed,
  markOrderCancelledByCall,
  markOrderConfirmed,
  applyOrderCorrection,
  setOrderClosure,
  systemDbHandle,
  transitionCallAttempt,
  type CallAttemptRow,
  type OrderRow,
} from "../db";
import { isConfirmationEligible } from "../orders/eligibility";
import { logIntegrationEvent, runInstrumented } from "../system/repo";
import { maskPhone } from "../safety";
import { defaultHolidayCalendar, type HolidayCalendar } from "./calendar";
import {
  aiCallsEnabled,
  callAllowedByAllowlist,
  callFirstRetryMinutes,
  callMaxContacts,
  callTriggerMinutes,
  callsDailyCap,
  callsShadowMode,
} from "./config";
import { buildCallPayload } from "./payload";
import { ProviderRequestError, type CallProvider, type ParsedCallEvent } from "./provider";
import { retellProvider } from "./retell";
import { insideCallWindow, madridDate, madridParts, nextCallableDayAfter, nextCallSlot, windowStart } from "./schedule";
import { parseCallResult, RESULT_OUTCOMES, type CallResult } from "./results";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const MAX_TECH_FAILURES = 3;
/** Minutos tras los que una fila atascada en 'dialing' pasa a revisión. */
const STUCK_DIALING_MINUTES = 10;
/** Minutos tras call_ended sin call_analyzed antes de clasificar por estado técnico. */
const ANALYSIS_TIMEOUT_MINUTES = 30;

export interface CallTickDeps {
  now?: Date;
  provider?: CallProvider;
  isHoliday?: HolidayCalendar;
}

export interface CallTickSummary {
  enqueued: number;
  dialed: number;
  shadowLogged: number;
  eventsProcessed: number;
  cancelledBeforeDial: number;
  manualReviews: number;
}

const toS = (d: Date) => Math.floor(d.getTime() / 1000);

function startOfMadridDay(now: Date): number {
  const p = madridParts(now);
  return toS(madridDate(p.year, p.month, p.day, 0, 0));
}

// ------------------------------------------------------------
// 1 · ENCOLAR: qué pedidos entran en la cola de llamadas
// ------------------------------------------------------------

function fallbackMinutes(): number {
  const v = parseFloat(process.env.CALL_FALLBACK_MINUTES ?? "");
  return Number.isFinite(v) && v > 0 ? v : 60;
}

/** Candidatos: (A) WhatsApp enviado hace ≥ trigger sin respuesta;
 *  (B) el envío inicial no ha conseguido salir en `CALL_FALLBACK_MINUTES`
 *      (sin WhatsApp / bot caído / fallo persistente) → entra ya. */
export function findCallCandidates(nowS: number): OrderRow[] {
  const trigger = nowS - Math.round(callTriggerMinutes() * 60);
  const fallback = nowS - Math.round(fallbackMinutes() * 60);
  return systemDbHandle()
    .prepare(
      `SELECT * FROM orders
       WHERE phone != ''
         AND closure_status = 'unknown'
         AND (
           (status IN ('awaiting_reply','reminder_sent') AND customer_replied_at IS NULL
              AND whatsapp_sent_at IS NOT NULL AND whatsapp_sent_at <= ?)
           OR status = 'needs_call'
           OR (status = 'pending_send' AND whatsapp_sent_at IS NULL AND created_at <= ?)
         )
       ORDER BY CAST(total_price AS REAL) DESC, created_at ASC
       LIMIT 50`
    )
    .all(trigger, fallback) as OrderRow[];
}

export function enqueueDueOrders(deps: Required<Pick<CallTickDeps, "now" | "isHoliday">>): number {
  const nowS = toS(deps.now);
  let enqueued = 0;
  for (const order of findCallCandidates(nowS)) {
    const elig = isConfirmationEligible(order);
    if (!elig.eligible) continue;
    if (isDncPhone(order.phone)) continue;
    if (getActiveCallAttemptForOrder(order.id)) continue;
    // Un intento en revisión manual BLOQUEA el re-encolado automático: hasta
    // que un humano resuelva (datos corregidos, estado en Retell verificado,
    // cupo agotado revisado), el sistema no vuelve a llamar solo.
    if (hasManualReviewCallAttempt(order.id)) continue;

    const consumidos = countConsumedContacts(order.id);
    if (consumidos >= callMaxContacts()) continue; // ya agotado (habrá review)

    const scheduled = nextCallSlot(deps.now, deps.isHoliday);
    const id = insertCallAttempt(order.id, consumidos + 1, toS(scheduled));
    if (id !== null) {
      enqueued++;
      logger.info(
        `[CALLS] #${order.shopify_order_number} en cola (contacto ${consumidos + 1}/${callMaxContacts()}) para ${scheduled.toISOString()}`
      );
    }
  }
  return enqueued;
}

// ------------------------------------------------------------
// 2 · MARCAR: intentos vencidos → proveedor (o shadow)
// ------------------------------------------------------------

function toManualReview(attempt: CallAttemptRow, reason: string): void {
  // "completed" incluido: agotar el cupo o un resultado que exige gestión
  // humana convierten el último intento (ya completado) en el marcador de
  // revisión que ve el panel — y que BLOQUEA el re-encolado automático.
  transitionCallAttempt(attempt.id, ["planned", "reserved", "dialing", "in_flight", "completed"], "manual_review", { reason });
  logIntegrationEvent("system", "call_manual_review", "warning", `llamada a revisión: ${reason}`, orderRef(attempt));
}

function orderRef(attempt: CallAttemptRow): string {
  return getOrderById(attempt.order_id)?.shopify_order_number ?? String(attempt.order_id);
}

export async function dialDueAttempts(deps: Required<CallTickDeps>): Promise<{
  dialed: number;
  shadowLogged: number;
  cancelled: number;
  reviews: number;
}> {
  const out = { dialed: 0, shadowLogged: 0, cancelled: 0, reviews: 0 };
  const now = deps.now;
  const nowS = toS(now);

  // Fuera de franja no se marca nada (los planned esperan su scheduled_at,
  // que siempre cae en franja, pero el reloj pudo entrar en festivo nuevo).
  if (!insideCallWindow(now, deps.isHoliday)) return out;

  const shadow = callsShadowMode();
  const enabled = aiCallsEnabled();
  // Kill switch y no-shadow: nada que hacer (los planned se quedan quietos).
  if (!enabled && !shadow) return out;

  const capDiario = callsDailyCap();

  for (const attempt of listDueCallAttempts(nowS, 500)) {
    const order = getOrderById(attempt.order_id);
    if (!order) {
      toManualReview(attempt, "pedido inexistente");
      out.reviews++;
      continue;
    }

    // Re-evaluación JUSTO antes de marcar: el cliente pudo confirmar por
    // WhatsApp, o Shopify cancelar/despachar, después de planificar.
    const elig = isConfirmationEligible(order);
    if (!elig.eligible) {
      transitionCallAttempt(attempt.id, ["planned"], "cancelled", { reason: `inelegible: ${elig.reason}` });
      out.cancelled++;
      continue;
    }
    if (isDncPhone(order.phone)) {
      transitionCallAttempt(attempt.id, ["planned"], "cancelled", { reason: "dnc" });
      out.cancelled++;
      continue;
    }
    if (!callAllowedByAllowlist(order.phone)) {
      // Fuera de allowlist: se queda en cola (no se cancela — al ampliar la
      // allowlist volverá a evaluarse), pero sin ruido en cada tick.
      continue;
    }

    // Validación de datos obligatorios ANTES de nada.
    const payload = buildCallPayload(order, now);
    if (!payload.ok) {
      toManualReview(attempt, `missing_data: ${payload.missing.join(", ")}`);
      logIntegrationEvent(
        "system",
        "call_missing_data",
        "warning",
        `no se puede llamar: faltan ${payload.missing.join(", ")}`,
        order.shopify_order_number
      );
      out.reviews++;
      continue;
    }

    // SHADOW: calcular todo, registrar UNA vez, no contactar.
    if (shadow) {
      if (!attempt.shadow_logged_at) {
        transitionCallAttempt(attempt.id, ["planned"], "planned", { shadow_logged_at: nowS });
        logIntegrationEvent(
          "system",
          "call_shadow_candidate",
          "info",
          `SHADOW: llamaría a ${maskPhone(order.phone)} (contacto ${attempt.contact_number}, variables listas)`,
          order.shopify_order_number
        );
        out.shadowLogged++;
      }
      continue;
    }
    if (!enabled) continue; // kill switch (con shadow off ya salimos antes)

    // Tope diario de llamadas REALES.
    if (countCallsStartedSince(startOfMadridDay(now)) >= capDiario) {
      logIntegrationEvent("system", "call_daily_cap_reached", "warning", `tope diario de llamadas (${capDiario}) alcanzado: no se marcan más hoy`);
      break;
    }

    // Claim atómico: solo un worker gana este intento.
    if (!claimCallAttempt(attempt.id)) continue;

    // DNC otra vez tras el claim (carrera: pudo entrar mientras tanto).
    if (isDncPhone(order.phone)) {
      transitionCallAttempt(attempt.id, ["reserved"], "cancelled", { reason: "dnc (carrera)" });
      out.cancelled++;
      continue;
    }

    // Persistir 'dialing' ANTES de tocar al proveedor: si morimos después
    // de que Retell acepte y antes de guardar el call_id, la fila queda en
    // 'dialing' y JAMÁS se re-marca sola (→ manual_review, ver más abajo).
    if (!transitionCallAttempt(attempt.id, ["reserved"], "dialing")) continue;

    try {
      const accepted = await deps.provider.createOutboundCall({
        toNumber: payload.toNumber!,
        fromNumber: deps.provider.name === "retell" ? (process.env.RETELL_FROM_NUMBER ?? "").trim() : "",
        dynamicVariables: payload.variables!,
        metadata: { attempt_id: String(attempt.id), order_number: order.shopify_order_number },
      });
      transitionCallAttempt(attempt.id, ["dialing"], "in_flight", {
        provider_call_id: accepted.providerCallId,
        started_at: nowS,
      });
      out.dialed++;
      logger.info(
        `[CALLS] #${order.shopify_order_number} llamada aceptada (${accepted.providerCallId}), contacto ${attempt.contact_number}`
      );
    } catch (err) {
      // Petición RECHAZADA antes de aceptarse: no hubo llamada. No consume
      // contacto; reintenta con la cadencia técnica y su propio tope.
      const msg = err instanceof ProviderRequestError ? err.message : String(err);
      logger.warn(`[CALLS] #${order.shopify_order_number} el proveedor rechazó la petición: ${msg.slice(0, 200)}`);
      transitionCallAttempt(attempt.id, ["dialing"], "completed", {
        result: "fallo_tecnico",
        retry_consumed: 0,
        reason: `provider_request_failed: ${msg.slice(0, 200)}`,
        ended_at: nowS,
      });
      planNextAfterResult(order, attempt, "fallo_tecnico", now, deps.isHoliday, null);
    }
  }
  return out;
}

// ------------------------------------------------------------
// 3 · Filas atascadas y llamadas sin análisis
// ------------------------------------------------------------

/** 'dialing' viejo = murió el proceso entre aceptar y guardar el id.
 *  NUNCA se re-marca solo: revisión humana (evita la doble llamada). */
export function reviewStuckDialing(now: Date): number {
  let n = 0;
  for (const a of listCallAttemptsByState("dialing")) {
    if (toS(now) - a.updated_at > STUCK_DIALING_MINUTES * 60) {
      toManualReview(a, "provider_unknown_state: el proceso murió marcando; comprobar en Retell si la llamada salió");
      n++;
    }
  }
  // 'reserved' atascado (crash entre claim y dialing): volver a la cola es
  // seguro — aún no se contactó al proveedor.
  for (const a of listCallAttemptsByState("reserved")) {
    if (toS(now) - a.updated_at > STUCK_DIALING_MINUTES * 60) {
      transitionCallAttempt(a.id, ["reserved"], "planned");
    }
  }
  return n;
}

/** call_ended llegó pero call_analyzed no: clasificar por estado técnico. */
export function classifyStaleInFlight(now: Date, isHoliday: HolidayCalendar): number {
  let n = 0;
  for (const a of listCallAttemptsByState("in_flight")) {
    if (!a.ended_at) continue;
    if (toS(now) - a.ended_at <= ANALYSIS_TIMEOUT_MINUTES * 60) continue;
    const order = getOrderById(a.order_id);
    if (!order) {
      toManualReview(a, "pedido inexistente");
      continue;
    }
    const reason = (a.provider_status ?? "").toLowerCase();
    const noAnswer = /no.?answer|busy|voicemail|dial_failed|not.?connected/.test(reason);
    const result: CallResult = noAnswer ? "no_contesta" : "fallo_tecnico";
    if (
      transitionCallAttempt(a.id, ["in_flight"], "completed", {
        result,
        retry_consumed: RESULT_OUTCOMES[result].consume ? 1 : 0,
        reason: "sin call_analyzed: clasificado por estado técnico",
      })
    ) {
      planNextAfterResult(order, a, result, now, isHoliday, null);
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------
// 4 · Resultados (inbox de eventos del proveedor)
// ------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Reintentos tras un resultado: crea el siguiente intento si toca. */
export function planNextAfterResult(
  order: OrderRow,
  attempt: CallAttemptRow,
  result: CallResult,
  now: Date,
  isHoliday: HolidayCalendar,
  momentoRellamada: number | null
): void {
  const outcome = RESULT_OUTCOMES[result];
  if (!outcome.retry) return;

  // Tope de fallos técnicos seguidos: sin castigar el cupo del cliente,
  // pero sin bucle infinito de reintentos que cuestan dinero.
  if (result === "fallo_tecnico" && countRecentTechFailures(order.id) >= MAX_TECH_FAILURES) {
    toManualReview(attempt, "provider_error_exhausted: 3 fallos técnicos seguidos");
    return;
  }

  const consumidos = countConsumedContacts(order.id);
  if (consumidos >= callMaxContacts()) {
    toManualReview(attempt, "attempts_exhausted: 5 contactos sin resolución");
    logIntegrationEvent("system", "call_attempts_exhausted", "warning", "5 contactos de llamada sin resolución: revisión manual", order.shopify_order_number);
    return;
  }

  let slot: Date;
  if (outcome.reschedule && momentoRellamada !== null) {
    // rellamar: valida el timestamp (futuro razonable, < 30 días).
    const nowS = toS(now);
    const valido = momentoRellamada > nowS - 300 && momentoRellamada < nowS + 30 * 86400;
    const baseline = valido ? new Date(momentoRellamada * 1000) : now;
    slot = nextCallSlot(baseline, isHoliday);
  } else {
    // Cadencia legal acordada (24-08-2026), anclada a DÍAS DE CALENDARIO, no
    // a un delta fijo de minutos — así el 3º/4º contacto caen siempre en el
    // día siguiente (mañana y tarde) y el 5º en la mañana del día después,
    // sea cual sea la hora exacta a la que terminó el contacto anterior.
    //   consumidos=1 → 2º contacto: pronto, normalmente el mismo día.
    //   consumidos=2 → 3º contacto: mañana del día siguiente.
    //   consumidos=3 → 4º contacto: tarde de ESE MISMO día (el siguiente).
    //   consumidos=4 → 5º contacto (último): mañana del día después de ese.
    if (consumidos === 1) {
      slot = nextCallSlot(new Date(now.getTime() + callFirstRetryMinutes() * 60_000), isHoliday);
    } else if (consumidos === 3) {
      const hoy = madridParts(now);
      const tarde = windowStart({ year: hoy.year, month: hoy.month, day: hoy.day }, "afternoon");
      // Red de seguridad: en operación normal `now` cae en la mañana de ese
      // mismo día (lo programó el paso anterior). Si por lo que sea no es
      // así, no se inventa una tarde ya pasada: se busca la franja legal real.
      slot = tarde.getTime() > now.getTime() ? tarde : nextCallSlot(now, isHoliday);
    } else {
      // consumidos === 2 (mañana del día siguiente) o 4 (mañana del día
      // después de la tarde anterior): mismo cálculo en ambos casos.
      slot = windowStart(nextCallableDayAfter(now, isHoliday), "morning");
    }
  }
  const nextContact = outcome.consume ? consumidos + 1 : attempt.contact_number;
  insertCallAttempt(order.id, nextContact, toS(slot));
}

/** Aplica el desenlace de negocio de un call_analyzed. Idempotente por el
 *  estado del intento: solo transiciona desde in_flight/dialing. */
export function applyCallAnalysis(
  attempt: CallAttemptRow,
  event: ParsedCallEvent,
  now: Date,
  isHoliday: HolidayCalendar
): void {
  const order = getOrderById(attempt.order_id);
  if (!order) {
    toManualReview(attempt, "pedido inexistente");
    return;
  }
  const analysis = event.analysis ?? {};
  const result = parseCallResult(analysis["resultado"] ?? analysis["result"]);
  if (!result) {
    transitionCallAttempt(attempt.id, ["in_flight", "dialing"], "manual_review", {
      reason: `unknown_retell_result: "${str(analysis["resultado"] ?? analysis["result"]).slice(0, 60)}"`,
      ended_at: event.eventAt ?? toS(now),
    });
    logIntegrationEvent("system", "call_unknown_result", "warning", "resultado de llamada no reconocido: revisión manual", order.shopify_order_number);
    return;
  }

  const outcome = RESULT_OUTCOMES[result];
  const moved = transitionCallAttempt(attempt.id, ["in_flight", "dialing"], "completed", {
    result,
    retry_consumed: outcome.consume ? 1 : 0,
    ended_at: attempt.ended_at ?? event.eventAt ?? toS(now),
    provider_status: event.providerStatus ?? attempt.provider_status ?? "",
  });
  if (!moved) return; // evento repetido/fuera de orden: ya estaba completado

  // Correcciones de datos (solo no-vacías y distintas; con auditoría).
  if (outcome.corrections) {
    const canon = (v: unknown) => str(v).trim();
    const dir = canon(analysis["direccion_corregida"]);
    const loc = canon(analysis["localidad_corregida"]);
    const cp = canon(analysis["codigo_postal_corregido"]);
    const tel = canon(analysis["telefono_alternativo"]).replace(/[^\d]/g, "");
    if (dir) applyOrderCorrection(order.id, "address_line1", dir, attempt.provider_call_id);
    if (loc) applyOrderCorrection(order.id, "city", loc, attempt.provider_call_id);
    if (cp) applyOrderCorrection(order.id, "postal_code", cp, attempt.provider_call_id);
    if (tel) applyOrderCorrection(order.id, "phone", tel, attempt.provider_call_id);
  }

  if (outcome.confirm) {
    // Confirmación de PEDIDO — jamás delivered: el cierre sigue su curso.
    markOrderConfirmed(order.id, false);
    logIntegrationEvent("system", "call_confirmed", "info", `pedido confirmado por llamada (${result})`, order.shopify_order_number);
  }

  if (outcome.closeCancelled) {
    const at = event.eventAt ?? toS(now);
    const applied = setOrderClosure(order.id, "cancelled", "llamada_ia", at);
    if (applied) {
      markOrderCancelledByCall(order.id);
    } else {
      // Un cierre autoritativo (Shopify/Dropea) ya dijo otra cosa: NO se pisa.
      logIntegrationEvent(
        "system",
        "call_closure_conflict",
        "warning",
        `la llamada dice "${result}" pero el pedido ya tiene un cierre terminal de otra fuente: revisar`,
        order.shopify_order_number
      );
      toManualReview({ ...attempt, state: "completed" } as CallAttemptRow, "closure_conflict");
    }
  }

  if (outcome.dnc) {
    addDncPhone(order.phone, "llamada_ia", {
      reason: "pidio_no_llamar",
      orderId: order.id,
      providerCallId: attempt.provider_call_id ?? undefined,
    });
    logIntegrationEvent("system", "call_dnc_added", "info", `teléfono ${maskPhone(order.phone)} añadido a la lista de no llamar`, order.shopify_order_number);
  }

  if (outcome.review) {
    toManualReview({ ...attempt, state: "completed" } as CallAttemptRow, `resultado ${result}: requiere gestión humana`);
  }

  // ¿Siguiente intento?
  const rellamada = analysis["momento_rellamada"];
  const rellamadaS =
    typeof rellamada === "number"
      ? Math.floor(rellamada)
      : typeof rellamada === "string" && Number.isFinite(Date.parse(rellamada))
        ? Math.floor(Date.parse(rellamada) / 1000)
        : null;
  planNextAfterResult(order, attempt, result, now, isHoliday, rellamadaS);
}

export function processCallEvents(now: Date, isHoliday: HolidayCalendar): number {
  let processed = 0;
  for (const ev of listUnprocessedCallEvents()) {
    try {
      const attempt = getCallAttemptByProviderId(ev.provider_call_id);
      if (!attempt) {
        markCallEventProcessed(ev.id, "unknown_call: sin intento con ese provider_call_id");
        logIntegrationEvent("system", "call_unknown_call_id", "warning", `evento de llamada para un call_id desconocido (${ev.event_type})`);
        continue;
      }
      if (ev.event_type === "call_started") {
        transitionCallAttempt(attempt.id, ["in_flight", "dialing"], "in_flight", {
          started_at: attempt.started_at ?? ev.event_at ?? toS(now),
        });
      } else if (ev.event_type === "call_ended") {
        // Solo datos técnicos: NUNCA clasifica el resultado de negocio.
        const parsed = ev.payload_json ? (JSON.parse(ev.payload_json) as ParsedCallEvent) : null;
        transitionCallAttempt(attempt.id, ["in_flight", "dialing"], "in_flight", {
          ended_at: attempt.ended_at ?? ev.event_at ?? toS(now),
          provider_status: parsed?.disconnectionReason ?? parsed?.providerStatus ?? attempt.provider_status ?? "",
        });
      } else if (ev.event_type === "call_analyzed") {
        const parsed = ev.payload_json ? (JSON.parse(ev.payload_json) as ParsedCallEvent) : null;
        if (parsed) applyCallAnalysis(attempt, parsed, now, isHoliday);
      }
      markCallEventProcessed(ev.id);
      processed++;
    } catch (err) {
      markCallEventProcessed(ev.id, err instanceof Error ? err.message.slice(0, 300) : "error");
    }
  }
  return processed;
}

// ------------------------------------------------------------
// 5 · Tick completo + arranque
// ------------------------------------------------------------

export async function runCallOrchestratorTick(deps: CallTickDeps = {}): Promise<CallTickSummary> {
  const now = deps.now ?? new Date();
  const provider = deps.provider ?? retellProvider;
  const isHoliday = deps.isHoliday ?? defaultHolidayCalendar;

  const eventsProcessed = processCallEvents(now, isHoliday);
  const reviews = reviewStuckDialing(now);
  classifyStaleInFlight(now, isHoliday);
  const enqueued = enqueueDueOrders({ now, isHoliday });
  const dial = await dialDueAttempts({ now, provider, isHoliday });

  return {
    enqueued,
    dialed: dial.dialed,
    shadowLogged: dial.shadowLogged,
    eventsProcessed,
    cancelledBeforeDial: dial.cancelled,
    manualReviews: reviews + dial.reviews,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startCallOrchestrator(): void {
  if (timer) return;
  const cada = Math.max(15, parseInt(process.env.CALL_POLL_SECONDS ?? "60", 10) || 60);
  logger.info(
    `[CALLS] orquestador activo (cada ${cada}s) — kill switch ${aiCallsEnabled() ? "ABIERTO" : "cerrado"}, shadow ${callsShadowMode() ? "ON" : "off"}`
  );
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    // LEASE: sin él, no se ejecuta. La guarda `ticking` de arriba solo
    // protege dentro de ESTE proceso; el lease protege contra un SEGUNDO
    // proceso (dos contenedores, reinicio solapado, un `start:bot` a mano).
    // Lo que duplicarían no son lecturas: son efectos externos.
    if (!acquireLease(LEASE_CALLS, Math.max(120, cada * 3))) {
      ticking = false;
      return;
    }
    void runInstrumented("scheduler:calls", "system", async () => {
      const r = await runCallOrchestratorTick();
      return { processed: r.dialed + r.eventsProcessed + r.enqueued, errors: 0 };
    })
      .catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err) }, "[CALLS] tick falló"))
      .finally(() => {
        ticking = false;
      });
  }, cada * 1000);
}
