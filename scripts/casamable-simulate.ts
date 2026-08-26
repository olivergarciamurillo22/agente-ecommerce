// ============================================================
// SIMULADOR OPERATIVO COMPLETO — npm run casamable:simulate
//
// Ejecuta los 10 flujos que Casamable tiene que saber hacer, de punta a
// punta, contra una BASE DE DATOS DESECHABLE en un directorio temporal.
//
//   · NO toca la DB real (ni la del NAS ni la local).
//   · NO hace ni una llamada de red (Shopify, Meta, Retell, proveedores).
//   · NO manda WhatsApp: todo muere en el outbox de la DB desechable.
//
// Salida: una línea por flujo y el veredicto "X/10 FLOWS PASS".
// Si algo falla, el código de salida es 1 (sirve para CI y para Pedro).
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// --- Aislamiento TOTAL antes de importar nada de src/ ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "casamable-simulate-"));
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = "silent";
process.env.SHOPIFY_WEBHOOK_SECRET = "simulate_secret";
process.env.DEFAULT_COUNTRY_CODE = "34";
process.env.APP_MODE = "production"; // los gates de envío exigen production…
process.env.WHATSAPP_SEND_ENABLED = "1"; // …pero todo queda en el outbox local
process.env.EMERGENCY_STOP = "0";
process.env.TEST_MODE = "0"; // DB desechable: aquí no hay teléfonos reales
process.env.WHATSAPP_WINDOW_ENABLED = "0";
process.env.MAX_ORDER_AGE_MINUTES = "9999999";
process.env.FIRST_REMINDER_MINUTES = "1";
process.env.NEEDS_CALL_MINUTES = "3";
delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // cero tentaciones de red
delete process.env.SHOPIFY_STORE_DOMAIN;
delete process.env.OPENROUTER_API_KEY;
delete process.env.META_WHATSAPP_ACCESS_TOKEN;
delete process.env.RETELL_API_KEY;
delete process.env.DROPEA_API_ENABLED;
delete process.env.WHATSAPP_PROVIDER;

function firma(raw: string): string {
  return crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET!).update(raw, "utf8").digest("base64");
}

let webhookSeq = 0;
const headers = (raw: string) => ({
  hmac: firma(raw),
  topic: "orders/create",
  webhookId: `sim-${++webhookSeq}`,
  shopDomain: "casamable-simulate.myshopify.com",
});

function payload(id: number, num: number, phone: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    order_number: num,
    name: `#${num}`,
    email: null,
    phone: null,
    currency: "EUR",
    total_price: "36.90",
    financial_status: "pending",
    gateway: "Cash on Delivery (COD)",
    payment_gateway_names: ["Cash on Delivery (COD)"],
    tags: "",
    customer: { first_name: "Simulación", last_name: "Casamable", email: null, phone: null },
    shipping_address: {
      name: "Simulación Casamable", address1: "Calle de Prueba 1", address2: null,
      city: "Madrid", province: "Madrid", zip: "28001", country: "Spain", country_code: "ES",
      phone,
    },
    billing_address: null,
    line_items: [{
      title: "Cortaúñas Eléctrico 3 en 1", quantity: 1, price: "36.90", sku: "10428",
      product_id: 8100000000010, variant_id: 4100000000010, requires_shipping: true,
      gift_card: false, fulfillment_service: "manual", fulfillment_status: null, fulfillable_quantity: 1,
    }],
    note_attributes: [],
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

interface Flujo { nombre: string; run: () => Promise<void> | void; }

async function main(): Promise<void> {
  const db = await import("../src/lib/db");
  const { processOrdersCreateWebhook } = await import("../src/lib/shopify/webhook");
  const { processOrdersEventWebhook } = await import("../src/lib/shopify/orders-events-webhook");
  const { handleOrderReply } = await import("../src/lib/orders/confirmation");
  const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
  const actionCenter = await import("../src/lib/system/action-center");
  const alerts = await import("../src/lib/system/business-alerts");

  // El scheduler solo envía si "WhatsApp está conectado". En la DB desechable
  // se simula la sesión: nada sale de verdad, todo muere en el outbox local.
  db.setConnectionState({ status: "connected", phone: "34600000000" });

  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  const entra = (id: number, num: number, tel: string, overrides: Record<string, unknown> = {}) => {
    const raw = payload(id, num, tel, overrides);
    const res = processOrdersCreateWebhook(raw, headers(raw));
    assert(res.status === 200, `webhook devolvió ${res.status}`);
    return db.getOrderByShopifyId(String(id))!;
  };
  const nowS = () => Math.floor(Date.now() / 1000);

  const flujos: Flujo[] = [
    {
      nombre: "Pedido feliz: webhook → WhatsApp en outbox → '1' → confirmado → routing escrito",
      run: async () => {
        const o = entra(101, 5101, "+34 600 000 101");
        await runSchedulerTick(nowS());
        assert(db.getOrderById(o.id)!.status === "awaiting_reply", "no pasó a awaiting_reply");
        assert(db.getPendingOutbox(99).some((m) => m.phone === "34600000101"), "no hay WhatsApp en el outbox");
        const r = handleOrderReply("34600000101", "1");
        assert(r.handled && db.getOrderById(o.id)!.status === "confirmed", "'1' no confirmó");
        await runSchedulerTick(nowS() + 5);
        assert(db.getOrderById(o.id)!.supplier_sync_status !== "not_ready", "el routing no se evaluó");
      },
    },
    {
      nombre: "Cambio de dirección: '2' + dirección nueva → needs_correction con propuesta guardada",
      run: async () => {
        const o = entra(102, 5102, "+34 600 000 102");
        await runSchedulerTick(nowS());
        handleOrderReply("34600000102", "2");
        handleOrderReply("34600000102", "Avenida Nueva 22, 2ºA, 28002 Madrid");
        const fila = db.getOrderById(o.id)!;
        assert(fila.status === "needs_correction", `estado ${fila.status}`);
        assert((fila.proposed_address ?? "").includes("Avenida Nueva 22"), "la dirección propuesta no quedó guardada");
      },
    },
    {
      nombre: "Nota al repartidor: '3' + nota → guardada; el '1' posterior confirma",
      run: async () => {
        const o = entra(103, 5103, "+34 600 000 103");
        await runSchedulerTick(nowS());
        handleOrderReply("34600000103", "3");
        handleOrderReply("34600000103", "Dejar en el portal con el conserje");
        let fila = db.getOrderById(o.id)!;
        assert((fila.delivery_note ?? "").includes("conserje"), "la nota no quedó guardada");
        // Por contrato, la nota NO confirma: hace falta el "1" del cliente.
        assert(fila.status === "awaiting_reply", `estado ${fila.status}`);
        handleOrderReply("34600000103", "1");
        fila = db.getOrderById(o.id)!;
        assert(fila.status === "confirmed", `tras el '1': ${fila.status}`);
      },
    },
    {
      nombre: "Sin respuesta: recordatorio y después a la cola de llamadas (needs_call)",
      run: async () => {
        const o = entra(104, 5104, "+34 600 000 104");
        const t0 = nowS();
        await runSchedulerTick(t0);
        await runSchedulerTick(t0 + 2 * 60); // recordatorio (1 min configurado)
        assert(db.getOrderById(o.id)!.status === "reminder_sent", "no hubo recordatorio");
        await runSchedulerTick(t0 + 10 * 60); // needs_call (3 min configurados)
        assert(db.getOrderById(o.id)!.status === "needs_call", "no escaló a needs_call");
      },
    },
    {
      nombre: "Multi-pedido: '5106' selecciona y 'todo correcto' confirma ESE, el otro no se toca",
      run: async () => {
        entra(105, 5105, "+34 600 000 105");
        entra(106, 5106, "+34 600 000 105", { total_price: "49.90", line_items: [{
          title: "Plancha de Vapor Vertical", quantity: 1, price: "49.90", sku: "10500",
          product_id: 8100000000011, variant_id: 4100000000011, requires_shipping: true,
          gift_card: false, fulfillment_service: "manual", fulfillment_status: null, fulfillable_quantity: 1,
        }] });
        await runSchedulerTick(nowS());
        const r1 = handleOrderReply("34600000105", "5106");
        assert(r1.handled && !!r1.reply && r1.reply.includes("5106"), "'5106' no seleccionó el pedido");
        handleOrderReply("34600000105", "todo correcto");
        assert(db.getOrderByShopifyId("106")!.status === "confirmed", "no confirmó el seleccionado");
        assert(db.getOrderByShopifyId("105")!.status === "awaiting_reply", "tocó el pedido equivocado");
      },
    },
    {
      nombre: "Duplicado a la entrada: dos pedidos idénticos → marcados y en la bandeja de Acciones",
      run: () => {
        entra(107, 5107, "+34 600 000 107");
        entra(108, 5108, "+34 600 000 107");
        assert(db.getOrderByShopifyId("107")!.possible_duplicate === 1, "el original no se marcó");
        assert(db.getOrderByShopifyId("108")!.possible_duplicate === 1, "el nuevo no se marcó");
        const ac = actionCenter.getActionCenter();
        assert(ac.items.some((i) => i.type === "POSSIBLE_DUPLICATE" && i.orderNumber === "5108"), "no está en Acciones");
      },
    },
    {
      nombre: "Cancelación: frase ambigua pide confirmación; confirmada queda REGISTRADA (nada se cancela solo)",
      run: async () => {
        const o = entra(109, 5109, "+34 600 000 109");
        await runSchedulerTick(nowS());
        const r1 = handleOrderReply("34600000109", "quiero cancelarlo");
        assert(r1.handled && !!r1.reply, "no pidió confirmación");
        handleOrderReply("34600000109", `cancelar ${db.getOrderById(o.id)!.shopify_order_number}`);
        const fila = db.getOrderById(o.id)!;
        assert(!!fila.cancellation_requested_at, "la petición no quedó estampada");
        assert(fila.status !== "cancelled", "¡canceló solo! eso es decisión de Pedro");
        const ac = actionCenter.getActionCenter();
        assert(ac.items[0]?.type === "CANCEL_REQUEST", "la cancelación no es lo primero de la bandeja");
      },
    },
    {
      nombre: "Webhooks fuera de orden: un fulfilled viejo NO pisa un cancelled ya fijado",
      run: () => {
        const o = entra(110, 5110, "+34 600 000 110");
        const tCancel = new Date().toISOString();
        const rawCancel = JSON.stringify({ id: 110, cancelled_at: tCancel, updated_at: tCancel });
        const h1 = { ...headers(rawCancel), topic: "orders/cancelled" };
        processOrdersEventWebhook(rawCancel, h1);
        assert(db.getOrderById(o.id)!.closure_status === "cancelled", "el cancelled no se aplicó");
        const tViejo = new Date(Date.now() - 3600_000).toISOString();
        const rawFul = JSON.stringify({ id: 110, updated_at: tViejo });
        const h2 = { ...headers(rawFul), topic: "orders/fulfilled" };
        processOrdersEventWebhook(rawFul, h2);
        assert(db.getOrderById(o.id)!.closure_status === "cancelled", "un fulfilled más viejo pisó el cancelled");
      },
    },
    {
      nombre: "Reinicio: otra conexión al mismo fichero ve TODO y el tick no reenvía nada",
      run: async () => {
        const Database = (await import("better-sqlite3")).default;
        const conn2 = new Database(db.dbFilePath());
        try {
          const n = (conn2.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
          assert(n >= 10, "la segunda conexión no ve los pedidos");
        } finally {
          conn2.close();
        }
        const antes = db.getPendingOutbox(999).length;
        await runSchedulerTick(nowS());
        assert(db.getPendingOutbox(999).length === antes, "un tick tras 'reiniciar' reenvió mensajes");
      },
    },
    {
      nombre: "Cliente caótico: nunca cancela solo, nunca entra en bucle, escala o resuelve; watchdog avisando",
      run: () => {
        entra(111, 5111, "+34 600 000 111");
        for (const msg of ["no sé", "eh", "mmm", "oye", "?"]) handleOrderReply("34600000111", msg);
        const st = db.getOrderByShopifyId("111")!.status;
        assert(["needs_call", "pending_send", "awaiting_reply"].includes(st), `estado raro: ${st}`);
        assert(st !== "cancelled" as string, "canceló solo");
        const res = alerts.getBusinessAlerts();
        const dup = res.alerts.find((a) => a.id === "possible_duplicates_pending");
        assert(dup?.status === "warning", "el watchdog no avisa de los duplicados pendientes del flujo 6");
      },
    },
  ];

  console.log("\n════════ CASAMABLE — SIMULACIÓN OPERATIVA COMPLETA ════════");
  console.log(`DB desechable: ${tmpDir} (se borra al terminar)\n`);

  let ok = 0;
  for (let i = 0; i < flujos.length; i++) {
    const f = flujos[i];
    try {
      await f.run();
      ok++;
      console.log(`  ✓ ${i + 1}/10 ${f.nombre}`);
    } catch (err) {
      console.log(`  ✗ ${i + 1}/10 ${f.nombre}`);
      console.log(`      → ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n════════ ${ok}/10 FLOWS PASS ════════\n`);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* mejor dejar basura temporal que fallar el veredicto */
  }
  process.exit(ok === flujos.length ? 0 : 1);
}

main().catch((err) => {
  console.error("\n✗ El simulador se rompió antes de terminar:", err instanceof Error ? err.message : err);
  process.exit(1);
});
