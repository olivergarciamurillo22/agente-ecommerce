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
    await withEnv({ WHATSAPP_WINDOW_START: "09:00", WHATSAPP_WINDOW_END: "21:00" }, () => {
      assert.equal(safety.insideSendWindow(madrugada), false, "03:00 está fuera");
      assert.equal(safety.insideSendWindow(mediodia), true, "12:00 está dentro");
      assert.equal(safety.localMinutesNow(mediodia), 12 * 60);
    });
    // Franja nocturna (cruza medianoche): 22:00-06:00
    await withEnv({ WHATSAPP_WINDOW_START: "22:00", WHATSAPP_WINDOW_END: "06:00" }, () => {
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
    await withEnv({ WHATSAPP_WINDOW_START: "09:00", WHATSAPP_WINDOW_END: "21:00" }, () => {
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

  await test("routing: sin reglas configuradas SIEMPRE unknown (nunca adivina)", () => {
    const o = mkConfirmed("970001", "1801");
    assert.equal(resolveSupplier(o).platform, "unknown");
    const ev = suppliers.evaluateOrderForSupplier(o);
    assert.equal(ev.status, "manual_review");
    assert.match(ev.reason, /sin reglas de enrutado/);
  });

  await test("routing con reglas: enruta por producto y detecta ambigüedad", async () => {
    const o = db.getOrderByShopifyId("970001")!;
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      assert.equal(resolveSupplier(o).platform, "dropi");
    });
    // Dos proveedores compiten por el mismo pedido → decisión humana
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador,dropea:ultrasónico" }, () => {
      const r = resolveSupplier(o);
      assert.equal(r.platform, "unknown");
      assert.match(r.reason, /varios proveedores/);
    });
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

  await test("gate cerrado por defecto: SUPPLIER_SYNC_ENABLED=0 bloquea", async () => {
    const o = db.getOrderByShopifyId("970003")!;
    await withEnv({ SUPPLIER_ROUTING_RULES: "dropi:limpiador" }, () => {
      const g = suppliers.canSyncSupplier(o, "dropi");
      assert.equal(g.allowed, false);
      assert.match(g.reason ?? "", /SUPPLIER_SYNC_ENABLED/);
    });
  });

  await test("matriz de llaves del proveedor: cualquiera cerrada = NO SYNC", async () => {
    const o = db.getOrderByShopifyId("970003")!;
    const base = {
      SUPPLIER_ROUTING_RULES: "dropi:limpiador",
      SUPPLIER_SYNC_ENABLED: "1",
      SUPPLIER_TEST_MODE: "0",
      DROPIPRO_WRITE_ENABLED: "1",
      SUPPLIER_PILOT_MODE: "0", // el piloto se prueba aparte
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
  const supplierWebhook = await import("../src/lib/suppliers/webhook");
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
      .run(`EXT-${shopifyId}`, phone, o.id);
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

  await test("webhook sin secreto configurado → 503 (fail closed)", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: undefined, DROPEA_HMAC_SECRET: undefined }, () => {
      const r = supplierWebhook.processSupplierWebhook("dropea", "{}", {});
      assert.equal(r.status, 503);
    });
  });

  await test("webhook con firma inválida → 401 y sin efectos", async () => {
    const o = mkSynced("980006", "1906", "34600111777");
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = JSON.stringify({ order_id: `EXT-980006`, status: "out_for_delivery" });
      const r = supplierWebhook.processSupplierWebhook("dropea", body, {
        "x-signature": "firma-falsa",
      });
      assert.equal(r.status, 401);
      assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "unknown", "no se tocó");
      assert.equal(
        db.getPendingOutbox(999).some((x) => x.phone === "34600111777"),
        false
      );
    });
  });

  await test("webhook con firma VÁLIDA → procesa, avisa una vez y es idempotente", async () => {
    const o = db.getOrderByShopifyId("980006")!;
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = JSON.stringify({
        order_id: "EXT-980006",
        status: "out_for_delivery",
        tracking_number: "TRKW1",
        carrier: "GLS",
      });
      const firma = crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("hex");

      const r1 = supplierWebhook.processSupplierWebhook("dropea", body, { "x-signature": firma });
      assert.equal(r1.status, 200);
      const tras1 = db.getPendingOutbox(999).filter((x) => x.phone === "34600111777").length;
      assert.ok(tras1 >= 1, "avisó al cliente");
      assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "out_for_delivery");

      // EXACTAMENTE el mismo webhook otra vez (reintento del proveedor)
      const r2 = supplierWebhook.processSupplierWebhook("dropea", body, { "x-signature": firma });
      assert.equal(r2.status, 200);
      assert.equal(
        db.getPendingOutbox(999).filter((x) => x.phone === "34600111777").length,
        tras1,
        "ni un mensaje duplicado"
      );
    });
  });

  await test("webhook acepta firma en base64 y con prefijo sha256=", async () => {
    const o = mkSynced("980007", "1907", "34600111888");
    await withEnv(
      { DROPEA_WEBHOOK_SECRET: "secreto-de-prueba", DROPEA_WEBHOOK_SIGNATURE_ENCODING: "base64" },
      () => {
        const body = JSON.stringify({ order_id: "EXT-980007", status: "in_transit" });
        const firma = crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("base64");
        const r = supplierWebhook.processSupplierWebhook("dropea", body, {
          "x-signature": `sha256=${firma}`,
        });
        assert.equal(r.status, 200);
        assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "in_transit");
      }
    );
  });

  await test("webhook de un pedido desconocido → 200 sin efectos", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: "secreto-de-prueba" }, () => {
      const body = JSON.stringify({ order_id: "NO-EXISTE", status: "delivered" });
      const firma = crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("hex");
      const r = supplierWebhook.processSupplierWebhook("dropea", body, { "x-signature": firma });
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

  // ============ 22 · Reinicio del proceso (persistencia) ============
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
