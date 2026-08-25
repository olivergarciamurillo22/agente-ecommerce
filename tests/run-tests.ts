// ============================================================
// Tests del MVP de confirmación de pedidos COD.
//
// Ejecutar con: npm test
//
// Usa una base de datos SQLite TEMPORAL (DATA_DIR apunta a un directorio
// desechable): jamás toca data/messages.db real. Sin red: ni OpenRouter ni
// la Admin API de Shopify están configuradas aquí.
// ============================================================

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";

// --- Entorno de test ANTES de cargar los módulos (usan process.env) ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pedro-mvp-test-"));
process.env.DATA_DIR = tmpDir;
process.env.LOG_LEVEL = "silent";
process.env.SHOPIFY_WEBHOOK_SECRET = "test_webhook_secret";
process.env.DEFAULT_COUNTRY_CODE = "34";
process.env.FIRST_REMINDER_MINUTES = "1"; // recordatorio al minuto
process.env.NEEDS_CALL_MINUTES = "3"; // llamada a los 3 minutos
delete process.env.OPENROUTER_API_KEY;
delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
delete process.env.SHOPIFY_STORE_DOMAIN;
delete process.env.TREAT_ALL_ORDERS_AS_COD;
delete process.env.COD_PENDING_IS_COD;
delete process.env.COD_GATEWAY_KEYWORDS;

// Safety gates: los tests de FLUJO corren con WhatsApp habilitado (si no, no
// habría nada que probar) y Shopify writes CERRADO. Los tests de SEGURIDAD
// manipulan cada llave individualmente con withEnv().
process.env.APP_MODE = "production";
process.env.WHATSAPP_SEND_ENABLED = "1";
process.env.EMERGENCY_STOP = "0";
process.env.TEST_MODE = "0";
process.env.MAX_ORDER_AGE_MINUTES = "9999999"; // los tests de timing viajan al futuro
// La ventana horaria haría fallar la suite según la hora del reloj (antes de
// las 09:00 no saldría ningún envío). Se desactiva aquí; sus tests la activan
// explícitamente con withEnv() y horas inyectadas.
process.env.WHATSAPP_WINDOW_ENABLED = "0";
delete process.env.SHOPIFY_WRITE_ENABLED;
delete process.env.TEST_PHONE_ALLOWLIST;
delete process.env.OUTBOX_MAX_AGE_MINUTES;

/** Aplica variables de entorno solo durante fn() y SIEMPRE las restaura. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): Promise<void> {
  const backup: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    backup[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(backup)) {
      const v = backup[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let passed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  ✗ ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sign(body: string): string {
  return crypto.createHmac("sha256", "test_webhook_secret").update(body).digest("base64");
}

/** Payload realista de orders/create (subconjunto que usamos). */
function codPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900001,
    order_number: 1101,
    name: "#1101",
    email: "cliente@example.com",
    phone: null,
    currency: "EUR",
    total_price: "49.90",
    financial_status: "pending",
    gateway: "Cash on Delivery (COD)",
    payment_gateway_names: ["Cash on Delivery (COD)"],
    tags: "",
    customer: {
      first_name: "María",
      last_name: "García",
      email: "cliente@example.com",
      phone: null,
    },
    shipping_address: {
      name: "María García",
      address1: "Calle Alcalá 123",
      address2: "3º B",
      city: "Madrid",
      province: "Madrid",
      zip: "28009",
      country: "Spain",
      country_code: "ES",
      phone: "+34 611 111 111",
    },
    billing_address: null,
    line_items: [
      { title: "Crema facial hidratante", quantity: 2, price: "19.95" },
      { title: "Sérum vitamina C", quantity: 1, price: "10.00" },
    ],
    note_attributes: [],
    ...overrides,
  };
}

const shopifyHeaders = (raw: string, extra: Record<string, string | null> = {}) => ({
  hmac: sign(raw),
  topic: "orders/create",
  webhookId: "wh-test",
  shopDomain: "test.myshopify.com",
  ...extra,
});

async function main(): Promise<void> {
  console.log(`\nTests del MVP (DB temporal en ${tmpDir})\n`);

  const db = await import("../src/lib/db");
  const { normalizePhone, isCodOrder, formatOrderItems, formatAddressForMessage } = await import(
    "../src/lib/orders/normalize"
  );
  const { verifyShopifyHmac } = await import("../src/lib/shopify/hmac");
  const { processOrdersCreateWebhook } = await import("../src/lib/shopify/webhook");
  const { processOrdersEventWebhook } = await import("../src/lib/shopify/orders-events-webhook");
  const backfill = await import("../src/lib/shopify/backfill");
  const dropeaReconcile = await import("../src/lib/suppliers/dropea/reconcile");
  const { handleOrderReply, classifyOrderReply, confirmOrder } = await import(
    "../src/lib/orders/confirmation"
  );
  const { tagOrderConfirmed } = await import("../src/lib/shopify/admin");
  const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
  const msgs = await import("../src/lib/orders/messages");
  const { sendWhatsAppMessage } = await import("../src/lib/whatsapp");
  const safety = await import("../src/lib/safety");
  const { handleIncomingMessages } = await import("../src/lib/baileys/handler");

  const mkOrder = (shopifyId: string, num: string, phone: string) =>
    db.insertOrderIfNew({
      shopify_order_id: shopifyId,
      shopify_order_number: num,
      customer_name: "Cliente Test",
      phone,
      email: null,
      product_summary: "Producto de prueba",
      total_price: "29.90",
      currency: "EUR",
      address_line1: "Calle Falsa 1",
      address_line2: null,
      city: "Madrid",
      province: "Madrid",
      postal_code: "28001",
      country: "España",
      status: "pending_send",
    }).order;

  // ============ 1 · Normalización de teléfono ============
  console.log("· Teléfonos");
  await test("9 dígitos nacionales → prefijo 34", () => {
    assert.equal(normalizePhone("612 34 56 78"), "34612345678");
  });
  await test("formato internacional con + y espacios", () => {
    assert.equal(normalizePhone("+34 612-345-678"), "34612345678");
  });
  await test("prefijo internacional 00", () => {
    assert.equal(normalizePhone("0034612345678"), "34612345678");
  });
  await test("vacío/null → cadena vacía", () => {
    assert.equal(normalizePhone(null), "");
    assert.equal(normalizePhone("   "), "");
  });

  // ============ 2 · Detección COD ============
  console.log("· Detección COD");
  await test("pedido con gateway 'Cash on Delivery (COD)' es COD", () => {
    assert.equal(isCodOrder(codPayload()), true);
  });
  await test("pedido pagado con Shopify Payments NO es COD", () => {
    assert.equal(
      isCodOrder(
        codPayload({
          payment_gateway_names: ["shopify_payments"],
          gateway: "shopify_payments",
          financial_status: "paid",
        })
      ),
      false
    );
  });
  await test("tag de Releasit en el pedido cuenta como COD", () => {
    assert.equal(
      isCodOrder(
        codPayload({
          payment_gateway_names: ["manual"],
          gateway: "manual",
          tags: "Releasit COD Form",
        })
      ),
      true
    );
  });
  await test("COD_PENDING_IS_COD=1 acepta cualquier pago pendiente", () => {
    process.env.COD_PENDING_IS_COD = "1";
    try {
      assert.equal(
        isCodOrder(
          codPayload({ payment_gateway_names: ["manual"], gateway: "manual", tags: "" })
        ),
        true
      );
    } finally {
      delete process.env.COD_PENDING_IS_COD;
    }
  });
  await test("TREAT_ALL_ORDERS_AS_COD=1 acepta todo", () => {
    process.env.TREAT_ALL_ORDERS_AS_COD = "1";
    try {
      assert.equal(
        isCodOrder(codPayload({ payment_gateway_names: ["shopify_payments"], financial_status: "paid" })),
        true
      );
    } finally {
      delete process.env.TREAT_ALL_ORDERS_AS_COD;
    }
  });

  // ============ 3 · HMAC ============
  console.log("· HMAC Shopify");
  await test("firma correcta pasa", () => {
    assert.equal(verifyShopifyHmac("cuerpo", sign("cuerpo"), "test_webhook_secret"), true);
  });
  await test("firma incorrecta falla", () => {
    assert.equal(verifyShopifyHmac("cuerpo", sign("otro cuerpo"), "test_webhook_secret"), false);
  });
  await test("sin header o sin secret falla", () => {
    assert.equal(verifyShopifyHmac("cuerpo", null, "test_webhook_secret"), false);
    assert.equal(verifyShopifyHmac("cuerpo", sign("cuerpo"), undefined), false);
  });

  // ============ 4 · Webhook orders/create ============
  console.log("· Webhook");
  await test("pedido COD válido se guarda como pending_send", () => {
    const raw = JSON.stringify(codPayload({ id: 900001, order_number: 1101 }));
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(res.status, 200);
    const row = db.getOrderByShopifyId("900001");
    assert.ok(row, "el pedido debe existir");
    assert.equal(row!.status, "pending_send");
    assert.equal(row!.phone, "34611111111");
    assert.equal(row!.shopify_order_number, "1101");
    assert.match(row!.product_summary, /2x Crema facial/);
  });
  await test("webhook duplicado NO crea otra fila", () => {
    const raw = JSON.stringify(codPayload({ id: 900001, order_number: 1101 }));
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, true);
    const all = db.listOrders().filter((o) => o.shopify_order_id === "900001");
    assert.equal(all.length, 1);
  });
  await test("HMAC inválido → 401 y no guarda nada", () => {
    const raw = JSON.stringify(codPayload({ id: 900002, order_number: 1102 }));
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw, { hmac: sign("manipulado") }));
    assert.equal(res.status, 401);
    assert.equal(db.getOrderByShopifyId("900002"), null);
  });
  await test("pedido NO COD se ignora con 200", () => {
    const raw = JSON.stringify(
      codPayload({
        id: 900003,
        order_number: 1103,
        payment_gateway_names: ["shopify_payments"],
        gateway: "shopify_payments",
        financial_status: "paid",
      })
    );
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, "no COD");
    assert.equal(db.getOrderByShopifyId("900003"), null);
  });
  await test("pedido COD sin teléfono queda en estado error", () => {
    const payload = codPayload({ id: 900004, order_number: 1104 });
    (payload.shipping_address as Record<string, unknown>).phone = null;
    (payload.customer as Record<string, unknown>).phone = null;
    const raw = JSON.stringify(payload);
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(res.status, 200);
    const row = db.getOrderByShopifyId("900004");
    assert.equal(row!.status, "error");
    assert.match(row!.last_error ?? "", /teléfono/);
  });
  await test("sin SHOPIFY_WEBHOOK_SECRET configurado → 500", () => {
    const backup = process.env.SHOPIFY_WEBHOOK_SECRET;
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    try {
      const raw = JSON.stringify(codPayload({ id: 900005 }));
      const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
      assert.equal(res.status, 500);
    } finally {
      process.env.SHOPIFY_WEBHOOK_SECRET = backup;
    }
  });

  // ============ 5 · Envío inicial + respuesta "1" ============
  console.log("· Flujo de confirmación");
  db.setConnectionState({ status: "connected", phone: "34600000000" });
  const T0 = Math.floor(Date.now() / 1000);

  await test("scheduler envía la confirmación inicial (via outbox)", async () => {
    mkOrder("910001", "1201", "34600000001");
    const r = await runSchedulerTick(T0);
    assert.ok(r.sent >= 1, "debe enviar al menos 1");
    const row = db.getOrderByShopifyId("910001")!;
    assert.equal(row.status, "awaiting_reply");
    assert.equal(row.whatsapp_sent_at, T0);
    const out = db.getPendingOutbox(100).find((o) => o.phone === "34600000001");
    assert.ok(out, "el mensaje debe estar en el outbox");
    assert.match(out!.content, /Soy Pedro, de atención al cliente de Casamable™/);
    assert.match(out!.content, /1 - Todo correcto/);
    assert.match(out!.content, /2 - Quiero cambiar la dirección/);
    assert.match(out!.content, /3 - Quiero dejar una nota al repartidor/);
    assert.match(out!.content, /en efectivo para pagar al repartidor/);
    assert.match(out!.content, /Calle Falsa 1/);
    assert.doesNotMatch(out!.content, /bot|asistente|autom|IA\b/i);
  });

  await test("respuesta '1' confirma el pedido", () => {
    const res = handleOrderReply("34600000001", "1");
    assert.equal(res.handled, true);
    assert.equal(res.reply, msgs.MSG_CONFIRMED);
    const row = db.getOrderByShopifyId("910001")!;
    assert.equal(row.status, "confirmed");
    assert.ok(row.confirmed_at, "confirmed_at debe quedar registrado");
  });

  await test("un pedido confirmado no recibe recordatorios ni escala", async () => {
    await runSchedulerTick(T0 + 999_999);
    assert.equal(db.getOrderByShopifyId("910001")!.status, "confirmed");
  });

  // ============ 6 · Respuesta "2" + dirección propuesta ============
  await test("respuesta '2' pide la dirección (needs_correction)", async () => {
    mkOrder("910002", "1202", "34600000002");
    await runSchedulerTick(Math.floor(Date.now() / 1000));
    const res = handleOrderReply("34600000002", "2");
    assert.equal(res.handled, true);
    assert.equal(res.reply, msgs.MSG_ASK_ADDRESS);
    assert.equal(db.getOrderByShopifyId("910002")!.status, "needs_correction");
  });

  await test("el siguiente mensaje se guarda como dirección propuesta", () => {
    const res = handleOrderReply("34600000002", "Calle Mayor 5, 3º B, 28001 Madrid");
    assert.equal(res.handled, true);
    assert.equal(res.reply, msgs.MSG_ADDRESS_SAVED);
    const row = db.getOrderByShopifyId("910002")!;
    assert.equal(row.status, "needs_correction");
    assert.match(row.proposed_address ?? "", /Calle Mayor 5/);
  });

  await test("mensajes extra amplían la dirección sin repetir el 'gracias'", () => {
    const res = handleOrderReply("34600000002", "portal 2, timbre B");
    assert.equal(res.handled, true);
    assert.equal(res.reply, undefined);
    const row = db.getOrderByShopifyId("910002")!;
    assert.match(row.proposed_address ?? "", /Calle Mayor 5/);
    assert.match(row.proposed_address ?? "", /portal 2/);
  });

  // ============ 7 · Número desconocido ============
  await test("un número sin pedidos activos no lo maneja el flujo (handled=false)", () => {
    const res = handleOrderReply("34999888777", "1");
    assert.equal(res.handled, false);
  });

  // ============ 8 · Varios pedidos activos del mismo teléfono ============
  await test("con 2 pedidos activos, '1' a secas pide desambiguar (no confirma nada)", async () => {
    mkOrder("910003", "1203", "34600000003");
    mkOrder("910004", "1204", "34600000003");
    await runSchedulerTick(Math.floor(Date.now() / 1000));
    const res = handleOrderReply("34600000003", "1");
    assert.equal(res.handled, true);
    assert.match(res.reply ?? "", /1203/);
    assert.match(res.reply ?? "", /1204/);
    assert.equal(db.getOrderByShopifyId("910003")!.status, "awaiting_reply");
    assert.equal(db.getOrderByShopifyId("910004")!.status, "awaiting_reply");
  });

  await test("'1204 1' confirma SOLO el pedido 1204", () => {
    const res = handleOrderReply("34600000003", "1204 1");
    assert.equal(res.handled, true);
    assert.equal(res.reply, msgs.MSG_CONFIRMED);
    assert.equal(db.getOrderByShopifyId("910004")!.status, "confirmed");
    assert.equal(db.getOrderByShopifyId("910003")!.status, "awaiting_reply");
  });

  // ============ 9 · Respuestas ambiguas ============
  await test("respuesta ambigua → aclaración; segunda ambigua → needs_call", async () => {
    mkOrder("910005", "1205", "34600000004");
    await runSchedulerTick(Math.floor(Date.now() / 1000));
    const r1 = handleOrderReply("34600000004", "hola, quién eres?");
    assert.equal(r1.reply, msgs.MSG_CLARIFY);
    assert.equal(db.getOrderByShopifyId("910005")!.status, "awaiting_reply");
    const r2 = handleOrderReply("34600000004", "no entiendo nada");
    assert.equal(r2.reply, msgs.MSG_WILL_CALL);
    assert.equal(db.getOrderByShopifyId("910005")!.status, "needs_call");
  });

  // ============ 10 · Recordatorio y needs_call por tiempo ============
  console.log("· Recordatorios y escalado (FIRST_REMINDER=1min, NEEDS_CALL=3min)");
  const T = T0 + 500_000; // base futura aislada para este bloque
  await test("recordatorio al minuto sin respuesta", async () => {
    mkOrder("910006", "1206", "34600000005");
    await runSchedulerTick(T); // envío inicial en T
    assert.equal(db.getOrderByShopifyId("910006")!.status, "awaiting_reply");

    await runSchedulerTick(T + 30); // a los 30s aún nada
    assert.equal(db.getOrderByShopifyId("910006")!.status, "awaiting_reply");

    const r = await runSchedulerTick(T + 61); // pasado 1 min → recordatorio
    assert.ok(r.reminders >= 1);
    const row = db.getOrderByShopifyId("910006")!;
    assert.equal(row.status, "reminder_sent");
    assert.equal(row.reminder_sent_at, T + 61);
    const out = db.getPendingOutbox(300).filter((o) => o.phone === "34600000005");
    assert.equal(out.length, 2, "inicial + recordatorio");
    const reminder = out.find((o) => /solo nos falta confirmar tu pedido de Casamable™/.test(o.content));
    assert.ok(reminder, "el recordatorio debe mencionar Casamable");
    assert.match(reminder!.content, /3 - Quiero dejar una nota al repartidor/);
  });

  await test("a los 3 minutos sin respuesta → needs_call", async () => {
    await runSchedulerTick(T + 181);
    const row = db.getOrderByShopifyId("910006")!;
    assert.equal(row.status, "needs_call");
  });

  await test("quien contestó algo (aunque ilegible) no recibe recordatorio", async () => {
    // 910003 quedó awaiting_reply con customer_replied_at puesto (test 8):
    // en los ticks de este bloque escala a needs_call por tiempo, pero NUNCA
    // debe haber recibido recordatorio (contestó: no era silencio).
    const out = db.getPendingOutbox(500).filter(
      (o) => o.phone === "34600000003" && /solo nos falta confirmar/.test(o.content)
    );
    assert.equal(out.length, 0);
  });

  // ============ 11 · Acciones manuales (reenviar) ============
  await test("resetOrderForResend devuelve el pedido a la cola y se reenvía", async () => {
    const before = db.getOrderByShopifyId("910005")!; // estaba en needs_call
    db.resetOrderForResend(before.id);
    const queued = db.getOrderByShopifyId("910005")!;
    assert.equal(queued.status, "pending_send");
    const r = await runSchedulerTick(T + 300);
    assert.ok(r.sent >= 1);
    assert.equal(db.getOrderByShopifyId("910005")!.status, "awaiting_reply");
  });

  // ============ 12 · Casamable: detección COD real ============
  console.log("· Casamable — detección COD (releasit_cod_form)");
  await test("tag releasit_cod_form es señal primaria (aunque las keywords no ayuden)", () => {
    process.env.COD_GATEWAY_KEYWORDS = "zzz-sin-coincidencias";
    try {
      assert.equal(
        isCodOrder(codPayload({ payment_gateway_names: [], gateway: "", tags: "releasit_cod_form" })),
        true
      );
      assert.equal(
        isCodOrder(
          codPayload({ payment_gateway_names: [], gateway: "", tags: "releasit_cod_form, error Dropi" })
        ),
        true,
        "el tag 'error Dropi' no bloquea"
      );
    } finally {
      delete process.env.COD_GATEWAY_KEYWORDS;
    }
  });
  await test("pending SIN releasit y COD_PENDING_IS_COD=0 → NO es COD solo por pending", () => {
    assert.equal(
      isCodOrder(
        codPayload({
          payment_gateway_names: ["manual"],
          gateway: "manual",
          tags: "",
          financial_status: "pending",
        })
      ),
      false
    );
  });

  // ============ 13 · Casamable: formatos ============
  console.log("· Casamable — formatos (productos, EUR, dirección)");
  const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
  await test("formatMoney: '39,97 €', nunca '39.97 EUR'", () => {
    assert.equal(nbsp(msgs.formatMoney("39.97", "EUR")), "39,97 €");
    assert.equal(nbsp(msgs.formatMoney(34.98, "EUR")), "34,98 €");
  });
  await test("formatOrderItems: varios line_items, una línea por producto", () => {
    assert.equal(
      formatOrderItems({
        line_items: [
          { title: "Cortaúñas y Pulidor Eléctrico 3 en 1", quantity: 1, price: "34.99" },
          { title: "Seguro de Envío", quantity: 1, price: "4.98" },
        ],
      }),
      "1x Cortaúñas y Pulidor Eléctrico 3 en 1\n1x Seguro de Envío"
    );
    assert.equal(
      formatOrderItems({
        line_items: [{ title: "Limpiador Ultrasónico Multiusos", quantity: 2, price: "17.49" }],
      }),
      "2x Limpiador Ultrasónico Multiusos"
    );
    assert.equal(
      formatOrderItems({ line_items: [{ title: "Suplemento Intelecto Forte", quantity: 1 }] }),
      "Suplemento Intelecto Forte"
    );
  });
  await test("dirección: address2 presente aparece; campos vacíos no dejan huecos", () => {
    const con = formatAddressForMessage({
      address_line1: "Calle Alcalá 123",
      address_line2: "3º B",
      city: "Madrid",
      province: "Madrid",
      postal_code: "28009",
      country: "España",
    });
    assert.match(con, /3º B/);
    // Caso real (pedido Releasit): sin address2 y SIN ciudad (Releasit a veces no la manda)
    const sin = formatAddressForMessage({
      address_line1: "Avda Ejemplo 4 (no comunidad)",
      address_line2: null,
      city: null,
      province: "Málaga",
      postal_code: "29327",
      country: "España",
    });
    assert.doesNotMatch(sin, /undefined|null/);
    assert.doesNotMatch(sin, /, ,/);
    assert.match(sin, /29327/);
    assert.match(sin, /Málaga/);
    assert.doesNotMatch(sin, /España|Spain/, "el país español no se muestra: sobra");
    assert.ok(sin.split("\n").every((l) => l.trim().length > 0), "sin líneas vacías");

    // Caso REAL del pedido #1056: Releasit mandó city="-" y country="Spain".
    const basura = formatAddressForMessage({
      address_line1: "Calle Ejemplo 5B",
      address_line2: null,
      city: "-",
      province: "Almería",
      postal_code: "04007",
      country: "Spain",
    });
    assert.doesNotMatch(basura, /04007 -|Spain/, "ni relleno '-' ni país en inglés");
    assert.match(basura, /04007/);
    assert.match(basura, /Almería/);
  });
  await test("el nombre del cliente se presenta capitalizado (caso real: 'oliver')", () => {
    const base = mkOrder("950001", "1601", "34600000090");
    const conNombre = (n: string) => ({ ...base, customer_name: n });
    assert.match(msgs.buildConfirmationMessage(conNombre("oliver ruiz")), /Hola Oliver, buenas/);
    assert.match(msgs.buildConfirmationMessage(conNombre("PEDRO SANCHEZ")), /Hola Pedro, buenas/);
    assert.match(msgs.buildConfirmationMessage(conNombre("Pedro")), /Hola Pedro, buenas/);
    // Nombres con mayúscula interna se respetan (no los destrozamos):
    assert.match(msgs.buildConfirmationMessage(conNombre("McCarthy")), /Hola McCarthy, buenas/);
    // Sin nombre, el saludo sigue siendo correcto:
    assert.match(msgs.buildConfirmationMessage(conNombre("")), /^Hola, buenas\./);
  });

  await test("classifyOrderReply: variantes naturales sin IA", () => {
    for (const t of ["1", "sí", "Sí.", "todo correcto", "está bien", "ok"])
      assert.equal(classifyOrderReply(t), "confirm", `"${t}"`);
    for (const t of ["2", "cambiar dirección", "direccion incorrecta"])
      assert.equal(classifyOrderReply(t), "change_address", `"${t}"`);
    for (const t of ["3", "nota", "Nota repartidor", "dejar nota"])
      assert.equal(classifyOrderReply(t), "delivery_note", `"${t}"`);
    for (const t of ["creo que sí pero la dirección no sé", "mañana os digo", "quién eres"])
      assert.equal(classifyOrderReply(t), "unknown", `"${t}"`);
  });

  // ============ 14 · Casamable: opción 3 (nota para el repartidor) ============
  console.log("· Casamable — opción 3 (nota repartidor)");
  await test("respuesta '3' pide la nota y NO recibe recordatorio mientras espera", async () => {
    mkOrder("920001", "1301", "34600000010");
    await runSchedulerTick(Math.floor(Date.now() / 1000));
    const res = handleOrderReply("34600000010", "3");
    assert.equal(res.reply, msgs.MSG_ASK_NOTE);
    assert.equal(db.getOrderByShopifyId("920001")!.status, "awaiting_delivery_note");
    // Pasada la ventana de recordatorio (1 min en tests), sigue sin reminder:
    await runSchedulerTick(Math.floor(Date.now() / 1000) + 61);
    assert.equal(db.getOrderByShopifyId("920001")!.status, "awaiting_delivery_note");
    const rem = db
      .getPendingOutbox(500)
      .filter((o) => o.phone === "34600000010" && /solo nos falta/.test(o.content));
    assert.equal(rem.length, 0);
  });

  await test("el siguiente mensaje se guarda como delivery_note y NO confirma", () => {
    const res = handleOrderReply("34600000010", "Llamar antes de subir");
    assert.equal(res.reply, msgs.MSG_NOTE_SAVED);
    const row = db.getOrderByShopifyId("920001")!;
    assert.equal(row.delivery_note, "Llamar antes de subir");
    assert.equal(row.status, "awaiting_reply", "guardar la nota NO confirma");
    assert.equal(row.confirmed_at, null);
  });

  await test("confirmar después de la nota (responde 1)", () => {
    const res = handleOrderReply("34600000010", "1");
    assert.equal(res.reply, msgs.MSG_CONFIRMED);
    const row = db.getOrderByShopifyId("920001")!;
    assert.equal(row.status, "confirmed");
    assert.equal(row.delivery_note, "Llamar antes de subir", "la nota se conserva");
  });

  await test("multipedido + opción 3: la nota JAMÁS va al pedido equivocado", async () => {
    mkOrder("920002", "1302", "34600000011");
    mkOrder("920003", "1303", "34600000011");
    await runSchedulerTick(Math.floor(Date.now() / 1000));

    const amb = handleOrderReply("34600000011", "3"); // ambiguo con 2 pedidos
    assert.match(amb.reply ?? "", /1302/);
    assert.match(amb.reply ?? "", /1303/);
    assert.equal(db.getOrderByShopifyId("920002")!.status, "awaiting_reply");
    assert.equal(db.getOrderByShopifyId("920003")!.status, "awaiting_reply");

    const ask = handleOrderReply("34600000011", "1303 3");
    assert.equal(ask.reply, msgs.MSG_ASK_NOTE);
    assert.equal(db.getOrderByShopifyId("920003")!.status, "awaiting_delivery_note");

    const saved = handleOrderReply("34600000011", "El timbre no funciona, llamad al móvil");
    assert.equal(saved.reply, msgs.MSG_NOTE_SAVED);
    assert.equal(db.getOrderByShopifyId("920003")!.delivery_note, "El timbre no funciona, llamad al móvil");
    assert.equal(db.getOrderByShopifyId("920002")!.delivery_note, null, "nota solo en el 1303");

    handleOrderReply("34600000011", "1302 1");
    assert.equal(db.getOrderByShopifyId("920002")!.status, "confirmed");
    const last = handleOrderReply("34600000011", "1"); // ya solo queda el 1303 activo
    assert.equal(last.reply, msgs.MSG_CONFIRMED);
    assert.equal(db.getOrderByShopifyId("920003")!.status, "confirmed");
  });

  // ============ 15 · Casamable: webhook con forma de pedido real ============
  console.log("· Casamable — webhook realista y tag Shopify");
  await test("pedido tipo Releasit (tags + note_attributes + ciudad vacía) entra bien", () => {
    const payload = codPayload({
      id: 18064595714378,
      order_number: 35010484,
      name: "#35010484",
      email: null,
      total_price: "34.98",
      financial_status: "pending",
      gateway: "",
      payment_gateway_names: [],
      tags: "releasit_cod_form, error Dropi",
      customer: { first_name: "Clienta", last_name: "-", email: null, phone: null },
      shipping_address: {
        name: "Clienta -",
        address1: "Avda Ejemplo 4 (no comunidad)",
        address2: null,
        city: null,
        province: "Málaga",
        zip: "29327",
        country: "España",
        country_code: "ES",
        phone: "+34600555666",
      },
      line_items: [{ title: "Limpiador Ultrasónico Multiusos", quantity: 2, price: "17.49" }],
      note_attributes: [{ name: "A que hora estare en casa", value: "siempre" }],
    });
    const raw = JSON.stringify(payload);
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(res.status, 200);
    const row = db.getOrderByShopifyId("18064595714378")!;
    assert.equal(row.status, "pending_send");
    assert.equal(row.phone, "34600555666");
    assert.equal(row.product_summary, "2x Limpiador Ultrasónico Multiusos");
    assert.equal(row.customer_note, "A que hora estare en casa: siempre");
    assert.equal(row.province, "Málaga");
  });

  await test("WA_CONFIRMED va por tagsAdd (añade SIN machacar los tags existentes)", async () => {
    const realFetch = global.fetch;
    process.env.SHOPIFY_STORE_DOMAIN = "qmbr1z-vf.myshopify.com";
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "token-de-prueba";
    process.env.SHOPIFY_WRITE_ENABLED = "1"; // gate abierto SOLO en este test
    let capturedUrl = "";
    let capturedBody = "";
    let capturedToken = "";
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      capturedToken = String(
        (init?.headers as Record<string, string> | undefined)?.["X-Shopify-Access-Token"] ?? ""
      );
      return new Response(
        JSON.stringify({
          data: { tagsAdd: { node: { id: "gid://shopify/Order/18064595714378" }, userErrors: [] } },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const ok = await tagOrderConfirmed("18064595714378");
      assert.equal(ok, true);
      assert.equal(capturedUrl, "https://qmbr1z-vf.myshopify.com/admin/api/2026-07/graphql.json");
      assert.equal(capturedToken, "token-de-prueba");
      assert.match(capturedBody, /tagsAdd/);
      assert.doesNotMatch(capturedBody, /orderUpdate/, "orderUpdate machacaría los tags");
      assert.match(capturedBody, /gid:\/\/shopify\/Order\/18064595714378/);
      assert.match(capturedBody, /WA_CONFIRMED/);
    } finally {
      global.fetch = realFetch;
      delete process.env.SHOPIFY_STORE_DOMAIN;
      delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
      delete process.env.SHOPIFY_WRITE_ENABLED;
    }
  });

  // ============ 16 · SEGURIDAD: safety gates ============
  console.log("· Seguridad — safety gates (probados directamente)");

  await test("safe mode JAMÁS envía WhatsApp (bloquea y no encola nada)", async () => {
    await withEnv({ APP_MODE: "safe" }, () => {
      assert.equal(safety.canSendRealWhatsApp("34600000050"), false);
      const ok = sendWhatsAppMessage("34600000050", "hola, esto no debe salir");
      assert.equal(ok, false);
      assert.equal(
        db.getPendingOutbox(500).some((o) => o.phone === "34600000050"),
        false,
        "nada en outbox"
      );
      assert.equal(
        db.listConversations().some((c) => c.phone === "34600000050"),
        false,
        "ni siquiera crea conversación"
      );
    });
  });

  await test("APP_MODE desconocido o ausente = safe (nunca asumir producción)", async () => {
    await withEnv({ APP_MODE: "produccion-typo" }, () => {
      assert.equal(safety.appMode(), "safe");
      assert.equal(safety.canSendRealWhatsApp("34600000050"), false);
    });
    await withEnv({ APP_MODE: undefined }, () => {
      assert.equal(safety.appMode(), "safe");
    });
  });

  await test("matriz de llaves: cualquier llave cerrada = NO SEND / NO WRITE", async () => {
    const phone = "34600000052";
    // producción pero sin flag de envío:
    await withEnv({ WHATSAPP_SEND_ENABLED: "0" }, () => {
      assert.equal(safety.canSendRealWhatsApp(phone), false);
      assert.equal(sendWhatsAppMessage(phone, "no debe salir"), false);
    });
    // producción + envío, pero EMERGENCY_STOP:
    await withEnv({ EMERGENCY_STOP: "1" }, () => {
      assert.equal(safety.canSendRealWhatsApp(phone), false);
      assert.equal(safety.canWriteToShopify(), false);
    });
    // EMERGENCY_STOP ausente = activado (default seguro):
    await withEnv({ EMERGENCY_STOP: undefined }, () => {
      assert.equal(safety.canSendRealWhatsApp(phone), false);
    });
    // escrituras Shopify: sin flag → bloqueado incluso en producción:
    assert.equal(safety.canWriteToShopify(), false);
    await withEnv({ SHOPIFY_WRITE_ENABLED: "1", APP_MODE: "safe" }, () => {
      assert.equal(safety.canWriteToShopify(), false, "safe mode manda sobre el flag");
    });
  });

  await test("TEST_MODE: fuera de allowlist bloqueado, dentro permitido", async () => {
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600000052, +34 600 333 444" }, () => {
      assert.equal(safety.phoneAllowed("34600000052"), true);
      assert.equal(safety.phoneAllowed("34600333444"), true, "acepta formatos con espacios/+");
      assert.equal(safety.phoneAllowed("34699999999"), false);
      assert.equal(safety.canSendRealWhatsApp("34600000052"), true);
      assert.equal(safety.canSendRealWhatsApp("34699999999"), false);
    });
  });

  await test("EMERGENCY_STOP=1 detiene el scheduler entero", async () => {
    mkOrder("930001", "1401", "34600000051");
    await withEnv({ EMERGENCY_STOP: "1" }, async () => {
      const r = await runSchedulerTick(Math.floor(Date.now() / 1000));
      assert.deepEqual(r, { sent: 0, reminders: 0, escalated: 0 });
    });
    assert.equal(db.getOrderByShopifyId("930001")!.status, "pending_send");
    assert.equal(
      db.getPendingOutbox(500).some((o) => o.phone === "34600000051"),
      false
    );
  });

  await test("TEST_MODE=1: el scheduler ignora pedidos fuera de allowlist", async () => {
    mkOrder("930002", "1402", "34688888888");
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600000052" }, async () => {
      await runSchedulerTick(Math.floor(Date.now() / 1000));
    });
    assert.equal(db.getOrderByShopifyId("930002")!.status, "pending_send", "ni enviado ni transicionado");
    assert.equal(
      db.getPendingOutbox(500).some((o) => o.phone === "34688888888"),
      false
    );
  });

  await test("pedido antiguo en cola → ignored_old, sin mensaje", async () => {
    // Backdatear el pedido del test anterior como si fuera de hace días:
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("UPDATE orders SET created_at = created_at - 999999 WHERE shopify_order_id = '930002'").run();
    raw.close();
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, async () => {
      await runSchedulerTick(Math.floor(Date.now() / 1000));
    });
    const row = db.getOrderByShopifyId("930002")!;
    assert.equal(row.status, "ignored_old");
    assert.equal(
      db.getPendingOutbox(500).some((o) => o.phone === "34688888888"),
      false,
      "jamás se le envió nada"
    );
  });

  await test("webhook con created_at antiguo → ignored_old (anti-replay)", async () => {
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, () => {
      const payload = codPayload({
        id: 930003,
        order_number: 1403,
        created_at: "2026-08-01T10:00:00+02:00", // semanas antes de hoy
      });
      const raw = JSON.stringify(payload);
      const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
      assert.equal(res.status, 200);
      assert.equal(db.getOrderByShopifyId("930003")!.status, "ignored_old");
    });
  });

  await test("idempotencia fuerte: doble tick no duplica inicial ni reminder", async () => {
    const T2 = T0 + 800_000;
    mkOrder("930004", "1404", "34600000053");
    await runSchedulerTick(T2);
    await runSchedulerTick(T2); // repetido: el claim atómico debe impedir otro envío
    let out = db.getPendingOutbox(900).filter((o) => o.phone === "34600000053");
    assert.equal(out.length, 1, "un solo mensaje inicial");

    await runSchedulerTick(T2 + 61);
    await runSchedulerTick(T2 + 61); // reminder repetido → solo uno
    out = db.getPendingOutbox(900).filter((o) => o.phone === "34600000053");
    assert.equal(out.length, 2, "inicial + UN reminder");
    assert.equal(db.getOrderByShopifyId("930004")!.status, "reminder_sent");
  });

  await test("mensaje de GRUPO → completamente ignorado", async () => {
    const before = db.listConversations().length;
    const fakeSock = {} as unknown as Parameters<typeof handleIncomingMessages>[0];
    const groupEvent = {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "120363000000000000@g.us", fromMe: false },
          message: { conversation: "1" },
          pushName: "Grupo Familia",
        },
      ],
    } as unknown as Parameters<typeof handleIncomingMessages>[1];
    await handleIncomingMessages(fakeSock, groupEvent);
    assert.equal(db.listConversations().length, before, "ni conversación ni nada");
  });

  await test("número SIN pedido activo y sin IA: se guarda pero JAMÁS se responde", async () => {
    const fakeSock = {} as unknown as Parameters<typeof handleIncomingMessages>[0];
    const event = {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "34699000111@s.whatsapp.net", fromMe: false },
          message: { conversation: "hola! soy un amigo de Pedro" },
          pushName: "Amigo",
        },
      ],
    } as unknown as Parameters<typeof handleIncomingMessages>[1];
    await handleIncomingMessages(fakeSock, event);
    assert.equal(
      db.listConversations().some((c) => c.phone === "34699000111"),
      true,
      "el mensaje queda visible en Chats"
    );
    assert.equal(
      db.getPendingOutbox(900).some((o) => o.phone === "34699000111"),
      false,
      "cero respuestas automáticas"
    );
  });

  await test("guardar nota NO escribe en Shopify; confirmar SÍ (y por el gate)", async () => {
    const T3 = T0 + 900_000;
    mkOrder("930006", "1406", "34600000055");
    await runSchedulerTick(T3); // envío inicial con writes CERRADOS
    handleOrderReply("34600000055", "3");

    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({ data: { tagsAdd: { node: { id: "x" }, userErrors: [] } } }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      await withEnv(
        {
          SHOPIFY_WRITE_ENABLED: "1",
          SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
          SHOPIFY_ADMIN_ACCESS_TOKEN: "token-de-prueba",
        },
        async () => {
          handleOrderReply("34600000055", "dejadlo en conserjería");
          await new Promise((r) => setTimeout(r, 50));
          assert.equal(fetchCalls, 0, "la nota no toca Shopify");
          handleOrderReply("34600000055", "1"); // confirmar → tagsAdd vía gate
          await new Promise((r) => setTimeout(r, 50));
          assert.equal(fetchCalls, 1, "el tag sale exactamente una vez");
        }
      );
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(db.getOrderByShopifyId("930006")!.status, "confirmed");
  });

  await test("acción manual 'confirmar' en safe mode: estado interno sí, Shopify NO", async () => {
    mkOrder("930007", "1407", "34600000056");
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await withEnv(
        {
          APP_MODE: "safe",
          SHOPIFY_WRITE_ENABLED: "1",
          SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
          SHOPIFY_ADMIN_ACCESS_TOKEN: "token-de-prueba",
        },
        async () => {
          confirmOrder(db.getOrderByShopifyId("930007")!, "manual");
          await new Promise((r) => setTimeout(r, 50));
          assert.equal(fetchCalls, 0, "safe mode manda: cero mutaciones");
        }
      );
    } finally {
      global.fetch = realFetch;
    }
    const row = db.getOrderByShopifyId("930007")!;
    assert.equal(row.status, "confirmed", "el estado interno sí cambia");
    assert.equal(row.shopify_tagged, 0, "sin tag: se reintentará cuando se abra el gate");
  });

  // ============ 17 · AUDITORÍA ADVERSARIAL ============
  console.log("· Auditoría — allowlist y formatos de teléfono");

  await test("allowlist: '600111222', '+34 600 33 34 44' y '34600111222' son el MISMO teléfono", async () => {
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "600111222, +34 600 33 34 44" }, () => {
      assert.equal(safety.phoneAllowed("34600111222"), true, "9 dígitos en allowlist casa con pedido");
      assert.equal(safety.phoneAllowed("34600333444"), true, "formato +34 con espacios casa");
      assert.equal(safety.phoneAllowed("600111222"), true);
      assert.equal(safety.phoneAllowed("+34 600-11-12-22"), true);
      assert.equal(safety.phoneAllowed("34600111223"), false, "un dígito distinto NO pasa");
      assert.equal(safety.phoneAllowed(""), false, "sin teléfono jamás es elegible");
    });
  });

  await test("acción manual en TEST_MODE: bloqueada fuera de allowlist, permitida dentro", async () => {
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, () => {
      assert.equal(safety.canOperateOnOrderManually("34699999999").ok, false);
      assert.match(safety.canOperateOnOrderManually("34699999999").reason ?? "", /TEST_MODE/);
      assert.equal(safety.canOperateOnOrderManually("600111222").ok, true);
    });
    assert.equal(safety.canOperateOnOrderManually("34699999999").ok, true, "sin TEST_MODE no bloquea");
  });

  console.log("· Auditoría — concurrencia e idempotencia");

  await test("webhook duplicado concurrente: INSERT atómico, 1 fila, sin excepción", () => {
    const payload = codPayload({ id: 940001, order_number: 1501 });
    (payload.shipping_address as Record<string, unknown>).phone = "+34 600 00 00 70";
    const raw = JSON.stringify(payload);
    const r1 = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    const r2 = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.duplicate, true);
    // Y el primitivo de DB directamente (base de la garantía anti-carrera):
    const dup = db.insertOrderIfNew({
      shopify_order_id: "940001",
      shopify_order_number: "1501",
      customer_name: null,
      phone: "34600000070",
      email: null,
      product_summary: "x",
      total_price: "1",
      currency: "EUR",
      address_line1: null,
      address_line2: null,
      city: null,
      province: null,
      postal_code: null,
      country: null,
      status: "pending_send",
    });
    assert.equal(dup.created, false, "no lanza ni duplica: OR IGNORE + re-select");
    assert.equal(db.listOrders().filter((o) => o.shopify_order_id === "940001").length, 1);
  });

  await test("doble '1' → una confirmación y UN solo intento de tag", async () => {
    const o = mkOrder("940002", "1502", "34600000060");
    db.claimOrderInitialSend(o.id); // awaiting_reply sin pasar por el scheduler
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({ data: { tagsAdd: { node: { id: "x" }, userErrors: [] } } }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      await withEnv(
        {
          SHOPIFY_WRITE_ENABLED: "1",
          SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
          SHOPIFY_ADMIN_ACCESS_TOKEN: "token-de-prueba",
        },
        async () => {
          const r1 = handleOrderReply("34600000060", "1");
          assert.equal(r1.reply, msgs.MSG_CONFIRMED);
          const r2 = handleOrderReply("34600000060", "1"); // ya no hay pedido activo
          assert.equal(r2.handled, false, "el segundo '1' es inerte");
          await new Promise((r) => setTimeout(r, 50));
          assert.equal(fetchCalls, 1, "exactamente un tagsAdd");
        }
      );
    } finally {
      global.fetch = realFetch;
    }
    assert.equal(db.markOrderConfirmed(o.id, true), false, "el claim de confirmación no se repite");
  });

  await test("carrera respuesta-vs-reminder: confirmado jamás recibe el reminder del tick en vuelo", () => {
    // El claim del reminder exige status='awaiting_reply': si el cliente
    // confirma entre el SELECT del tick y el claim, el claim falla.
    const o = mkOrder("940003", "1503", "34600000061");
    db.claimOrderInitialSend(o.id);
    db.markOrderConfirmed(o.id, true);
    assert.equal(db.claimOrderReminder(o.id), false);
    assert.equal(db.claimOrderInitialSend(o.id), false, "tampoco un inicial repetido");
  });

  console.log("· Auditoría — máquina de estados");

  await test("transiciones inválidas: rechazadas sin side effects", () => {
    const o = mkOrder("940004", "1504", "34600000062"); // pending_send
    assert.equal(db.claimOrderReminder(o.id), false, "pending_send no recibe reminder");
    assert.equal(db.saveOrderDeliveryNote(o.id, "x"), false, "nota solo esperando nota");
    assert.equal(db.appendOrderProposedAddress(o.id, "x"), false, "dirección solo en corrección");
    db.claimOrderInitialSend(o.id);
    db.markOrderConfirmed(o.id, true);
    assert.equal(db.markOrderNeedsCall(o.id), false, "confirmed → needs_call imposible");
    assert.equal(db.resetOrderForResend(o.id), false, "confirmed no se reenvía");
    assert.equal(db.markOrderCancelled(o.id), false, "confirmed no se descarta");
    assert.equal(db.markOrderIgnoredOld(o.id), false, "confirmed no pasa a ignored_old");
    assert.equal(db.getOrderByShopifyId("940004")!.status, "confirmed", "el estado no se movió");

    const o2 = mkOrder("940005", "1505", "34600000063");
    db.markOrderCancelled(o2.id);
    assert.equal(db.markOrderConfirmed(o2.id, true), false, "cancelled → confirmed imposible");
    assert.equal(db.claimOrderInitialSend(o2.id), false, "cancelled no vuelve a la cola solo");
    assert.equal(db.getOrderByShopifyId("940005")!.status, "cancelled");
  });

  console.log("· Auditoría — Baileys y clasificador");

  await test("el bot IGNORA sus propios mensajes (echo fromMe con un '1' dentro)", async () => {
    const o = mkOrder("940006", "1506", "34600000064");
    db.claimOrderInitialSend(o.id); // awaiting_reply: un '1' entrante confirmaría
    const fakeSock = {} as unknown as Parameters<typeof handleIncomingMessages>[0];
    const echo = {
      type: "notify",
      messages: [
        {
          // El propio mensaje del bot ("...Responde: 1 - Todo correcto...")
          key: { remoteJid: "34600000064@s.whatsapp.net", fromMe: true },
          message: { conversation: "Respóndeme: 1 - Todo correcto" },
        },
      ],
    } as unknown as Parameters<typeof handleIncomingMessages>[1];
    await handleIncomingMessages(fakeSock, echo);
    assert.equal(db.getOrderByShopifyId("940006")!.status, "awaiting_reply", "el echo NO confirma");
  });

  await test("clasificador adversarial: solo confirma lo inequívoco", () => {
    assert.equal(classifyOrderReply("1 gracias"), "confirm");
    assert.equal(classifyOrderReply("2, me he equivocado"), "change_address");
    assert.equal(classifyOrderReply("3 quiero poner una nota"), "delivery_note");
    for (const t of ["👍", "?", "si perfecto", "correcto gracias", "hola", "creo que sí"]) {
      assert.equal(classifyOrderReply(t), "unknown", `"${t}" debe pedir aclaración`);
    }
    // Caso REAL (#1057, Pedro): un typo NO se adivina. Pedir aclaración cuesta
    // un mensaje; confirmar por error manda un pedido COD sin confirmar.
    assert.equal(classifyOrderReply("todo crrrrreectro"), "unknown");
  });

  await test("tags como ARRAY (payload no confiable) también detecta releasit_cod_form", () => {
    const payload = codPayload({
      payment_gateway_names: [],
      gateway: "",
      tags: ["releasit_cod_form", "error Dropi"] as unknown as string,
    });
    assert.equal(isCodOrder(payload), true);
  });

  console.log("· Auditoría — TEST_MODE, Shopify y outbox");

  await test("TEST_MODE: la respuesta de un cliente NO elegible se ignora por completo", async () => {
    const o = mkOrder("940007", "1507", "34688888877");
    db.claimOrderInitialSend(o.id);
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await withEnv(
        {
          TEST_MODE: "1",
          TEST_PHONE_ALLOWLIST: "34600111222",
          SHOPIFY_WRITE_ENABLED: "1",
          SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
          SHOPIFY_ADMIN_ACCESS_TOKEN: "token-de-prueba",
        },
        async () => {
          // Fuera de allowlist y sin autorizar: ni siquiera se le atiende, así
          // que nunca se confirma un pedido al que jamás escribimos.
          const r = handleOrderReply("34688888877", "1");
          assert.equal(r.handled, false, "no se procesa a un cliente no elegible");
          await new Promise((r2) => setTimeout(r2, 50));
          assert.equal(fetchCalls, 0, "el pedido de un cliente real jamás se taggea en pruebas");
        }
      );
    } finally {
      global.fetch = realFetch;
    }
    const row = db.getOrderByShopifyId("940007")!;
    assert.equal(row.status, "awaiting_reply", "su estado no se toca");
    assert.equal(row.shopify_tagged, 0);
  });

  await test("Dev Dashboard: pide token por client-credentials, lo cachea y lo usa", async () => {
    const admin = await import("../src/lib/shopify/admin");
    const realFetch = global.fetch;
    let tokenCalls = 0;
    let usedToken = "";
    admin._resetTokenCache();
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/admin/oauth/access_token")) {
        tokenCalls++;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        assert.equal(body.grant_type, "client_credentials");
        assert.equal(body.client_id, "id-de-prueba");
        return new Response(JSON.stringify({ access_token: "token-fresco", expires_in: 86399 }), {
          status: 200,
        });
      }
      usedToken = String((init?.headers as Record<string, string>)?.["X-Shopify-Access-Token"] ?? "");
      return new Response(
        JSON.stringify({ data: { tagsAdd: { node: { id: "x" }, userErrors: [] } } }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      await withEnv(
        {
          SHOPIFY_ADMIN_ACCESS_TOKEN: undefined, // sin token estático: usa la vía B
          SHOPIFY_CLIENT_ID: "id-de-prueba",
          SHOPIFY_CLIENT_SECRET: "secret-de-prueba",
          SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
          SHOPIFY_WRITE_ENABLED: "1",
        },
        async () => {
          assert.equal(admin.shopifyAdminConfigured(), true, "client id+secret bastan");
          assert.equal(await admin.tagOrderConfirmed("1"), true);
          assert.equal(usedToken, "token-fresco", "usa el token recién pedido");
          assert.equal(tokenCalls, 1);
          await admin.tagOrderConfirmed("2");
          assert.equal(tokenCalls, 1, "segundo tag reutiliza el token cacheado");
        }
      );
    } finally {
      global.fetch = realFetch;
      admin._resetTokenCache();
    }
  });

  await test("sin credenciales de Admin API, tagsAdd no revienta y devuelve false", async () => {
    const admin = await import("../src/lib/shopify/admin");
    await withEnv(
      {
        SHOPIFY_ADMIN_ACCESS_TOKEN: undefined,
        SHOPIFY_CLIENT_ID: undefined,
        SHOPIFY_CLIENT_SECRET: undefined,
        SHOPIFY_WRITE_ENABLED: "1",
        SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
      },
      async () => {
        assert.equal(admin.shopifyAdminConfigured(), false);
        assert.equal(await admin.tagOrderConfirmed("1"), false);
      }
    );
  });

  await test("tagsAdd: userErrors, red caída y 429 → false sin excepción", async () => {
    const realFetch = global.fetch;
    try {
      await withEnv(
        {
          SHOPIFY_WRITE_ENABLED: "1",
          SHOPIFY_STORE_DOMAIN: "qmbr1z-vf.myshopify.com",
          SHOPIFY_ADMIN_ACCESS_TOKEN: "token-de-prueba",
        },
        async () => {
          global.fetch = (async () =>
            new Response(
              JSON.stringify({ data: { tagsAdd: { node: null, userErrors: [{ message: "no permission" }] } } }),
              { status: 200 }
            )) as typeof fetch;
          assert.equal(await tagOrderConfirmed("1"), false, "userErrors detectados");

          global.fetch = (async () => {
            throw new Error("network down");
          }) as typeof fetch;
          assert.equal(await tagOrderConfirmed("1"), false, "error de red no revienta");

          global.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
          assert.equal(await tagOrderConfirmed("1"), false, "429 tratado como fallo suave");
        }
      );
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("outbox: claim→revert deja el mensaje pendiente para reintento (sin duplicar)", () => {
    const convo = db.getOrCreateConversation("34600000065");
    const obId = db.enqueueOutbox(convo.id, "34600000065", "prueba de revert");
    db.markOutboxSent(obId); // claim
    assert.equal(
      db.getPendingOutbox(999).some((i) => i.id === obId),
      false,
      "reclamado: nadie más lo puede enviar"
    );
    db.revertOutboxSent(obId); // el envío falló de forma controlada
    assert.equal(
      db.getPendingOutbox(999).some((i) => i.id === obId),
      true,
      "vuelve a la cola exactamente una vez"
    );
  });

  // ============ 18 · PRE-PILOTO: ventana horaria ============
  console.log("· Pre-piloto — ventana horaria");

  await test("insideSendWindow respeta la franja (y la nocturna que cruza medianoche)", async () => {
    // 2026-08-20 a las 03:00 y 12:00 hora de Madrid (verano, UTC+2)
    const madrugada = Date.parse("2026-08-20T01:00:00Z"); // 03:00 local
    const mediodia = Date.parse("2026-08-20T10:00:00Z"); // 12:00 local
    await withEnv({ WHATSAPP_WINDOW_ENABLED: "1", WHATSAPP_WINDOW_START: "09:00", WHATSAPP_WINDOW_END: "21:00" }, () => {
      assert.equal(safety.insideSendWindow(madrugada), false, "03:00 está fuera");
      assert.equal(safety.insideSendWindow(mediodia), true, "12:00 está dentro");
      assert.equal(safety.localMinutesNow(mediodia), 12 * 60);
    });
    // Franja nocturna (cruza medianoche): 22:00-06:00
    await withEnv({ WHATSAPP_WINDOW_ENABLED: "1", WHATSAPP_WINDOW_START: "22:00", WHATSAPP_WINDOW_END: "06:00" }, () => {
      assert.equal(safety.insideSendWindow(madrugada), true, "03:00 entra en la nocturna");
      assert.equal(safety.insideSendWindow(mediodia), false);
    });
    // Valores inválidos → se usa el default 09:00-21:00 (fail safe)
    await withEnv({ WHATSAPP_WINDOW_START: "99:99", WHATSAPP_WINDOW_END: "basura" }, () => {
      assert.equal(safety.windowStartMinutes(), 9 * 60);
      assert.equal(safety.windowEndMinutes(), 21 * 60);
    });
    await withEnv({ WHATSAPP_WINDOW_ENABLED: "0" }, () => {
      assert.equal(safety.insideSendWindow(madrugada), true, "desactivada = siempre dentro");
    });
  });

  await test("nextWindowOpen apunta a la siguiente apertura", async () => {
    await withEnv({ WHATSAPP_WINDOW_ENABLED: "1", WHATSAPP_WINDOW_START: "09:00", WHATSAPP_WINDOW_END: "21:00" }, () => {
      const madrugada = Date.parse("2026-08-20T01:00:00Z"); // 03:00 local → faltan 6h
      const abre = safety.nextWindowOpen(madrugada);
      assert.equal(abre - Math.floor(madrugada / 1000), 6 * 3600);
      const noche = Date.parse("2026-08-20T20:00:00Z"); // 22:00 local → faltan 11h
      assert.equal(safety.nextWindowOpen(noche) - Math.floor(noche / 1000), 11 * 3600);
    });
  });

  await test("fuera de ventana: NO se envía, NO se pierde y NO caduca a ignored_old", async () => {
    const o = mkOrder("960001", "1701", "34600000100");
    await withEnv(
      {
        TEST_MODE: "0",
        WHATSAPP_WINDOW_ENABLED: "1",
        WHATSAPP_WINDOW_START: "09:00",
        WHATSAPP_WINDOW_END: "09:01", // ventana de 1 minuto: casi seguro cerrada
        MAX_ORDER_AGE_MINUTES: "30",
      },
      async () => {
        if (safety.insideSendWindow()) return; // por si el test corre justo a las 09:00
        const r = await runSchedulerTick();
        assert.equal(r.sent, 0, "no envía fuera de horario");
        const row = db.getOrderById(o.id)!;
        assert.equal(row.status, "pending_send", "sigue en cola, no se pierde");
        assert.ok(row.deferred_until, "queda marcada la próxima apertura");
        assert.equal(
          db.getPendingOutbox(900).some((x) => x.phone === "34600000100"),
          false
        );

        // Aunque pase mucho tiempo esperando, NO se marca ignored_old:
        const muchoDespues = (row.deferred_until as number) + 60;
        await runSchedulerTick(muchoDespues);
        assert.notEqual(db.getOrderById(o.id)!.status, "ignored_old", "esperar no lo caduca");
      }
    );
  });

  await test("dentro de ventana: el pedido diferido se envía con normalidad", async () => {
    const o = mkOrder("960002", "1702", "34600000101");
    await withEnv({ TEST_MODE: "0", WHATSAPP_WINDOW_ENABLED: "0" }, async () => {
      await runSchedulerTick();
      const row = db.getOrderById(o.id)!;
      assert.equal(row.status, "awaiting_reply");
      assert.equal(
        db.getPendingOutbox(900).some((x) => x.phone === "34600000101"),
        true
      );
    });
  });

  // ============ 19 · PRE-PILOTO: autorización manual por pedido ============
  console.log("· Pre-piloto — autorización manual de piloto");

  await test("sin autorizar, un cliente fuera de allowlist no recibe NADA", async () => {
    const o = mkOrder("960003", "1703", "34777000111"); // NO está en la allowlist
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, async () => {
      assert.equal(safety.orderActionAllowed(db.getOrderById(o.id)!), false);
      await runSchedulerTick();
      assert.equal(db.getOrderById(o.id)!.status, "pending_send");
      assert.equal(
        db.getPendingOutbox(900).some((x) => x.phone === "34777000111"),
        false
      );
    });
  });

  await test("tras autorizar, ESE pedido recibe mensaje, reminder y tag", async () => {
    const o = db.getOrderByShopifyId("960003")!;
    assert.equal(db.authorizeOrderForPilot(o.id), true);
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, async () => {
      const fresco = db.getOrderById(o.id)!;
      assert.equal(fresco.pilot_authorized, 1);
      assert.equal(safety.orderActionAllowed(fresco), true);
      assert.equal(
        safety.canSendRealWhatsApp("34777000111", { orderAuthorized: true }),
        true,
        "el gate deja pasar SOLO con la marca del pedido"
      );
      assert.equal(
        safety.canSendRealWhatsApp("34777000111"),
        false,
        "sin la marca, el mismo teléfono sigue bloqueado"
      );

      const T = Math.floor(Date.now() / 1000);
      await runSchedulerTick(T);
      const enviado = db.getOrderById(o.id)!;
      assert.equal(enviado.status, "awaiting_reply", "ya se le envió el inicial");
      const items = db.getPendingOutbox(900).filter((x) => x.phone === "34777000111");
      assert.equal(items.length, 1);
      assert.equal(items[0].authorized, 1, "el mensaje viaja marcado como autorizado");

      // Recordatorio: también permitido para este pedido.
      await runSchedulerTick(T + 61);
      assert.equal(db.getOrderById(o.id)!.status, "reminder_sent");

      // Y su respuesta se procesa y se le contesta.
      const r = handleOrderReply("34777000111", "1");
      assert.equal(r.handled, true);
      assert.equal(r.reply, msgs.MSG_CONFIRMED);
      assert.equal(r.authorized, true, "la respuesta hereda la autorización");
      assert.equal(db.getOrderById(o.id)!.status, "confirmed");
    });
  });

  await test("AISLAMIENTO: autorizar un pedido NO autoriza otro del MISMO teléfono", async () => {
    const autorizado = db.getOrderByShopifyId("960003")!; // ya autorizado y confirmado
    const otro = mkOrder("960004", "1704", "34777000111"); // mismo teléfono, pedido nuevo
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, async () => {
      assert.equal(autorizado.pilot_authorized, 1);
      assert.equal(db.getOrderById(otro.id)!.pilot_authorized, 0, "el nuevo nace sin autorizar");
      assert.equal(safety.orderActionAllowed(db.getOrderById(otro.id)!), false);
      const antes = db.getPendingOutbox(900).filter((x) => x.phone === "34777000111").length;
      await runSchedulerTick();
      assert.equal(db.getOrderById(otro.id)!.status, "pending_send", "no se le envía nada");
      const despues = db.getPendingOutbox(900).filter((x) => x.phone === "34777000111").length;
      assert.equal(despues, antes, "ni un mensaje nuevo para el pedido sin autorizar");
      // Y su respuesta tampoco se procesa (no hay pedido elegible activo):
      assert.equal(handleOrderReply("34777000111", "1").handled, false);
    });
  });

  await test("AISLAMIENTO: autorizar un pedido NO autoriza a otros clientes", async () => {
    const ajeno = mkOrder("960005", "1705", "34777000222"); // otro cliente distinto
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, async () => {
      assert.equal(safety.orderActionAllowed(db.getOrderById(ajeno.id)!), false);
      await runSchedulerTick();
      assert.equal(db.getOrderById(ajeno.id)!.status, "pending_send");
      assert.equal(
        db.getPendingOutbox(900).some((x) => x.phone === "34777000222"),
        false
      );
    });
  });

  await test("la autorización NO salta el kill switch ni el APP_MODE", async () => {
    const o = db.getOrderByShopifyId("960003")!;
    assert.equal(o.pilot_authorized, 1);
    await withEnv({ EMERGENCY_STOP: "1" }, () => {
      assert.equal(safety.canSendRealWhatsApp(o.phone, { orderAuthorized: true }), false);
    });
    await withEnv({ APP_MODE: "safe" }, () => {
      assert.equal(safety.canSendRealWhatsApp(o.phone, { orderAuthorized: true }), false);
    });
    await withEnv({ WHATSAPP_SEND_ENABLED: "0" }, () => {
      assert.equal(safety.canSendRealWhatsApp(o.phone, { orderAuthorized: true }), false);
    });
  });

  await test("la autorización persiste y no se puede dar a pedidos terminales", async () => {
    const cancelado = mkOrder("960006", "1706", "34777000333");
    db.markOrderCancelled(cancelado.id);
    assert.equal(db.authorizeOrderForPilot(cancelado.id), false, "cancelado no se autoriza");
    assert.equal(db.getOrderById(cancelado.id)!.pilot_authorized, 0);

    // Persistencia real en disco:
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path.join(tmpDir, "messages.db"), { readonly: true });
    try {
      const row = raw
        .prepare("SELECT pilot_authorized FROM orders WHERE shopify_order_id='960003'")
        .get() as { pilot_authorized: number };
      assert.equal(row.pilot_authorized, 1, "sobrevive a un reinicio");
    } finally {
      raw.close();
    }
    // Y se puede retirar:
    const o = db.getOrderByShopifyId("960003")!;
    db.revokeOrderPilotAuthorization(o.id);
    assert.equal(db.getOrderById(o.id)!.pilot_authorized, 0);
    db.authorizeOrderForPilot(o.id); // restaurar para no afectar a otros tests
  });

  // ============ 20 · PROVEEDORES (Dropi/Dropea) — fase 2, simulación ============
  console.log("· Proveedores — routing, dirección y gates");

  const suppliers = await import("../src/lib/suppliers/service");
  const { validateSupplierAddress } = await import("../src/lib/suppliers/address");
  const { resolveSupplier } = await import("../src/lib/suppliers/router");
  const { ProviderNotConfiguredError } = await import("../src/lib/suppliers/types");
  const { dropiProvider } = await import("../src/lib/suppliers/dropi");
  const { dropeaProvider } = await import("../src/lib/suppliers/dropea");

  /** Crea un pedido ya ENVIADO (awaiting_reply), listo para responder. */
  const mkSent = (
    shopifyId: string,
    num: string,
    extra: Partial<{ city: string | null; postal_code: string | null; address_line1: string | null }> = {}
  ) => {
    const o = db.insertOrderIfNew({
      shopify_order_id: shopifyId,
      shopify_order_number: num,
      customer_name: "Cliente Proveedor",
      phone: "34600111222",
      email: null,
      product_summary: "1x Limpiador Ultrasónico Multiusos",
      total_price: "34.98",
      currency: "EUR",
      address_line1: "address_line1" in extra ? extra.address_line1! : "Calle Ejemplo 5B",
      address_line2: null,
      city: "city" in extra ? extra.city! : "Almería",
      province: "Almería",
      postal_code: "postal_code" in extra ? extra.postal_code! : "04007",
      country: "España",
      status: "pending_send",
      // Líneas reales (con SKU e IDs): es lo que usa el routing por mapping.
      raw_payload: JSON.stringify({
        line_items: [
          { title: "Limpiador Ultrasónico Multiusos", quantity: 1, price: "34.98", sku: "LIMP-001", product_id: 111, variant_id: 1111 },
          { title: "Seguro de Envío", quantity: 1, price: "1.99" },
        ],
      }),
    }).order;
    db.claimOrderInitialSend(o.id);
    return db.getOrderById(o.id)!;
  };

  /** Pedido ya enviado Y confirmado por el cliente. */
  const mkConfirmed = (
    shopifyId: string,
    num: string,
    extra: Partial<{ city: string | null; postal_code: string | null; address_line1: string | null }> = {}
  ) => {
    const o = mkSent(shopifyId, num, extra);
    db.markOrderConfirmed(o.id, true);
    return db.getOrderById(o.id)!;
  };

  await test("validateSupplierAddress: bloquea city '-', vacía y corta", () => {
    const ok = validateSupplierAddress({
      address_line1: "Calle Ejemplo 5B",
      city: "Almería",
      postal_code: "04007",
    });
    assert.equal(ok.valid, true);

    // El caso REAL de Casamable: Releasit manda city = "-"
    const guion = validateSupplierAddress({
      address_line1: "Calle Ejemplo 5B",
      city: "-",
      postal_code: "04007",
    });
    assert.equal(guion.valid, false);
    assert.ok(guion.issues.includes("invalid_city"));

    for (const c of ["", "   ", "AB", ".", "n/a"]) {
      const r = validateSupplierAddress({ address_line1: "Calle X 1", city: c, postal_code: "04007" });
      assert.equal(r.valid, false, `city "${c}" debe bloquear`);
      assert.ok(r.issues.includes("invalid_city"));
    }

    const sinCp = validateSupplierAddress({ address_line1: "Calle X 1", city: "Madrid", postal_code: "" });
    assert.ok(sinCp.issues.includes("missing_postal_code"));
    const sinCalle = validateSupplierAddress({ address_line1: "-", city: "Madrid", postal_code: "28001" });
    assert.ok(sinCalle.issues.includes("missing_address"));
  });

  await test("routing: sin mapping SIEMPRE unknown → manual_review (nunca adivina por título)", () => {
    const o = mkConfirmed("970001", "1801");
    const r = resolveSupplier(o);
    assert.equal(r.platform, "unknown");
    assert.equal(r.code, "unmapped_products");
    const ev = suppliers.evaluateOrderForSupplier(o);
    assert.equal(ev.status, "manual_review");
    assert.match(ev.reason, /sin correspondencia de proveedor/);
  });

  await test("routing por mapping: SKU mapeado a Dropi → dropi (la línea de servicio no cuenta)", () => {
    // Mapping de prueba: el limpiador va a Dropi PRO. Es el que usan el
    // resto de tests de proveedores de esta sección.
    db.upsertSupplierProductMapping({
      supplier_platform: "dropi",
      shopify_sku: "LIMP-001",
      shopify_title: "Limpiador Ultrasónico Multiusos",
      supplier_variant_id: "LIMP-001",
    });
    const o = db.getOrderByShopifyId("970001")!;
    const r = resolveSupplier(o);
    assert.equal(r.platform, "dropi");
    assert.equal(r.code, "mapped");
    assert.equal(r.lines.length, 1, "el seguro de envío no entra en el routing");
  });

  await test("pedido con city '-' → blocked_address, nunca ready", async () => {
    const o = mkConfirmed("970002", "1802", { city: "-" });
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const ev = suppliers.evaluateOrderForSupplier(o);
      assert.equal(ev.status, "blocked_address");
      assert.match(ev.reason, /localidad/);
      assert.equal(suppliers.canSyncSupplier(o, "dropi").allowed, false);
    });
  });

  await test("dirección válida + routing → ready, con el DTO completo", async () => {
    const o = mkConfirmed("970003", "1803");
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const ev = suppliers.evaluateOrderForSupplier(db.getOrderById(o.id)!);
      assert.equal(ev.status, "ready");
      assert.equal(ev.platform, "dropi");
      assert.ok(ev.input, "debe construir el DTO");
      assert.equal(ev.input!.shopifyOrderId, "970003", "la referencia es nuestro id de Shopify");
      assert.equal(ev.input!.finalAddress.city, "Almería");
      assert.equal(ev.input!.addressSource, "original");
      assert.equal(ev.input!.codAmount, "34.98");
      assert.equal(ev.input!.items[0].quantity, 1);
      assert.match(ev.input!.items[0].title, /Limpiador/);
    });
  });

  await test("delivery_note del cliente llega al DTO", async () => {
    // Ruta real del cliente: recibe el mensaje → "3" → escribe la nota → "1"
    const o = mkSent("970004", "1804");
    assert.equal(db.markOrderAwaitingDeliveryNote(o.id), true);
    assert.equal(db.saveOrderDeliveryNote(o.id, "Llamar antes de subir"), true);
    db.markOrderConfirmed(o.id, true);
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const ev = suppliers.evaluateOrderForSupplier(db.getOrderById(o.id)!);
      assert.equal(ev.input?.deliveryNote, "Llamar antes de subir");
    });
  });

  await test("dirección propuesta SIN aprobar → manual_review (no se envía sola)", async () => {
    // Ruta real: el cliente respondió "2", mandó su dirección y luego confirmó.
    const o = mkSent("970005", "1805");
    assert.equal(db.markOrderNeedsCorrection(o.id), true);
    assert.equal(db.appendOrderProposedAddress(o.id, "Calle Nueva 7, 2B, 28004 Madrid"), true);
    db.markOrderConfirmed(o.id, true);
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const ev = suppliers.evaluateOrderForSupplier(db.getOrderById(o.id)!);
      assert.equal(ev.status, "manual_review");
      assert.match(ev.reason, /nadie ha decidido/);
      assert.equal(ev.input, null, "no se construye DTO con una dirección sin decidir");
    });
  });

  await test("propuesta aprobada → sigue exigiendo revisión (texto libre)", async () => {
    const o = db.getOrderByShopifyId("970005")!;
    assert.equal(db.setOrderFinalAddressSource(o.id, "proposed"), true);
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const ev = suppliers.evaluateOrderForSupplier(db.getOrderById(o.id)!);
      assert.equal(ev.status, "manual_review");
      assert.match(ev.reason, /texto libre/);
    });
    // Y si se decide usar la original, vuelve a ser enviable:
    db.setOrderFinalAddressSource(o.id, "original");
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      assert.equal(suppliers.evaluateOrderForSupplier(db.getOrderById(o.id)!).status, "ready");
    });
  });

  await test("pedido NO confirmado nunca sale (not_ready)", () => {
    const o = mkOrder("970006", "1806", "34600111222"); // pending_send
    const ev = suppliers.evaluateOrderForSupplier(o);
    assert.equal(ev.status, "not_ready");
    assert.equal(suppliers.canSyncSupplier(o, "dropi").allowed, false);
  });

  console.log("· Proveedores — safety gates e idempotencia");

  await test("gate cerrado por defecto: nada sale sin abrir varias llaves", async () => {
    const o = db.getOrderByShopifyId("970003")!;
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      // Con todo por defecto, el primer freno es el candado de la
      // integración antigua (el más peligroso: duplicaría envíos).
      const g = suppliers.canSyncSupplier(o, "dropi");
      assert.equal(g.allowed, false);
      assert.match(g.reason ?? "", /LEGACY_SUPPLIER_INTEGRATIONS_DISABLED/);
    });
    // Y quitando ese, sigue frenando el interruptor maestro.
    await withEnv(
      { SUPPLIER_ROUTING_RULES: "dropi:limpiador", LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1" },
      () => {
        const g = suppliers.canSyncSupplier(o, "dropi");
        assert.equal(g.allowed, false);
        assert.match(g.reason ?? "", /SUPPLIER_SYNC_ENABLED/);
      }
    );
  });

  await test("matriz de llaves del proveedor: cualquiera cerrada = NO SYNC", async () => {
    const o = db.getOrderByShopifyId("970003")!;
    const base = {
      SUPPLIER_ROUTING_RULES: "dropi:limpiador",
      SUPPLIER_SYNC_ENABLED: "1",
      SUPPLIER_TEST_MODE: "0",
      DROPIPRO_WRITE_ENABLED: "1",
      SUPPLIER_PILOT_MODE: "0", // el piloto se prueba aparte
      LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1", // el candado se prueba aparte
    };
    // Todas abiertas… pero el provider NO está implementado:
    await withEnv(base, () => {
      const g = suppliers.canSyncSupplier(o, "dropi");
      assert.equal(g.allowed, false);
      assert.match(g.reason ?? "", /no está configurado/);
    });
    // Test mode activo → solo simulación
    await withEnv({ ...base, SUPPLIER_TEST_MODE: "1" }, () => {
      assert.match(suppliers.canSyncSupplier(o, "dropi").reason ?? "", /SUPPLIER_TEST_MODE/);
    });
    // Llave de plataforma cerrada
    await withEnv({ ...base, DROPIPRO_WRITE_ENABLED: "0" }, () => {
      assert.match(suppliers.canSyncSupplier(o, "dropi").reason ?? "", /escritura no habilitada/);
    });
    // Kill switch global
    await withEnv({ ...base, EMERGENCY_STOP: "1" }, () => {
      assert.match(suppliers.canSyncSupplier(o, "dropi").reason ?? "", /EMERGENCY_STOP/);
    });
  });

  await test("idempotencia: con external_order_id no se recrea jamás", async () => {
    const o = mkConfirmed("970007", "1807");
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw
      .prepare("UPDATE orders SET supplier_external_order_id = 'DROPI-XYZ' WHERE shopify_order_id = '970007'")
      .run();
    raw.close();
    const fresco = db.getOrderById(o.id)!;
    await withEnv(
      {
        SUPPLIER_ROUTING_RULES: "dropi:limpiador",
        SUPPLIER_SYNC_ENABLED: "1",
        SUPPLIER_TEST_MODE: "0",
        DROPIPRO_WRITE_ENABLED: "1",
        LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1",
      },
      () => {
        const ev = suppliers.evaluateOrderForSupplier(fresco);
        assert.equal(ev.status, "synced");
        assert.match(ev.reason, /no se recrea/);
        const g = suppliers.canSyncSupplier(fresco, "dropi");
        assert.equal(g.allowed, false);
        assert.match(g.reason ?? "", /idempotencia/);
      }
    );
  });

  await test("providers stub: createOrder LANZA, no finge éxito ni toca la red", async () => {
    const realFetch = global.fetch;
    let llamadas = 0;
    global.fetch = (async () => {
      llamadas++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const input = {
        shopifyOrderId: "1",
        orderNumber: "1",
        customerName: "X",
        phone: "34600111222",
        email: null,
        finalAddress: {
          line1: "Calle X 1",
          line2: null,
          city: "Madrid",
          province: null,
          postalCode: "28001",
          country: "España",
        },
        addressSource: "original" as const,
        items: [{ title: "P", quantity: 1, price: null, sku: null }],
        total: "10",
        currency: "EUR",
        codAmount: "10",
        deliveryNote: null,
      };
      for (const p of [dropiProvider, dropeaProvider]) {
        assert.equal(p.isConfigured(), false, `${p.platform} no debe declararse configurado`);
        await assert.rejects(() => p.createOrder(input), ProviderNotConfiguredError);
        await assert.rejects(() => p.cancelOrder("x"), ProviderNotConfiguredError);
        await assert.rejects(() => p.getStatus("x"), ProviderNotConfiguredError);
        // La simulación sí funciona, y es evidente que es simulada:
        const sim = p.simulateCreateOrder(input);
        assert.equal(sim.simulated, true);
        assert.match(sim.externalOrderId, /^SIMULATED-/);
      }
      assert.equal(llamadas, 0, "ningún provider hizo una sola petición de red");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("el scheduler evalúa proveedores SIN ningún efecto externo", async () => {
    const realFetch = global.fetch;
    let llamadas = 0;
    global.fetch = (async () => {
      llamadas++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const o = mkConfirmed("970008", "1808", { city: "-" });
      await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, async () => {
        await runSchedulerTick();
      });
      const row = db.getOrderById(o.id)!;
      assert.equal(row.supplier_sync_status, "blocked_address", "queda anotado en la DB");
      assert.equal(row.supplier_platform, "dropi");
      assert.match(row.supplier_last_error ?? "", /localidad/);
      assert.equal(row.supplier_reference, "970008", "guarda la referencia estable");
      assert.equal(row.supplier_external_order_id, null, "no inventa un id");
      assert.equal(llamadas, 0, "el tick no hizo ninguna llamada de red a proveedores");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("simulateSupplierSync no toca la DB ni la red", async () => {
    const o = db.getOrderByShopifyId("970003")!;
    const antes = JSON.stringify(db.getOrderById(o.id));
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const r = suppliers.simulateSupplierSync(db.getOrderById(o.id)!);
      assert.equal(r.evaluation.status, "ready");
      assert.equal(r.simulated?.simulated, true);
      assert.match(r.simulated?.externalOrderId ?? "", /^SIMULATED-DROPI-/);
      assert.equal(r.gate.allowed, false, "simular NUNCA implica permiso de envío");
    });
    assert.equal(JSON.stringify(db.getOrderById(o.id)), antes, "el pedido no se modificó");
  });

  // ============ 21 · TRACKING Y AVISOS DE POSTVENTA ============
  console.log("· Tracking — normalización y transiciones");

  const tracking = await import("../src/lib/tracking/service");
  const { normalizeSupplierStatus } = await import("../src/lib/tracking/normalizer");
  const { isTerminalTracking } = await import("../src/lib/tracking/types");
  const supplierWebhook = await import("../src/lib/suppliers/dropea/webhook");
  const { runTrackingPollTick } = await import("../src/lib/tracking/scheduler");

  /** Pedido confirmado Y ya sincronizado con un proveedor ficticio. */
  const mkSynced = (shopifyId: string, num: string, phone = "34600111222") => {
    const o = mkConfirmed(shopifyId, num);
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw
      .prepare(
        `UPDATE orders SET supplier_platform='dropea', supplier_sync_status='synced',
         supplier_external_order_id=?, phone=? WHERE id=?`
      )
      .run(String(shopifyId), phone, o.id);
    raw.close();
    return db.getOrderById(o.id)!;
  };

  await test("normalizeSupplierStatus: traduce lo conocido, jamás adivina", () => {
    assert.equal(normalizeSupplierStatus("ENTREGADO"), "delivered");
    assert.equal(normalizeSupplierStatus("En reparto"), "out_for_delivery");
    assert.equal(normalizeSupplierStatus("in_transit"), "in_transit");
    assert.equal(normalizeSupplierStatus("En tránsito"), "in_transit");
    assert.equal(normalizeSupplierStatus("devuelto"), "returned");
    // Vocabulario propio del proveedor que aún no conocemos → unknown
    assert.equal(normalizeSupplierStatus("GUIA_GENERADA_BODEGA"), "unknown");
    assert.equal(normalizeSupplierStatus(null), "unknown");
  });

  await test("SUPPLIER_STATUS_MAP permite añadir estados sin tocar código", async () => {
    await withEnv({ SUPPLIER_STATUS_MAP: "GUIA_GENERADA:shipped,EN_BODEGA:processing" }, () => {
      assert.equal(normalizeSupplierStatus("GUIA_GENERADA"), "shipped");
      assert.equal(normalizeSupplierStatus("en bodega"), "processing");
    });
  });

  await test("terminales identificados correctamente", () => {
    for (const s of ["delivered", "returned", "cancelled"]) assert.equal(isTerminalTracking(s), true);
    for (const s of ["in_transit", "out_for_delivery", "incident"]) assert.equal(isTerminalTracking(s), false);
  });

  await test("aparece tracking → UN aviso; repetir el update → NINGUNO más", () => {
    const o = mkSynced("980001", "1901");
    const antes = db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;

    const r1 = tracking.processSupplierUpdate(o, {
      rawStatus: "shipped",
      trackingNumber: "TRK123",
      trackingUrl: "https://track.example/TRK123",
      carrier: "SEUR",
    });
    assert.ok(r1.events.includes("TRACKING_AVAILABLE"));
    assert.ok(r1.notified.includes("TRACKING_AVAILABLE"));
    const tras1 = db.getPendingOutbox(999).filter((x) => x.phone === o.phone);
    assert.equal(tras1.length, antes + 1, "exactamente un mensaje");
    assert.match(tras1[tras1.length - 1].content, /ya está en camino/);
    assert.match(tras1[tras1.length - 1].content, /TRK123/);

    // Mismo update otra vez (webhook duplicado): ni un mensaje más.
    const r2 = tracking.processSupplierUpdate(db.getOrderById(o.id)!, {
      rawStatus: "shipped",
      trackingNumber: "TRK123",
    });
    assert.equal(r2.events.length, 0, "sin cambios = sin eventos");
    assert.equal(
      db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length,
      antes + 1,
      "no se reenvía"
    );
    const row = db.getOrderById(o.id)!;
    assert.equal(row.tracking_number, "TRK123");
    assert.equal(row.carrier, "SEUR");
    assert.ok(row.tracking_first_seen_at, "queda registrado cuándo apareció");
    assert.ok(row.tracking_notification_sent_at, "queda el sello del aviso");
  });

  await test("out_for_delivery → UN aviso con el importe; repetido → ninguno", () => {
    const o = db.getOrderByShopifyId("980001")!;
    const antes = db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;

    const r1 = tracking.processSupplierUpdate(o, { rawStatus: "En reparto" });
    assert.ok(r1.notified.includes("OUT_FOR_DELIVERY"));
    const msgs2 = db.getPendingOutbox(999).filter((x) => x.phone === o.phone);
    assert.equal(msgs2.length, antes + 1);
    const texto = msgs2[msgs2.length - 1].content;
    assert.match(texto, /está en reparto/);
    assert.match(texto, /en efectivo/);
    assert.match(texto, /34,98/, "recuerda el importe en formato español");

    // Otro webhook con el mismo estado: nada.
    const r2 = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "out_for_delivery" });
    assert.equal(r2.notified.length, 0);
    assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length, antes + 1);
  });

  await test("delivered con el aviso DESACTIVADO → no manda nada", () => {
    const o = db.getOrderByShopifyId("980001")!;
    const antes = db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    const r = tracking.processSupplierUpdate(o, { rawStatus: "ENTREGADO" });
    assert.ok(r.events.includes("DELIVERED"));
    assert.equal(r.notified.length, 0, "DELIVERED_WHATSAPP_ENABLED=0 por defecto");
    assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length, antes);
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "delivered");
  });

  await test("delivered ACTIVADO → un solo aviso", async () => {
    const o = mkSynced("980002", "1902", "34600111333");
    tracking.processSupplierUpdate(o, { rawStatus: "in_transit", trackingNumber: "TRK9" });
    await withEnv({ DELIVERED_WHATSAPP_ENABLED: "1" }, () => {
      const antes = db.getPendingOutbox(999).filter((x) => x.phone === "34600111333").length;
      const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "delivered" });
      assert.ok(r.notified.includes("DELIVERED"));
      const despues = db.getPendingOutbox(999).filter((x) => x.phone === "34600111333");
      assert.equal(despues.length, antes + 1);
      assert.match(despues[despues.length - 1].content, /entregado/);
      // Repetir no reenvía
      tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "delivered" });
      assert.equal(
        db.getPendingOutbox(999).filter((x) => x.phone === "34600111333").length,
        antes + 1
      );
    });
  });

  await test("incidencia: NO escribe al cliente y manda el pedido a revisión", () => {
    const o = mkSynced("980003", "1903", "34600111444");
    const antes = db.getPendingOutbox(999).filter((x) => x.phone === "34600111444").length;
    const r = tracking.processSupplierUpdate(o, { rawStatus: "incidencia" });
    assert.ok(r.events.includes("INCIDENT"));
    assert.equal(r.notified.length, 0, "ningún mensaje automático ante incidencias");
    assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === "34600111444").length, antes);
    const row = db.getOrderById(o.id)!;
    assert.equal(row.supplier_sync_status, "manual_review", "visible en el panel");
    assert.equal(row.status, "confirmed", "la confirmación del cliente no se altera");
  });

  await test("update atrasado no hace retroceder el estado", () => {
    const o = mkSynced("980004", "1904", "34600111555");
    tracking.processSupplierUpdate(o, { rawStatus: "out_for_delivery" });
    // Llega tarde un "in_transit" (webhooks desordenados)
    const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "in_transit" });
    assert.equal(r.newStatus, "out_for_delivery", "no retrocede");
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "out_for_delivery");
  });

  await test("estado desconocido no pisa lo que ya sabíamos", () => {
    const o = mkSynced("980005", "1905", "34600111666");
    tracking.processSupplierUpdate(o, { rawStatus: "in_transit" });
    const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "PALABRA_RARA" });
    assert.equal(r.newStatus, "in_transit");
  });

  console.log("· Tracking — webhooks de proveedor y polling");

  /** Firma como la calcula Dropea: sha256=<base64 de HMAC-SHA256(raw_body)>. */
  const firmaDropea = (body: string, secret = "secreto-de-prueba") =>
    "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

  /** Envoltorio v2 de Dropea con un pedido dentro. */
  const sobreDropea = (resourceId: number, order: Record<string, unknown>, topic = "order.status.changed") =>
    JSON.stringify({
      topic,
      market: "ES",
      event_id: `evt-${resourceId}-${topic}`,
      event_at: "2026-08-22T10:00:00.000Z",
      resource_id: resourceId,
      resource: order,
    });

  await test("webhook sin secreto configurado → 503 (fail closed)", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: undefined }, () => {
      const r = supplierWebhook.processDropeaWebhook("{}", {});
      assert.equal(r.status, 503);
    });
  });

  await test("firma inválida → 401 y sin efectos", async () => {
    const o = mkSynced("980006", "1906", "34600111777");
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(980006, { id: 980006, status: "SHIPPING", sub_status: "OUT_FOR_DELIVERY" });
      // Firma con otro secreto
      const r = supplierWebhook.processDropeaWebhook(body, {
        "x-dropea-signature": firmaDropea(body, "otro-secreto"),
      });
      assert.equal(r.status, 401);
      assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "unknown", "no se tocó");
      assert.equal(db.getPendingOutbox(999).some((x) => x.phone === "34600111777"), false);
    });
  });

  await test("firma sin el prefijo sha256= o en hex → 401 (solo su formato)", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(980006, { id: 980006, status: "SHIPPING" });
      const base64Pelado = crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("base64");
      const hex = crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("hex");
      assert.equal(supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": base64Pelado }).status, 401);
      assert.equal(supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": `sha256=${hex}` }).status, 401);
    });
  });

  await test("firma VÁLIDA (X-Dropea-Signature, base64) → procesa y es idempotente", async () => {
    const o = db.getOrderByShopifyId("980006")!;
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600111777").length;
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(980006, {
        id: 980006,
        status: "SHIPPING",
        sub_status: "OUT_FOR_DELIVERY",
        tracking_number: "TRKW1",
        tracking_url: "https://track.example/TRKW1",
        carrier: "GLS",
      });
      const firma = firmaDropea(body);

      const antes = contar();
      const r1 = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firma });
      assert.equal(r1.status, 200);
      assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "out_for_delivery");
      assert.ok(contar() > antes, "avisó al cliente");
      const tras1 = contar();

      // Reintento idéntico de Dropea
      const r2 = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firma });
      assert.equal(r2.status, 200);
      assert.equal(contar(), tras1, "ni un mensaje duplicado");
    });
  });

  await test("topic desconocido → 200 sin efectos", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(980006, { id: 980006, status: "SHIPPING" }, "order.something.new");
      const r = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firmaDropea(body) });
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, "topic desconocido");
    });
  });

  await test("envoltorio inválido → 400", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = JSON.stringify({ topic: "order.created" }); // sin resource_id
      const r = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firmaDropea(body) });
      assert.equal(r.status, 400);
      const roto = "{no-json";
      assert.equal(
        supplierWebhook.processDropeaWebhook(roto, { "x-dropea-signature": firmaDropea(roto) }).status,
        400
      );
    });
  });

  await test("incidencia (issue.*) → revisión manual, SIN mensaje al cliente", async () => {
    const o = mkSynced("980010", "1910", "34600111999");
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600111999").length;
    const antes = contar();
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(
        5,
        { id: 5, order_id: 980010, status: "PENDING", is_active: true, tracking_number: "X" },
        "issue.created"
      );
      const r = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firmaDropea(body) });
      assert.equal(r.status, 200);
      assert.equal(r.body.requiereAccion, true);
      assert.equal(db.getOrderById(o.id)!.supplier_sync_status, "manual_review");
      assert.equal(contar(), antes, "las incidencias no escriben al cliente");
    });
  });

  await test("emparejado por external_order_id (nuestra referencia)", async () => {
    const o = mkConfirmed("980011", "1911");
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(444555, {
        id: 444555,
        status: "PROCESSING",
        sub_status: "PICKING",
        external_order_id: "980011",
      });
      const r = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firmaDropea(body) });
      assert.equal(r.status, 200);
      assert.equal(r.body.order, "1911");
      const fresco = db.getOrderById(o.id)!;
      assert.equal(fresco.supplier_external_order_id, "444555", "adopta el id de Dropea");
      assert.equal(fresco.supplier_status_normalized, "processing");
    });
  });

  await test("webhook de un pedido desconocido → 200 sin efectos", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(99887766, { id: 99887766, status: "FINISH", sub_status: "DELIVERED" });
      const r = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firmaDropea(body) });
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, "pedido desconocido");
    });
  });

  await test("polling: bloqueado por gates y sin tocar la red", async () => {
    const realFetch = global.fetch;
    let llamadas = 0;
    global.fetch = (async () => {
      llamadas++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const r = await runTrackingPollTick();
      assert.equal(r.blocked, "SUPPLIER_SYNC_ENABLED=0");
      assert.equal(r.checked, 0);
      // Con sync habilitado sigue sin haber provider implementado:
      await withEnv({ SUPPLIER_SYNC_ENABLED: "1" }, async () => {
        const r2 = await runTrackingPollTick();
        assert.equal(r2.blocked, null);
        assert.equal(r2.checked, 0, "ningún provider configurado: no consulta");
      });
      assert.equal(llamadas, 0, "el polling no hizo ninguna petición");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("polling NO consulta pedidos ya entregados/devueltos", () => {
    const entregados = db
      .getOrdersForTrackingPolling(Math.floor(Date.now() / 1000) + 999)
      .filter((o) => ["delivered", "returned", "cancelled"].includes(o.supplier_status_normalized));
    assert.equal(entregados.length, 0, "los terminales quedan fuera de la cola");
  });

  await test("piloto de proveedores: hace falta aprobar el pedido UNO A UNO", async () => {
    const o = mkConfirmed("980008", "1908");
    await withEnv(
      {
        SUPPLIER_ROUTING_RULES: "dropi:limpiador",
        SUPPLIER_SYNC_ENABLED: "1",
        SUPPLIER_TEST_MODE: "0",
        DROPIPRO_WRITE_ENABLED: "1",
        SUPPLIER_PILOT_MODE: "1",
        LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1",
      },
      () => {
        const g1 = suppliers.canSyncSupplier(db.getOrderById(o.id)!, "dropi");
        assert.equal(g1.allowed, false);
        assert.match(g1.reason ?? "", /no está aprobado/);

        assert.equal(db.setOrderSupplierPilotApproval(o.id, true), true);
        const g2 = suppliers.canSyncSupplier(db.getOrderById(o.id)!, "dropi");
        // Aprobado, pero el provider sigue sin implementación real:
        assert.equal(g2.allowed, false);
        assert.match(g2.reason ?? "", /no está configurado/);
      }
    );
  });

  await test("los avisos de tracking pasan por el outbox y respetan los gates", async () => {
    const o = mkSynced("980009", "1909", "34799000111"); // fuera de allowlist
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, () => {
      const r = tracking.processSupplierUpdate(o, {
        rawStatus: "shipped",
        trackingNumber: "TRK-BLOCK",
      });
      assert.ok(r.events.includes("TRACKING_AVAILABLE"));
      assert.equal(r.notified.length, 0, "el gate bloquea el envío a un no autorizado");
      assert.equal(
        db.getPendingOutbox(999).some((x) => x.phone === "34799000111"),
        false,
        "nada en el outbox"
      );
    });
  });

  // ============ 22 · DROPI: webhook de actualizaciones ============
  console.log("· Dropi — webhook de actualizaciones (estructura confirmada)");

  const dropiWebhook = await import("../src/lib/suppliers/dropi/webhook");
  const { validateDropiPayload } = await import("../src/lib/suppliers/dropi/types");
  const { normalizeDropiStatus } = await import("../src/lib/suppliers/dropi/status-map");

  /** Payload con la estructura EXACTA que muestra el panel de Dropi. */
  const dropiPayload = (over: Record<string, unknown> = {}) => ({
    order_id: 555001,
    event_date: "2026-08-22T10:15:00Z",
    status_id: 4,
    status_name: "EN REPARTO",
    details: "Actualización de prueba",
    tracking_code: "DRP-TRK-001",
    tracking_url: "https://tracking.example/DRP-TRK-001",
    shopify_order_id: null,
    shipping_company: "Transportista Test",
    total: "34.98",
    ...over,
  });

  await test("webhook Dropi DESHABILITADO → 503 y sin efectos", () => {
    const r = dropiWebhook.processDropiWebhook(JSON.stringify(dropiPayload()));
    assert.equal(r.status, 503, "fail-closed mientras no sepamos cómo autentica Dropi");
  });

  await test("validación del payload: acepta el válido, rechaza lo que no encaja", () => {
    assert.equal(validateDropiPayload(dropiPayload()).ok, true);

    const casos: Array<[string, Record<string, unknown>]> = [
      ["order_id no numérico", { order_id: "abc" }],
      ["order_id cero", { order_id: 0 }],
      ["fecha inválida", { event_date: "no-es-una-fecha" }],
      ["status_id inválido", { status_id: "x" }],
      ["status_name vacío", { status_name: "   " }],
      ["tracking_url con tipo raro", { tracking_url: 123 }],
      ["shopify_order_id no entero", { shopify_order_id: "abc" }],
      ["total no numérico", { total: "muchos euros" }],
    ];
    for (const [desc, over] of casos) {
      assert.equal(validateDropiPayload(dropiPayload(over)).ok, false, desc);
    }
    // No-objetos
    assert.equal(validateDropiPayload("texto").ok, false);
    assert.equal(validateDropiPayload([1, 2]).ok, false);
    assert.equal(validateDropiPayload(null).ok, false);
  });

  await test("nulos permitidos: tracking_url y shopify_order_id", () => {
    const v = validateDropiPayload(dropiPayload({ tracking_url: null, shopify_order_id: null }));
    assert.equal(v.ok, true);
    assert.equal(v.payload!.tracking_url, null);
    assert.equal(v.payload!.shopify_order_id, null);
    // tracking_code vacío también es válido (pedido aún sin guía)
    assert.equal(validateDropiPayload(dropiPayload({ tracking_code: "" })).ok, true);
  });

  await test("payload inválido → 400 y sin efectos", async () => {
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const r1 = dropiWebhook.processDropiWebhook("{no es json");
      assert.equal(r1.status, 400);
      const r2 = dropiWebhook.processDropiWebhook(JSON.stringify(dropiPayload({ order_id: "x" })));
      assert.equal(r2.status, 400);
      assert.ok(Array.isArray(r2.body.issues));
    });
  });

  await test("estados de Dropi SIN confirmar → unknown (no se adivina)", () => {
    assert.equal(normalizeDropiStatus(4, "EN REPARTO"), "unknown");
    assert.equal(normalizeDropiStatus(99, "ENTREGADO"), "unknown");
  });

  await test("DROPI_STATUS_MAP permite confirmar estados por id o por nombre", async () => {
    await withEnv({ DROPI_STATUS_MAP: "4:out_for_delivery,ENTREGADO:delivered" }, () => {
      assert.equal(normalizeDropiStatus(4, "EN REPARTO"), "out_for_delivery");
      assert.equal(normalizeDropiStatus(88, "ENTREGADO"), "delivered");
      assert.equal(normalizeDropiStatus(77, "OTRA COSA"), "unknown");
    });
  });

  await test("emparejado por shopify_order_id (vía preferente) y adopción del id externo", async () => {
    const o = mkConfirmed("990001", "2001");
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const r = dropiWebhook.processDropiWebhook(
        JSON.stringify(dropiPayload({ order_id: 777001, shopify_order_id: 990001 }))
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.order, "2001");
      const fresco = db.getOrderById(o.id)!;
      assert.equal(fresco.supplier_platform, "dropi");
      assert.equal(fresco.supplier_external_order_id, "777001", "adopta el id de Dropi");
      assert.equal(fresco.tracking_number, "DRP-TRK-001");
      assert.equal(fresco.carrier, "Transportista Test");
      assert.equal(fresco.supplier_status_raw, "EN REPARTO", "guarda el estado tal cual");
      assert.equal(fresco.supplier_status_normalized, "unknown", "pero sin interpretarlo");
    });
  });

  await test("emparejado alternativo por order_id cuando no viene shopify_order_id", async () => {
    const o = db.getOrderByShopifyId("990001")!;
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const r = dropiWebhook.processDropiWebhook(
        JSON.stringify(
          dropiPayload({ order_id: 777001, shopify_order_id: null, tracking_code: "DRP-TRK-001" })
        )
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.order, o.shopify_order_number);
    });
  });

  await test("tracking nuevo → UN aviso; el mismo webhook repetido → ninguno", async () => {
    const o = mkConfirmed("990002", "2002");
    const tel = o.phone;
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === tel).length;
    const antes = contar();
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const body = JSON.stringify(
        dropiPayload({ order_id: 777002, shopify_order_id: 990002, tracking_code: "DRP-XYZ" })
      );
      const r1 = dropiWebhook.processDropiWebhook(body);
      assert.deepEqual(r1.body.events, ["TRACKING_AVAILABLE"]);
      assert.equal(contar(), antes + 1, "exactamente un aviso");

      const r2 = dropiWebhook.processDropiWebhook(body); // reintento idéntico
      assert.deepEqual(r2.body.events, [], "sin cambios = sin eventos");
      assert.equal(contar(), antes + 1, "ni un duplicado");
    });
  });

  await test("sin tracking_code no se avisa de nada", async () => {
    const o = mkConfirmed("990003", "2003");
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    const antes = contar();
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const r = dropiWebhook.processDropiWebhook(
        JSON.stringify(
          dropiPayload({ order_id: 777003, shopify_order_id: 990003, tracking_code: "", tracking_url: null })
        )
      );
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.events, []);
      assert.equal(contar(), antes);
    });
  });

  await test("estado desconocido NUNCA dispara el aviso de reparto", async () => {
    const o = mkConfirmed("990004", "2004");
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    const antes = contar();
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1", DROPI_STATUS_MAP: "" }, () => {
      const r = dropiWebhook.processDropiWebhook(
        JSON.stringify(
          dropiPayload({ order_id: 777004, shopify_order_id: 990004, tracking_code: "" , status_name: "EN REPARTO" })
        )
      );
      assert.deepEqual(r.body.events, [], "un estado sin confirmar no genera eventos");
      assert.equal(db.getOrderById(o.id)!.out_for_delivery_notification_sent_at, null);
      assert.equal(contar(), antes, "ni un mensaje nuevo con un estado sin confirmar");
    });
  });

  await test("con el estado CONFIRMADO sí avisa del reparto, una sola vez", async () => {
    const o = mkConfirmed("990005", "2005");
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    const antes = contar();
    await withEnv(
      { DROPIPRO_WEBHOOK_ENABLED: "1", DROPI_STATUS_MAP: "4:out_for_delivery" },
      () => {
        const body = JSON.stringify(
          dropiPayload({ order_id: 777005, shopify_order_id: 990005, tracking_code: "" })
        );
        const r1 = dropiWebhook.processDropiWebhook(body);
        assert.ok((r1.body.events as string[]).includes("OUT_FOR_DELIVERY"));
        const msgs = db.getPendingOutbox(999).filter((x) => x.phone === o.phone);
        assert.equal(msgs.length, antes + 1);
        assert.match(msgs[msgs.length - 1].content, /en reparto/);
        assert.match(msgs[msgs.length - 1].content, /efectivo/);

        dropiWebhook.processDropiWebhook(body); // repetido
        assert.equal(contar(), antes + 1, "sin duplicados");
      }
    );
  });

  await test("pedido desconocido → 200 sin efectos", async () => {
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const r = dropiWebhook.processDropiWebhook(
        JSON.stringify(dropiPayload({ order_id: 999999999, shopify_order_id: 888888888 }))
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, "pedido desconocido");
    });
  });

  await test("no pisa datos válidos con cadenas vacías", async () => {
    const o = db.getOrderByShopifyId("990002")!; // ya tiene tracking DRP-XYZ y carrier
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      dropiWebhook.processDropiWebhook(
        JSON.stringify(
          dropiPayload({
            order_id: 777002,
            shopify_order_id: 990002,
            tracking_code: "",
            tracking_url: null,
            shipping_company: "",
          })
        )
      );
      const fresco = db.getOrderById(o.id)!;
      assert.equal(fresco.tracking_number, "DRP-XYZ", "el tracking anterior se conserva");
      assert.ok(fresco.carrier, "el transportista anterior se conserva");
    });
  });

  await test("CANDADO doble integración: bloquea la creación aunque todo esté abierto", async () => {
    const o = mkConfirmed("990010", "2010");
    db.setOrderSupplierPilotApproval(o.id, true);
    const todoAbierto = {
      SUPPLIER_ROUTING_RULES: "dropi:limpiador",
      SUPPLIER_SYNC_ENABLED: "1",
      SUPPLIER_TEST_MODE: "0",
      DROPIPRO_WRITE_ENABLED: "1",
      SUPPLIER_PILOT_MODE: "0",
    };
    // Con el candado cerrado (por defecto), NO se puede crear:
    await withEnv({ ...todoAbierto, LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "0" }, () => {
      const g = suppliers.canSyncSupplier(db.getOrderById(o.id)!, "dropi");
      assert.equal(g.allowed, false);
      assert.match(g.reason ?? "", /LEGACY_SUPPLIER_INTEGRATIONS_DISABLED/);
      assert.match(g.reason ?? "", /duplicar/i);
    });
    // Sin la variable puesta se asume lo peor (integración antigua viva):
    await withEnv({ ...todoAbierto, LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: undefined }, () => {
      assert.equal(suppliers.canSyncSupplier(db.getOrderById(o.id)!, "dropi").allowed, false);
    });
    // Abriéndolo, el bloqueo pasa a ser el siguiente de la cadena:
    await withEnv({ ...todoAbierto, LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1" }, () => {
      const g = suppliers.canSyncSupplier(db.getOrderById(o.id)!, "dropi");
      assert.equal(g.allowed, false);
      assert.match(g.reason ?? "", /no está configurado/, "ahora frena el provider sin implementar");
    });
  });

  await test("Dropi createOrder SIGUE bloqueado (esto solo confirmó el tracking)", async () => {
    const { dropiProvider } = await import("../src/lib/suppliers/dropi");
    assert.equal(dropiProvider.isConfigured(), false);
    await assert.rejects(
      () =>
        dropiProvider.createOrder({
          shopifyOrderId: "1",
          orderNumber: "1",
          customerName: "X",
          phone: "34600111222",
          email: null,
          finalAddress: {
            line1: "Calle X 1",
            line2: null,
            city: "Madrid",
            province: null,
            postalCode: "28001",
            country: "España",
          },
          addressSource: "original",
          items: [{ title: "P", quantity: 1, price: null, sku: null }],
          total: "10",
          currency: "EUR",
          codAmount: "10",
          deliveryNote: null,
        }),
      ProviderNotConfiguredError
    );
  });

  // ============ 23 · DROPEA: contrato oficial ============
  console.log("· Dropea — contrato oficial (URL, auth, mapper, estados)");

  const dropeaClient = await import("../src/lib/suppliers/dropea/client");
  const dropeaMod = await import("../src/lib/suppliers/dropea");
  const { normalizeDropeaStatus, DROPEA_SUB_STATUSES, DROPEA_STATUSES } = await import(
    "../src/lib/suppliers/dropea/status-map"
  );
  const { mapToDropeaCreateOrder, splitName, toInternationalPhone } = await import(
    "../src/lib/suppliers/dropea/mapper"
  );

  await test("URL base: se deriva del mercado (host por país)", async () => {
    await withEnv({ DROPEA_API_KEY: "k", DROPEA_API_BASE_URL: undefined, DROPEA_MARKET: "es" }, () => {
      assert.equal(dropeaClient.dropeaConfig()?.baseUrl, "https://es.public-api.dropea.com");
    });
    await withEnv({ DROPEA_API_KEY: "k", DROPEA_API_BASE_URL: undefined, DROPEA_MARKET: "pt" }, () => {
      assert.equal(dropeaClient.dropeaConfig()?.baseUrl, "https://pt.public-api.dropea.com");
    });
    await withEnv({ DROPEA_API_KEY: undefined }, () => {
      assert.equal(dropeaClient.dropeaConfig(), null, "sin API key no hay configuración");
    });
  });

  await test("auth: Authorization Bearer + Idempotency-Key, y la key no se filtra", async () => {
    const realFetch = global.fetch;
    let capturado: { url: string; headers: Record<string, string> } | null = null;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturado = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response(JSON.stringify({ success: true, data: { id: 1 } }), { status: 200 });
    }) as typeof fetch;
    try {
      await withEnv(
        { DROPEA_API_KEY: "clave-secreta-de-prueba", DROPEA_API_ENABLED: "1", DROPEA_MARKET: "es" },
        async () => {
          await dropeaClient.dropeaRequest({
            path: "/dropshipper/orders",
            method: "POST",
            body: { x: 1 },
            idempotencyKey: "1057",
          });
          assert.equal(capturado!.url, "https://es.public-api.dropea.com/dropshipper/orders");
          assert.equal(capturado!.headers["Authorization"], "Bearer clave-secreta-de-prueba");
          assert.equal(capturado!.headers["Idempotency-Key"], "1057");
        }
      );

      // Un 401 NO debe incluir la credencial en el mensaje de error.
      global.fetch = (async () =>
        new Response(
          JSON.stringify({
            success: false,
            failure: { type: "UnauthorizedFailure", message: "API key is invalid", httpStatusCode: 401 },
          }),
          { status: 401 }
        )) as typeof fetch;
      await withEnv({ DROPEA_API_KEY: "clave-secreta-de-prueba", DROPEA_API_ENABLED: "1" }, async () => {
        await assert.rejects(
          () => dropeaClient.dropeaRequest({ path: "/dropshipper/me" }),
          (err: Error) => {
            assert.doesNotMatch(err.message, /clave-secreta-de-prueba/, "la key no aparece en el error");
            assert.match(err.message, /inválida o caducada/);
            return true;
          }
        );
      });
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("errores: 429 con Retry-After, 422 con código de negocio, 504 en curso", async () => {
    const realFetch = global.fetch;
    try {
      await withEnv({ DROPEA_API_KEY: "k", DROPEA_API_ENABLED: "1" }, async () => {
        global.fetch = (async () =>
          new Response(JSON.stringify({ success: false, failure: { type: "RateLimitFailure", message: "too many", httpStatusCode: 429 } }), {
            status: 429,
            headers: { "retry-after": "60" },
          })) as typeof fetch;
        await assert.rejects(
          () => dropeaClient.dropeaRequest({ path: "/dropshipper/orders" }),
          (e: InstanceType<typeof dropeaClient.DropeaApiError>) => {
            assert.equal(e.httpStatus, 429);
            assert.equal(e.retryAfterSeconds, 60);
            assert.equal(e.retryable, true);
            return true;
          }
        );

        global.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: false,
              failure: {
                type: "BusinessFailure",
                message: "Order total 5 is below the wholesale cost 8",
                code: "ORDER_TOTAL_BELOW_COST",
                httpStatusCode: 422,
              },
            }),
            { status: 422 }
          )) as typeof fetch;
        await assert.rejects(
          () => dropeaClient.dropeaRequest({ path: "/dropshipper/orders", method: "POST", body: {} }),
          (e: InstanceType<typeof dropeaClient.DropeaApiError>) => {
            assert.equal(e.businessCode, "ORDER_TOTAL_BELOW_COST");
            assert.equal(e.retryable, false, "un 422 no se reintenta: duplicaría el pedido");
            return true;
          }
        );

        global.fetch = (async () =>
          new Response(JSON.stringify({ success: false, data: { operation_id: "op-123", status: "pending" } }), {
            status: 504,
          })) as typeof fetch;
        await assert.rejects(
          () =>
            dropeaClient.dropeaRequest({ path: "/dropshipper/orders", method: "POST", body: {}, idempotencyKey: "op-123" }),
          dropeaClient.DropeaOperationPendingError
        );
      });
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("estados: los 22 sub_status y los 8 status del spec están cubiertos", () => {
    // Se aísla el sub_status usando un status padre inexistente: así se ve
    // qué sub-estados se resuelven por sí solos. Solo PENDING queda fuera
    // a propósito (significa cosas distintas según su padre).
    const sinMapear = DROPEA_SUB_STATUSES.filter(
      (s) => normalizeDropeaStatus("__SIN_PADRE__", s) === "unknown"
    );
    assert.deepEqual(sinMapear, ["PENDING"], "solo PENDING depende del status padre");
    // Y con padre, PENDING sí se resuelve:
    assert.equal(normalizeDropeaStatus("SHIPPING", "PENDING"), "in_transit");
    assert.equal(normalizeDropeaStatus("PENDING", "PENDING"), "created");

    // Los pares clave del ciclo de vida:
    assert.equal(normalizeDropeaStatus("SHIPPING", "OUT_FOR_DELIVERY"), "out_for_delivery");
    assert.equal(normalizeDropeaStatus("FINISH", "DELIVERED"), "delivered");
    assert.equal(normalizeDropeaStatus("FINISH", "PAID"), "delivered");
    assert.equal(normalizeDropeaStatus("FINISH", "CANCELLED"), "cancelled");
    assert.equal(normalizeDropeaStatus("PROCESSING", "PICKING"), "processing");
    assert.equal(normalizeDropeaStatus("SHIPPING", "SHIPPED"), "shipped");
    assert.equal(normalizeDropeaStatus("ERROR", null), "incident");
    assert.equal(normalizeDropeaStatus("SHIPPING", "DELIVERY_EXCEPTION"), "incident");
    assert.equal(normalizeDropeaStatus("SHIPPING", "REFUSED"), "returned");
    // El sub_status manda sobre el status padre:
    assert.equal(normalizeDropeaStatus("PROCESSING", "OUT_FOR_DELIVERY"), "out_for_delivery");
    // FINISH sin sub_status NO se asume entregado:
    assert.equal(normalizeDropeaStatus("FINISH", null), "unknown");
    // Todos los status de primer nivel dan algo (salvo FINISH, que exige sub):
    for (const st of DROPEA_STATUSES.filter((s) => s !== "FINISH")) {
      assert.notEqual(normalizeDropeaStatus(st, null), "unknown", `status ${st}`);
    }
    // Basura → unknown
    assert.equal(normalizeDropeaStatus("INVENTADO", "TAMBIEN"), "unknown");
  });

  await test("mapper: construye el pedido con los campos reales del contrato", () => {
    const input = {
      shopifyOrderId: "1057",
      orderNumber: "1057",
      customerName: "María García López",
      phone: "34600111222",
      email: "maria@example.com",
      finalAddress: {
        line1: "Calle Ejemplo 5B",
        line2: "3º B",
        city: "Almería",
        province: "Almería",
        postalCode: "04007",
        country: "España",
      },
      addressSource: "original" as const,
      items: [{ title: "Limpiador Ultrasónico", quantity: 2, price: null, sku: null }],
      total: "34.98",
      currency: "EUR",
      codAmount: "34.98",
      deliveryNote: "Llamar antes de subir",
    };
    const ctx = {
      storeId: 7,
      variantByTitle: new Map([["Limpiador Ultrasónico", { variantId: 42, unitPrice: 17.49 }]]),
    };
    const r = mapToDropeaCreateOrder(input, ctx);
    assert.deepEqual(r.errors, []);
    const req = r.request!;
    assert.equal(req.store_id, 7);
    assert.equal(req.payment_method, "COD", "contra reembolso");
    assert.equal(req.external_order_id, "1057", "nuestra referencia viaja a Dropea");
    assert.deepEqual(req.line_items, [{ variant_id: 42, quantity: 2, unit_price: 17.49 }]);
    // El importe COD se DERIVA de las líneas: 2 × 17.49 = 34.98
    const derivado = req.line_items.reduce((s, l) => s + l.unit_price * l.quantity, 0);
    assert.equal(derivado.toFixed(2), "34.98");
    const dir = req.customer_details.shipping_address;
    assert.equal(dir.first_name, "María");
    assert.equal(dir.last_name, "García López");
    assert.equal(dir.city, "Almería");
    assert.equal(dir.state, "Almería", "state es la PROVINCIA");
    assert.equal(dir.postal_code, "04007");
    assert.equal(dir.country, "ES", "país en ISO-2");
    assert.equal(dir.address_line_2, "3º B");
    assert.equal(req.customer_details.phone, "+34600111222", "teléfono internacional con +");
    // La nota del repartidor NO cabe en su API: debe avisarse
    assert.ok(
      r.warnings.some((w) => /nota/i.test(w)),
      "avisa de que la nota no se puede enviar"
    );
    assert.equal(JSON.stringify(req).includes("Llamar antes de subir"), false);
  });

  await test("mapper: bloquea si falta variante, localidad o email", () => {
    const base = {
      shopifyOrderId: "1",
      orderNumber: "1",
      customerName: "X Y",
      phone: "34600111222",
      email: "x@example.com",
      finalAddress: {
        line1: "Calle 1",
        line2: null,
        city: "Madrid",
        province: "Madrid",
        postalCode: "28001",
        country: "ES",
      },
      addressSource: "original" as const,
      items: [{ title: "Producto A", quantity: 1, price: null, sku: null }],
      total: "10",
      currency: "EUR",
      codAmount: "10",
      deliveryNote: null,
    };
    const conVariante = {
      storeId: 1,
      variantByTitle: new Map([["Producto A", { variantId: 9, unitPrice: 10 }]]),
    };
    // Sin correspondencia de producto:
    const sinVariante = mapToDropeaCreateOrder(base, { storeId: 1, variantByTitle: new Map() });
    assert.equal(sinVariante.request, null);
    assert.match(sinVariante.errors.join(" "), /variant_id/);
    // Sin email (habitual en Releasit): Dropea lo exige.
    const sinEmail = mapToDropeaCreateOrder({ ...base, email: null }, conVariante);
    assert.equal(sinEmail.request, null);
    assert.match(sinEmail.errors.join(" "), /email/);
    // La localidad "-" ya viene bloqueada antes, pero si llegara vacía:
    const sinCiudad = mapToDropeaCreateOrder(
      { ...base, finalAddress: { ...base.finalAddress, city: "" } },
      conVariante
    );
    assert.equal(sinCiudad.request, null);
    assert.match(sinCiudad.errors.join(" "), /localidad/);
  });

  await test("helpers del mapper: nombre y teléfono", () => {
    assert.deepEqual(splitName("Pedro Sánchez Ejemplo"), { first: "Pedro", last: "Sánchez Ejemplo" });
    assert.deepEqual(splitName("Trinidad"), { first: "Trinidad", last: "-" });
    assert.deepEqual(splitName(null), { first: "Cliente", last: "-" });
    assert.equal(toInternationalPhone("34600111222"), "+34600111222");
    assert.equal(toInternationalPhone(""), "");
  });

  await test("lectura y escritura son llaves SEPARADAS", async () => {
    await withEnv({ DROPEA_API_KEY: "k", DROPEA_API_ENABLED: "1", DROPEA_WRITE_ENABLED: "0" }, () => {
      assert.equal(dropeaClient.dropeaReadEnabled(), true, "se puede consultar");
      assert.equal(dropeaMod.dropeaWriteEnabled(), false, "pero no escribir");
      assert.equal(dropeaMod.dropeaProvider.isConfigured(), true);
    });
    await withEnv({ DROPEA_API_KEY: "k", DROPEA_API_ENABLED: "0", DROPEA_WRITE_ENABLED: "1" }, () => {
      assert.equal(dropeaClient.dropeaReadEnabled(), false);
      assert.equal(dropeaMod.dropeaWriteEnabled(), false, "sin lectura tampoco hay escritura");
    });
  });

  await test("createOrder y cancelOrder de Dropea siguen bloqueados", async () => {
    await withEnv({ DROPEA_API_KEY: "k", DROPEA_API_ENABLED: "1", DROPEA_WRITE_ENABLED: "1" }, async () => {
      const realFetch = global.fetch;
      let llamadas = 0;
      global.fetch = (async () => {
        llamadas++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        await assert.rejects(
          () =>
            dropeaMod.dropeaProvider.createOrder({
              shopifyOrderId: "1",
              orderNumber: "1",
              customerName: "X",
              phone: "34600111222",
              email: "x@example.com",
              finalAddress: {
                line1: "C 1",
                line2: null,
                city: "Madrid",
                province: "Madrid",
                postalCode: "28001",
                country: "ES",
              },
              addressSource: "original",
              items: [{ title: "P", quantity: 1, price: null, sku: null }],
              total: "10",
              currency: "EUR",
              codAmount: "10",
              deliveryNote: null,
            }),
          ProviderNotConfiguredError
        );
        await assert.rejects(() => dropeaMod.dropeaProvider.cancelOrder("1"), ProviderNotConfiguredError);
        assert.equal(llamadas, 0, "ni una petición: no se intenta crear nada");
      } finally {
        global.fetch = realFetch;
      }
    });
  });

  // ============ 24 · DROPEA: modo de creación, mapping y piloto ============
  console.log("· Dropea — modo de creación (external_app) y piloto");

  const createGate = await import("../src/lib/suppliers/dropea/create-gate");
  const createOrderMod = await import("../src/lib/suppliers/dropea/create-order");
  const { MISSING_EMAIL_CODE } = await import("../src/lib/suppliers/dropea/mapper");

  /** Todas las llaves abiertas MENOS la que se quiera probar. */
  const llavesAbiertas = {
    APP_MODE: "production",
    EMERGENCY_STOP: "0",
    SUPPLIER_SYNC_ENABLED: "1",
    SUPPLIER_TEST_MODE: "1",
    TEST_MODE: "1",
    TEST_PHONE_ALLOWLIST: "34600111222",
    LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1",
    DROPEA_API_KEY: "clave",
    DROPEA_API_ENABLED: "1",
    DROPEA_WRITE_ENABLED: "1",
    DROPEA_CREATE_MODE: "our_api",
    DROPEA_LEGACY_CREATE_ACTIVE: "0",
    SUPPLIER_PILOT_MODE: "1",
  };

  await test("external_app (por defecto) BLOQUEA la creación", async () => {
    const o = mkConfirmed("991001", "3001");
    db.setOrderSupplierPilotApproval(o.id, true);
    // Por defecto, sin tocar nada:
    const porDefecto = createGate.canCreateDropeaOrder(db.getOrderById(o.id)!);
    assert.equal(porDefecto.allowed, false);
    assert.equal(createGate.dropeaCreateMode(), "external_app");

    // Y aun con TODAS las demás llaves abiertas:
    await withEnv({ ...llavesAbiertas, DROPEA_CREATE_MODE: "external_app" }, () => {
      const g = createGate.canCreateDropeaOrder(db.getOrderById(o.id)!);
      assert.equal(g.allowed, false);
      assert.equal(g.blocker, "create_mode_external_app");
      assert.match(g.reason ?? "", /app oficial/);
    });
  });

  await test("la app oficial activa bloquea aunque el modo sea our_api", async () => {
    const o = db.getOrderByShopifyId("991001")!;
    await withEnv({ ...llavesAbiertas, DROPEA_LEGACY_CREATE_ACTIVE: "1" }, () => {
      const g = createGate.canCreateDropeaOrder(db.getOrderById(o.id)!);
      assert.equal(g.allowed, false);
      assert.equal(g.blocker, "legacy_app_active");
    });
    // Sin la variable puesta se asume que sigue activa (lo peor):
    await withEnv({ ...llavesAbiertas, DROPEA_LEGACY_CREATE_ACTIVE: undefined }, () => {
      assert.equal(createGate.canCreateDropeaOrder(db.getOrderById(o.id)!).blocker, "legacy_app_active");
    });
  });

  await test("matriz completa: quitar CUALQUIER llave bloquea la creación", async () => {
    const o = db.getOrderByShopifyId("991001")!;
    // Con todas abiertas, el gate deja pasar:
    await withEnv(llavesAbiertas, () => {
      const g = createGate.canCreateDropeaOrder(db.getOrderById(o.id)!);
      assert.equal(g.allowed, true, `esperaba permitido, bloqueó: ${g.blocker}`);
    });
    // Quitando una cada vez:
    const casos: Array<[string, Record<string, string | undefined>, string]> = [
      ["emergency stop", { EMERGENCY_STOP: "1" }, "emergency_stop"],
      ["sync general", { SUPPLIER_SYNC_ENABLED: "0" }, "supplier_sync"],
      ["api deshabilitada", { DROPEA_API_ENABLED: "0" }, "api_disabled"],
      ["escritura", { DROPEA_WRITE_ENABLED: "0" }, "write_disabled"],
      ["candado general", { LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "0" }, "legacy_integrations"],
      ["test mode en piloto", { TEST_MODE: "0" }, "pilot_without_test_mode"],
    ];
    for (const [desc, override, blocker] of casos) {
      await withEnv({ ...llavesAbiertas, ...override }, () => {
        const g = createGate.canCreateDropeaOrder(db.getOrderById(o.id)!);
        assert.equal(g.allowed, false, desc);
        assert.equal(g.blocker, blocker, desc);
      });
    }
  });

  await test("piloto sin aprobar y pedido sin confirmar bloquean", async () => {
    const sinAprobar = mkConfirmed("991002", "3002");
    await withEnv(llavesAbiertas, () => {
      assert.equal(
        createGate.canCreateDropeaOrder(db.getOrderById(sinAprobar.id)!).blocker,
        "pilot_not_approved"
      );
    });
    const sinConfirmar = mkOrder("991003", "3003", "34600111222");
    db.setOrderSupplierPilotApproval(sinConfirmar.id, true);
    await withEnv(llavesAbiertas, () => {
      assert.equal(
        createGate.canCreateDropeaOrder(db.getOrderById(sinConfirmar.id)!).blocker,
        "not_confirmed"
      );
    });
  });

  await test("createDropeaOrderForOrder NO toca la red en modo external_app", async () => {
    const o = db.getOrderByShopifyId("991001")!;
    const realFetch = global.fetch;
    let llamadas = 0;
    global.fetch = (async () => {
      llamadas++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const r = await createOrderMod.createDropeaOrderForOrder(
        db.getOrderById(o.id)!,
        { storeId: 1, variantByTitle: new Map() },
        {
          shopifyOrderId: "991001",
          orderNumber: "3001",
          customerName: "X Y",
          phone: "34600111222",
          email: "x@example.com",
          finalAddress: {
            line1: "C 1",
            line2: null,
            city: "Madrid",
            province: "Madrid",
            postalCode: "28001",
            country: "ES",
          },
          addressSource: "original",
          items: [{ title: "P", quantity: 1, price: null, sku: null }],
          total: "10",
          currency: "EUR",
          codAmount: "10",
          deliveryNote: null,
        }
      );
      assert.equal(r.ok, false);
      assert.equal(r.blocker, "create_mode_external_app");
      assert.equal(llamadas, 0, "ni una petición a Dropea");
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log("· Dropea — idempotencia, adopción y mapping");

  await test("la clave de idempotencia es ESTABLE y válida para su contrato", () => {
    const k1 = createOrderMod.buildIdempotencyKey("18066042290506", "create");
    const k2 = createOrderMod.buildIdempotencyKey("18066042290506", "create");
    assert.equal(k1, k2, "misma entrada → misma clave (nunca aleatoria)");
    assert.equal(k1, "casamable-shopify-18066042290506-create");
    assert.notEqual(k1, createOrderMod.buildIdempotencyKey("18066042290506", "confirm"));
    // Debe cumplir el patrón del contrato: ^[A-Za-z0-9_-]{1,255}$
    for (const k of [k1, createOrderMod.buildIdempotencyKey("#3305/raro", "confirm")]) {
      assert.match(k, /^[A-Za-z0-9_-]{1,255}$/);
    }
  });

  await test("máquina de estados create→confirm sobrevive a un reinicio", () => {
    const o = mkConfirmed("991010", "3010");
    const key = createOrderMod.buildIdempotencyKey("991010", "create");

    // Reclamar la creación: solo el primero gana.
    assert.equal(db.claimSupplierCreate(o.id, key), true);
    assert.equal(db.claimSupplierCreate(o.id, key), false, "no se reclama dos veces");
    let row = db.getOrderById(o.id)!;
    assert.equal(row.supplier_create_phase, "creating");
    assert.equal(row.supplier_idempotency_key, key, "la clave queda persistida");

    // Simular: creado en Dropea y CAÍDA justo después.
    db.markSupplierCreated(o.id, "dropea", "77001");
    row = db.getOrderById(o.id)!;
    assert.equal(row.supplier_create_phase, "created");
    assert.equal(row.supplier_external_order_id, "77001");

    // Tras el reinicio, intentar crear otra vez NO procede:
    assert.equal(db.claimSupplierCreate(o.id, key), false, "jamás un segundo create");

    // Confirmar sí procede, una sola vez.
    const ck = createOrderMod.buildIdempotencyKey("991010", "confirm");
    assert.equal(db.claimSupplierConfirm(o.id, ck), true);
    assert.equal(db.claimSupplierConfirm(o.id, ck), false);
    db.markSupplierConfirmed(o.id);
    assert.equal(db.getOrderById(o.id)!.supplier_create_phase, "confirmed");
    // Y la clave del confirm también quedó guardada:
    assert.equal(db.getOrderById(o.id)!.supplier_confirm_idempotency_key, ck);
  });

  await test("un fallo de creación NO borra la clave de idempotencia", () => {
    const o = mkConfirmed("991011", "3011");
    const key = createOrderMod.buildIdempotencyKey("991011", "create");
    db.claimSupplierCreate(o.id, key);
    db.markSupplierCreateFailed(o.id, "error de red");
    const row = db.getOrderById(o.id)!;
    assert.equal(row.supplier_create_phase, "failed");
    assert.equal(row.supplier_idempotency_key, key, "se reutiliza en el reintento");
    assert.equal(row.supplier_sync_attempts, 1);
    // Y se puede reintentar (fase failed sí permite reclamar):
    assert.equal(db.claimSupplierCreate(o.id, key), true);
  });

  await test("mapping de productos: exacto se usa, ausente bloquea", () => {
    const id = db.upsertSupplierProductMapping({
      supplier_platform: "dropea",
      shopify_sku: "LIMPIADOR-ULTRA",
      shopify_title: "Limpiador Ultrasónico Multiusos",
      supplier_variant_id: "42",
      supplier_unit_price: 17.49,
    });
    assert.ok(id > 0);
    const todos = db.listSupplierProductMappings("dropea");
    const m = todos.find((x) => x.shopify_sku === "LIMPIADOR-ULTRA")!;
    assert.equal(m.supplier_variant_id, "42");
    assert.equal(m.supplier_unit_price, 17.49);
    assert.equal(m.active, 1);

    // Upsert por el mismo SKU actualiza en vez de duplicar:
    db.upsertSupplierProductMapping({
      supplier_platform: "dropea",
      shopify_sku: "LIMPIADOR-ULTRA",
      supplier_variant_id: "43",
    });
    const tras = db.listSupplierProductMappings("dropea").filter((x) => x.shopify_sku === "LIMPIADOR-ULTRA");
    assert.equal(tras.length, 1, "no duplica");
    assert.equal(tras[0].supplier_variant_id, "43", "actualiza");
    db.deleteSupplierProductMapping(tras[0].id);
  });

  await test("email ausente bloquea con su código explícito", () => {
    const base = {
      shopifyOrderId: "1",
      orderNumber: "1",
      customerName: "X Y",
      phone: "34600111222",
      email: null,
      finalAddress: {
        line1: "C 1",
        line2: null,
        city: "Madrid",
        province: "Madrid",
        postalCode: "28001",
        country: "ES",
      },
      addressSource: "original" as const,
      items: [{ title: "P", quantity: 1, price: null, sku: null }],
      total: "10",
      currency: "EUR",
      codAmount: "10",
      deliveryNote: null,
    };
    const ctx = { storeId: 1, variantByTitle: new Map([["P", { variantId: 1, unitPrice: 10 }]]) };
    const r = mapToDropeaCreateOrder(base, ctx);
    assert.equal(r.request, null);
    assert.ok(r.errors.some((e) => e.includes(MISSING_EMAIL_CODE)));
    // Con email, pasa:
    assert.ok(mapToDropeaCreateOrder({ ...base, email: "a@b.com" }, ctx).request);
  });

  await test("delivery note: se marca unsupported y es configurable bloquear", async () => {
    const conNota = {
      shopifyOrderId: "1",
      orderNumber: "1",
      customerName: "X Y",
      phone: "34600111222",
      email: "a@b.com",
      finalAddress: {
        line1: "C 1",
        line2: null,
        city: "Madrid",
        province: "Madrid",
        postalCode: "28001",
        country: "ES",
      },
      addressSource: "original" as const,
      items: [{ title: "P", quantity: 1, price: null, sku: null }],
      total: "10",
      currency: "EUR",
      codAmount: "10",
      deliveryNote: "Llamar antes de subir",
    };
    const ctx = { storeId: 1, variantByTitle: new Map([["P", { variantId: 1, unitPrice: 10 }]]) };

    // Por defecto: no bloquea, pero queda registrado como unsupported.
    const r = mapToDropeaCreateOrder(conNota, ctx);
    assert.equal(r.deliveryNoteStatus, "unsupported");
    assert.ok(r.request, "no bloquea por defecto");
    assert.equal(JSON.stringify(r.request).includes("Llamar antes de subir"), false, "no se cuela en otro campo");

    // Sin nota: not_present
    assert.equal(mapToDropeaCreateOrder({ ...conNota, deliveryNote: null }, ctx).deliveryNoteStatus, "not_present");

    // Configurable: puede bloquear
    await withEnv({ DROPEA_BLOCK_ON_DELIVERY_NOTE: "1" }, () => {
      const b = mapToDropeaCreateOrder(conNota, ctx);
      assert.equal(b.request, null);
      assert.match(b.errors.join(" "), /nota para el repartidor/);
    });

    // Y el estado se persiste en el pedido:
    const o = mkConfirmed("991020", "3020");
    db.setOrderDeliveryNoteStatus(o.id, "unsupported");
    assert.equal(db.getOrderById(o.id)!.supplier_delivery_note_status, "unsupported");
  });

  await test("webhook duplicado por event_id → un solo efecto", async () => {
    const o = mkSynced("991030", "3030", "34600111222");
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600111222").length;
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = JSON.stringify({
        topic: "order.status.changed",
        market: "ES",
        event_id: "evento-unico-123",
        event_at: "2026-08-22T10:00:00.000Z",
        resource_id: 991030,
        resource: { id: 991030, status: "SHIPPING", sub_status: "SHIPPED", tracking_number: "TRK-DUP" },
      });
      const firma =
        "sha256=" + crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("base64");

      const antes = contar();
      const r1 = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firma });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.duplicate, undefined);
      const tras1 = contar();
      assert.ok(tras1 > antes, "avisó del tracking");

      // Mismo event_id otra vez: se corta ANTES de procesar nada.
      const r2 = supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firma });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.duplicate, true, "detectado como repetido por event_id");
      assert.equal(contar(), tras1, "sin efectos");
    });
  });

  // ============ 25 · Reinicio del proceso (persistencia) ============
  await test("el estado sobrevive a un reinicio (conexión nueva al mismo .db)", async () => {
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path.join(tmpDir, "messages.db"));
    try {
      const row = raw.prepare("SELECT status FROM orders WHERE shopify_order_id = '910001'").get() as {
        status: string;
      };
      assert.equal(row.status, "confirmed");
      // La nota del repartidor también sobrevive al reinicio:
      const nota = raw
        .prepare("SELECT status, delivery_note FROM orders WHERE shopify_order_id = '920001'")
        .get() as { status: string; delivery_note: string };
      assert.equal(nota.status, "confirmed");
      assert.equal(nota.delivery_note, "Llamar antes de subir");
      // Un pedido en plena corrección conserva estado Y dirección propuesta:
      const corr = raw
        .prepare("SELECT status, proposed_address FROM orders WHERE shopify_order_id = '910002'")
        .get() as { status: string; proposed_address: string };
      assert.equal(corr.status, "needs_correction");
      assert.match(corr.proposed_address, /Calle Mayor 5/);
      const vivos = raw
        .prepare(
          "SELECT COUNT(*) AS n FROM orders WHERE status IN ('awaiting_reply','reminder_sent','needs_correction','needs_call')"
        )
        .get() as { n: number };
      assert.ok(vivos.n >= 1, "los pedidos en curso siguen ahí tras 'reiniciar'");
    } finally {
      raw.close();
    }
  });


  // ============================================================
  // CONTROL CENTER (observabilidad): sanitizado, repo, health services
  // ============================================================
  console.log("\n— Control Center —");

  const sanitizeMod = await import("../src/lib/system/sanitize");
  const sysRepo = await import("../src/lib/system/repo");
  const sysCore = await import("../src/lib/system/health-core");
  const sysInteg = await import("../src/lib/system/health-integrations");
  const sysTracking = await import("../src/lib/system/tracking-overview");
  const sysOverview = await import("../src/lib/system/overview");

  await test("sanitize: emails, tokens, JWT y hex largos fuera; teléfonos enmascarados", () => {
    const sucia =
      "cliente pedro@casamable.es tel 34644313917 token shpat_abcdef123456 " +
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456 " +
      "hmac a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const limpia = sanitizeMod.sanitizeForEvents(sucia);
    assert.ok(!limpia.includes("pedro@casamable.es"), "email fuera");
    assert.ok(!limpia.includes("34644313917"), "teléfono completo fuera");
    assert.ok(!limpia.includes("shpat_abcdef123456"), "token de Shopify fuera");
    assert.ok(!limpia.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT fuera");
    assert.ok(!limpia.includes("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"), "hex largo fuera");
    // Idempotente y acotado
    assert.equal(sanitizeMod.sanitizeForEvents(limpia), limpia);
    assert.ok(sanitizeMod.sanitizeForEvents("x".repeat(2000)).length <= 300);
  });

  await test("integration_events: se guarda sanitizado y con filtros", () => {
    sysRepo.logIntegrationEvent(
      "dropea",
      "test_event",
      "warning",
      "fallo con email test@x.com y tel 34600111222",
      "#9001"
    );
    const [ev] = sysRepo.listIntegrationEvents({ integration: "dropea", limit: 1 });
    assert.ok(ev, "evento guardado");
    assert.equal(ev.event_type, "test_event");
    assert.equal(ev.order_ref, "#9001");
    assert.ok(!ev.message.includes("test@x.com"), "email sanitizado al guardar");
    assert.ok(!ev.message.includes("34600111222"), "teléfono sanitizado al guardar");
    const soloCriticos = sysRepo.listIntegrationEvents({ severity: "critical" });
    assert.ok(soloCriticos.every((e) => e.severity === "critical"));
  });

  await test("countIntegrationEvents cuenta por tipo y ventana temporal", () => {
    const antes = sysRepo.countIntegrationEvents("dropea", "test_event", 0);
    sysRepo.logIntegrationEvent("dropea", "test_event", "info", "otro");
    assert.equal(sysRepo.countIntegrationEvents("dropea", "test_event", 0), antes + 1);
    // Ventana futura: no cuenta nada
    const futuro = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(sysRepo.countIntegrationEvents("dropea", "test_event", futuro), 0);
  });

  await test("service_health: transición a peor deja alerta en el feed, y la recuperación también", () => {
    sysRepo.recordServiceCheck("dropi", { status: "healthy", ok: true });
    const antesCrit = sysRepo.listIntegrationEvents({ integration: "dropi" }).length;
    sysRepo.recordServiceCheck("dropi", { status: "critical", ok: false, error: "se rompió" });
    const trasCrit = sysRepo.listIntegrationEvents({ integration: "dropi" });
    assert.equal(trasCrit.length, antesCrit + 1, "el empeoramiento genera evento");
    assert.equal(trasCrit[0].severity, "critical");
    sysRepo.recordServiceCheck("dropi", { status: "healthy", ok: true });
    const trasRecuperar = sysRepo.listIntegrationEvents({ integration: "dropi" });
    assert.equal(trasRecuperar.length, antesCrit + 2, "la recuperación genera evento info");
    assert.equal(trasRecuperar[0].severity, "info");
    const row = sysRepo.getServiceHealth("dropi");
    assert.ok(row && row.status === "healthy" && row.last_error_message, "el último error se conserva");
  });

  await test("service_health: metadata se sanitiza y el error nunca guarda secretos", () => {
    sysRepo.recordServiceCheck("shopify", {
      status: "warning",
      ok: false,
      error: "401 con token shpat_supersecreto999 de pedro@x.com",
      metadata: { nota: "Bearer eyJaaa.bbb.ccc y tel 34644313917" },
    });
    const row = sysRepo.getServiceHealth("shopify")!;
    assert.ok(!String(row.last_error_message).includes("shpat_supersecreto999"));
    assert.ok(!String(row.last_error_message).includes("pedro@x.com"));
    assert.ok(!String(row.metadata_json).includes("34644313917"));
  });

  await test("runInstrumented: con trabajo crea fila; el error se registra Y se relanza", async () => {
    await sysRepo.runInstrumented("scheduler:orders", "orders", async () => ({
      processed: 3,
      errors: 0,
    }));
    const [run] = sysRepo.listSchedulerRuns("orders", 1);
    assert.ok(run && run.processed_count === 3 && run.status === "ok");

    let relanzado = false;
    try {
      await sysRepo.runInstrumented("scheduler:orders", "orders", async () => {
        throw new Error("tick roto");
      });
    } catch {
      relanzado = true;
    }
    assert.ok(relanzado, "el error del tick NO se traga");
    const [runErr] = sysRepo.listSchedulerRuns("orders", 1);
    assert.equal(runErr.status, "error");
    assert.ok(String(runErr.last_error).includes("tick roto"));
  });

  await test("runInstrumented: un tick sin trabajo NO crea fila (solo latido)", async () => {
    const antes = sysRepo.listSchedulerRuns("tracking").length;
    await sysRepo.runInstrumented("scheduler:tracking", "tracking", async () => ({
      processed: 0,
      errors: 0,
    }));
    assert.equal(sysRepo.listSchedulerRuns("tracking").length, antes, "sin fila nueva");
    assert.ok(sysRepo.getServiceHealth("scheduler:tracking"), "pero el latido existe");
  });

  await test("SYSTEM_HEALTH_ENABLED=0 apaga la instrumentación sin romper nada", async () => {
    await withEnv({ SYSTEM_HEALTH_ENABLED: "0" }, () => {
      const antes = sysRepo.listIntegrationEvents({ limit: 500 }).length;
      sysRepo.logIntegrationEvent("system", "apagado", "info", "no debería guardarse");
      assert.equal(sysRepo.listIntegrationEvents({ limit: 500 }).length, antes);
    });
  });

  await test("getDatabaseHealth: DB sana → healthy, WAL, esquema al día, filas y última escritura", () => {
    const h = sysCore.getDatabaseHealth();
    assert.equal(h.status, "healthy");
    assert.equal(h.reachable, true);
    assert.equal(h.integrity, "ok");
    assert.equal(h.journalMode.toLowerCase(), "wal");
    assert.equal(h.schemaVersion, h.expectedSchemaVersion, "user_version estampada");
    assert.ok((h.rowCounts["orders"] ?? 0) > 0, "cuenta filas de orders");
    assert.ok(h.lastWriteAt, "última escritura detectada");
    assert.ok(h.dbSizeBytes && h.dbSizeBytes > 0);
    // integrity_check completo también funciona
    assert.equal(sysCore.getDatabaseHealth({ full: true }).integrity, "ok");
  });

  await test("getBackupHealth: carpeta inexistente → unknown SIN crash (modo local)", async () => {
    await withEnv({ BACKUP_DIR: path.join(tmpDir, "no-existe") }, () => {
      const h = sysCore.getBackupHealth();
      assert.equal(h.status, "unknown");
      assert.ok(h.message.includes("inexistente"));
    });
  });

  await test("getBackupHealth: carpeta vacía → warning (existe pero sin copias)", async () => {
    const dirVacia = path.join(tmpDir, "backups-vacia");
    fs.mkdirSync(dirVacia, { recursive: true });
    await withEnv({ BACKUP_DIR: dirVacia }, () => {
      assert.equal(sysCore.getBackupHealth().status, "warning");
    });
  });

  await test("getBackupHealth: copia fresca e íntegra → healthy; vieja → warning; muy vieja → critical", async () => {
    const dir = path.join(tmpDir, "backups-ok");
    fs.mkdirSync(dir, { recursive: true });
    // Copia REAL: un sqlite válido que pasa quick_check
    const Database = require("better-sqlite3");
    const fichero = path.join(dir, "messages-2026-01-01_0200.db");
    const bdb = new Database(fichero);
    bdb.exec("CREATE TABLE t (id INTEGER)");
    bdb.close();
    for (const sufijo of ["-wal", "-shm"]) fs.rmSync(fichero + sufijo, { force: true });

    await withEnv({ BACKUP_DIR: dir }, () => {
      assert.equal(sysCore.getBackupHealth().status, "healthy", "recién creada → healthy");
      assert.equal(sysCore.getBackupHealth().integrity, "ok");

      const h30 = new Date(Date.now() - 30 * 3600 * 1000);
      fs.utimesSync(fichero, h30, h30);
      assert.equal(sysCore.getBackupHealth().status, "warning", ">24h → warning");

      const h50 = new Date(Date.now() - 50 * 3600 * 1000);
      fs.utimesSync(fichero, h50, h50);
      assert.equal(sysCore.getBackupHealth().status, "critical", ">48h → critical");
    });
  });

  await test("getBackupHealth: copia corrupta → critical aunque sea reciente", async () => {
    const dir = path.join(tmpDir, "backups-mal");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "messages-rota.db"), "esto no es un sqlite");
    await withEnv({ BACKUP_DIR: dir }, () => {
      const h = sysCore.getBackupHealth();
      assert.equal(h.status, "critical");
      assert.ok(h.message.includes("comprobación"), "explica que no pasa la comprobación");
    });
  });

  await test("getOutboxHealth: cola vacía o al día → healthy; sent_at se estampa al enviar", () => {
    const conv = db.getOrCreateConversation("34600999888", "Salud Outbox");
    const encolado = db.enqueueOutbox(conv.id, conv.phone, "mensaje de prueba salud");
    db.markOutboxSent(encolado);
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    const fila = raw.prepare("SELECT sent, sent_at FROM outbox WHERE id = ?").get(encolado);
    raw.close();
    assert.equal(fila.sent, 1);
    assert.ok(fila.sent_at, "sent_at estampado al enviar");
    const h = sysCore.getOutboxHealth();
    assert.equal(h.status, "healthy");
    assert.ok(h.sentLast24h >= 1);
    assert.ok(h.lastSentAt);
  });

  await test("getOutboxHealth: pendiente atascado → warning; retenidos masivos → critical", async () => {
    const conv = db.getOrCreateConversation("34600999888", "Salud Outbox");
    const id = db.enqueueOutbox(conv.id, conv.phone, "atascado");
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    try {
      // 20 min de antigüedad: supera OUTBOX_STALE_MINUTES (15) pero no la
      // edad máxima (60) → warning "¿el bot corre?"
      raw.prepare("UPDATE outbox SET created_at = created_at - 1200 WHERE id = ?").run(id);
      assert.equal(sysCore.getOutboxHealth().status, "warning");

      // 2h: retenido (no saldrá solo) → warning con aviso de outbox:inspect
      raw.prepare("UPDATE outbox SET created_at = created_at - 6000 WHERE id = ?").run(id);
      const h = sysCore.getOutboxHealth();
      assert.equal(h.status, "warning");
      assert.equal(h.retained, 1);
      assert.ok(h.message.includes("outbox:inspect"));

      // 12 retenidos → critical
      const ids: number[] = [];
      for (let i = 0; i < 11; i++) {
        ids.push(db.enqueueOutbox(conv.id, conv.phone, `retenido ${i}`));
      }
      raw
        .prepare(
          `UPDATE outbox SET created_at = created_at - 7200 WHERE id IN (${ids.join(",")})`
        )
        .run();
      assert.equal(sysCore.getOutboxHealth().status, "critical");
      // Limpieza: fuera los artificiales para no ensuciar el resto
      raw.prepare(`DELETE FROM outbox WHERE id IN (${[...ids, id].join(",")})`).run();
    } finally {
      raw.close();
    }
  });

  await test("getSchedulersHealth: sin latido → unknown; latido fresco → healthy; latido viejo → critical", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    try {
      raw.prepare("DELETE FROM service_health WHERE service = 'scheduler:watchdog'").run();
      let wd = sysCore.getSchedulersHealth().find((s) => s.name === "watchdog")!;
      assert.equal(wd.status, "unknown");

      sysRepo.recordServiceCheck("scheduler:watchdog", { status: "healthy", ok: true });
      wd = sysCore.getSchedulersHealth().find((s) => s.name === "watchdog")!;
      assert.equal(wd.status, "healthy");

      raw
        .prepare(
          "UPDATE service_health SET last_checked_at = last_checked_at - 999999 WHERE service = 'scheduler:watchdog'"
        )
        .run();
      wd = sysCore.getSchedulersHealth().find((s) => s.name === "watchdog")!;
      assert.equal(wd.status, "critical");
      assert.ok(wd.message.includes("sin latido"));
    } finally {
      raw.close();
    }
  });

  await test("getWhatsAppHealth: desconectado → critical; conectado → healthy con número ENMASCARADO", () => {
    db.setConnectionState({ status: "disconnected", phone: null });
    let h = sysInteg.getWhatsAppHealth();
    assert.equal(h.status, "critical");

    db.setConnectionState({ status: "connected", phone: "34641308254" });
    // "Conectado" sin latido del proceso del bot NO se cree: warning.
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("DELETE FROM service_health WHERE service = 'scheduler:outbox'").run();
    raw.close();
    h = sysInteg.getWhatsAppHealth();
    assert.equal(h.status, "warning", "conectado sin bot vivo = estado obsoleto");
    assert.ok(h.message.includes("no da señales"));

    // Con latido fresco del bot: healthy de verdad.
    sysRepo.recordServiceCheck("scheduler:outbox", { status: "healthy", ok: true });
    h = sysInteg.getWhatsAppHealth();
    assert.equal(h.status, "healthy");
    assert.ok(h.businessNumberMasked && !h.businessNumberMasked.includes("641308254"),
      "el número jamás sale completo");
    assert.ok(h.lastInboundAt !== undefined && h.outboxPending >= 0);
  });

  await test("getShopifyHealth: sin credenciales → no healthy; con error 401 reciente → critical", async () => {
    await withEnv(
      { SHOPIFY_ADMIN_ACCESS_TOKEN: undefined, SHOPIFY_CLIENT_ID: undefined, SHOPIFY_CLIENT_SECRET: undefined, SHOPIFY_STORE_DOMAIN: undefined },
      () => {
        const h = sysInteg.getShopifyHealth();
        assert.notEqual(h.status, "healthy");
        assert.equal(h.configured, false);
        assert.ok(h.lastWebhookAt, "el último webhook se deriva de orders");
      }
    );
    await withEnv(
      { SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_token_de_prueba", SHOPIFY_STORE_DOMAIN: "x.myshopify.com" },
      () => {
        sysRepo.recordServiceCheck("shopify", { status: "critical", ok: false, error: "tagsAdd 401: credencial inválida" });
        const h = sysInteg.getShopifyHealth();
        assert.equal(h.authMode, "static");
        assert.equal(h.status, "critical", "401 reciente → critical");
        sysRepo.recordServiceCheck("shopify", { status: "healthy", ok: true });
        assert.equal(sysInteg.getShopifyHealth().status, "healthy");
      }
    );
  });

  await test("getDropeaHealth: sin key → disabled; habilitada sin llamadas → unknown; con éxito → healthy read-only", async () => {
    await withEnv({ DROPEA_API_KEY: undefined, DROPEA_API_ENABLED: undefined }, () => {
      assert.equal(sysInteg.getDropeaHealth().status, "disabled");
    });
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("DELETE FROM service_health WHERE service = 'dropea'").run();
    // Estado virgen de verdad: sin firmas inválidas heredadas de otros tests
    // (si las hubiera, el warning sería CORRECTO, pero aquí probamos "nunca llamada")
    raw
      .prepare("DELETE FROM integration_events WHERE integration = 'dropea' AND event_type = 'webhook_bad_signature'")
      .run();
    raw.close();
    await withEnv({ DROPEA_API_KEY: "clave-test", DROPEA_API_ENABLED: "1" }, () => {
      let h = sysInteg.getDropeaHealth();
      assert.equal(h.status, "unknown", "sin llamadas: unknown, jamás datos inventados");
      assert.ok(h.message.includes("doctor"));
      sysRepo.recordServiceCheck("dropea", { status: "healthy", ok: true });
      h = sysInteg.getDropeaHealth();
      assert.equal(h.status, "healthy");
      assert.equal(h.createMode, "external_app");
      assert.ok(h.message.includes("app oficial"), "deja claro quién crea los pedidos");
    });
  });

  await test("getDropeaHealth: firmas inválidas recientes degradan a warning", async () => {
    await withEnv({ DROPEA_API_KEY: "clave-test", DROPEA_API_ENABLED: "1" }, () => {
      sysRepo.logIntegrationEvent("dropea", "webhook_bad_signature", "warning", "firma inválida");
      const h = sysInteg.getDropeaHealth();
      assert.ok(h.counters.webhookBadSignature >= 1);
      assert.equal(h.status, "warning");
    });
  });

  await test("getDropiHealth: apagado → disabled; encendido sin auth confirmada → warning, NUNCA healthy", async () => {
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: undefined }, () => {
      assert.equal(sysInteg.getDropiHealth().status, "disabled");
    });
    await withEnv({ DROPIPRO_WEBHOOK_ENABLED: "1" }, () => {
      const h = sysInteg.getDropiHealth();
      assert.equal(h.status, "warning");
      assert.ok(h.message.includes("sin autenticación"));
    });
  });

  await test("getTrackingOverview: cuenta activos, stale configurable y bloqueados por dirección", async () => {
    const o = mkSynced("77001", "#77001");
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    try {
      raw
        .prepare(
          `UPDATE orders SET supplier_status_normalized='in_transit',
           tracking_last_checked_at = unixepoch() - 8 * 3600 WHERE id = ?`
        )
        .run(o.id);
      // Umbral 12h: 8h sin mirar NO es stale
      let t = sysTracking.getTrackingOverview();
      assert.ok(t.activeShipments >= 1);
      assert.ok(!t.staleOrders.some((x) => x.orderNumber === "#77001"));
      // Umbral 6h (env): ahora sí
      await withEnv({ TRACKING_STALE_HOURS: "6" }, () => {
        const t2 = sysTracking.getTrackingOverview();
        assert.ok(t2.staleOrders.some((x) => x.orderNumber === "#77001"));
        assert.equal(t2.status, "warning");
      });
      // Bloqueado por dirección (el hallazgo de la city "-")
      raw
        .prepare("UPDATE orders SET supplier_sync_status='blocked_address' WHERE id = ?")
        .run(o.id);
      t = sysTracking.getTrackingOverview();
      assert.ok(t.blockedAddress >= 1, "los city '-' se ven en el panel");
    } finally {
      raw
        .prepare(
          "UPDATE orders SET supplier_status_normalized='delivered', supplier_sync_status='synced' WHERE id = ?"
        )
        .run(o.id);
      raw.close();
    }
  });

  await test("getSystemOverview: 10 tarjetas (con Negocio), overall = peor estado OPERATIVO (disabled/unknown no arrastran)", () => {
    db.setConnectionState({ status: "connected", phone: "34641308254" });
    const ov = sysOverview.getSystemOverview();
    assert.equal(ov.cards.length, 10);
    assert.ok(ov.cards.some((c) => c.service === "business"), "tarjeta de negocio presente");
    const rank: Record<string, number> = { healthy: 0, disabled: 0, unknown: 0, warning: 1, critical: 2 };
    const esperado = ov.cards.reduce((acc, c) => (rank[c.status] > rank[acc] ? c.status : acc),
      "healthy" as string);
    const rankEsperado = rank[esperado];
    assert.equal(rank[ov.overall], rankEsperado, "overall coherente con las tarjetas");
    assert.equal(ov.emergencyStop, false);
  });

  await test("getSystemOverview: JAMÁS filtra secretos ni teléfonos completos", async () => {
    await withEnv(
      {
        SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_absolutamente_secreto_123",
        DROPEA_API_KEY: "clave-dropea-secretisima",
        DROPEA_WEBHOOK_SECRET: "firma-secreta-webhook",
        SHOPIFY_STORE_DOMAIN: "x.myshopify.com",
        DROPEA_API_ENABLED: "1",
      },
      () => {
        db.setConnectionState({ status: "connected", phone: "34641308254" });
        const json = JSON.stringify(sysOverview.getSystemOverview());
        assert.ok(!json.includes("shpat_absolutamente_secreto_123"), "token Shopify fuera");
        assert.ok(!json.includes("clave-dropea-secretisima"), "API key Dropea fuera");
        assert.ok(!json.includes("firma-secreta-webhook"), "signing secret fuera");
        assert.ok(!json.includes("34641308254"), "número del negocio nunca completo");
      }
    );
  });

  await test("webhook Dropea con firma inválida deja evento webhook_bad_signature en el feed", async () => {
    const { processDropeaWebhook } = await import("../src/lib/suppliers/dropea/webhook");
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-firma" }, () => {
      const antes = sysRepo.countIntegrationEvents("dropea", "webhook_bad_signature", 0);
      const r = processDropeaWebhook('{"topic":"order.created","resource_id":1}', {
        "x-dropea-signature": "sha256=firmafalsa",
      });
      assert.equal(r.status, 401);
      assert.equal(sysRepo.countIntegrationEvents("dropea", "webhook_bad_signature", 0), antes + 1);
    });
  });


  // ============ 30 · FASE A — routing por mapping, histórico, métricas, alertas, economía ============
  console.log("\n— Fase A —");

  const { resolveSupplierWith } = await import("../src/lib/suppliers/router");
  const deliveryMetrics = await import("../src/lib/system/delivery-metrics");
  const businessAlerts = await import("../src/lib/system/business-alerts");
  const unitEconomics = await import("../src/lib/system/unit-economics");
  const dropiCreate = await import("../src/lib/suppliers/dropi/create-order");
  const { canCreateDropiOrder } = await import("../src/lib/suppliers/dropi/create-gate");
  const trackingNotif = await import("../src/lib/tracking/notifications");

  const payloadCon = (lineas: Array<Record<string, unknown>>) => JSON.stringify({ line_items: lineas });
  const MAPPINGS = [
    { id: 1, supplier_platform: "dropea", shopify_product_id: "9001", shopify_variant_id: "90011", shopify_sku: "10428", shopify_title: "Cortaúñas Eléctrico 3 en 1", supplier_product_id: "a3f618c76fb450ce890e7189", supplier_variant_id: "v-dropea-1", supplier_unit_price: 29.9, active: 1, created_at: 0, updated_at: 0 },
    { id: 2, supplier_platform: "dropi", shopify_product_id: "9002", shopify_variant_id: "90021", shopify_sku: "LIMP-001", shopify_title: "Limpiador Ultrasónico Multiusos", supplier_product_id: null, supplier_variant_id: "LIMP-001", supplier_unit_price: null, active: 1, created_at: 0, updated_at: 0 },
    { id: 3, supplier_platform: "dropi", shopify_product_id: null, shopify_variant_id: null, shopify_sku: "INACTIVO", shopify_title: "Viejo", supplier_product_id: null, supplier_variant_id: "x", supplier_unit_price: null, active: 0, created_at: 0, updated_at: 0 },
  ];

  await test("A1 routing: producto mapeado a Dropea → dropea", () => {
    const r = resolveSupplierWith(
      { raw_payload: payloadCon([{ title: "Cortaúñas Eléctrico 3 en 1", quantity: 1, sku: "10428", product_id: 9001, variant_id: 90011 }, { title: "Seguro de Envío", quantity: 1 }]) },
      MAPPINGS
    );
    assert.equal(r.platform, "dropea");
    assert.equal(r.code, "mapped");
    assert.equal(r.lines.length, 1, "el seguro de envío no cuenta");
  });

  await test("A1 routing: producto mapeado a Dropi → dropi (por SKU aunque cambien los IDs)", () => {
    const r = resolveSupplierWith(
      { raw_payload: payloadCon([{ title: "Limpiador", quantity: 2, sku: "limp-001", product_id: 777, variant_id: 7777 }]) },
      MAPPINGS
    );
    assert.equal(r.platform, "dropi");
    assert.equal(r.code, "mapped");
  });

  await test("A1 routing: pedido mixto Dropea + Dropi → unknown / mixed_supplier (manual_review)", () => {
    const r = resolveSupplierWith(
      { raw_payload: payloadCon([{ title: "Cortaúñas", quantity: 1, sku: "10428" }, { title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
      MAPPINGS
    );
    assert.equal(r.platform, "unknown");
    assert.equal(r.code, "mixed_supplier");
  });

  await test("A1 routing: sin mapping → unknown / unmapped_products; mapping inactivo no cuenta", () => {
    const r = resolveSupplierWith({ raw_payload: payloadCon([{ title: "Pulidor", quantity: 1, sku: "PUL-9" }]) }, MAPPINGS);
    assert.equal(r.platform, "unknown");
    assert.equal(r.code, "unmapped_products");
    const r2 = resolveSupplierWith({ raw_payload: payloadCon([{ title: "Viejo", quantity: 1, sku: "INACTIVO" }]) }, MAPPINGS);
    assert.equal(r2.code, "unmapped_products");
    // Un pedido mapeado parcialmente también es revisión: nunca se manda a medias.
    const r3 = resolveSupplierWith({ raw_payload: payloadCon([{ title: "Cortaúñas", quantity: 1, sku: "10428" }, { title: "Pulidor", quantity: 1, sku: "PUL-9" }]) }, MAPPINGS);
    assert.equal(r3.code, "unmapped_products");
  });

  await test("A1 routing: sin raw_payload o solo servicios → unknown (no adivina por product_summary)", () => {
    assert.equal(resolveSupplierWith({ raw_payload: null }, MAPPINGS).code, "no_line_items");
    assert.equal(resolveSupplierWith({ raw_payload: "{no json" }, MAPPINGS).code, "no_line_items");
    assert.equal(resolveSupplierWith({ raw_payload: payloadCon([{ title: "Seguro de Envío", quantity: 1 }]) }, MAPPINGS).code, "no_product_lines");
  });

  await test("A2 histórico: cada transición real se persiste UNA vez; mismo estado no crea fila", () => {
    const o = mkSynced("990001", "3001", "34600119001");
    const r1 = tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "H1", source: "polling" });
    assert.ok(r1.historyId, "primera transición registrada");
    const r2 = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "shipped", source: "polling" });
    assert.equal(r2.historyId, null, "mismo estado: sin transición");
    const h = db.listOrderStatusHistory(o.id);
    assert.equal(h.length, 1);
    assert.equal(h[0].previous_status, "unknown");
    assert.equal(h[0].new_status, "shipped");
    assert.equal(h[0].source, "polling");
    assert.equal(h[0].supplier_platform, "dropea");
  });

  await test("A2 histórico: dedupe por event_id (mismo evento dos veces → una fila)", () => {
    const o = mkSynced("990002", "3002", "34600119002");
    const a = db.insertOrderStatusHistory({ orderId: o.id, shopifyOrderId: o.shopify_order_id, supplierPlatform: "dropea", carrier: "GLS", previousStatus: "unknown", newStatus: "shipped", rawStatus: "SHIPPING.SHIPPED", source: "webhook", eventId: "evt-unico-1" });
    const b = db.insertOrderStatusHistory({ orderId: o.id, shopifyOrderId: o.shopify_order_id, supplierPlatform: "dropea", carrier: "GLS", previousStatus: "unknown", newStatus: "shipped", rawStatus: "SHIPPING.SHIPPED", source: "webhook", eventId: "evt-unico-1" });
    assert.ok(a);
    assert.equal(b, null);
    assert.equal(db.listOrderStatusHistory(o.id).length, 1);
  });

  await test("A2 histórico: polling repetido de la misma transición no duplica (clave estable sin event_id)", () => {
    const o = mkSynced("990003", "3003", "34600119003");
    const base = { orderId: o.id, shopifyOrderId: o.shopify_order_id, supplierPlatform: "dropea", carrier: null, previousStatus: "shipped", newStatus: "in_transit", rawStatus: "SHIPPING", source: "polling" as const };
    assert.ok(db.insertOrderStatusHistory(base));
    assert.equal(db.insertOrderStatusHistory(base), null, "misma transición en la ventana → duplicado");
    // Una transición DISTINTA sí entra.
    assert.ok(db.insertOrderStatusHistory({ ...base, previousStatus: "in_transit", newStatus: "out_for_delivery" }));
    assert.equal(db.listOrderStatusHistory(o.id).length, 2);
  });

  await test("A2 histórico: webhook Dropea duplicado (mismo event_id) no duplica el histórico ni el aviso", async () => {
    const o = mkSynced("990004", "3004", "34600119004");
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = sobreDropea(990004, { id: 990004, status: "SHIPPING", sub_status: "SHIPPED", tracking_number: "TRKH4", carrier: "GLS" });
      const firma = firmaDropea(body);
      assert.equal(supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firma }).status, 200);
      assert.equal(supplierWebhook.processDropeaWebhook(body, { "x-dropea-signature": firma }).status, 200);
    });
    const h = db.listOrderStatusHistory(o.id);
    assert.equal(h.length, 1);
    assert.equal(h[0].source, "webhook");
    assert.equal(h[0].event_id, "dropea:evt-990004-order.status.changed");
    assert.equal(h[0].raw_sub_status, "SHIPPED");
    assert.equal(h[0].occurred_at, Math.floor(Date.parse("2026-08-22T10:00:00.000Z") / 1000), "fecha del hecho según Dropea");
  });

  await test("A3 tasa de entrega: entregados / (entregados + devueltos); en curso NO cuentan", () => {
    assert.equal(deliveryMetrics.computeDeliveryRate(7, 3), 70);
    assert.equal(deliveryMetrics.computeDeliveryRate(0, 0), null);
    assert.equal(deliveryMetrics.computeDeliveryRate(2, 1), 66.7);

    // Escenario real en DB: 3 enviados → 2 entregados, 1 devuelto, 1 en tránsito (no resuelto)
    const mk = (id: string, num: string, tel: string) => mkSynced(id, num, tel);
    const a = mk("990010", "3010", "34600119010");
    const b = mk("990011", "3011", "34600119011");
    const c = mk("990012", "3012", "34600119012");
    const d = mk("990013", "3013", "34600119013");
    for (const o of [a, b, c, d]) tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: `T${o.id}`, carrier: o.id === d.id ? "CEX-A3" : "GLS-A3", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(a.id)!, { rawStatus: "delivered", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(b.id)!, { rawStatus: "delivered", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(c.id)!, { rawStatus: "returned", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(d.id)!, { rawStatus: "in_transit", source: "polling" });

    const ahora = Math.floor(Date.now() / 1000);
    const w = deliveryMetrics.getDeliveryWindow(ahora - 60, ahora + 2);
    // Otros tests de esta misma ejecución también han enviado pedidos: se
    // comprueba por transportista (claves únicas de este test) y en agregado.
    assert.ok(w.shipped >= 4);
    const gls = w.byCarrier.find((x) => x.key === "GLS-A3")!;
    assert.equal(gls.shipped, 3);
    assert.equal(gls.delivered, 2);
    assert.equal(gls.returned, 1);
    assert.equal(gls.pending, 0);
    assert.equal(gls.deliveryRate, 66.7);
    const correos = w.byCarrier.find((x) => x.key === "CEX-A3")!;
    assert.equal(correos.pending, 1, "el que sigue en tránsito no está resuelto");
    assert.equal(correos.deliveryRate, null, "sin resueltos → sin tasa, no 0 %");
    assert.ok((w.bySupplier.find((x) => x.key === "dropea")?.shipped ?? 0) >= 4);
    assert.ok(w.byProduct.length >= 1);
    assert.equal(w.delivered + w.returned + w.pending, w.shipped, "todo enviado está resuelto o pendiente");
    assert.equal(w.deliveryRate, deliveryMetrics.computeDeliveryRate(w.delivered, w.returned));
    assert.ok((w.avgHoursToDeliver ?? 0) >= 0);
    // Fuera de la ventana: nada.
    assert.equal(deliveryMetrics.getDeliveryWindow(ahora - 7200, ahora - 3600).shipped, 0);
  });

  await test("A3 terminales/no terminales: delivery_attempted y at_pickup_point siguen vivos", () => {
    assert.equal(isTerminalTracking("delivery_attempted"), false);
    assert.equal(isTerminalTracking("at_pickup_point"), false);
    assert.equal(isTerminalTracking("delivered"), true);
    assert.equal(isTerminalTracking("returned"), true);
  });

  await test("A4 DELIVERY_ATTEMPT_FAILED: Dropea DELIVERY_ATTEMPTED → evento; apagado → revisión humana sin mensaje", () => {
    const { normalizeDropeaStatus } = require("../src/lib/suppliers/dropea/status-map");
    assert.equal(normalizeDropeaStatus("SHIPPING", "DELIVERY_ATTEMPTED"), "delivery_attempted");
    const o = mkSynced("990020", "3020", "34600119020");
    tracking.processSupplierUpdate(o, { rawStatus: "SHIPPING.OUT_FOR_DELIVERY", normalizedOverride: "out_for_delivery", trackingNumber: "TA1", source: "webhook" });
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600119020").length;
    const antes = contar();
    const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "SHIPPING.DELIVERY_ATTEMPTED", normalizedOverride: "delivery_attempted", source: "webhook" });
    assert.deepEqual(r.events, ["DELIVERY_ATTEMPT_FAILED"]);
    assert.equal(r.notified.length, 0, "apagado por defecto: sin mensaje");
    assert.equal(contar(), antes);
    const fresco = db.getOrderById(o.id)!;
    assert.equal(fresco.supplier_sync_status, "manual_review");
    assert.equal(fresco.delivery_attempt_notification_sent_at, null, "no se consumió el sello");
    // Vuelve a reparto al día siguiente: no es un retroceso.
    const r2 = tracking.processSupplierUpdate(fresco, { rawStatus: "SHIPPING.OUT_FOR_DELIVERY", normalizedOverride: "out_for_delivery", source: "webhook" });
    assert.equal(r2.newStatus, "out_for_delivery");
  });

  await test("A4 DELIVERY_ATTEMPT_FAILED: activado → UN mensaje (configurable) y nunca dos", async () => {
    const o = mkSynced("990021", "3021", "34600119021");
    tracking.processSupplierUpdate(o, { rawStatus: "out_for_delivery", trackingNumber: "TA2", source: "webhook" });
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600119021").length;
    await withEnv({ DELIVERY_ATTEMPT_WHATSAPP_ENABLED: "1", DELIVERY_ATTEMPT_MESSAGE: "Hola {nombre}, {tienda}: no pudimos entregar. Importe {importe}." }, () => {
      const antes = contar();
      const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { normalizedOverride: "delivery_attempted", rawStatus: "attempt", source: "webhook" });
      assert.deepEqual(r.notified, ["DELIVERY_ATTEMPT_FAILED"]);
      assert.equal(contar(), antes + 1);
      const msg = db.getPendingOutbox(999).filter((x) => x.phone === "34600119021").pop()!;
      assert.match(msg.content, /no pudimos entregar/);
      assert.match(msg.content, /34,98|34\.98/);
      // Segundo intento fallido: sello ya puesto → sin segundo mensaje
      tracking.processSupplierUpdate(db.getOrderById(o.id)!, { normalizedOverride: "out_for_delivery", rawStatus: "ofd", source: "webhook" });
      const r3 = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { normalizedOverride: "delivery_attempted", rawStatus: "attempt", source: "webhook" });
      assert.deepEqual(r3.events, ["DELIVERY_ATTEMPT_FAILED"]);
      assert.equal(r3.notified.length, 0);
      assert.equal(contar(), antes + 1);
    });
  });

  await test("A4 PICKUP_POINT_AVAILABLE: sin datos del punto → revisión; con datos y activado → mensaje con el punto", async () => {
    const o = mkSynced("990022", "3022", "34600119022");
    tracking.processSupplierUpdate(o, { rawStatus: "in_transit", trackingNumber: "TP1", source: "webhook" });
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600119022").length;
    await withEnv({ PICKUP_POINT_WHATSAPP_ENABLED: "1" }, () => {
      const antes = contar();
      const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { normalizedOverride: "at_pickup_point", rawStatus: "pickup", source: "webhook" });
      assert.deepEqual(r.events, ["PICKUP_POINT_AVAILABLE"]);
      assert.equal(r.notified.length, 0, "sin dirección del punto no hay mensaje");
      assert.equal(contar(), antes);
      assert.equal(db.getOrderById(o.id)!.supplier_sync_status, "manual_review");
    });
    const o2 = mkSynced("990023", "3023", "34600119023");
    tracking.processSupplierUpdate(o2, { rawStatus: "in_transit", trackingNumber: "TP2", source: "webhook" });
    const contar2 = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600119023").length;
    await withEnv({ PICKUP_POINT_WHATSAPP_ENABLED: "1" }, () => {
      const antes = contar2();
      const r = tracking.processSupplierUpdate(db.getOrderById(o2.id)!, {
        normalizedOverride: "at_pickup_point",
        rawStatus: "pickup",
        source: "webhook",
        pickupPoint: { name: "Estanco Plaza Mayor", address: "Plaza Mayor 3, Almería" },
      });
      assert.deepEqual(r.notified, ["PICKUP_POINT_AVAILABLE"]);
      assert.equal(contar2(), antes + 1);
      const msg = db.getPendingOutbox(999).filter((x) => x.phone === "34600119023").pop()!;
      assert.match(msg.content, /Estanco Plaza Mayor/);
    });
    // Apagado (default): revisión, sin mensaje aunque haya datos.
    const o3 = mkSynced("990024", "3024", "34600119024");
    const r3 = tracking.processSupplierUpdate(o3, { normalizedOverride: "at_pickup_point", rawStatus: "pickup", source: "webhook", pickupPoint: { name: "X" } });
    assert.equal(r3.notified.length, 0);
  });

  await test("A4 anti-spam: tope de avisos por pedido (TRACKING_MAX_NOTIFICATIONS_PER_ORDER)", async () => {
    const o = mkSynced("990025", "3025", "34600119025");
    const contar = () => db.getPendingOutbox(999).filter((x) => x.phone === "34600119025").length;
    await withEnv({ TRACKING_MAX_NOTIFICATIONS_PER_ORDER: "1" }, () => {
      const antes = contar();
      tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "TS1", source: "webhook" }); // 1º aviso
      assert.equal(contar(), antes + 1);
      const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "out_for_delivery", source: "webhook" });
      assert.deepEqual(r.events, ["OUT_FOR_DELIVERY"]);
      assert.equal(r.notified.length, 0, "tope alcanzado");
      assert.equal(contar(), antes + 1);
      assert.equal(trackingNotif.trackingNotificationsSent(db.getOrderById(o.id)!), 1);
    });
  });

  await test("A5 alertas: tasa < 70 → warning, < 65 → critical, muestra insuficiente → unknown", () => {
    const t = { deliveryWarn: 70, deliveryCrit: 65, deliveryMinSample: 10 };
    assert.equal(businessAlerts.evalDeliveryRate(72, 20, t).status, "healthy");
    assert.equal(businessAlerts.evalDeliveryRate(69.9, 20, t).status, "warning");
    assert.equal(businessAlerts.evalDeliveryRate(64.9, 20, t).status, "critical");
    assert.equal(businessAlerts.evalDeliveryRate(50, 3, t).status, "unknown", "3 resueltos no bastan");
    assert.equal(businessAlerts.evalDeliveryRate(null, 0, t).status, "unknown");
    const a = businessAlerts.evalDeliveryRate(64.9, 20, t);
    assert.equal(a.category, "business");
    assert.match(a.message, /break-even/);
  });

  await test("A5 alertas: needs_call > 12 h → warning; muchos → critical; fallos proveedor; stale; incidencias; avisos fallidos", () => {
    const t = businessAlerts.businessThresholds();
    assert.equal(businessAlerts.evalNeedsCall(0, 2, t).status, "healthy");
    assert.equal(businessAlerts.evalNeedsCall(1, 2, t).status, "warning");
    assert.equal(businessAlerts.evalNeedsCall(5, 6, t).status, "critical");
    assert.equal(businessAlerts.evalNeedsCall(1, 2, t).category, "operations");
    assert.equal(businessAlerts.evalSupplierFailures(2, t).status, "healthy");
    assert.equal(businessAlerts.evalSupplierFailures(3, t).status, "warning");
    assert.equal(businessAlerts.evalTrackingStale(0, 12).status, "healthy");
    assert.equal(businessAlerts.evalTrackingStale(2, 12).status, "warning");
    assert.equal(businessAlerts.evalOpenIncidents(0, t).status, "healthy");
    assert.equal(businessAlerts.evalOpenIncidents(1, t).status, "warning");
    assert.equal(businessAlerts.evalTrackingNotifyFailures(5, t).status, "healthy");
    assert.equal(businessAlerts.evalTrackingNotifyFailures(6, t).status, "warning");
  });

  await test("A5 alertas: bloqueo deliberado (TEST_MODE/allowlist) NO cuenta como fallo; los fallos reales sí", async () => {
    const antes = businessAlerts.readBusinessSnapshot().trackingNotifyFailures24h;

    // 10 avisos bloqueados por allowlist: notifyTrackingEvent real, de punta a
    // punta, pasando por notifications.ts → logIntegrationEvent. Deliberado:
    // no debe disparar la alerta.
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600999999" }, () => {
      for (let i = 0; i < 10; i++) {
        const o = mkSynced(`990600${i}`, `3600${i}`, `346110006${i}`);
        tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: `TBQ${i}`, source: "polling" });
      }
    });

    const trasBloqueos = businessAlerts.readBusinessSnapshot().trackingNotifyFailures24h;
    assert.equal(trasBloqueos, antes, "10 avisos bloqueados por allowlist no cuentan como fallo");
    assert.equal(
      businessAlerts.getBusinessAlerts().alerts.find((a) => a.id === "tracking_notify_failures")!.status,
      "healthy",
      "la alerta sigue healthy con solo bloqueos deliberados"
    );

    // 6 fallos reales (el motivo real es irrelevante para la alerta: lo único
    // que importa es que quedan registrados como notification_failed, no
    // notification_skipped_by_gate).
    for (let i = 0; i < 6; i++) {
      sysRepo.logIntegrationEvent("tracking", "notification_failed", "warning", `fallo real simulado ${i}`, `3600${i}`);
    }

    const trasFallos = businessAlerts.readBusinessSnapshot().trackingNotifyFailures24h;
    assert.equal(trasFallos, antes + 6, "los 6 fallos reales sí se cuentan");
    assert.equal(
      businessAlerts.getBusinessAlerts().alerts.find((a) => a.id === "tracking_notify_failures")!.status,
      "warning",
      "6 fallos reales superan el umbral por defecto (5) y disparan la alerta"
    );
  });

  await test("A5 alertas: needs_call atrasado se lee de la DB (needs_call_at) y umbrales por env", async () => {
    const o = mkSent("990030", "3030");
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("UPDATE orders SET status='needs_call', needs_call_at = unixepoch() - 13*3600 WHERE id = ?").run(o.id);
    raw.close();
    const snap = businessAlerts.readBusinessSnapshot();
    assert.ok(snap.needsCallTotal >= 1);
    assert.ok(snap.needsCallStale >= 1, "13 h > 12 h → atrasado");
    await withEnv({ NEEDS_CALL_STALE_HOURS: "24" }, () => {
      const s2 = businessAlerts.readBusinessSnapshot(Math.floor(Date.now() / 1000), 24);
      assert.equal(s2.needsCallStale, 0, "con umbral 24 h ya no está atrasado");
    });
    const res = businessAlerts.getBusinessAlerts();
    assert.ok(res.alerts.find((a) => a.id === "needs_call_stale")!.status !== "healthy");
    assert.ok(["warning", "critical"].includes(res.status));
  });

  await test("A6 unit economics: sin costes ni ads → incompleto con la lista de lo que falta, cifras reales intactas", () => {
    const ahora = Math.floor(Date.now() / 1000);
    const rows = [
      { id: 1, status: "delivered", total_price: "34.98", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
      { id: 2, status: "returned", total_price: "34.98", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
    ];
    const w = unitEconomics.computeEconomics(rows, [], new Map(), ahora - 86400, ahora);
    assert.equal(w.complete, false);
    assert.equal(w.grossRevenue, 69.96);
    assert.equal(w.deliveredRevenue, 34.98);
    assert.equal(w.productCost, null);
    assert.equal(w.adSpend, null);
    assert.equal(w.estimatedMargin, null);
    assert.equal(w.netRoas, null);
    assert.ok(w.missing.some((m) => m.includes("LIMP-001")));
    assert.ok(w.missing.some((m) => m.includes("ads")));
  });

  await test("A6 unit economics: con costes y ads → completo; margen y ROAS bruto/neto correctos", () => {
    const ahora = Math.floor(Date.now() / 1000);
    const rows = [
      { id: 1, status: "delivered", total_price: "40.00", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 2, sku: "LIMP-001" }]) },
      { id: 2, status: "returned", total_price: "20.00", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
    ];
    const costs = [{ sku: "LIMP-001", title: "Limpiador", product_cost: 5, shipping_cost: 4, cod_fee: 1, updated_at: 0 }];
    const hoy = new Date();
    const dia = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
    const inicioDia = deliveryMetrics.startOfLocalDay();
    const w = unitEconomics.computeEconomics(rows, costs, new Map([[dia, 10]]), inicioDia, ahora + 1);
    assert.equal(w.complete, true);
    assert.deepEqual(w.missing, []);
    assert.equal(w.grossRevenue, 60);
    assert.equal(w.deliveredRevenue, 40);
    assert.equal(w.productCost, 15, "3 unidades × 5, se entreguen o no");
    assert.equal(w.shippingCost, 12, "3 × 4");
    assert.equal(w.codFees, 2, "solo las 2 unidades entregadas");
    assert.equal(w.adSpend, 10);
    assert.equal(w.estimatedMargin, 40 - 15 - 12 - 2 - 10);
    assert.equal(w.grossRoas, 6);
    assert.equal(w.netRoas, 4);
  });

  await test("A6 costes y ads: alta/edición en DB y lectura por getUnitEconomics", () => {
    db.upsertProductCost({ sku: "LIMP-001", title: "Limpiador", product_cost: 5, shipping_cost: 4 });
    db.upsertProductCost({ sku: "LIMP-001", cod_fee: 0.7 });
    const c = db.listProductCosts().find((x) => x.sku === "LIMP-001")!;
    assert.equal(c.product_cost, 5);
    assert.equal(c.cod_fee, 0.7, "la segunda llamada no borra lo anterior");
    db.upsertDailyAdSpend("2026-08-22", 123.45);
    db.upsertDailyAdSpend("2026-08-22", 100);
    assert.equal(db.listDailyAdSpend("2026-08-22", "2026-08-22")[0].amount, 100);
    assert.throws(() => db.upsertDailyAdSpend("22/08/2026", 1));
    assert.throws(() => db.upsertDailyAdSpend("2026-08-22", -1));
    const ue = unitEconomics.getUnitEconomics();
    assert.ok(ue.costsConfigured >= 1);
    assert.ok(ue.last30d.shippedOrders >= 1);
  });

  await test("A8 Dropi: gate falla cerrado (cliente no implementado) y createOrder nunca toca la red ni cambia de fase", async () => {
    const o = db.getOrderByShopifyId("970003")!;
    const g = canCreateDropiOrder(o);
    assert.equal(g.allowed, false);
    assert.equal(g.blocker, "client_not_implemented");
    await withEnv({ LEGACY_SUPPLIER_INTEGRATIONS_DISABLED: "1", SUPPLIER_SYNC_ENABLED: "1", DROPIPRO_WRITE_ENABLED: "1", DROPIPRO_CREATE_ENABLED: "1", DROPIPRO_API_BASE_URL: "https://api.example", DROPIPRO_API_KEY: "k" }, async () => {
      assert.equal(canCreateDropiOrder(o).blocker, "client_not_implemented", "ni con todas las llaves abiertas: falta el cliente");
      const antes = JSON.stringify(db.getOrderById(o.id));
      const r = await dropiCreate.createDropiOrderForOrder(o, suppliers.evaluateOrderForSupplier(o).input!);
      assert.equal(r.ok, false);
      assert.equal(r.blocker, "client_not_implemented");
      assert.equal(JSON.stringify(db.getOrderById(o.id)), antes, "sin efectos en la DB");
    });
    // Borrador por mapping: una línea sin mapping impide crear.
    const draft = dropiCreate.buildDropiOrderDraft(
      { raw_payload: payloadCon([{ title: "Limpiador", quantity: 2, sku: "LIMP-001" }, { title: "Pulidor", quantity: 1, sku: "PUL-9" }]), shopify_order_id: "1" },
      MAPPINGS as never
    );
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].dropiVariantId, "LIMP-001");
    assert.equal(draft.errors.length, 1);
    assert.equal(dropiCreate.buildDropiIdempotencyKey("12345"), "casamable-shopify-12345-dropi-create");
  });

  await test("A7 overview: sección business presente y sin fuga de secretos ni teléfonos", async () => {
    await withEnv({ SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_secreto_faseA", DROPEA_API_KEY: "dropea-key-faseA", DROPIPRO_API_KEY: "dropi-key-faseA" }, () => {
      const ov = sysOverview.getSystemOverview();
      assert.ok(ov.business.delivery.last7d);
      assert.ok(Array.isArray(ov.business.alerts.alerts) && ov.business.alerts.alerts.length === 6);
      assert.ok(ov.business.economics.last30d);
      const json = JSON.stringify(ov);
      for (const s of ["shpat_secreto_faseA", "dropea-key-faseA", "dropi-key-faseA", "34600119021", "Calle Ejemplo"]) {
        assert.ok(!json.includes(s), `"${s}" no debe salir por /api/system`);
      }
    });
  });

  // ============ E1 · Eje de cierre (espejo de Shopify) ============
  console.log("· E1 — eje de cierre");

  await test("E1 migración: DB vacía → columnas nuevas con sus defaults, sin CHECK que rechace nada", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "e1-empty.db"));
    // Tabla mínima "pre-E1": sin closure_status/closure_source/closure_at.
    raw.exec(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending_send')"
    );
    db.migrateClosureAxis(raw);

    const cols = raw.prepare("PRAGMA table_info(orders)").all().map((c: { name: string }) => c.name);
    assert.ok(cols.includes("closure_status"));
    assert.ok(cols.includes("closure_source"));
    assert.ok(cols.includes("closure_at"));

    // Una fila insertada DESPUÉS de migrar, sin mencionar las columnas nuevas,
    // debe caer en el default: 'unknown', sin origen ni fecha.
    raw.prepare("INSERT INTO orders (shopify_order_id) VALUES ('e1-empty-1')").run();
    const fila = raw.prepare("SELECT closure_status, closure_source, closure_at FROM orders WHERE shopify_order_id = 'e1-empty-1'").get();
    assert.equal(fila.closure_status, "unknown");
    assert.equal(fila.closure_source, null);
    assert.equal(fila.closure_at, null);
    raw.close();
  });

  await test("E1 migración: DB con filas de un esquema anterior → backfill a 'unknown', NUNCA se infiere del status viejo", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "e1-existing-rows.db"));
    raw.exec(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending_send')"
    );
    // Filas previas con estados MUY dispares del eje de confirmación — si la
    // migración "adivinara" el cierre a partir de status, aquí se notaría.
    raw.prepare("INSERT INTO orders (shopify_order_id, status) VALUES ('e1-old-1', 'confirmed')").run();
    raw.prepare("INSERT INTO orders (shopify_order_id, status) VALUES ('e1-old-2', 'needs_call')").run();
    raw.prepare("INSERT INTO orders (shopify_order_id, status) VALUES ('e1-old-3', 'cancelled')").run();

    db.migrateClosureAxis(raw);

    const filas = raw.prepare("SELECT shopify_order_id, closure_status, closure_source, closure_at FROM orders ORDER BY id").all();
    assert.equal(filas.length, 3);
    for (const f of filas) {
      assert.equal(f.closure_status, "unknown", `${f.shopify_order_id} debe arrancar en unknown, no inferido de status`);
      assert.equal(f.closure_source, null);
      assert.equal(f.closure_at, null);
    }
    raw.close();
  });

  await test("E1 migración: correr dos veces (o tres) es un no-op — no rompe nada ni pisa datos ya migrados", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "e1-twice.db"));
    raw.exec(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending_send')"
    );
    raw.prepare("INSERT INTO orders (shopify_order_id, status) VALUES ('e1-twice-1', 'confirmed')").run();

    assert.doesNotThrow(() => db.migrateClosureAxis(raw), "primera pasada");
    assert.doesNotThrow(() => db.migrateClosureAxis(raw), "segunda pasada: no debe fallar por columna/índice duplicados");
    assert.doesNotThrow(() => db.migrateClosureAxis(raw), "tercera pasada, por si acaso");

    // Ni la fila preexistente ni el esquema se han corrompido.
    const cols = raw.prepare("PRAGMA table_info(orders)").all().map((c: { name: string }) => c.name);
    assert.equal(cols.filter((c: string) => c === "closure_status").length, 1, "la columna no se duplica");
    const fila = raw.prepare("SELECT closure_status, closure_source, closure_at FROM orders WHERE shopify_order_id = 'e1-twice-1'").get();
    assert.equal(fila.closure_status, "unknown");
    assert.equal(fila.closure_source, null);
    assert.equal(fila.closure_at, null);

    // Y ahora, sobre esta misma tabla ya migrada, escribir un cierre real y
    // volver a migrar no debe pisarlo (comprobación de que el "no-op" respeta
    // también filas que ya tienen un cierre asignado, no solo las 'unknown').
    raw.prepare("UPDATE orders SET closure_status = 'delivered', closure_source = 'shopify', closure_at = 123 WHERE shopify_order_id = 'e1-twice-1'").run();
    db.migrateClosureAxis(raw);
    const trasSegundoCierre = raw.prepare("SELECT closure_status, closure_source, closure_at FROM orders WHERE shopify_order_id = 'e1-twice-1'").get();
    assert.equal(trasSegundoCierre.closure_status, "delivered");
    assert.equal(trasSegundoCierre.closure_source, "shopify");
    assert.equal(trasSegundoCierre.closure_at, 123);
    raw.close();
  });

  await test("E1 transiciones de cierre (canTransitionClosure): terminal no se abandona; unknown/in_progress van a cualquier sitio", () => {
    assert.equal(db.canTransitionClosure("unknown", "in_progress"), true);
    assert.equal(db.canTransitionClosure("unknown", "delivered"), true);
    assert.equal(db.canTransitionClosure("in_progress", "delivered"), true);
    assert.equal(db.canTransitionClosure("in_progress", "refused"), true);
    assert.equal(db.canTransitionClosure("in_progress", "cancelled"), true);
    // Idempotente: repetir el mismo valor siempre está permitido.
    assert.equal(db.canTransitionClosure("delivered", "delivered"), true);
    assert.equal(db.canTransitionClosure("unknown", "unknown"), true);
    // Terminal → distinto: bloqueado siempre, para los tres terminales.
    assert.equal(db.canTransitionClosure("delivered", "cancelled"), false);
    assert.equal(db.canTransitionClosure("refused", "unknown"), false);
    assert.equal(db.canTransitionClosure("cancelled", "in_progress"), false);
  });

  await test("E1 setOrderClosure: escribe si la transición vale, no toca nada si el pedido ya está en otro cierre terminal", () => {
    const o = mkOrder("990700", "3700", "34600119700");
    const antes = db.getOrderById(o.id)!;
    assert.equal(antes.closure_status, "unknown", "un pedido nuevo arranca en unknown");
    assert.equal(antes.closure_source, null);
    assert.equal(antes.closure_at, null);

    assert.equal(db.setOrderClosure(o.id, "in_progress", "shopify", 1000), true);
    let actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_status, "in_progress");
    assert.equal(actual.closure_source, "shopify");
    assert.equal(actual.closure_at, 1000);

    assert.equal(db.setOrderClosure(o.id, "delivered", "dropea", 2000), true);
    actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_status, "delivered");
    assert.equal(actual.closure_source, "dropea");
    assert.equal(actual.closure_at, 2000);

    // Terminal ya alcanzado: un intento de moverlo a OTRO valor se ignora.
    assert.equal(db.setOrderClosure(o.id, "cancelled", "manual", 3000), false, "no se abandona un cierre terminal");
    actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_status, "delivered", "sigue delivered, no se pisó");
    assert.equal(actual.closure_source, "dropea", "el origen tampoco cambió");
    assert.equal(actual.closure_at, 2000);

    // Repetir el MISMO valor sí está permitido (p.ej. una segunda fuente
    // corrobora el mismo cierre): se actualiza el origen/fecha.
    assert.equal(db.setOrderClosure(o.id, "delivered", "shopify", 2500), true);
    actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_source, "shopify", "la fuente más reciente sí se registra");
    assert.equal(actual.closure_at, 2500);

    // Pedido inexistente: no revienta, simplemente no hace nada.
    assert.equal(db.setOrderClosure(999999999, "delivered", "shopify"), false);
  });

  // ============ E2 · Webhooks Shopify: cancelled / fulfilled / updated ============
  console.log("· E2 — webhooks Shopify (cierre)");

  const closurePayload = (overrides: Record<string, unknown> = {}) => ({
    id: 990800,
    updated_at: "2026-08-23T10:00:00Z",
    ...overrides,
  });

  await test("E2: HMAC inválido → 401; sin SHOPIFY_WEBHOOK_SECRET → 500; ningún efecto en la DB", () => {
    const o = mkOrder("990800", "3800", "34600119800");
    const raw = JSON.stringify(closurePayload({ id: 990800 }));
    const resBadHmac = processOrdersEventWebhook(
      raw,
      shopifyHeaders(raw, { topic: "orders/cancelled", hmac: sign("manipulado"), webhookId: "wh-e2-badhmac" })
    );
    assert.equal(resBadHmac.status, 401);
    assert.equal(db.getOrderById(o.id)!.closure_status, "unknown");

    const backup = process.env.SHOPIFY_WEBHOOK_SECRET;
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    try {
      const res = processOrdersEventWebhook(raw, shopifyHeaders(raw, { topic: "orders/cancelled", webhookId: "wh-e2-nosecret" }));
      assert.equal(res.status, 500);
    } finally {
      process.env.SHOPIFY_WEBHOOK_SECRET = backup;
    }
    assert.equal(db.getOrderById(o.id)!.closure_status, "unknown");
  });

  await test("E2 orders/cancelled: closure_status → cancelled, source shopify, closure_at = cancelled_at del payload", () => {
    const o = mkOrder("990801", "3801", "34600119801");
    const raw = JSON.stringify(
      closurePayload({ id: 990801, cancelled_at: "2026-08-23T09:00:00Z", updated_at: "2026-08-23T09:00:00Z" })
    );
    const res = processOrdersEventWebhook(raw, shopifyHeaders(raw, { topic: "orders/cancelled", webhookId: "wh-e2-cancel-1" }));
    assert.equal(res.status, 200);
    const actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_status, "cancelled");
    assert.equal(actual.closure_source, "shopify");
    assert.equal(actual.closure_at, Math.floor(Date.parse("2026-08-23T09:00:00Z") / 1000));
  });

  await test("E2 orders/fulfilled: closure_status → in_progress (NUNCA delivered), source shopify", () => {
    const o = mkOrder("990802", "3802", "34600119802");
    const raw = JSON.stringify(closurePayload({ id: 990802, updated_at: "2026-08-23T11:00:00Z" }));
    const res = processOrdersEventWebhook(raw, shopifyHeaders(raw, { topic: "orders/fulfilled", webhookId: "wh-e2-fulfilled-1" }));
    assert.equal(res.status, 200);
    const actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_status, "in_progress");
    assert.notEqual(actual.closure_status, "delivered");
    assert.equal(actual.closure_source, "shopify");
  });

  await test("E2 idempotencia por X-Shopify-Webhook-Id: mismo id de entrega, payload DISTINTO → un solo efecto", () => {
    const o = mkOrder("990803", "3803", "34600119803");
    const raw1 = JSON.stringify(closurePayload({ id: 990803, updated_at: "2026-08-23T12:00:00Z" }));
    const res1 = processOrdersEventWebhook(raw1, shopifyHeaders(raw1, { topic: "orders/fulfilled", webhookId: "wh-e2-dup" }));
    assert.equal(res1.status, 200);
    assert.equal(res1.body.duplicate, undefined);

    // Mismo webhook-id, payload DISTINTO (timestamp más nuevo): si
    // deduplicáramos por contenido no lo detectaríamos como repetido; por
    // webhook-id, sí — que es justo lo que se pedía verificar.
    const raw2 = JSON.stringify(closurePayload({ id: 990803, updated_at: "2026-08-23T13:00:00Z" }));
    const res2 = processOrdersEventWebhook(raw2, shopifyHeaders(raw2, { topic: "orders/fulfilled", webhookId: "wh-e2-dup" }));
    assert.equal(res2.status, 200);
    assert.equal(res2.body.duplicate, true);

    const actual = db.getOrderById(o.id)!;
    assert.equal(
      actual.closure_at,
      Math.floor(Date.parse("2026-08-23T12:00:00Z") / 1000),
      "el segundo (duplicado por webhook-id) no se llegó a aplicar"
    );
  });

  await test("E2 fuera de orden: un evento más antiguo que el cierre ya guardado se descarta, aunque la transición sería válida", () => {
    const o = mkOrder("990804", "3804", "34600119804");
    const rawNuevo = JSON.stringify(closurePayload({ id: 990804, updated_at: "2026-08-23T15:00:00Z" }));
    const res1 = processOrdersEventWebhook(rawNuevo, shopifyHeaders(rawNuevo, { topic: "orders/fulfilled", webhookId: "wh-e2-orden-1" }));
    assert.equal(res1.status, 200);
    assert.equal(db.getOrderById(o.id)!.closure_at, Math.floor(Date.parse("2026-08-23T15:00:00Z") / 1000));

    // Llega DESPUÉS en el tiempo real, pero con fecha de EVENTO anterior
    // (retraso de entrega de Shopify). in_progress → in_progress sería una
    // transición válida por sí sola, pero debe descartarse por ser más viejo
    // que lo que ya hay guardado.
    const rawViejo = JSON.stringify(closurePayload({ id: 990804, updated_at: "2026-08-23T14:00:00Z" }));
    const res2 = processOrdersEventWebhook(rawViejo, shopifyHeaders(rawViejo, { topic: "orders/fulfilled", webhookId: "wh-e2-orden-2" }));
    assert.equal(res2.status, 200);
    assert.equal(res2.body.ignored, "stale_event");
    assert.equal(
      db.getOrderById(o.id)!.closure_at,
      Math.floor(Date.parse("2026-08-23T15:00:00Z") / 1000),
      "el evento más viejo no pisa el más reciente"
    );
  });

  await test("E2 terminal ya fijado: cancelled no se pisa por un fulfilled posterior (ni con fecha más nueva)", () => {
    const o = mkOrder("990805", "3805", "34600119805");
    const rawCancel = JSON.stringify(closurePayload({ id: 990805, cancelled_at: "2026-08-23T09:00:00Z" }));
    processOrdersEventWebhook(rawCancel, shopifyHeaders(rawCancel, { topic: "orders/cancelled", webhookId: "wh-e2-terminal-1" }));
    assert.equal(db.getOrderById(o.id)!.closure_status, "cancelled");

    const rawFulfilled = JSON.stringify(closurePayload({ id: 990805, updated_at: "2026-08-23T20:00:00Z" }));
    const res = processOrdersEventWebhook(rawFulfilled, shopifyHeaders(rawFulfilled, { topic: "orders/fulfilled", webhookId: "wh-e2-terminal-2" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, false, "el gate de canTransitionClosure lo bloquea");
    const actual = db.getOrderById(o.id)!;
    assert.equal(actual.closure_status, "cancelled", "sigue cancelado: Shopify no pisa un terminal");
    assert.equal(actual.closure_source, "shopify");
  });

  await test("E2 orders/updated (sin tag dropea_id): nunca escribe closure_status ni ningún otro campo; solo deja rastro en integration_events", () => {
    const o = mkOrder("990806", "3806", "34600119806");
    const antes = db.getOrderById(o.id)!;
    const raw = JSON.stringify(closurePayload({ id: 990806, updated_at: "2026-08-23T16:00:00Z" }));
    const res = processOrdersEventWebhook(raw, shopifyHeaders(raw, { topic: "orders/updated", webhookId: "wh-e2-updated-1" }));
    assert.equal(res.status, 200);
    const despues = db.getOrderById(o.id)!;
    assert.equal(despues.closure_status, antes.closure_status);
    assert.equal(despues.closure_source, antes.closure_source);
    assert.equal(despues.closure_at, antes.closure_at);
    assert.equal(despues.updated_at, antes.updated_at, "orders/updated no toca ni siquiera updated_at: cero escritura");
  });

  await test("E2: pedido desconocido y JSON inválido → 200 sin efectos", () => {
    const rawDesconocido = JSON.stringify(closurePayload({ id: 999999999 }));
    const resDesconocido = processOrdersEventWebhook(
      rawDesconocido,
      shopifyHeaders(rawDesconocido, { topic: "orders/cancelled", webhookId: "wh-e2-unknown" })
    );
    assert.equal(resDesconocido.status, 200);
    assert.equal(resDesconocido.body.ignored, "pedido desconocido");

    const rawMalo = "{no es json";
    const resMalo = processOrdersEventWebhook(rawMalo, shopifyHeaders(rawMalo, { topic: "orders/cancelled", webhookId: "wh-e2-badjson" }));
    assert.equal(resMalo.status, 200);
    assert.equal(resMalo.body.ignored, "json inválido");
  });

  // ============ E3 · Backfill del histórico de Shopify ============
  console.log("· E3 — backfill del histórico");

  const backfillOrder = (overrides: Record<string, unknown> = {}) =>
    codPayload(overrides) as unknown as import("../src/lib/shopify/backfill").ShopifyBackfillOrder;

  await test("E3 salvaguarda estructural: el módulo de backfill y su script NO importan WhatsApp/Baileys, ni de lejos", () => {
    const prohibido = [
      /from\s+["'].*\/whatsapp["']/,
      /from\s+["'].*\/baileys/,
      /from\s+["'].*\/orders\/messages["']/,
      /from\s+["'].*\/orders\/confirmation["']/,
      /sendWhatsAppMessage/,
      /enqueueOutbox/,
    ];
    for (const rel of ["src/lib/shopify/backfill.ts", "scripts/shopify-backfill.ts"]) {
      const contenido = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const patron of prohibido) {
        assert.ok(!patron.test(contenido), `${rel} no debe contener ${patron} — un import de WhatsApp aquí es el fallo, no un flag`);
      }
    }
  });

  await test("E3 decideBackfillAction: no-COD y sin señal se saltan; cancelled/fulfilled deciden inserción", () => {
    const noCod = backfillOrder({ id: 995001, gateway: "Tarjeta", payment_gateway_names: ["Tarjeta"], tags: "" });
    assert.equal(backfill.decideBackfillAction(null, noCod).kind, "skip_not_cod");

    const sinSenal = backfillOrder({ id: 995002 }); // ni cancelled_at ni fulfillment_status
    assert.equal(backfill.decideBackfillAction(null, sinSenal).kind, "skip_no_signal");

    const cancelado = backfillOrder({ id: 995003, cancelled_at: "2026-08-20T10:00:00Z" });
    const a1 = backfill.decideBackfillAction(null, cancelado);
    assert.equal(a1.kind, "insert_cancelled");
    assert.equal(a1.signal?.status, "cancelled");
    assert.equal(a1.signal?.at, Math.floor(Date.parse("2026-08-20T10:00:00Z") / 1000), "closure_at es la fecha de Shopify, no now()");

    const despachado = backfillOrder({ id: 995004, fulfillment_status: "fulfilled", updated_at: "2026-08-21T11:00:00Z" });
    const a2 = backfill.decideBackfillAction(null, despachado);
    assert.equal(a2.kind, "insert_in_progress");
    assert.notEqual(a2.signal?.status, "delivered", "fulfilled NUNCA es delivered");
  });

  await test("E3 decideBackfillAction: nunca pisa un pedido que ya tiene closure_source propio (webhook primero)", () => {
    const o = mkOrder("995010", "3910", "34600119910");
    db.setOrderClosure(o.id, "in_progress", "dropea", 1000); // "ya llegó un webhook"
    const conFuente = db.getOrderById(o.id)!;
    const cancelado = backfillOrder({ id: 995010, cancelled_at: "2026-08-20T10:00:00Z" });
    assert.equal(backfill.decideBackfillAction(conFuente, cancelado).kind, "skip_has_own_source");
  });

  await test("E3 decideBackfillAction: pedido existente sin fuente propia (unknown) → update, no insert", () => {
    const o = mkOrder("995011", "3911", "34600119911");
    const existente = db.getOrderById(o.id)!;
    assert.equal(existente.closure_status, "unknown");
    const cancelado = backfillOrder({ id: 995011, cancelled_at: "2026-08-20T10:00:00Z" });
    assert.equal(backfill.decideBackfillAction(existente, cancelado).kind, "update_cancelled");
  });

  await test("E3 runShopifyBackfill (dry-run): cuenta el desglose completo y NO escribe nada ni mueve el checkpoint", async () => {
    const antesCheckpoint = db.getSetting("shopify_backfill_cursor");
    const pagina = {
      orders: [
        backfillOrder({ id: 995101, cancelled_at: "2026-08-20T09:00:00Z" }),
        backfillOrder({ id: 995102, fulfillment_status: "fulfilled", updated_at: "2026-08-20T10:00:00Z" }),
        backfillOrder({ id: 995103, gateway: "Tarjeta", payment_gateway_names: ["Tarjeta"], tags: "" }),
      ],
      nextCursor: null,
    };
    const report = await backfill.runShopifyBackfill({
      dryRun: true,
      pageFetcher: async () => pagina,
    });
    assert.equal(report.summary.toCancelled, 1);
    assert.equal(report.summary.toInProgress, 1);
    assert.equal(report.summary.unchanged, 1);
    assert.equal(report.counts.skip_not_cod, 1);
    assert.equal(db.getOrderByShopifyId("995101"), null, "dry-run no inserta nada");
    assert.equal(db.getSetting("shopify_backfill_cursor"), antesCheckpoint, "dry-run no toca el checkpoint");
  });

  await test("E3 runShopifyBackfill (--apply): inserta con status ignored_old (nunca dispara colas) y actualiza cierre existente", async () => {
    const oExistente = mkOrder("995201", "3920", "34600119920"); // ya en la DB, closure unknown
    const pagina = {
      orders: [
        backfillOrder({ id: 995200, cancelled_at: "2026-08-20T09:00:00Z" }), // NO existe: se inserta
        backfillOrder({ id: 995201, fulfillment_status: "fulfilled", updated_at: "2026-08-20T11:00:00Z" }), // SÍ existe: se actualiza
      ],
      nextCursor: null,
    };
    const report = await backfill.runShopifyBackfill({ dryRun: false, pageFetcher: async () => pagina });
    assert.equal(report.summary.toCancelled, 1);
    assert.equal(report.summary.toInProgress, 1);

    const insertado = db.getOrderByShopifyId("995200")!;
    assert.ok(insertado, "el pedido que no existía se insertó");
    assert.equal(insertado.status, "ignored_old", "jamás pending_send/awaiting_reply: no debe disparar ninguna cola");
    assert.equal(insertado.closure_status, "cancelled");
    assert.equal(insertado.closure_source, "shopify");
    assert.equal(insertado.closure_at, Math.floor(Date.parse("2026-08-20T09:00:00Z") / 1000));

    const actualizado = db.getOrderById(oExistente.id)!;
    assert.equal(actualizado.closure_status, "in_progress");
    assert.equal(actualizado.closure_source, "shopify");
    assert.equal(actualizado.closure_at, Math.floor(Date.parse("2026-08-20T11:00:00Z") / 1000));
    // El status de la máquina de confirmación NO se toca por el backfill.
    assert.equal(actualizado.status, oExistente.status);
  });

  await test("E3 runShopifyBackfill: paginación + checkpoint reanudable — no repite páginas ya completadas", async () => {
    const paginas = [
      { orders: [backfillOrder({ id: 995301, cancelled_at: "2026-08-20T09:00:00Z" })], nextCursor: "cursor-pagina-2" },
      { orders: [backfillOrder({ id: 995302, cancelled_at: "2026-08-20T09:00:00Z" })], nextCursor: null },
    ];
    const cursoresPedidos: Array<string | null> = [];
    const fetcherLimitado: import("../src/lib/shopify/backfill").PageFetcher = async (cursor) => {
      cursoresPedidos.push(cursor);
      return cursor === null ? paginas[0] : paginas[1];
    };

    // Primera ejecución: se detiene tras la página 1 (maxPages: 1) — simula
    // un proceso interrumpido a mitad del histórico.
    const r1 = await backfill.runShopifyBackfill({ dryRun: false, pageFetcher: fetcherLimitado, maxPages: 1, resetCheckpoint: true });
    assert.equal(r1.done, false);
    assert.equal(r1.pagesProcessed, 1);
    assert.equal(db.getSetting("shopify_backfill_cursor"), "cursor-pagina-2", "el checkpoint queda apuntando a la siguiente página");

    // Segunda ejecución (nueva "invocación" del script): SIN resetCheckpoint,
    // debe reanudar desde "cursor-pagina-2", no repetir la página 1.
    const r2 = await backfill.runShopifyBackfill({ dryRun: false, pageFetcher: fetcherLimitado });
    assert.equal(r2.done, true);
    assert.deepEqual(cursoresPedidos, [null, "cursor-pagina-2"], "no se repite el cursor ya procesado");
    assert.ok(db.getOrderByShopifyId("995301"), "lo de la primera ejecución sigue aplicado");
    assert.ok(db.getOrderByShopifyId("995302"), "lo de la segunda ejecución también se aplicó");
    assert.equal(db.getSetting("shopify_backfill_cursor"), "", "al terminar, el checkpoint se limpia");
  });


  // ============ 40 · FASE FINAL — elegibilidad, reconciliación, scopes ============
  console.log("\n— Fase final: elegibilidad + reconciliación + scopes —");

  const { isConfirmationEligible } = await import("../src/lib/orders/eligibility");
  const reconcile = await import("../src/lib/shopify/reconcile");

  await test("F1 elegibilidad: cada bloqueo de dominio con su motivo; el hallazgo 4/5/1 no puede repetirse", () => {
    const base = mkSent("996001", "4001");
    assert.equal(isConfirmationEligible(db.getOrderById(base.id)!).eligible, true);

    // Shopify cancela → fuera, aunque el status operativo siga vivo.
    assert.ok(db.setOrderClosure(base.id, "cancelled", "shopify", 1_800_000_000));
    const tras = isConfirmationEligible(db.getOrderById(base.id)!);
    assert.equal(tras.eligible, false);
    assert.equal(tras.reason, "closure_cancelled");

    // Fulfillment en marcha → fuera (fulfilled NUNCA es delivered, pero SÍ
    // saca al pedido de la confirmación).
    const f = mkSent("996002", "4002");
    assert.ok(db.setOrderClosure(f.id, "in_progress", "shopify", 1_800_000_000));
    assert.equal(isConfirmationEligible(db.getOrderById(f.id)!).reason, "fulfillment_in_progress");

    // Confirmado, histórico y sin teléfono.
    const c = mkSent("996003", "4003");
    db.markOrderConfirmed(c.id, true);
    assert.equal(isConfirmationEligible(db.getOrderById(c.id)!).reason, "already_confirmed");
    const h = db.insertOrderIfNew({
      shopify_order_id: "996004", shopify_order_number: "4004", customer_name: "H", phone: "34600114004",
      email: null, product_summary: "1x Cosa", total_price: "10.00", currency: "EUR",
      address_line1: "Calle 1", address_line2: null, city: "Madrid", province: null,
      postal_code: "28001", country: "España", status: "ignored_old",
    }).order;
    assert.equal(isConfirmationEligible(h).reason, "historical_import");
  });

  await test("F1 scheduler: un pedido con cierre cancelado NO manda confirmación inicial ni escala a needs_call", async () => {
    const o = db.insertOrderIfNew({
      shopify_order_id: "996010", shopify_order_number: "4010", customer_name: "F Uno",
      phone: "34600114010", email: null, product_summary: "1x Cosa", total_price: "19.90",
      currency: "EUR", address_line1: "Calle 3", address_line2: null, city: "Madrid",
      province: null, postal_code: "28001", country: "España", status: "pending_send",
    }).order;
    db.setOrderClosure(o.id, "cancelled", "shopify", 1_800_000_000);
    const delPedido = () => db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    const antes = delPedido();
    await runSchedulerTick();
    assert.equal(delPedido(), antes, "ni un WhatsApp a un pedido cancelado");
    assert.equal(db.getOrderById(o.id)!.status, "pending_send", "tampoco transiciona");
  });

  await test("F1 snapshot: needs_call solo cuenta candidatos reales (cierre desconocido y con teléfono)", () => {
    const a = mkSent("996020", "4020");
    const b = mkSent("996021", "4021");
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("UPDATE orders SET status='needs_call', needs_call_at=unixepoch() WHERE id IN (?,?)").run(a.id, b.id);
    raw.close();
    const antes = businessAlerts.readBusinessSnapshot().needsCallTotal;
    db.setOrderClosure(b.id, "cancelled", "shopify", 1_800_000_000);
    const despues = businessAlerts.readBusinessSnapshot().needsCallTotal;
    assert.equal(despues, antes - 1, "el cancelado en Shopify deja de contar");
  });

  await test("F2 scopes: sin read_all_orders → coverage last_60_days_only; sin poder comprobar → unverified; nunca se afirma histórico completo", async () => {
    const paginaVacia = async () => ({ orders: [], nextCursor: null });
    const r1 = await backfill.runShopifyBackfill({
      dryRun: true, pageFetcher: paginaVacia,
      scopeFetcher: async () => ["read_orders", "write_orders"],
    });
    assert.equal(r1.coverage, "last_60_days_only");
    assert.equal(r1.scopeCheck.hasReadAllOrders, false);
    const r2 = await backfill.runShopifyBackfill({
      dryRun: true, pageFetcher: paginaVacia,
      scopeFetcher: async () => { throw new Error("sin credenciales"); },
    });
    assert.equal(r2.coverage, "unverified");
    assert.match(r2.scopeCheck.error ?? "", /credenciales/);
    const r3 = await backfill.runShopifyBackfill({
      dryRun: true, pageFetcher: paginaVacia,
      scopeFetcher: async () => ["read_orders", "read_all_orders"],
    });
    assert.equal(r3.coverage, "full");
  });

  await test("F3 reconciliación: repara un webhook perdido, no pisa terminales, y detecta creates perdidos", async () => {
    // Pedido local abierto; Shopify dice que se canceló hace 1 h (webhook perdido).
    const o = mkSent("996030", "4030");
    const remoto = (id: number, extra: Record<string, unknown> = {}) => ({
      ...codPayload({ id, order_number: 4030 }),
      cancelled_at: "2026-08-24T08:00:00Z",
      ...extra,
    });
    const r = await reconcile.runShopifyReconcile({
      fetcher: async () => [remoto(996030) as never],
      nowMs: Date.parse("2026-08-24T10:00:00Z"),
    });
    assert.equal(r.repaired, 1);
    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.closure_status, "cancelled");
    assert.equal(fila.closure_source, "shopify");
    assert.equal(fila.closure_at, Math.floor(Date.parse("2026-08-24T08:00:00Z") / 1000), "fecha del evento, no now()");

    // Segunda pasada idéntica: idempotente, nada que reparar.
    const r2 = await reconcile.runShopifyReconcile({
      fetcher: async () => [remoto(996030) as never],
      nowMs: Date.parse("2026-08-24T10:00:00Z"),
    });
    assert.equal(r2.repaired, 0);

    // Conflicto: local dice delivered (Dropea), Shopify dice cancelled más nuevo → NO se pisa.
    const d = mkSent("996031", "4031");
    db.setOrderClosure(d.id, "delivered", "dropea", Math.floor(Date.parse("2026-08-24T07:00:00Z") / 1000));
    const r3 = await reconcile.runShopifyReconcile({
      fetcher: async () => [remoto(996031, { order_number: 4031 }) as never],
      nowMs: Date.parse("2026-08-24T10:00:00Z"),
    });
    assert.equal(r3.conflicts, 1);
    assert.equal(db.getOrderById(d.id)!.closure_status, "delivered", "el terminal autoritativo se queda");

    // Create perdido: existe en Shopify, no localmente → ignored_old + aviso, sin WhatsApp.
    const antes = db.getPendingOutbox(999).length;
    const r4 = await reconcile.runShopifyReconcile({
      fetcher: async () => [remoto(996032, { order_number: 4032 }) as never],
      nowMs: Date.parse("2026-08-24T10:00:00Z"),
    });
    assert.equal(r4.insertedMissing, 1);
    const importado = db.getOrderByShopifyId("996032")!;
    assert.equal(importado.status, "ignored_old");
    assert.equal(importado.closure_status, "cancelled");
    assert.equal(db.getPendingOutbox(999).length, antes, "cero mensajes");
  });

  await test("F3 reconciliación: salvaguarda estructural — sin imports de WhatsApp/Baileys/proveedores", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "shopify", "reconcile.ts"), "utf8");
    for (const pat of [/from\s+["'].*\/whatsapp["']/, /from\s+["'].*\/baileys/, /from\s+["'].*\/suppliers\//, /from\s+["'].*\/calls\//]) {
      assert.ok(!pat.test(src), `import prohibido en reconcile.ts: ${pat}`);
    }
  });

  // ============ E4 · Enlace con Dropea por el tag de Shopify ============
  console.log("\n— E4: enlace con Dropea vía tag dropea_id —");

  const tags = await import("../src/lib/orders/supplier-tags");

  /** Payload COD con los tags que se le pidan. */
  const taggedPayload = (id: number, tagStr: string, extra: Record<string, unknown> = {}) =>
    codPayload({ id, order_number: id % 10000, tags: tagStr, ...extra });

  /** ¿Existe un evento de este tipo para este pedido? */
  const hayEvento = (tipo: string, ref: string) =>
    sysRepo
      .listIntegrationEvents({ integration: "dropea", limit: 500 })
      .some((e) => e.event_type === tipo && e.order_ref === ref);

  // --- Capa 1: el parser, puro ---

  await test("E4 parser: saca el id de entre los demás tags y no confunde `dropea_error`", () => {
    assert.deepEqual(
      tags.extractDropeaIdFromTags(["releasit_cod_form", "dropea_id:1366919", "dropea_error"]),
      { kind: "found", dropeaId: "1366919" }
    );
    // orderTags() ya normaliza a minúsculas/sin espacios sobrantes; el
    // parser además tolera espacios alrededor de los dos puntos.
    assert.deepEqual(tags.extractDropeaIdFromTags(["dropea_id : 1366919"]), {
      kind: "found",
      dropeaId: "1366919",
    });
    // Ceros a la izquierda: se recortan para casar con el id que manda su
    // webhook (String(resource_id), sin relleno).
    assert.deepEqual(tags.extractDropeaIdFromTags(["dropea_id:0001366919"]), {
      kind: "found",
      dropeaId: "1366919",
    });
    // Repetido con el MISMO valor no es ambigüedad.
    assert.deepEqual(tags.extractDropeaIdFromTags(["dropea_id:77", "dropea_id:77"]), {
      kind: "found",
      dropeaId: "77",
    });
    // `dropea_error` solo, sin id, no es candidato a nada.
    assert.deepEqual(tags.extractDropeaIdFromTags(["dropea_error", "sync error - dropi pro"]), {
      kind: "absent",
    });
  });

  await test("E4 parser: sin tag → absent; dos ids distintos → ambiguous; valor no numérico o 0 → malformed", () => {
    assert.deepEqual(tags.extractDropeaIdFromTags([]), { kind: "absent" });
    assert.deepEqual(tags.extractDropeaIdFromTags(["releasit_cod_form"]), { kind: "absent" });

    const amb = tags.extractDropeaIdFromTags(["dropea_id:100", "dropea_id:200"]);
    assert.equal(amb.kind, "ambiguous");
    assert.deepEqual(amb.kind === "ambiguous" ? amb.ids : [], ["100", "200"]);

    // Si su app cambiara el formato, E4 dejaría de enlazar EN SILENCIO. Por
    // eso un valor que no son dígitos se declara roto, no "ausente".
    assert.equal(tags.extractDropeaIdFromTags(["dropea_id:abc"]).kind, "malformed");
    assert.equal(tags.extractDropeaIdFromTags(["dropea_id:"]).kind, "malformed");
    assert.equal(tags.extractDropeaIdFromTags(["dropea_id:0"]).kind, "malformed");
    // Un roto entre válidos tampoco se ignora a la ligera.
    assert.equal(tags.extractDropeaIdFromTags(["dropea_id:55", "dropea_id:x"]).kind, "malformed");
  });

  await test("E4 parser: lee los tags del payload tal cual los manda Shopify (string con comas)", () => {
    assert.deepEqual(
      tags.extractDropeaIdFromPayload(
        taggedPayload(997700, "releasit_cod_form, dropea_id:1366919") as never
      ),
      { kind: "found", dropeaId: "1366919" }
    );
  });

  // --- Capa 2: la escritura ---

  await test("E4 enlace: rellena supplier_external_order_id + platform dropea, y repetirlo no cambia nada", () => {
    const o = mkOrder("997701", "7701", "34600197701");
    const payload = taggedPayload(997701, "releasit_cod_form, dropea_id:1366919") as never;

    const r1 = tags.linkDropeaFromShopifyTags(db.getOrderById(o.id)!, payload, "test");
    assert.equal(r1.linked, true);
    assert.equal(r1.reason, "linked");
    assert.equal(r1.dropeaId, "1366919");

    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.supplier_external_order_id, "1366919");
    assert.equal(fila.supplier_platform, "dropea");
    assert.equal(fila.supplier_sync_status, "synced");
    assert.ok(hayEvento("order_linked_by_tag", "7701"));

    // Idempotente: segunda pasada no reescribe ni marca linked.
    const r2 = tags.linkDropeaFromShopifyTags(db.getOrderById(o.id)!, payload, "test");
    assert.equal(r2.linked, false);
    assert.equal(r2.reason, "already_linked");
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, "1366919");
  });

  await test("E4 enlace: nunca pisa un id externo ya guardado; si el tag dice otro, avisa y no toca", () => {
    const o = mkOrder("997702", "7702", "34600197702");
    db.setOrderSupplierPlatformAndExternalId(o.id, "dropea", "999111");
    const r = tags.linkDropeaFromShopifyTags(
      db.getOrderById(o.id)!,
      taggedPayload(997702, "dropea_id:222333") as never,
      "test"
    );
    assert.equal(r.linked, false);
    assert.equal(r.reason, "already_linked");
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, "999111", "el id guardado manda");
    assert.ok(hayEvento("dropea_link_mismatch", "7702"), "la discrepancia queda registrada para un humano");
  });

  await test("E4 enlace: un dropea_id que ya es de OTRO pedido no se reasigna", () => {
    const dueno = mkOrder("997703", "7703", "34600197703");
    db.setOrderSupplierPlatformAndExternalId(dueno.id, "dropea", "555000");
    const otro = mkOrder("997704", "7704", "34600197704");

    const r = tags.linkDropeaFromShopifyTags(
      db.getOrderById(otro.id)!,
      taggedPayload(997704, "dropea_id:555000") as never,
      "test"
    );
    assert.equal(r.linked, false);
    assert.equal(r.reason, "id_taken_by_other_order");
    assert.equal(db.getOrderById(otro.id)!.supplier_external_order_id, null, "no se inventa un enlace");
    assert.equal(db.getOrderById(dueno.id)!.supplier_external_order_id, "555000", "el dueño no pierde el suyo");
    assert.ok(hayEvento("dropea_link_duplicate", "7704"));
  });

  await test("E4 enlace: tag ambiguo o roto no escribe NADA y deja aviso (capas distintas, avisos distintos)", () => {
    const amb = mkOrder("997705", "7705", "34600197705");
    const rAmb = tags.linkDropeaFromShopifyTags(
      db.getOrderById(amb.id)!,
      taggedPayload(997705, "dropea_id:100, dropea_id:200") as never,
      "test"
    );
    assert.equal(rAmb.reason, "ambiguous_tag");
    assert.equal(db.getOrderById(amb.id)!.supplier_external_order_id, null);
    assert.ok(hayEvento("dropea_tag_ambiguous", "7705"));

    const roto = mkOrder("997706", "7706", "34600197706");
    const rRoto = tags.linkDropeaFromShopifyTags(
      db.getOrderById(roto.id)!,
      taggedPayload(997706, "dropea_id:NNNNNNN") as never,
      "test"
    );
    assert.equal(rRoto.reason, "malformed_tag");
    assert.equal(db.getOrderById(roto.id)!.supplier_external_order_id, null);
    assert.ok(hayEvento("dropea_tag_malformed", "7706"));

    const sinTag = mkOrder("997707", "7707", "34600197707");
    const rSin = tags.linkDropeaFromShopifyTags(
      db.getOrderById(sinTag.id)!,
      taggedPayload(997707, "releasit_cod_form") as never,
      "test"
    );
    assert.equal(rSin.reason, "no_tag");
    assert.equal(db.getOrderById(sinTag.id)!.supplier_platform, null, "sin tag no se toca ni la plataforma");
  });

  await test("E4 enlace: el routing decía dropi, pero el tag es un HECHO — manda el tag y queda constancia", () => {
    const o = mkOrder("997708", "7708", "34600197708");
    db.setOrderSupplierEvaluation(o.id, "dropi", "pending", "sin mapping de Dropea");
    assert.equal(db.getOrderById(o.id)!.supplier_platform, "dropi");

    const r = tags.linkDropeaFromShopifyTags(
      db.getOrderById(o.id)!,
      taggedPayload(997708, "dropea_id:424242") as never,
      "test"
    );
    assert.equal(r.linked, true);
    assert.equal(db.getOrderById(o.id)!.supplier_platform, "dropea", "el pedido YA existe en Dropea");
    assert.ok(hayEvento("dropea_link_platform_override", "7708"));
  });

  // --- Capa 3: canal `orders/updated` (espejo acordado de UN solo campo) ---

  await test("E4 orders/updated: enlaza por tag y NO toca el eje de cierre (capas separadas)", () => {
    const o = mkOrder("997710", "7710", "34600197710");
    const antes = db.getOrderById(o.id)!;
    const raw = JSON.stringify(
      taggedPayload(997710, "releasit_cod_form, dropea_id:1366920", { updated_at: "2026-08-24T10:00:00Z" })
    );
    const res = processOrdersEventWebhook(
      raw,
      shopifyHeaders(raw, { topic: "orders/updated", webhookId: "wh-e4-upd-1" })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.dropea_linked, true);
    assert.equal(res.body.dropea_id, "1366920");

    const despues = db.getOrderById(o.id)!;
    assert.equal(despues.supplier_external_order_id, "1366920");
    assert.equal(despues.closure_status, antes.closure_status, "el eje de cierre sigue intacto");
    assert.equal(despues.closure_source, antes.closure_source);
    assert.equal(despues.closure_at, antes.closure_at);
  });

  await test("E4 orders/updated SIN tag: sigue siendo cero escritura, ni siquiera updated_at", () => {
    const o = mkOrder("997711", "7711", "34600197711");
    const antes = db.getOrderById(o.id)!;
    const raw = JSON.stringify(taggedPayload(997711, "releasit_cod_form"));
    const res = processOrdersEventWebhook(
      raw,
      shopifyHeaders(raw, { topic: "orders/updated", webhookId: "wh-e4-upd-2" })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.dropea_linked, false);
    const despues = db.getOrderById(o.id)!;
    assert.equal(despues.supplier_external_order_id, null);
    assert.equal(despues.updated_at, antes.updated_at, "sin tag, el espejo no escribe nada");
  });

  await test("E4 orders/updated: el dedupe por webhook-id sigue delante del espejo", () => {
    const o = mkOrder("997712", "7712", "34600197712");
    const raw1 = JSON.stringify(taggedPayload(997712, "dropea_id:700001"));
    processOrdersEventWebhook(raw1, shopifyHeaders(raw1, { topic: "orders/updated", webhookId: "wh-e4-dup" }));
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, "700001");

    // Reentrega con el MISMO webhook-id y payload distinto: ni se mira el tag.
    const raw2 = JSON.stringify(taggedPayload(997712, "dropea_id:700002"));
    const res2 = processOrdersEventWebhook(
      raw2,
      shopifyHeaders(raw2, { topic: "orders/updated", webhookId: "wh-e4-dup" })
    );
    assert.equal(res2.body.duplicate, true);
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, "700001");
  });

  // --- Capa 4: canal reconciliación ---

  await test("E4 reconciliación: enlaza aunque el pedido no traiga señal de cierre", async () => {
    const o = mkOrder("997720", "7720", "34600197720");
    const r = await reconcile.runShopifyReconcile({
      // Sin cancelled_at ni fulfillment_status: cero señal de cierre.
      fetcher: async () => [taggedPayload(997720, "releasit_cod_form, dropea_id:810001") as never],
      nowMs: Date.parse("2026-08-24T10:00:00Z"),
    });
    assert.equal(r.linkedDropea, 1);
    assert.equal(r.repaired, 0, "el eje de cierre no se toca");
    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.supplier_external_order_id, "810001");
    assert.equal(fila.closure_status, "unknown");

    // Segunda pasada: idempotente.
    const r2 = await reconcile.runShopifyReconcile({
      fetcher: async () => [taggedPayload(997720, "releasit_cod_form, dropea_id:810001") as never],
      nowMs: Date.parse("2026-08-24T11:00:00Z"),
    });
    assert.equal(r2.linkedDropea, 0);
  });

  await test("E4 reconciliación: el create perdido que se importa también queda enlazado", async () => {
    const r = await reconcile.runShopifyReconcile({
      fetcher: async () => [
        taggedPayload(997721, "releasit_cod_form, dropea_id:810002", {
          cancelled_at: "2026-08-24T08:00:00Z",
        }) as never,
      ],
      nowMs: Date.parse("2026-08-24T10:00:00Z"),
    });
    assert.equal(r.insertedMissing, 1);
    assert.equal(r.linkedDropea, 1);
    const importado = db.getOrderByShopifyId("997721")!;
    assert.equal(importado.status, "ignored_old", "sigue sin entrar en ninguna cola");
    assert.equal(importado.supplier_external_order_id, "810002");
    assert.equal(importado.closure_status, "cancelled");
  });

  // --- Capa 5: canal backfill ---

  await test("E4 backfill decideDropeaLink: decisión pura, sin DB ni red", () => {
    const conTag = taggedPayload(997730, "dropea_id:900001") as never;
    const sinTag = taggedPayload(997731, "releasit_cod_form") as never;
    const noCod = codPayload({
      id: 997732,
      tags: "dropea_id:900002",
      gateway: "Tarjeta",
      payment_gateway_names: ["Tarjeta"],
      financial_status: "paid",
    }) as never;

    assert.equal(backfill.decideDropeaLink(null, conTag, true), "link");
    assert.equal(backfill.decideDropeaLink(null, conTag, false), "no_local_order");
    assert.equal(backfill.decideDropeaLink(null, sinTag, true), "no_tag");
    assert.equal(backfill.decideDropeaLink(null, noCod, true), "not_cod");
    assert.equal(
      backfill.decideDropeaLink(
        { supplier_external_order_id: "ya-tengo" } as never,
        conTag,
        false
      ),
      "already_linked"
    );
    assert.equal(
      backfill.decideDropeaLink(null, taggedPayload(997733, "dropea_id:a, dropea_id:b") as never, true),
      "tag_unusable"
    );
  });

  await test("E4 backfill dry-run: cuenta lo que enlazaría y NO escribe nada", async () => {
    const o = mkOrder("997740", "7740", "34600197740");
    const pagina = async () => ({
      orders: [taggedPayload(997740, "releasit_cod_form, dropea_id:910001") as never],
      nextCursor: null,
    });
    const r = await backfill.runShopifyBackfill({
      dryRun: true,
      pageFetcher: pagina,
      scopeFetcher: async () => ["read_orders", "read_all_orders"],
      resetCheckpoint: true,
    });
    assert.equal(r.dropeaLink.link, 1, "el dry-run desglosa el enlace, no solo un contador plano");
    assert.equal(r.dropeaLinked, 0, "en dry-run no se escribe ni un enlace");
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, null);
  });

  await test("E4 backfill --apply: enlaza el pedido existente y el que importa en la misma pasada", async () => {
    const o = mkOrder("997741", "7741", "34600197741");
    const pagina = async () => ({
      orders: [
        taggedPayload(997741, "releasit_cod_form, dropea_id:910002") as never,
        // Este no existe localmente y trae señal de cierre → se inserta y se
        // enlaza en la misma pasada (el enlace se aplica tras el INSERT).
        taggedPayload(997742, "releasit_cod_form, dropea_id:910003", {
          cancelled_at: "2026-08-24T08:00:00Z",
        }) as never,
        // Sin tag: no cuenta en el eje de enlace.
        taggedPayload(997743, "releasit_cod_form") as never,
      ],
      nextCursor: null,
    });
    const antesOutbox = db.getPendingOutbox(999).length;
    const r = await backfill.runShopifyBackfill({
      dryRun: false,
      pageFetcher: pagina,
      scopeFetcher: async () => ["read_orders", "read_all_orders"],
      resetCheckpoint: true,
    });
    assert.equal(r.dropeaLink.link, 2);
    assert.equal(r.dropeaLinked, 2);
    assert.equal(r.dropeaLink.no_tag, 1);
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, "910002");
    const importado = db.getOrderByShopifyId("997742")!;
    assert.equal(importado.supplier_external_order_id, "910003");
    assert.equal(importado.status, "ignored_old");
    assert.equal(db.getPendingOutbox(999).length, antesOutbox, "cero mensajes: el backfill no habla con nadie");
  });

  // --- Consecuencia de E4 sobre postventa: el histórico enlazado no escribe ---

  await test("E4 · gate ignored_old: un pedido de historial enlazado y con tracking NO le escribe al cliente", () => {
    // Cadena real que abre E4: el backfill importa un pedido antiguo como
    // ignored_old → lo enlaza por tag → queda en el polling de tracking →
    // el proveedor responde "shipped". Antes de este gate, eso encolaba un
    // "tu pedido ya está en camino" a un cliente de hace dos meses.
    const o = mkOrder("997750", "7750", "34600197750");
    assert.equal(db.markOrderIgnoredOld(o.id, "backfilled_from_shopify"), true);
    tags.linkDropeaFromShopifyTags(
      db.getOrderById(o.id)!,
      taggedPayload(997750, "releasit_cod_form, dropea_id:920001") as never,
      "test"
    );
    assert.equal(db.getOrderById(o.id)!.supplier_external_order_id, "920001");

    const antes = db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, {
      rawStatus: "shipped",
      trackingNumber: "TRK-HIST",
      trackingUrl: "https://track.example/TRK-HIST",
      source: "polling",
    });
    assert.ok(r.events.includes("TRACKING_AVAILABLE"), "el evento SÍ ocurre: la trazabilidad no se pierde");
    assert.deepEqual(r.notified, [], "pero no se avisa a nadie");
    assert.equal(
      db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length,
      antes,
      "cero mensajes encolados"
    );
    assert.equal(
      db.getOrderById(o.id)!.tracking_notification_sent_at,
      null,
      "ni siquiera se gasta el sello: si algún día se reactiva a mano, el aviso sigue disponible"
    );
    assert.equal(db.getOrderById(o.id)!.tracking_number, "TRK-HIST", "el estado de envío sí se guarda");
  });

  // --- Salvaguarda estructural del módulo nuevo ---

  await test("E4 salvaguarda estructural: supplier-tags.ts no importa WhatsApp/Baileys/proveedores", () => {
    // Lo consumen el backfill y la reconciliación, que tienen prohibido
    // arrastrar WhatsApp o clientes de proveedor. Si este módulo importara
    // uno, el test de aquellos pasaría igual (solo miran SU fichero) y la
    // salvaguarda se habría roto en silencio. Por eso también se mira aquí.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "orders", "supplier-tags.ts"),
      "utf8"
    );
    for (const pat of [
      /from\s+["'].*\/whatsapp["']/,
      /from\s+["'].*\/baileys/,
      /from\s+["'].*\/suppliers\//,
      /from\s+["'].*\/orders\/messages["']/,
      /from\s+["'].*\/orders\/confirmation["']/,
      /sendWhatsAppMessage/,
      /enqueueOutbox/,
    ]) {
      assert.ok(!pat.test(src), `import prohibido en supplier-tags.ts: ${pat}`);
    }
  });

  // ============ 41 · E7 — franjas, calendario y textos ============
  console.log("· E7 — franjas horarias, festivos y formatos");

  const sched = await import("../src/lib/calls/schedule");
  const calendar = await import("../src/lib/calls/calendar");
  const spanish = await import("../src/lib/calls/spanish");
  const sinFestivos = () => false;
  /** Date en hora de Madrid (construida con la utilidad real, testeada aparte). */
  const md = (y: number, mo: number, d: number, h: number, mi: number) => sched.madridDate(y, mo, d, h, mi);

  await test("E7 franjas: los 6 casos obligatorios + domingo + festivo", () => {
    const slot = (d: Date) => sched.nextCallSlot(d, sinFestivos);
    // martes 01-09-2026, laborable
    assert.equal(slot(md(2026, 9, 1, 15, 0)).getTime(), md(2026, 9, 1, 17, 0).getTime(), "15:00 → 17:00");
    assert.equal(slot(md(2026, 9, 1, 1, 0)).getTime(), md(2026, 9, 1, 9, 0).getTime(), "01:00 → 09:00");
    assert.equal(slot(md(2026, 9, 1, 10, 0)).getTime(), md(2026, 9, 1, 10, 0).getTime(), "10:00 ya es legal (el +15 se aplica antes)");
    assert.equal(slot(md(2026, 9, 1, 13, 10)).getTime(), md(2026, 9, 1, 17, 0).getTime(), "12:55+15 → 13:10 → 17:00");
    assert.equal(slot(md(2026, 9, 1, 20, 10)).getTime(), md(2026, 9, 2, 9, 0).getTime(), "19:55+cadencia → día siguiente 09:00");
    // sábado 05-09-2026 19:50+ → lunes 07-09 09:00
    assert.equal(slot(md(2026, 9, 5, 20, 5)).getTime(), md(2026, 9, 7, 9, 0).getTime(), "sábado noche → lunes 09:00");
    // domingo 06-09 → lunes
    assert.equal(slot(md(2026, 9, 6, 11, 0)).getTime(), md(2026, 9, 7, 9, 0).getTime(), "domingo jamás");
    // festivo lunes 12-10-2026 (Fiesta Nacional) con calendario real → martes 13
    assert.equal(
      sched.nextCallSlot(md(2026, 10, 12, 11, 0), calendar.defaultHolidayCalendar).getTime(),
      md(2026, 10, 13, 9, 0).getTime(),
      "festivo nacional en lunes → martes 09:00"
    );
  });

  await test("E7 franjas: cambio horario de marzo y de octubre (DST real, sin offset fijo)", () => {
    // Sábado 28-03-2026 20:30 → lunes 30-03 09:00 CEST (UTC+2 → 07:00Z)
    const marzo = sched.nextCallSlot(md(2026, 3, 28, 20, 30), sinFestivos);
    assert.equal(marzo.toISOString(), "2026-03-30T07:00:00.000Z");
    // Sábado 24-10-2026 20:30 → lunes 26-10 09:00 CET (UTC+1 → 08:00Z)
    const octubre = sched.nextCallSlot(md(2026, 10, 24, 20, 30), sinFestivos);
    assert.equal(octubre.toISOString(), "2026-10-26T08:00:00.000Z");
    // insideCallWindow coherente en ambos regímenes
    assert.equal(sched.insideCallWindow(new Date("2026-03-30T07:30:00Z"), sinFestivos), true);
    assert.equal(sched.insideCallWindow(new Date("2026-10-26T07:30:00Z"), sinFestivos), false, "07:30Z en invierno = 08:30 Madrid, fuera");
  });

  await test("E7 calendario: festivos nacionales CALCULADOS para cualquier año (no caducan) + extras por config", () => {
    const h26 = calendar.spanishNationalHolidays(2026);
    assert.ok(h26.includes("2026-12-25") && h26.includes("2026-10-12"));
    assert.ok(h26.includes("2026-04-03"), "Viernes Santo 2026 calculado (Pascua 05-04)");
    const h27 = calendar.spanishNationalHolidays(2027);
    assert.ok(h27.includes("2027-03-26"), "Viernes Santo 2027 calculado (Pascua 28-03)");
    db.setSetting("call_holidays_extra", "2026-09-08");
    assert.equal(calendar.defaultHolidayCalendar("2026-09-08"), true, "festivo extra configurado sin tocar código");
    db.setSetting("call_holidays_extra", "");
  });

  await test("E7 textos: importe en palabras, unidades y fecha relativa deterministas", () => {
    assert.equal(spanish.importeEnPalabras("29.95"), "veintinueve euros con noventa y cinco céntimos");
    assert.equal(spanish.importeEnPalabras("1.01"), "un euro con un céntimo");
    assert.equal(spanish.importeEnPalabras("100"), "cien euros");
    assert.equal(spanish.importeEnPalabras("134.50"), "ciento treinta y cuatro euros con cincuenta céntimos");
    assert.equal(spanish.unidadesEnTexto(1), "una unidad");
    assert.equal(spanish.unidadesEnTexto(2), "dos unidades");
    const ahora = md(2026, 9, 3, 10, 0);
    const ayer = Math.floor(md(2026, 9, 2, 22, 0).getTime() / 1000);
    assert.equal(spanish.fechaPedidoRelativa(ayer, ahora), "ayer");
    assert.equal(spanish.fechaPedidoRelativa(Math.floor(md(2026, 9, 3, 1, 0).getTime() / 1000), ahora), "hoy");
    assert.equal(spanish.fechaPedidoRelativa(Math.floor(md(2026, 8, 29, 12, 0).getTime() / 1000), ahora), "hace cinco días");
    assert.ok(spanish.currentDatetimeMadrid(ahora).includes("septiembre"));
  });

  // ============ 42 · E7 — orquestador: cola, marcación, resultados ============
  console.log("· E7 — orquestador de llamadas");

  const calls = await import("../src/lib/calls/scheduler");
  const callsCfg = await import("../src/lib/calls/config");
  const { RESULT_OUTCOMES, CALL_RESULTS, parseCallResult } = await import("../src/lib/calls/results");
  const { buildCallPayload, toE164 } = await import("../src/lib/calls/payload");
  const { retellProvider } = await import("../src/lib/calls/retell");
  const providerMod = await import("../src/lib/calls/provider");

  /** Proveedor de mentira: cuenta llamadas y permite forzar fallos. */
  let mockCallSeq = 0; // ids ÚNICOS entre todos los mocks (índice único global en DB)
  function mkProvider(opts: { fail?: boolean } = {}) {
    const created: Array<{ toNumber: string; variables: Record<string, string>; metadata: Record<string, string> }> = [];
    const provider: import("../src/lib/calls/provider").CallProvider = {
      name: "mock",
      isConfigured: () => true,
      async createOutboundCall(req) {
        if (opts.fail) throw new providerMod.ProviderRequestError("mock: rechazado", 500);
        created.push({ toNumber: req.toNumber, variables: req.dynamicVariables, metadata: req.metadata });
        return { providerCallId: `mock-call-${++mockCallSeq}` };
      },
      verifyWebhook: () => true,
      parseEvent: () => null,
    };
    return { provider, created };
  }

  // Instante fijo DENTRO de franja: martes 01-09-2026 10:30 Madrid.
  const enFranja = md(2026, 9, 1, 10, 30);

  /** Pedido listo para llamar: WhatsApp enviado hace 30 min (RELATIVO al
   *  instante fijo de los tests, no al reloj real), sin respuesta. */
  const mkCallable = (shopifyId: string, num: string, phone: string, sentAgoMin = 30) => {
    const o = db.insertOrderIfNew({
      shopify_order_id: shopifyId, shopify_order_number: num, customer_name: "Cliente Llamada",
      phone, email: null, product_summary: "1x Cortaúñas Eléctrico 3 en 1",
      total_price: "29.95", currency: "EUR", address_line1: "Calle Mayor 5", address_line2: null,
      city: "Almería", province: "Almería", postal_code: "04001", country: "España",
      status: "pending_send",
      raw_payload: JSON.stringify({ line_items: [{ title: "Cortaúñas Eléctrico 3 en 1", quantity: 1, price: "29.95", sku: "10428" }] }),
    }).order;
    db.claimOrderInitialSend(o.id, Math.floor(enFranja.getTime() / 1000) - sentAgoMin * 60);
    return db.getOrderById(o.id)!;
  };

  const noHoliday = () => false;

  /** Deja la config de llamadas en un estado conocido. */
  const resetCallCfg = () => {
    db.setSetting("ai_calls_enabled", "0");
    db.setSetting("calls_shadow_mode", "1");
    db.setSetting("calls_daily_cap", "30");
    db.setSetting("calls_allowlist", "");
  };
  resetCallCfg();

  await test("E7 defaults seguros: kill switch OFF y shadow ON tras el deploy", () => {
    db.setSetting("ai_calls_enabled", "");
    db.setSetting("calls_shadow_mode", "");
    assert.equal(callsCfg.aiCallsEnabled(), false, "AI_CALLS_ENABLED off por defecto");
    assert.equal(callsCfg.callsShadowMode(), true, "shadow on por defecto");
    resetCallCfg();
  });

  await test("E7 encolar: WhatsApp sin respuesta ≥15 min entra; el que respondió no; prioriza importe", () => {
    const a = mkCallable("997001", "4101", "34600117001", 30);
    const contestado = mkCallable("997002", "4102", "34600117002", 30);
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("UPDATE orders SET customer_replied_at = unixepoch() WHERE id = ?").run(contestado.id);
    raw.close();
    const reciente = mkCallable("997003", "4103", "34600117003", 5); // solo 5 min

    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    assert.ok(db.getActiveCallAttemptForOrder(a.id), "30 min sin respuesta → en cola");
    assert.equal(db.getActiveCallAttemptForOrder(contestado.id), null, "respondió → jamás");
    assert.equal(db.getActiveCallAttemptForOrder(reciente.id), null, "5 min → todavía no");
    const attempt = db.getActiveCallAttemptForOrder(a.id)!;
    assert.equal(attempt.contact_number, 1);
    // Programado dentro de franja legal.
    assert.ok(sched.insideCallWindow(new Date(attempt.scheduled_at * 1000), noHoliday));
  });

  await test("E7 encolar (disparador B): envío inicial que no salió en 60 min → entra ya; DNC no entra", () => {
    const sinWa = db.insertOrderIfNew({
      shopify_order_id: "997010", shopify_order_number: "4110", customer_name: "Sin WhatsApp",
      phone: "34600117010", email: null, product_summary: "1x Cortaúñas", total_price: "29.95",
      currency: "EUR", address_line1: "Calle 2", address_line2: null, city: "Almería",
      province: null, postal_code: "04001", country: "España", status: "pending_send",
    }).order;
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("UPDATE orders SET created_at = ? WHERE id = ?").run(Math.floor(enFranja.getTime() / 1000) - 3700, sinWa.id);
    raw.close();
    const bloqueado = mkCallable("997011", "4111", "34600117011", 30);
    db.addDncPhone("34600117011", "test", { reason: "prueba" });

    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    assert.ok(db.getActiveCallAttemptForOrder(sinWa.id), "envío que nunca salió → cola de llamadas");
    assert.equal(db.getActiveCallAttemptForOrder(bloqueado.id), null, "DNC no entra ni en la cola");
  });

  await test("E7 shadow: calcula candidato y payload, lo registra UNA vez, y NO contacta al proveedor", async () => {
    resetCallCfg(); // shadow ON, calls OFF
    const o = mkCallable("997020", "4120", "34600117020", 30);
    db.setSetting("calls_allowlist", "34600117020"); // aísla el test del resto de la cola
    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    const { provider, created } = mkProvider();
    const r1 = await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(created.length, 0, "shadow: cero llamadas reales");
    assert.ok(r1.shadowLogged >= 1);
    const attempt = db.getActiveCallAttemptForOrder(o.id)!;
    assert.equal(attempt.state, "planned");
    assert.ok(attempt.shadow_logged_at, "candidato registrado");
    const r2 = await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(r2.shadowLogged, 0, "no se re-registra en cada tick");
    resetCallCfg();
  });

  await test("E7 kill switch: OFF y sin shadow → ni una llamada; ON → marca de verdad con payload mínimo exacto", async () => {
    const o = mkCallable("997021", "4121", "34600117021", 30);
    db.setSetting("calls_allowlist", "34600117021");
    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    const { provider, created } = mkProvider();

    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "0");
    await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(created.length, 0, "kill switch cerrado: nada");

    db.setSetting("ai_calls_enabled", "1");
    const r = await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(r.dialed, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].toNumber, "+34600117021");
    const vars = created[0].variables;
    assert.deepEqual(Object.keys(vars).sort(), [
      "codigo_postal", "current_datetime", "direccion", "fecha_pedido", "importe_total",
      "localidad", "nombre_cliente", "numero_pedido", "producto", "telefono", "unidades",
    ], "EXACTAMENTE las variables acordadas, ni una más");
    assert.equal(vars.importe_total, "veintinueve euros con noventa y cinco céntimos");
    assert.equal(vars.unidades, "una unidad");
    const attempt = db.getActiveCallAttemptForOrder(o.id)!;
    assert.equal(attempt.state, "in_flight");
    assert.ok(attempt.provider_call_id?.startsWith("mock-call-"));
    resetCallCfg();
  });

  await test("E7 validación previa: cada campo obligatorio ausente → NO se llama y va a revisión con missing_data", async () => {
    const casos: Array<[string, Record<string, unknown>]> = [
      ["nombre_cliente", { customer_name: null }],
      ["producto", { product_summary: "" }],
      ["importe_total", { total_price: "no-num" }],
      ["direccion", { address_line1: null }],
      ["localidad", { city: "-" }],
    ];
    let n = 30;
    for (const [campo, override] of casos) {
      n++;
      const tel = `346001171${String(n).padStart(2, "0")}`;
      const o = mkCallable(`9970${n}`, `41${n}`, tel, 30);
      const Database = require("better-sqlite3");
      const raw = new Database(path.join(tmpDir, "messages.db"));
      for (const [k, v] of Object.entries(override)) {
        raw.prepare(`UPDATE orders SET ${k} = ? WHERE id = ?`).run(v as never, o.id);
      }
      raw.close();
      const fila = db.getOrderById(o.id)!;
      const payload = buildCallPayload(fila, enFranja);
      assert.equal(payload.ok, false);
      assert.ok(payload.missing.includes(campo), `falta ${campo}`);

      db.setSetting("calls_allowlist", tel);
      db.setSetting("calls_shadow_mode", "0");
      db.setSetting("ai_calls_enabled", "1");
      calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      const { provider, created } = mkProvider();
      await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
      assert.equal(created.length, 0, `con ${campo} ausente el proveedor recibe CERO llamadas`);
      const attempts = db.listCallAttemptsForOrder(o.id);
      assert.equal(attempts[attempts.length - 1].state, "manual_review");
      assert.match(attempts[attempts.length - 1].reason ?? "", /missing_data/);
    }
    // teléfono inválido
    assert.equal(toE164("12"), null);
    assert.equal(toE164("34600117001"), "+34600117001");
    resetCallCfg();
  });

  await test("E7 carreras: confirmación WhatsApp / cancelación Shopify / fulfillment / DNC justo antes de marcar → NO CALL", async () => {
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    const escenarios: Array<[string, (o: import("../src/lib/db").OrderRow) => void]> = [
      ["confirma por WhatsApp", (o) => db.markOrderConfirmed(o.id, true)],
      ["Shopify cancela", (o) => void db.setOrderClosure(o.id, "cancelled", "shopify", 1_800_000_000)],
      ["Shopify despacha (fulfillment)", (o) => void db.setOrderClosure(o.id, "in_progress", "shopify", 1_800_000_000)],
      ["entra en DNC", (o) => db.addDncPhone(o.phone, "test")],
    ];
    let n = 40;
    for (const [nombre, sabotea] of escenarios) {
      n++;
      const tel = `346001172${String(n).padStart(2, "0")}`;
      const o = mkCallable(`9971${n}`, `42${n}`, tel, 30);
      db.setSetting("calls_allowlist", tel);
      calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      assert.ok(db.getActiveCallAttemptForOrder(o.id), `${nombre}: estaba en cola`);
      sabotea(db.getOrderById(o.id)!); // ← ocurre DESPUÉS de planificar
      const { provider, created } = mkProvider();
      await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
      assert.equal(created.length, 0, `${nombre}: NO se llama`);
      const activo = db.getActiveCallAttemptForOrder(o.id);
      assert.equal(activo, null, `${nombre}: el intento quedó cancelado`);
    }
    resetCallCfg();
  });

  await test("E7 concurrencia: dos workers sobre el mismo intento → una sola llamada; y jamás dos intentos vivos por pedido", async () => {
    const tel = "34600117300";
    const o = mkCallable("997300", "4300", tel, 30);
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    const attempt = db.getActiveCallAttemptForOrder(o.id)!;
    // Claim atómico: solo el primero gana.
    assert.equal(db.claimCallAttempt(attempt.id), true);
    assert.equal(db.claimCallAttempt(attempt.id), false, "el segundo worker no puede reclamarlo");
    // Y el índice único impide un segundo intento vivo del mismo pedido.
    assert.equal(db.insertCallAttempt(o.id, 2, attempt.scheduled_at), null);
    // devolver a planned para no dejar basura
    db.transitionCallAttempt(attempt.id, ["reserved"], "cancelled", { reason: "test" });
    resetCallCfg();
  });

  await test("E7 crash al marcar: fila en 'dialing' NUNCA se re-marca sola → revisión provider_unknown_state", async () => {
    const tel = "34600117301";
    const o = mkCallable("997301", "4301", tel, 30);
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    const attempt = db.getActiveCallAttemptForOrder(o.id)!;
    // Simula el crash: reclamado y en 'dialing', el proceso muere sin guardar call_id.
    db.claimCallAttempt(attempt.id);
    db.transitionCallAttempt(attempt.id, ["reserved"], "dialing");
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    raw.prepare("UPDATE call_attempts SET updated_at = unixepoch() - 900 WHERE id = ?").run(attempt.id);
    raw.close();

    const { provider, created } = mkProvider();
    await calls.runCallOrchestratorTick({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(created.length, 0, "cero llamadas nuevas para ese pedido");
    assert.equal(db.getCallAttempt(attempt.id)!.state, "manual_review");
    assert.match(db.getCallAttempt(attempt.id)!.reason ?? "", /provider_unknown_state/);
    resetCallCfg();
  });

  await test("E7 tope diario: al llegar al cap se dejan de marcar llamadas y queda evento", async () => {
    // Día distinto para no contar llamadas de otros tests: miércoles 02-09.
    const dia2 = md(2026, 9, 2, 10, 30);
    const t1 = "34600117310";
    const t2 = "34600117311";
    const o1 = mkCallable("997310", "4310", t1, 30);
    const o2 = mkCallable("997311", "4311", t2, 30);
    db.setSetting("calls_allowlist", `${t1},${t2}`);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    db.setSetting("calls_daily_cap", "1");
    calls.enqueueDueOrders({ now: dia2, isHoliday: noHoliday });
    const { provider, created } = mkProvider();
    const antes = sysRepo.countIntegrationEvents("system", "call_daily_cap_reached", 0);
    await calls.dialDueAttempts({ now: dia2, provider, isHoliday: noHoliday });
    assert.equal(created.length, 1, "solo una llamada: el cap corta la segunda");
    const enVuelo = [o1, o2].filter((o) => db.getActiveCallAttemptForOrder(o.id)?.state === "in_flight");
    assert.equal(enVuelo.length, 1, "exactamente una en vuelo; la otra sigue en cola");
    // Segundo tick del mismo día: cap ya alcanzado → ninguna más y evento registrado.
    await calls.dialDueAttempts({ now: dia2, provider, isHoliday: noHoliday });
    assert.equal(created.length, 1);
    assert.ok(sysRepo.countIntegrationEvents("system", "call_daily_cap_reached", 0) > antes);
    resetCallCfg();
  });

  // ============ 43 · E7 — resultados, reintentos, DNC, webhook ============
  console.log("· E7 — resultados y webhook");

  /** Marca una llamada real con el mock y devuelve el intento in_flight. */
  async function dialOne(shopifyId: string, num: string, tel: string, when = enFranja) {
    const o = mkCallable(shopifyId, num, tel, 30);
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    db.setSetting("calls_daily_cap", "500");
    calls.enqueueDueOrders({ now: when, isHoliday: noHoliday });
    const { provider, created } = mkProvider();
    await calls.dialDueAttempts({ now: when, provider, isHoliday: noHoliday });
    assert.equal(created.length, 1, "la llamada salió");
    const attempt = db.getActiveCallAttemptForOrder(o.id)!;
    assert.equal(attempt.state, "in_flight");
    return { order: db.getOrderById(o.id)!, attempt };
  }

  /** Evento call_analyzed parseado, como lo guardaría el webhook. */
  const analyzedEvent = (callId: string, analysis: Record<string, unknown>, atS = Math.floor(enFranja.getTime() / 1000)) => ({
    type: "call_analyzed" as const,
    providerCallId: callId,
    eventAt: atS,
    providerStatus: "ended",
    disconnectionReason: null,
    durationMs: 42_000,
    analysis,
  });

  await test("E7 tabla de resultados: cada enum tiene su fila y coincide con la especificación", () => {
    assert.equal(CALL_RESULTS.length, 12);
    const esperado: Record<string, { retry: boolean; consume: boolean }> = {
      confirmado: { retry: false, consume: true },
      confirmado_con_correccion: { retry: false, consume: true },
      cancelado: { retry: false, consume: true },
      no_reconoce_pedido: { retry: false, consume: true },
      numero_equivocado: { retry: false, consume: true },
      no_volver_a_llamar: { retry: false, consume: true },
      incidencia_precio: { retry: false, consume: true },
      no_disponible: { retry: false, consume: true },
      rellamar: { retry: true, consume: false },
      no_contesta: { retry: true, consume: true },
      buzon_de_voz: { retry: true, consume: true },
      fallo_tecnico: { retry: true, consume: false },
    };
    for (const r of CALL_RESULTS) {
      assert.equal(RESULT_OUTCOMES[r].retry, esperado[r].retry, `${r}.retry`);
      assert.equal(RESULT_OUTCOMES[r].consume, esperado[r].consume, `${r}.consume`);
    }
    assert.equal(RESULT_OUTCOMES.confirmado.confirm, true);
    assert.equal(RESULT_OUTCOMES.cancelado.closeCancelled, true);
    assert.equal(RESULT_OUTCOMES.no_reconoce_pedido.closeCancelled, true);
    assert.equal(RESULT_OUTCOMES.no_volver_a_llamar.dnc, true);
    assert.equal(RESULT_OUTCOMES.incidencia_precio.review, true);
    assert.equal(parseCallResult(" Confirmado "), "confirmado");
    assert.equal(parseCallResult("algo_rarisimo"), null);
    assert.equal(parseCallResult(42), null);
  });

  await test("E7 confirmado por llamada: marca confirmación, NUNCA delivered; el cierre sigue unknown", async () => {
    const { order, attempt } = await dialOne("997400", "4400", "34600117400");
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "confirmado" }), enFranja, noHoliday);
    const fila = db.getOrderById(order.id)!;
    assert.equal(fila.status, "confirmed");
    assert.equal(fila.closure_status, "unknown", "confirmar NO cierra: la entrega la dirá el proveedor");
    assert.equal(db.getCallAttempt(attempt.id)!.state, "completed");
    assert.equal(db.getActiveCallAttemptForOrder(order.id), null, "sin reintentos tras confirmar");
    resetCallCfg();
  });

  await test("E7 cancelado por llamada: closure cancelled/llamada_ia con fecha del evento; conflicto con terminal NO pisa", async () => {
    const { order, attempt } = await dialOne("997401", "4401", "34600117401");
    const ts = Math.floor(enFranja.getTime() / 1000);
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "cancelado" }, ts), enFranja, noHoliday);
    const fila = db.getOrderById(order.id)!;
    assert.equal(fila.closure_status, "cancelled");
    assert.equal(fila.closure_source, "llamada_ia");
    assert.equal(fila.closure_at, ts);
    assert.equal(fila.status, "cancelled", "también el eje operativo");

    // Conflicto: Dropea ya dijo delivered → la llamada NO lo pisa.
    const { order: o2, attempt: a2 } = await dialOne("997402", "4402", "34600117402");
    db.setOrderClosure(o2.id, "delivered", "dropea", ts - 100);
    const antes = sysRepo.countIntegrationEvents("system", "call_closure_conflict", 0);
    calls.applyCallAnalysis(a2, analyzedEvent(a2.provider_call_id!, { resultado: "no_reconoce_pedido" }, ts), enFranja, noHoliday);
    assert.equal(db.getOrderById(o2.id)!.closure_status, "delivered", "el terminal autoritativo se queda");
    assert.ok(sysRepo.countIntegrationEvents("system", "call_closure_conflict", 0) > antes, "conflicto registrado");
    resetCallCfg();
  });

  await test("E7 correcciones: vacío no hace nada, igual no hace nada, distinto actualiza con auditoría", async () => {
    const { order, attempt } = await dialOne("997403", "4403", "34600117403");
    calls.applyCallAnalysis(
      attempt,
      analyzedEvent(attempt.provider_call_id!, {
        resultado: "confirmado_con_correccion",
        direccion_corregida: "  Avenida Nueva 7, 2ºB  ",
        localidad_corregida: "Almería", // igual que la actual → no cambia
        codigo_postal_corregido: "",    // vacío → no borra
        telefono_alternativo: "",
      }),
      enFranja,
      noHoliday
    );
    const fila = db.getOrderById(order.id)!;
    assert.equal(fila.address_line1, "Avenida Nueva 7, 2ºB");
    assert.equal(fila.city, "Almería");
    assert.equal(fila.postal_code, "04001", "vacío jamás borra un dato");
    const audit = db.listOrderDataAudit(order.id);
    assert.equal(audit.length, 1, "solo el cambio real se audita");
    assert.equal(audit[0].field, "address_line1");
    assert.equal(audit[0].old_value, "Calle Mayor 5");
    assert.equal(audit[0].source, "llamada_ia");
    assert.equal(audit[0].provider_call_id, attempt.provider_call_id);
    resetCallCfg();
  });

  await test("E7 DNC: pidió no llamar → teléfono bloqueado GLOBALMENTE, también para pedidos futuros", async () => {
    const tel = "34600117404";
    const { order, attempt } = await dialOne("997404", "4404", tel);
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "no_volver_a_llamar" }), enFranja, noHoliday);
    assert.equal(db.isDncPhone(tel), true);
    assert.equal(db.getActiveCallAttemptForOrder(order.id), null, "sin reintentos");
    // Pedido FUTURO con el mismo teléfono normalizado: no entra ni en cola.
    const futuro = mkCallable("997405", "4405", tel, 30);
    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    assert.equal(db.getActiveCallAttemptForOrder(futuro.id), null, "DNC global por teléfono");
    resetCallCfg();
  });

  await test("E7 rellamar: no consume contacto y respeta momento_rellamada (encajado en franja legal); timestamps absurdos → siguiente franja", async () => {
    const { order, attempt } = await dialOne("997406", "4406", "34600117406");
    // Rellamar el mismo día a las 18:00 (franja de tarde, válido).
    const objetivo = Math.floor(md(2026, 9, 1, 18, 0).getTime() / 1000);
    calls.applyCallAnalysis(
      attempt,
      analyzedEvent(attempt.provider_call_id!, { resultado: "rellamar", momento_rellamada: objetivo }),
      enFranja,
      noHoliday
    );
    const siguiente = db.getActiveCallAttemptForOrder(order.id)!;
    assert.equal(siguiente.contact_number, attempt.contact_number, "rellamar NO consume contacto");
    assert.equal(siguiente.scheduled_at, objetivo, "respeta el momento pedido (ya es legal)");
    assert.equal(db.countConsumedContacts(order.id), 0);

    // Timestamp absurdo (en el pasado remoto) → se ignora y va a la siguiente franja.
    const { order: o2, attempt: a2 } = await dialOne("997407", "4407", "34600117407");
    calls.applyCallAnalysis(
      a2,
      analyzedEvent(a2.provider_call_id!, { resultado: "rellamar", momento_rellamada: 1_000_000 }),
      enFranja,
      noHoliday
    );
    const s2 = db.getActiveCallAttemptForOrder(o2.id)!;
    assert.ok(s2.scheduled_at >= Math.floor(enFranja.getTime() / 1000), "jamás en el pasado");
    assert.ok(sched.insideCallWindow(new Date(s2.scheduled_at * 1000), noHoliday));
    resetCallCfg();
  });

  await test("E7 plan de reintentos completo: intento + 4 retries en franja legal → agotado → revisión manual y fuera de cola", async () => {
    const tel = "34600117410";
    let { order, attempt } = await dialOne("997410", "4410", tel);
    let now = enFranja;
    for (let contacto = 1; contacto <= 5; contacto++) {
      calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "no_contesta" }, Math.floor(now.getTime() / 1000)), now, noHoliday);
      assert.equal(db.countConsumedContacts(order.id), contacto);
      const siguiente = db.getActiveCallAttemptForOrder(order.id);
      if (contacto < 5) {
        assert.ok(siguiente, `tras el contacto ${contacto} hay reintento planificado`);
        assert.equal(siguiente!.contact_number, contacto + 1);
        assert.ok(siguiente!.scheduled_at > Math.floor(now.getTime() / 1000), "siempre hacia delante");
        assert.ok(sched.insideCallWindow(new Date(siguiente!.scheduled_at * 1000), noHoliday), "siempre en franja legal");
        // "Marca" el siguiente: lo pasamos a in_flight a mano (sin proveedor).
        now = new Date(siguiente!.scheduled_at * 1000);
        db.claimCallAttempt(siguiente!.id);
        db.transitionCallAttempt(siguiente!.id, ["reserved"], "dialing");
        db.transitionCallAttempt(siguiente!.id, ["dialing"], "in_flight", { provider_call_id: `mock-seq-${contacto}`, started_at: Math.floor(now.getTime() / 1000) });
        attempt = db.getCallAttempt(siguiente!.id)!;
      } else {
        assert.equal(siguiente, null, "quinto contacto sin resolución: fuera de cola");
        const todos = db.listCallAttemptsForOrder(order.id);
        assert.equal(todos[todos.length - 1].state, "manual_review");
        assert.match(todos[todos.length - 1].reason ?? "", /attempts_exhausted/);
      }
    }
    resetCallCfg();
  });

  await test("E7 cadencia por día de calendario (24-08-2026): mismo día → mañana/tarde del siguiente → mañana del de después", async () => {
    // Inicial: martes 01-09-2026 10:30 (franja de mañana).
    const tel = "34600117411";
    let { order, attempt } = await dialOne("997411", "4411", tel, enFranja);
    let now = enFranja;

    const resolver = (motivo: "no_contesta") => {
      calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: motivo }, Math.floor(now.getTime() / 1000)), now, noHoliday);
      const siguiente = db.getActiveCallAttemptForOrder(order.id);
      assert.ok(siguiente, "debe haber siguiente contacto planificado");
      now = new Date(siguiente!.scheduled_at * 1000);
      db.claimCallAttempt(siguiente!.id);
      db.transitionCallAttempt(siguiente!.id, ["reserved"], "dialing");
      db.transitionCallAttempt(siguiente!.id, ["dialing"], "in_flight", { provider_call_id: `mock-cad-${siguiente!.contact_number}`, started_at: Math.floor(now.getTime() / 1000) });
      attempt = db.getCallAttempt(siguiente!.id)!;
      return now;
    };

    // Contacto 2 (1er reintento): mismo día, ≥2h después (10:30+2h=12:30, sigue en franja de mañana).
    assert.equal(resolver("no_contesta").getTime(), md(2026, 9, 1, 12, 30).getTime(), "1er reintento: mismo día, +2h");

    // Contacto 3 (2º reintento): mañana del día SIGUIENTE (miércoles 02-09).
    assert.equal(resolver("no_contesta").getTime(), md(2026, 9, 2, 9, 0).getTime(), "2º reintento: mañana del día siguiente");

    // Contacto 4 (3er reintento): tarde de ESE MISMO día (miércoles 02-09).
    assert.equal(resolver("no_contesta").getTime(), md(2026, 9, 2, 17, 0).getTime(), "3er reintento: tarde del mismo día que el anterior");

    // Contacto 5 (4º y último reintento): mañana del día DESPUÉS (jueves 03-09).
    assert.equal(resolver("no_contesta").getTime(), md(2026, 9, 3, 9, 0).getTime(), "4º reintento: mañana del día después");

    // Quinto contacto sin resolución: agotado, revisión manual, fuera de cola.
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "no_contesta" }, Math.floor(now.getTime() / 1000)), now, noHoliday);
    assert.equal(db.getActiveCallAttemptForOrder(order.id), null, "5 contactos: fuera de cola");
    const todos = db.listCallAttemptsForOrder(order.id);
    assert.equal(todos.length, 5);
    assert.equal(todos[todos.length - 1].state, "manual_review");
    resetCallCfg();
  });

  await test("E7 cadencia: el 1er reintento respeta call_first_retry_minutes configurado", async () => {
    const tel = "34600117412";
    db.setSetting("call_first_retry_minutes", "45");
    let { order, attempt } = await dialOne("997412", "4412", tel, enFranja);
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "no_contesta" }, Math.floor(enFranja.getTime() / 1000)), enFranja, noHoliday);
    const siguiente = db.getActiveCallAttemptForOrder(order.id)!;
    assert.equal(siguiente.scheduled_at, Math.floor(md(2026, 9, 1, 11, 15).getTime() / 1000), "10:30 + 45 min = 11:15, dentro de franja");
    db.setSetting("call_first_retry_minutes", ""); // no lo toca resetCallCfg: se limpia a mano
    resetCallCfg();
  });

  await test("E7 cadencia: el anclaje sigue el día REAL de cada contacto, no el día del disparo original", async () => {
    // Inicial a las 19:30 (última franja del día: 17:00-20:00). El +2h del
    // 1er reintento (21:30) cae FUERA de ventana, así que se reprograma a la
    // mañana siguiente — el propio 1er reintento ya "salta" un día. Si el
    // resto de la cadencia se anclara al día del disparo original (martes)
    // en vez de al día real del contacto anterior, el contacto 3 caería el
    // mismo día que el 2 (solape). No debe pasar.
    const tel = "34600117413";
    let { order, attempt } = await dialOne("997413", "4413", tel, md(2026, 9, 1, 19, 30));
    let now = md(2026, 9, 1, 19, 30);

    const resolver = () => {
      calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "no_contesta" }, Math.floor(now.getTime() / 1000)), now, noHoliday);
      const siguiente = db.getActiveCallAttemptForOrder(order.id);
      assert.ok(siguiente, "debe haber siguiente contacto planificado");
      now = new Date(siguiente!.scheduled_at * 1000);
      db.claimCallAttempt(siguiente!.id);
      db.transitionCallAttempt(siguiente!.id, ["reserved"], "dialing");
      db.transitionCallAttempt(siguiente!.id, ["dialing"], "in_flight", { provider_call_id: `mock-tarde-${siguiente!.contact_number}`, started_at: Math.floor(now.getTime() / 1000) });
      attempt = db.getCallAttempt(siguiente!.id)!;
      return now;
    };

    // Contacto 2 (1er reintento): 19:30+2h=21:30 fuera de ventana → salta a
    // la mañana del día siguiente (miércoles 02-09), NO al mismo martes.
    const c2 = resolver();
    assert.equal(c2.getTime(), md(2026, 9, 2, 9, 0).getTime(), "1er reintento: fuera de ventana → mañana del día siguiente");

    // Contacto 3 (2º reintento): mañana del día siguiente AL CONTACTO 2 real
    // (miércoles), es decir jueves 03-09 — NUNCA el mismo día que el 2.
    const c3 = resolver();
    assert.equal(c3.getTime(), md(2026, 9, 3, 9, 0).getTime(), "2º reintento: día siguiente al contacto 2 real, no al disparo original");
    assert.notEqual(c3.toDateString(), c2.toDateString(), "el contacto 3 NUNCA cae el mismo día que el 2 — ahí estaría el solape");

    // Contacto 4 (3er reintento): tarde de ESE MISMO día (jueves 03-09).
    const c4 = resolver();
    assert.equal(c4.getTime(), md(2026, 9, 3, 17, 0).getTime(), "3er reintento: tarde del mismo día que el 2º reintento");

    // Contacto 5 (4º y último): mañana del día después (viernes 04-09).
    const c5 = resolver();
    assert.equal(c5.getTime(), md(2026, 9, 4, 9, 0).getTime(), "4º reintento: mañana del día después");

    // Secuencia completa coherente: 5 contactos, siempre hacia delante, y
    // agotado sin más reintentos.
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado: "no_contesta" }, Math.floor(now.getTime() / 1000)), now, noHoliday);
    assert.equal(db.getActiveCallAttemptForOrder(order.id), null, "5 contactos: fuera de cola");
    const todos = db.listCallAttemptsForOrder(order.id);
    assert.equal(todos.length, 5);
    const horas = todos.map((t) => t.scheduled_at);
    for (let i = 1; i < horas.length; i++) assert.ok(horas[i] > horas[i - 1], "siempre hacia delante, sin solapes");
    assert.equal(todos[todos.length - 1].state, "manual_review");
    resetCallCfg();
  });

  await test("E7 fallo técnico: reintenta SIN consumir cupo, y 3 seguidos → provider_error_exhausted", async () => {
    const tel = "34600117420";
    const o = mkCallable("997420", "4420", tel, 30);
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    db.setSetting("calls_daily_cap", "500");
    const { provider } = mkProvider({ fail: true });
    for (let i = 0; i < 3; i++) {
      calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      const activo = db.getActiveCallAttemptForOrder(o.id);
      if (activo) {
        const Database = require("better-sqlite3");
        const raw = new Database(path.join(tmpDir, "messages.db"));
        raw.prepare("UPDATE call_attempts SET scheduled_at = ? WHERE id = ?").run(Math.floor(enFranja.getTime() / 1000) - 1, activo.id);
        raw.close();
      }
      await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
    }
    assert.equal(db.countConsumedContacts(o.id), 0, "los fallos técnicos no castigan el cupo del cliente");
    const todos = db.listCallAttemptsForOrder(o.id);
    const ultimo = todos[todos.length - 1];
    assert.equal(ultimo.state, "manual_review");
    assert.match(ultimo.reason ?? "", /provider_error_exhausted/);
    resetCallCfg();
  });

  await test("E7 webhook: firma inválida rechazada; válida (v=ts,d=hex) aceptada; caducada rechazada", async () => {
    await withEnv({ RETELL_API_KEY: "retell-key-test" }, () => {
      const body = JSON.stringify({ event: "call_ended", call: { call_id: "call-x" } });
      const ts = String(Date.now());
      const d = crypto.createHmac("sha256", "retell-key-test").update(body + ts).digest("hex");
      assert.equal(retellProvider.verifyWebhook(body, `v=${ts},d=${d}`), true);
      assert.equal(retellProvider.verifyWebhook(body, `v=${ts},d=${"0".repeat(64)}`), false);
      assert.equal(retellProvider.verifyWebhook(body, null), false);
      const viejo = String(Date.now() - 10 * 60_000);
      const dViejo = crypto.createHmac("sha256", "retell-key-test").update(body + viejo).digest("hex");
      assert.equal(retellProvider.verifyWebhook(body, `v=${viejo},d=${dViejo}`), false, "timestamp caducado (anti-replay)");
      // Fallback: firma simple del cuerpo.
      const simple = crypto.createHmac("sha256", "retell-key-test").update(body).digest("hex");
      assert.equal(retellProvider.verifyWebhook(body, simple), true);
      // Parser estricto de eventos.
      assert.equal(retellProvider.parseEvent("{no json"), null);
      assert.equal(retellProvider.parseEvent(JSON.stringify({ event: "otra_cosa", call: { call_id: "x" } })), null);
      assert.equal(retellProvider.parseEvent(JSON.stringify({ event: "call_ended", call: {} })), null, "sin call_id → null");
    });
  });

  await test("E7 inbox: evento duplicado UN solo efecto; call_analyzed repetido no revierte; call_id desconocido seguro", async () => {
    const { order, attempt } = await dialOne("997430", "4430", "34600117430");
    const callId = attempt.provider_call_id!;
    const ev = analyzedEvent(callId, { resultado: "confirmado" });
    // Mismo dedupe_key dos veces → el segundo no entra ni en el inbox.
    assert.equal(db.insertCallEvent({ dedupeKey: `${callId}:call_analyzed:${ev.eventAt}`, providerCallId: callId, eventType: "call_analyzed", eventAt: ev.eventAt, payloadJson: JSON.stringify(ev) }), true);
    assert.equal(db.insertCallEvent({ dedupeKey: `${callId}:call_analyzed:${ev.eventAt}`, providerCallId: callId, eventType: "call_analyzed", eventAt: ev.eventAt, payloadJson: JSON.stringify(ev) }), false);
    calls.processCallEvents(enFranja, noHoliday);
    assert.equal(db.getOrderById(order.id)!.status, "confirmed");
    assert.equal(db.getCallAttempt(attempt.id)!.result, "confirmado");

    // Un call_analyzed VIEJO/repetido con otro resultado no revierte el estado.
    const ev2 = analyzedEvent(callId, { resultado: "cancelado" }, ev.eventAt! - 60);
    db.insertCallEvent({ dedupeKey: `${callId}:call_analyzed:${ev2.eventAt}`, providerCallId: callId, eventType: "call_analyzed", eventAt: ev2.eventAt, payloadJson: JSON.stringify(ev2) });
    calls.processCallEvents(enFranja, noHoliday);
    assert.equal(db.getCallAttempt(attempt.id)!.result, "confirmado", "el estado más nuevo se queda");
    assert.equal(db.getOrderById(order.id)!.closure_status, "unknown");

    // call_id desconocido: se marca procesado con error, sin efectos ni excepción.
    db.insertCallEvent({ dedupeKey: "fantasma:call_ended:1", providerCallId: "fantasma", eventType: "call_ended", eventAt: 1, payloadJson: null });
    calls.processCallEvents(enFranja, noHoliday);
    assert.equal(db.listUnprocessedCallEvents().length, 0, "todo el inbox drenado");

    // Resultado desconocido → manual review, nunca se interpreta.
    const { attempt: a3 } = await dialOne("997431", "4431", "34600117431");
    calls.applyCallAnalysis(a3, analyzedEvent(a3.provider_call_id!, { resultado: "quizas_luego" }), enFranja, noHoliday);
    assert.equal(db.getCallAttempt(a3.id)!.state, "manual_review");
    assert.match(db.getCallAttempt(a3.id)!.reason ?? "", /unknown_retell_result/);
    resetCallCfg();
  });

  await test("E7 frontera de código: el módulo calls no importa WhatsApp/Baileys/proveedores; backfill tampoco crea llamadas", async () => {
    const dirCalls = path.join(__dirname, "..", "src", "lib", "calls");
    for (const f of fs.readdirSync(dirCalls)) {
      const src = fs.readFileSync(path.join(dirCalls, f), "utf8");
      for (const pat of [/from\s+["'].*\/whatsapp["']/, /from\s+["'].*\/baileys/, /from\s+["'].*\/suppliers\//, /from\s+["'].*\/orders\/messages["']/]) {
        assert.ok(!pat.test(src), `import prohibido en calls/${f}: ${pat}`);
      }
    }
    // Backfill: cero llamadas además de cero WhatsApps (ya probado).
    const attemptsAntes = (db.systemDbHandle().prepare("SELECT COUNT(*) AS n FROM call_attempts").get() as { n: number }).n;
    await backfill.runShopifyBackfill({
      dryRun: false,
      scopeFetcher: async () => ["read_orders", "read_all_orders"],
      pageFetcher: async () => ({
        orders: [backfillOrder({ id: 997500, order_number: 4500, cancelled_at: "2026-08-20T10:00:00Z" })],
        nextCursor: null,
      }),
    });
    const attemptsDespues = (db.systemDbHandle().prepare("SELECT COUNT(*) AS n FROM call_attempts").get() as { n: number }).n;
    assert.equal(attemptsDespues, attemptsAntes, "el backfill no crea NINGUNA llamada");
    assert.equal(db.getOrderByShopifyId("997500")!.status, "ignored_old");
  });



  await test("E2 suscripciones: planWebhookEnsure detecta faltantes, no duplica y avisa de URLs cambiadas", async () => {
    const { planWebhookEnsure } = await import("../src/lib/shopify/webhook-subscriptions");
    const deseadas = [
      { topic: "orders/create", address: "https://x.example/api/webhooks/shopify/orders-create" },
      { topic: "orders/cancelled", address: "https://x.example/api/webhooks/shopify/orders-events" },
    ];
    const plan = planWebhookEnsure(
      [
        { id: 1, topic: "orders/create", address: "https://x.example/api/webhooks/shopify/orders-create" },
        { id: 2, topic: "orders/paid", address: "https://otro.example/x" },
      ],
      deseadas
    );
    assert.deepEqual(plan.toCreate.map((x) => x.topic), ["orders/cancelled"], "solo crea lo que falta");
    assert.equal(plan.ok.length, 1, "lo existente no se duplica");
    assert.equal(plan.extra[0].topic, "orders/paid");
    const plan2 = planWebhookEnsure(
      [{ id: 1, topic: "orders/create", address: "https://OTRA.example/hook" }],
      deseadas
    );
    assert.equal(plan2.mismatched.length, 1, "misma suscripción con otra URL: aviso, no duplicado");
    assert.equal(plan2.toCreate.some((x) => x.topic === "orders/create"), false);
  });

  // ============ 45 · Arreglos de fidelidad (lo que el sistema contaba mal) ============
  console.log("\n— Fidelidad: fulfillment parcial y orden de llegada —");

  await test("fulfillment `partial` TAMBIÉN es in_progress (el caso normal en Casamable, no el raro)", () => {
    // Los pedidos llevan una línea `Seguro de Envío` que no es mercancía y que
    // el proveedor nunca despacha: el pedido se queda en `partial` para
    // siempre y jamás llega a `fulfilled`. Mirar solo `fulfilled` dejaba esos
    // pedidos con el cierre en `unknown`.
    const parcial = backfillOrder({
      id: 998001,
      fulfillment_status: "partial",
      updated_at: "2026-08-24T12:00:00Z",
    });
    const señal = backfill.planClosureFromShopify(parcial);
    assert.equal(señal?.status, "in_progress");
    assert.equal(señal?.at, Math.floor(Date.parse("2026-08-24T12:00:00Z") / 1000), "fecha de Shopify, no now()");
    assert.notEqual(señal?.status, "delivered", "parcial no es entregado, igual que fulfilled no lo es");

    // Y sigue funcionando lo que ya funcionaba.
    assert.equal(
      backfill.planClosureFromShopify(
        backfillOrder({ id: 998002, fulfillment_status: "fulfilled", updated_at: "2026-08-24T12:00:00Z" })
      )?.status,
      "in_progress"
    );
    assert.equal(backfill.planClosureFromShopify(backfillOrder({ id: 998003 })), null, "sin fulfillment: sin señal");

    // Regla que se mantiene intacta: sin NINGUNA fecha de Shopify no se
    // escribe señal. Antes que estampar now() y corromper la cronología,
    // se prefiere no saber.
    assert.equal(
      backfill.planClosureFromShopify(backfillOrder({ id: 998007, fulfillment_status: "partial" })),
      null,
      "parcial pero sin fecha: no se inventa una"
    );
  });

  await test("fulfillment `restocked` NO es in_progress: la mercancía volvió al almacén", () => {
    assert.equal(
      backfill.planClosureFromShopify(backfillOrder({ id: 998004, fulfillment_status: "restocked" })),
      null
    );
    // Y una cancelación gana sobre cualquier fulfillment, como ya era.
    const cancelado = backfill.planClosureFromShopify(
      backfillOrder({ id: 998005, fulfillment_status: "partial", cancelled_at: "2026-08-24T09:00:00Z" })
    );
    assert.equal(cancelado?.status, "cancelled");
  });

  await test("backfill: un pedido parcialmente despachado se importa como in_progress", () => {
    const parcial = backfillOrder({ id: 998006, fulfillment_status: "partial", updated_at: "2026-08-24T12:00:00Z" });
    assert.equal(backfill.decideBackfillAction(null, parcial).kind, "insert_in_progress");
  });

  await test("orden de llegada: el panel ordena por número de pedido, no por cuándo se insertó la fila", () => {
    // El backfill insertó 93 pedidos en el mismo instante: `created_at` no
    // distingue nada entre ellos. Se insertan aquí DESORDENADOS a propósito.
    const b = mkOrder("998101", "990002", "34600198101"); // el de en medio, primero
    const a = mkOrder("998102", "990003", "34600198102"); // el más nuevo, segundo
    const c = mkOrder("998103", "990001", "34600198103"); // el más viejo, último

    const mios = new Set([a.id, b.id, c.id]);
    const orden = db
      .listOrders(undefined, 1000)
      .filter((o) => mios.has(o.id))
      .map((o) => o.shopify_order_number);

    assert.deepEqual(orden, ["990003", "990002", "990001"], "de más nuevo a más viejo por número de pedido");

    // Y el mismo criterio filtrando por estado (la otra consulta del panel).
    const porEstado = db
      .listOrders("pending_send", 1000)
      .filter((o) => mios.has(o.id))
      .map((o) => o.shopify_order_number);
    assert.deepEqual(porEstado, ["990003", "990002", "990001"]);
  });

  // ============ 44 · PRUEBA DE REALIDAD FINAL (flujo completo) ============
  console.log("· Prueba de realidad — ciclo de vida completo");

  await test("REALIDAD: pedido COD → WhatsApp → 15 min → llamada → no contesta → retry → confirma por WhatsApp → retry cancelado → fulfillment → cero contactos más", async () => {
    const tel = "34600117900";
    // 1. Pedido nuevo, WhatsApp de confirmación enviado hace 20 min sin respuesta.
    const o = mkCallable("997900", "4900", tel, 20);
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    db.setSetting("calls_daily_cap", "500");

    // 2. Tick dentro de franja: entra en cola y Retell (mock) marca.
    const { provider, created } = mkProvider();
    await calls.runCallOrchestratorTick({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(created.filter((c) => c.toNumber === "+" + tel).length, 1, "una llamada real");
    const a1 = db.getActiveCallAttemptForOrder(o.id)!;
    assert.equal(a1.state, "in_flight");

    // 3. No contesta → retry planificado en franja legal, contacto 2.
    calls.applyCallAnalysis(a1, analyzedEvent(a1.provider_call_id!, { resultado: "no_contesta" }), enFranja, noHoliday);
    const a2 = db.getActiveCallAttemptForOrder(o.id)!;
    assert.equal(a2.contact_number, 2);
    assert.ok(sched.insideCallWindow(new Date(a2.scheduled_at * 1000), noHoliday));

    // 4. ANTES del retry, el cliente confirma por WhatsApp (carrera §58).
    db.markOrderConfirmed(o.id, true);
    const cuandoToca = new Date(a2.scheduled_at * 1000);
    const antes = created.length;
    await calls.runCallOrchestratorTick({ now: cuandoToca, provider, isHoliday: noHoliday });
    assert.equal(created.length, antes, "el retry NO llama: reevaluó elegibilidad justo antes");
    assert.equal(db.getActiveCallAttemptForOrder(o.id), null, "retry cancelado");

    // 5. El ciclo de proveedor sigue; Shopify marca fulfillment (E2):
    //    closure in_progress — JAMÁS delivered — y cero contactos más.
    assert.ok(db.setOrderClosure(o.id, "in_progress", "shopify", Math.floor(cuandoToca.getTime() / 1000) + 60));
    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.closure_status, "in_progress");
    assert.notEqual(fila.closure_status, "delivered", "fulfilled nunca es delivered");
    await calls.runCallOrchestratorTick({ now: new Date(cuandoToca.getTime() + 3600_000), provider, isHoliday: noHoliday });
    assert.equal(db.getActiveCallAttemptForOrder(o.id), null, "ningún contacto nuevo tras fulfillment");
    assert.equal(created.length, antes);

    // 6. La entrega real la dictará la fuente autoritativa (Dropea) y el
    //    terminal no podrá ser pisado por nadie (ya probado en E1/E7).
    assert.ok(db.setOrderClosure(o.id, "delivered", "dropea", Math.floor(cuandoToca.getTime() / 1000) + 7200));
    assert.equal(db.setOrderClosure(o.id, "cancelled", "llamada_ia", Math.floor(cuandoToca.getTime() / 1000) + 9000), false);
    resetCallCfg();
  });

  // ============ E8 · Reconciliador de Dropea por API ============
  console.log("· E8 — reconciliador de Dropea");

  const dropeaOrderFixture = (overrides: Record<string, unknown> = {}) => ({
    id: 0,
    status: "SHIPPING",
    sub_status: "SHIPPED", // in_progress: envío en curso, no resuelto
    external_order_id: null,
    updated_at: "2026-08-24T10:00:00Z",
    created_at: "2026-08-20T09:00:00Z",
    ...overrides,
  }) as import("../src/lib/suppliers/dropea/types").DropeaOrder;

  await test("E8 salvaguarda estructural: el módulo de reconciliación no importa WhatsApp/Baileys ni ninguna escritura de Dropea", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/suppliers/dropea/reconcile.ts"), "utf8");
    for (const pat of [
      /from\s+["'].*\/whatsapp["']/,
      /from\s+["'].*\/baileys/,
      /from\s+["'].*\/orders\/messages["']/,
      /from\s+["'].*\/orders\/confirmation["']/,
      /sendWhatsAppMessage/,
      /enqueueOutbox/,
      /createDropeaOrderForOrder/,
      /confirmDropeaOrder/,
      /dropeaProvider\.createOrder/,
      /dropeaProvider\.cancelOrder/,
    ]) {
      assert.ok(!pat.test(src), `import/uso prohibido en reconcile.ts: ${pat}`);
    }
  });

  await test("E8 decideLink: sin external_order_id, sin correspondencia, y ya enlazado al mismo id", () => {
    const o = mkOrder("920100", "8100", "34600120100");
    const orden = db.getOrderById(o.id)!;

    assert.equal(dropeaReconcile.decideLink(null, null, null, null).outcome, "no_external_order_id");
    assert.equal(dropeaReconcile.decideLink("", null, null, null).outcome, "no_external_order_id");
    assert.equal(dropeaReconcile.decideLink("920999", null, null, null).outcome, "no_local_match");

    const yaEnlazado = dropeaReconcile.decideLink("88800100", orden, null, null);
    assert.equal(yaEnlazado.outcome, "already_linked_same");
    assert.equal(yaEnlazado.localOrderId, o.id);
  });

  await test("E8 decideLink: casa por shopify_order_id o por shopify_order_number, y lo dice explícitamente", () => {
    const o = mkOrder("920101", "8101", "34600120101");
    const orden = db.getOrderById(o.id)!;

    const porId = dropeaReconcile.decideLink("920101", null, orden, null);
    assert.equal(porId.outcome, "linked_by_shopify_order_id");
    assert.equal(porId.matchedVia, "shopify_order_id");
    assert.equal(porId.localOrderId, o.id);

    const porNumero = dropeaReconcile.decideLink("8101", null, null, orden);
    assert.equal(porNumero.outcome, "linked_by_shopify_order_number");
    assert.equal(porNumero.matchedVia, "shopify_order_number");

    // Coincide con el mismo pedido por las dos vías a la vez: no es ambiguo
    // (es un único candidato), gana la vía por shopify_order_id.
    const porAmbas = dropeaReconcile.decideLink("920101", null, orden, orden);
    assert.equal(porAmbas.outcome, "linked_by_shopify_order_id");
  });

  await test("E8 decideLink: ambiguo (dos pedidos locales distintos) y conflicto (ya enlazado a OTRO id)", () => {
    const oAmbiguoA = mkOrder("920102", "8102", "34600120102");
    const oAmbiguoB = mkOrder("920103", "8102b", "34600120103"); // su NÚMERO coincide con el ID del anterior... no, ver abajo
    // Construcción real del caso ambiguo: el ID de un pedido coincide con el
    // NÚMERO de otro pedido distinto — el mismo external_order_id de Dropea
    // "casa" con dos pedidos locales por vías distintas.
    void oAmbiguoB;
    const oNumeroIgualAlIdAnterior = mkOrder("920104", "920102", "34600120104");
    const ordenA = db.getOrderById(oAmbiguoA.id)!;
    const ordenB = db.getOrderById(oNumeroIgualAlIdAnterior.id)!;
    const ambiguo = dropeaReconcile.decideLink("920102", null, ordenA, ordenB);
    assert.equal(ambiguo.outcome, "ambiguous_multiple_matches");
    assert.equal(ambiguo.localOrderId, null);

    const oConflicto = mkOrder("920105", "8105", "34600120105");
    db.setOrderSupplierPlatformAndExternalId(oConflicto.id, "dropea", "77700000"); // ya enlazado a OTRO id
    const ordenConflicto = db.getOrderById(oConflicto.id)!;
    const conflicto = dropeaReconcile.decideLink("920105", null, ordenConflicto, null);
    assert.equal(conflicto.outcome, "already_linked_conflict");
    assert.equal(conflicto.localOrderId, oConflicto.id);
  });

  await test("E8 planClosureFromDropeaOrder: delivered/refused/cancelled correctos, fulfilled NUNCA delivered, sin fecha → no se escribe", () => {
    const entregado = dropeaReconcile.planClosureFromDropeaOrder(dropeaOrderFixture({ sub_status: "DELIVERED", updated_at: "2026-08-24T12:00:00Z" }))!;
    assert.equal(entregado.status, "delivered");
    assert.equal(entregado.at, Math.floor(Date.parse("2026-08-24T12:00:00Z") / 1000));

    const rechazado = dropeaReconcile.planClosureFromDropeaOrder(dropeaOrderFixture({ sub_status: "REFUSED" }))!;
    assert.equal(rechazado.status, "refused");

    const cancelado = dropeaReconcile.planClosureFromDropeaOrder(dropeaOrderFixture({ sub_status: "CANCELLED" }))!;
    assert.equal(cancelado.status, "cancelled");

    // "En camino" (SHIPPED) es in_progress, jamás delivered.
    const enCurso = dropeaReconcile.planClosureFromDropeaOrder(dropeaOrderFixture({ sub_status: "SHIPPED" }))!;
    assert.equal(enCurso.status, "in_progress");
    assert.notEqual(enCurso.status, "delivered");

    // Par de estados que no reconocemos: no se adivina, no se escribe nada.
    assert.equal(dropeaReconcile.planClosureFromDropeaOrder(dropeaOrderFixture({ status: "RARO", sub_status: "RARISIMO" })), null);

    // Estado conocido pero SIN fecha alguna: tampoco se escribe (nunca now()).
    assert.equal(
      dropeaReconcile.planClosureFromDropeaOrder(dropeaOrderFixture({ sub_status: "DELIVERED", updated_at: undefined, created_at: undefined })),
      null
    );
  });

  await test("E8 runDropeaReconcile (dry-run): decide todo, no escribe NADA, ni el enlace ni el cierre", async () => {
    const o = mkOrder("920200", "8200", "34600120200");
    db.claimWebhookEvent("e8-dry-1", "dropea", "order.status.changed", "88800200");
    const antes = JSON.stringify(db.getOrderById(o.id));

    const fetcher: import("../src/lib/suppliers/dropea/reconcile").DropeaOrderFetcher = async (id) =>
      id === "88800200"
        ? dropeaOrderFixture({ id: 88800200, external_order_id: "920200", sub_status: "DELIVERED" })
        : dropeaOrderFixture({ external_order_id: null }); // cualquier otro pedido de la suite: sin señal

    const report = await dropeaReconcile.runDropeaReconcile({ dryRun: true, fetcher });
    const item = report.items.find((i) => i.resourceId === "88800200")!;
    assert.equal(item.outcome, "linked_by_shopify_order_id");
    assert.equal(item.closureStatus, "delivered");
    assert.equal(item.closureApplied, false, "dry-run nunca aplica, aunque informe qué haría");
    assert.equal(JSON.stringify(db.getOrderById(o.id)), antes, "cero escritura en dry-run");
  });

  await test("E8 runDropeaReconcile (--apply): enlaza, rellena el eje de cierre, y NUNCA pisa un enlace o un terminal existente", async () => {
    const oPorId = mkOrder("920201", "8201", "34600120201");
    const oPorNumero = mkOrder("920202", "8202", "34600120202");
    const oYaEnlazado = mkOrder("920203", "8203", "34600120203");
    db.setOrderSupplierPlatformAndExternalId(oYaEnlazado.id, "dropea", "88800203");
    const oConflicto = mkOrder("920204", "8204", "34600120204");
    db.setOrderSupplierPlatformAndExternalId(oConflicto.id, "dropea", "77711204"); // enlace previo a OTRO id
    const oTerminal = mkOrder("920205", "8205", "34600120205");
    db.setOrderClosure(oTerminal.id, "cancelled", "shopify", 1000); // terminal ya fijado por Shopify

    db.claimWebhookEvent("e8-ap-1", "dropea", "order.status.changed", "88800201");
    db.claimWebhookEvent("e8-ap-2", "dropea", "order.status.changed", "88800202");
    db.claimWebhookEvent("e8-ap-3", "dropea", "order.status.changed", "88800203");
    db.claimWebhookEvent("e8-ap-4", "dropea", "order.status.changed", "88800204");
    db.claimWebhookEvent("e8-ap-5", "dropea", "order.status.changed", "88800205");

    const respuestas: Record<string, ReturnType<typeof dropeaOrderFixture>> = {
      "88800201": dropeaOrderFixture({ id: 88800201, external_order_id: "920201", sub_status: "DELIVERED" }),
      "88800202": dropeaOrderFixture({ id: 88800202, external_order_id: "8202", sub_status: "REFUSED" }),
      "88800203": dropeaOrderFixture({ id: 88800203, external_order_id: "920203", sub_status: "SHIPPED" }),
      "88800204": dropeaOrderFixture({ id: 88800204, external_order_id: "920204", sub_status: "DELIVERED" }),
      "88800205": dropeaOrderFixture({ id: 88800205, external_order_id: "920205", sub_status: "SHIPPED" }), // in_progress: no debe pisar el cancelled
    };
    const fetcher: import("../src/lib/suppliers/dropea/reconcile").DropeaOrderFetcher = async (id) => respuestas[id] ?? dropeaOrderFixture({ external_order_id: null });

    const report = await dropeaReconcile.runDropeaReconcile({ dryRun: false, fetcher });
    const porId = (rid: string) => report.items.find((i) => i.resourceId === rid)!;

    assert.equal(porId("88800201").outcome, "linked_by_shopify_order_id");
    assert.equal(db.getOrderById(oPorId.id)!.supplier_external_order_id, "88800201");
    assert.equal(db.getOrderById(oPorId.id)!.closure_status, "delivered");

    assert.equal(porId("88800202").outcome, "linked_by_shopify_order_number");
    assert.equal(db.getOrderById(oPorNumero.id)!.supplier_external_order_id, "88800202");
    assert.equal(db.getOrderById(oPorNumero.id)!.closure_status, "refused");

    assert.equal(porId("88800203").outcome, "already_linked_same", "ya estaba enlazado: no se re-enlaza, solo se rellena el cierre");
    assert.equal(db.getOrderById(oYaEnlazado.id)!.closure_status, "in_progress");

    assert.equal(porId("88800204").outcome, "already_linked_conflict");
    assert.equal(db.getOrderById(oConflicto.id)!.supplier_external_order_id, "77711204", "el enlace previo NUNCA se pisa");
    assert.equal(db.getOrderById(oConflicto.id)!.closure_status, "unknown", "conflicto de enlace: tampoco se toca el cierre");

    // oTerminal no estaba enlazado todavía: el enlace en sí SÍ se hace (es
    // nuevo, no pisa nada) — lo que se bloquea es el CIERRE, porque ya tenía
    // un terminal fijado por Shopify. Enlazar y cerrar son ejes independientes.
    assert.equal(porId("88800205").outcome, "linked_by_shopify_order_id");
    assert.equal(db.getOrderById(oTerminal.id)!.supplier_external_order_id, "88800205", "el enlace en sí sí se hace: no había uno previo");
    assert.equal(porId("88800205").closureApplied, false, "bloqueado por el terminal ya fijado");
    assert.equal(db.getOrderById(oTerminal.id)!.closure_status, "cancelled", "Dropea no pisa un terminal de Shopify");
    assert.equal(db.getOrderById(oTerminal.id)!.closure_source, "shopify");
  });

  await test("E8 runDropeaReconcile: un fallo de red en un pedido no bloquea el resto, y queda marcado", async () => {
    db.claimWebhookEvent("e8-fail-1", "dropea", "order.status.changed", "88800300");
    const fetcher: import("../src/lib/suppliers/dropea/reconcile").DropeaOrderFetcher = async (id) => {
      if (id === "88800300") throw new Error("network boom");
      return dropeaOrderFixture({ external_order_id: null });
    };
    const report = await dropeaReconcile.runDropeaReconcile({ dryRun: true, fetcher });
    const item = report.items.find((i) => i.resourceId === "88800300")!;
    assert.equal(item.outcome, "fetch_failed");
    assert.match(item.error ?? "", /network boom/);
  });

  await test("E8 checkpoint: reanuda sin repetir pedidos ya procesados, y se limpia al terminar", async () => {
    db.claimWebhookEvent("e8-cp-1", "dropea", "order.status.changed", "88800401");
    db.claimWebhookEvent("e8-cp-2", "dropea", "order.status.changed", "88800402");
    db.claimWebhookEvent("e8-cp-3", "dropea", "order.status.changed", "88800403");

    const totalPendiente = db.listOrderWebhookResourceIds("dropea").length;
    const vistos: string[] = [];
    const fetcher: import("../src/lib/suppliers/dropea/reconcile").DropeaOrderFetcher = async (id) => {
      vistos.push(id);
      return dropeaOrderFixture({ external_order_id: null });
    };

    const primerLote = Math.max(1, totalPendiente - 1);
    const r1 = await dropeaReconcile.runDropeaReconcile({ dryRun: false, fetcher, resetCheckpoint: true, maxItems: primerLote });
    assert.equal(r1.processed, primerLote);
    assert.equal(r1.done, false, "queda al menos 1 por procesar");
    const checkpoint1 = db.getSetting("dropea_reconcile_last_resource_id");
    assert.ok(checkpoint1, "checkpoint guardado tras la primera pasada");
    const vistosEnPrimera = [...vistos];
    vistos.length = 0;

    const r2 = await dropeaReconcile.runDropeaReconcile({ dryRun: false, fetcher }); // sin reset: retoma
    assert.equal(r2.done, true);
    assert.equal(r2.processed, totalPendiente - primerLote);
    for (const id of vistosEnPrimera) {
      assert.ok(!vistos.includes(id), `${id} no se vuelve a pedir en la segunda pasada`);
    }
    assert.equal(db.getSetting("dropea_reconcile_last_resource_id"), "", "checkpoint limpio al terminar el recorrido completo");
  });

  // ============ Resumen ============
  console.log(`\n${passed} tests OK, ${failures.length} fallos\n`);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
