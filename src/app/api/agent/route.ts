// ============================================================
// AGENTE — el copiloto operativo del panel (§24).
//
// GET → { ok, summary, items }: qué está pasando, qué falta y qué haría el
// agente, pedido a pedido. 100% DETERMINISTA: lee el Action Center y la
// cola de Beeping y deriva una recomendación por tipo. Sin LLM, sin red.
// ============================================================

import { NextResponse } from "next/server";
import { getActionCenter, type ActionType } from "@/lib/system/action-center";
import { getBeepingHealth } from "@/lib/beeping/health";
import { listOrdersAwaitingBeepingRelease } from "@/lib/beeping/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type AgentItemType = ActionType | "BEEPING_RELEASE";

export interface AgentItem {
  orderId: number;
  orderNumber: string;
  customer: string;
  urgency: number;
  whatsHappening: string;
  whatsMissing: string;
  recommendation: string;
  type: AgentItemType;
  sinceAt: number;
}

export interface AgentSummary {
  total: number;
  urgent: number;
  awaitingRelease: number;
}

/** Qué haría el agente, por tipo de problema. Frases fijas y acordadas. */
const RECOMENDACION: Record<ActionType, string> = {
  CANCEL_REQUEST:
    "Habla con el cliente y decide: si mantiene el pedido, márcalo resuelto; si no, cancélalo en Shopify y gestiona la cancelación en Beeping.",
  POSSIBLE_DUPLICATE: "Compara los dos pedidos y cancela el que sobre antes de liberar nada.",
  NEEDS_CALL:
    "Llámalo ahora o usa 'Llamar ahora' en la ficha; si no contesta, reintenta en franja de tarde.",
  ADDRESS_CORRECTION: "Verifica la dirección por WhatsApp antes de liberar a Beeping.",
  SUPPLIER_ERROR: "Revisa el error del proveedor en la ficha y decide si va a mano.",
  TRACKING_INCIDENT: "Mira el estado con el transportista y decide si avisas al cliente.",
};

/** Mismo formato enmascarado que usa el Action Center: nombre de pila + últimos 4. */
function cliente(nombre: string | null, telefono: string): string {
  const pila = (nombre ?? "").trim().split(/\s+/)[0] || "Cliente";
  const tel = telefono ? `***${telefono.slice(-4)}` : "sin teléfono";
  return `${pila} (${tel})`;
}

export async function GET(): Promise<NextResponse> {
  try {
    const ac = getActionCenter();
    const beeping = getBeepingHealth();

    const items: AgentItem[] = ac.items.map((item) => ({
      orderId: item.orderId,
      orderNumber: item.orderNumber,
      customer: item.customer,
      urgency: item.urgency,
      whatsHappening: item.problem,
      whatsMissing: item.whatToDo,
      recommendation: RECOMENDACION[item.type],
      type: item.type,
      sinceAt: item.sinceAt,
    }));

    // Cola de Beeping: confirmados por el cliente y aún sin liberar. No es un
    // "problema" del Action Center, pero sí trabajo pendiente de Pedro.
    const enActionCenter = new Set(items.map((i) => `${i.orderId}`));
    for (const o of listOrdersAwaitingBeepingRelease()) {
      // Si el pedido ya aparece arriba con un problema, no lo duplicamos:
      // primero se resuelve el problema, luego se libera.
      if (enActionCenter.has(`${o.id}`)) continue;
      items.push({
        orderId: o.id,
        orderNumber: o.shopify_order_number,
        customer: cliente(o.customer_name, o.phone),
        urgency: 7, // por detrás de todos los tipos del Action Center
        whatsHappening: "Confirmado por el cliente",
        whatsMissing: "Pendiente de enviar a Beeping",
        recommendation: "Ábrelo en Pedidos y pulsa 'Enviar a Beeping' antes del corte.",
        type: "BEEPING_RELEASE",
        sinceAt: o.confirmed_at ?? o.updated_at,
      });
    }

    const summary: AgentSummary = {
      total: items.length,
      urgent: items.filter((i) => i.type === "CANCEL_REQUEST" || i.type === "POSSIBLE_DUPLICATE").length,
      awaitingRelease: beeping.awaitingRelease,
    };

    return NextResponse.json({ ok: true, summary, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error interno";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
