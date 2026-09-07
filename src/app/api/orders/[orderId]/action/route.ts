import { NextResponse, type NextRequest } from "next/server";
import {
  getOrderById,
  markOrderNeedsCall,
  markOrderCancelled,
  resetOrderForResend,
  authorizeOrderForPilot,
  revokeOrderPilotAuthorization,
} from "@/lib/db";
import { confirmOrder } from "@/lib/orders/confirmation";
import { sendDelayNotificationForOrder } from "@/lib/orders/notify-delay";
import { canOperateOnOrderManually, orderActionAllowed } from "@/lib/safety";
import { manualDialOrder } from "@/lib/calls/manual";
import { requireStaff } from "@/lib/auth/guard";
import { audit, safeOrder } from "@/lib/workspace";
import { systemDbHandle } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

const ACTIONS = new Set([
  "confirm",
  "call_now",
  "needs_call",
  "resend",
  "notify_delay",
  "cancel",
  "authorize_pilot",
  "revoke_pilot",
]);

/**
 * Acciones manuales de Pedro sobre un pedido:
 *  - confirm    → marcar confirmado (p.ej. tras llamar él mismo) + tag en Shopify
 *  - needs_call → mover a la lista de llamadas (interno)
 *  - resend     → reenviar el WhatsApp de confirmación desde cero
 *  - cancel     → descartar el pedido de este flujo (interno, no toca Shopify)
 *
 * SEGURIDAD: las acciones con efecto EXTERNO (confirm → tag, resend → envío)
 * respetan TEST_MODE: en pruebas solo sobre teléfonos de la allowlist. Las
 * internas (needs_call, cancel) se permiten siempre. Toda transición inválida
 * se rechaza sin side effects.
 */
export async function POST(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = requireStaff(req);
  if (!auth.ok) return auth.response;
  const { orderId } = await params;
  const id = parseInt(orderId, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
  }

  let body: { action?: string; replenishmentDate?: string };
  try {
    body = (await req.json()) as { action?: string; replenishmentDate?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const action = body.action ?? "";
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: "acción no permitida" }, { status: 400 });
  }
  if (auth.user.role === "agent" && action !== "resend") {
    return NextResponse.json({ ok: false, error: "No tienes permiso para esta acción" }, { status: 403 });
  }

  // Un agente NO recibe la ficha completa: se le devuelve la MISMA proyección
  // que usa el espacio de trabajo (sin email, raw_payload, marketing_* ni
  // supplier_*). El propietario sigue recibiendo la fila entera, que es lo
  // que consume su panel. Sin esto, abrir esta ruta a staff filtraría PII por
  // la RESPUESTA aunque la acción en sí estuviese permitida.
  const vistaDelPedido = (pedidoId: number) => {
    const fila = getOrderById(pedidoId);
    return auth.user.role === "agent" ? safeOrder(fila) : fila;
  };

  const order = getOrderById(id);
  if (!order) {
    return NextResponse.json({ ok: false, error: "pedido no encontrado" }, { status: 404 });
  }

  // Autorización manual de piloto: es la ÚNICA acción que puede tocar un
  // pedido fuera de la allowlist, y por eso no pasa por el gate de abajo.
  // Autoriza SOLO este pedido, nunca su teléfono ni otros pedidos suyos.
  if (action === "authorize_pilot") {
    if (!authorizeOrderForPilot(id)) {
      return NextResponse.json(
        { ok: false, error: `no se puede autorizar un pedido en estado ${order.status}` },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true, order: vistaDelPedido(id) });
  }
  if (action === "revoke_pilot") {
    revokeOrderPilotAuthorization(id);
    return NextResponse.json({ ok: true, order: vistaDelPedido(id) });
  }

  // Gate de TEST_MODE para acciones con efecto externo: pasa si el teléfono
  // está en la allowlist O si este pedido concreto está autorizado.
  if (action === "confirm" || action === "resend" || action === "notify_delay") {
    if (!orderActionAllowed(order)) {
      const gate = canOperateOnOrderManually(order.phone);
      return NextResponse.json(
        {
          ok: false,
          error:
            (gate.reason ?? "acción no permitida") +
            ' Puedes habilitarlo con "Autorizar piloto" en este pedido.',
        },
        { status: 403 }
      );
    }
  }

  if (action === "confirm") {
    if (order.status === "confirmed") {
      return NextResponse.json({ ok: true, order: vistaDelPedido(id) });
    }
    if (order.status === "cancelled" || order.status === "ignored_old") {
      return NextResponse.json(
        { ok: false, error: `no se puede confirmar un pedido en estado ${order.status}` },
        { status: 409 }
      );
    }
    const confirmation = confirmOrder(order, "manual");
    if (!confirmation.confirmed) {
      return NextResponse.json(
        {
          ok: false,
          error:
            confirmation.blocker === "suspicious_address"
              ? "Confirmación bloqueada: la dirección parece incompleta o no direccional. El caso se ha enviado a Atención."
              : `no se puede confirmar un pedido en estado ${order.status}`,
          order: vistaDelPedido(id),
        },
        { status: 409 }
      );
    }
  } else if (action === "call_now") {
    const result = await manualDialOrder(id);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error ?? "no se pudo iniciar la llamada" },
        { status: 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      order: vistaDelPedido(id),
      providerCallId: result.providerCallId,
    });
  } else if (action === "notify_delay") {
    // Construcción y envío EXACTAMENTE en src/lib/orders/notify-delay.ts —
    // el botón del panel y el script de campaña (npm run notify:delay-ultras)
    // llaman a la misma función, nada se duplica aquí.
    const replenishmentDate = (body.replenishmentDate ?? "").trim();
    const result = sendDelayNotificationForOrder(order, replenishmentDate);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status ?? 409 });
    }
    return NextResponse.json({ ok: true, order: vistaDelPedido(id) });
  } else if (action === "needs_call") {
    if (!markOrderNeedsCall(id)) {
      return NextResponse.json(
        { ok: false, error: `transición inválida: ${order.status} → needs_call` },
        { status: 409 }
      );
    }
  } else if (action === "resend") {
    if (!order.phone) {
      return NextResponse.json(
        { ok: false, error: "el pedido no tiene teléfono" },
        { status: 409 }
      );
    }
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
    const claimed = systemDbHandle().prepare("INSERT OR IGNORE INTO confirmation_resends(order_id,day) VALUES(?,?)").run(id, day);
    if (claimed.changes === 0) {
      return NextResponse.json({ ok: false, error: "Ya se reenvió la confirmación de este pedido hoy" }, { status: 429 });
    }
    if (!resetOrderForResend(id)) {
      systemDbHandle().prepare("DELETE FROM confirmation_resends WHERE order_id=? AND day=?").run(id, day);
      return NextResponse.json(
        { ok: false, error: `no se puede reenviar un pedido en estado ${order.status}` },
        { status: 409 }
      );
    }
    audit(auth.user, "resend_confirmation", "order", id, { day });
  } else if (action === "cancel") {
    if (!markOrderCancelled(id)) {
      return NextResponse.json(
        { ok: false, error: "un pedido confirmado no se descarta desde aquí" },
        { status: 409 }
      );
    }
  }

  return NextResponse.json({ ok: true, order: vistaDelPedido(id) });
}
