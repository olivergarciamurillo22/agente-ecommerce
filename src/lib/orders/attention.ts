import {
  getOrCreateConversation,
  setMode,
  systemDbHandle,
  type OrderRow,
} from "../db";
import { logIntegrationEvent } from "../system/repo";
import type { EventSeverity } from "../system/types";

/**
 * Usa el workspace existente (modo HUMAN + work_items), sin esquema nuevo.
 * Es idempotente para que reintentos/webhooks duplicados no llenen la cola.
 */
export function escalateOrderToHuman(input: {
  order: OrderRow;
  reason: string;
  eventType: string;
  severity: EventSeverity;
  eventMessage: string;
}): number {
  const convo = getOrCreateConversation(input.order.phone, input.order.customer_name ?? undefined);
  setMode(convo.id, "HUMAN");
  systemDbHandle()
    .prepare(
      `INSERT INTO work_items(conversation_id, order_id, reason, owner_only)
       SELECT ?, ?, ?, 0
       WHERE NOT EXISTS (
         SELECT 1 FROM work_items
          WHERE conversation_id = ? AND order_id = ? AND reason = ? AND resolved_at IS NULL
       )`
    )
    .run(convo.id, input.order.id, input.reason, convo.id, input.order.id, input.reason);
  logIntegrationEvent(
    "whatsapp",
    input.eventType,
    input.severity,
    input.eventMessage,
    input.order.shopify_order_number
  );
  return convo.id;
}
