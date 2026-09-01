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
import { sendDelayNotification } from "@/lib/orders/notify-delay";
import { canOperateOnOrderManually, orderActionAllowed } from "@/lib/safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

const ACTIONS = new Set([
  "confirm",
  "needs_call",
  "resend",
  "cancel",
  "authorize_pilot",
  "revoke_pilot",
  "notify_delay",
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
    return NextResponse.json({ ok: true, order: getOrderById(id) });
  }
  if (action === "revoke_pilot") {
    revokeOrderPilotAuthorization(id);
    return NextResponse.json({ ok: true, order: getOrderById(id) });
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
      return NextResponse.json({ ok: true, order: getOrderById(id) });
    }
    if (order.status === "cancelled" || order.status === "ignored_old") {
      return NextResponse.json(
        { ok: false, error: `no se puede confirmar un pedido en estado ${order.status}` },
        { status: 409 }
      );
    }
    confirmOrder(order, "manual");
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
    if (!resetOrderForResend(id)) {
      return NextResponse.json(
        { ok: false, error: `no se puede reenviar un pedido en estado ${order.status}` },
        { status: 409 }
      );
    }
  } else if (action === "cancel") {
    if (!markOrderCancelled(id)) {
      return NextResponse.json(
        { ok: false, error: "un pedido confirmado no se descarta desde aquí" },
        { status: 409 }
      );
    }
  } else if (action === "notify_delay") {
    if (!order.phone) {
      return NextResponse.json({ ok: false, error: "el pedido no tiene teléfono" }, { status: 409 });
    }
    const replenishmentDate = (body.replenishmentDate ?? "").trim();
    if (!replenishmentDate) {
      return NextResponse.json(
        { ok: false, error: "falta replenishmentDate (la fecha prevista de reposición)" },
        { status: 400 }
      );
    }
    // batchId "manual:<orderId>": distingue este disparo a mano del batch de
    // campaña en notify_delay_sends, sin inventar una tabla aparte.
    const result = sendDelayNotification(order, replenishmentDate, `manual:${id}`, false);
    if (result.outcome === "error") {
      return NextResponse.json({ ok: false, error: result.error ?? "fallo al enviar" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, order: getOrderById(id), notifyDelay: result });
  }

  return NextResponse.json({ ok: true, order: getOrderById(id) });
}
