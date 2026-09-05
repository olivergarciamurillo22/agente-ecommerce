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
    // Líneas REALISTAS: la Admin API siempre manda product_id/variant_id y
    // los campos de fulfillment. Una fixture sin ellos hacía pasar tests que
    // en producción se habrían comportado distinto.
    line_items: [
      {
        title: "Crema facial hidratante",
        quantity: 2,
        price: "19.95",
        sku: "CREMA-01",
        product_id: 8100000000001,
        variant_id: 4100000000001,
        requires_shipping: true,
        gift_card: false,
        fulfillment_service: "manual",
        fulfillment_status: null,
        fulfillable_quantity: 2,
      },
      {
        title: "Sérum vitamina C",
        quantity: 1,
        price: "10.00",
        sku: "SERUM-01",
        product_id: 8100000000002,
        variant_id: 4100000000002,
        requires_shipping: true,
        gift_card: false,
        fulfillment_service: "manual",
        fulfillment_status: null,
        fulfillable_quantity: 1,
      },
    ],
    note_attributes: [],
    ...overrides,
  };
}


/**
 * Líneas de pedido REALISTAS para probar fulfillment por línea.
 *
 * `fisicasDespachadas` / `fisicasPendientes`: cuántas líneas de mercancía en
 * cada estado. `seguro`: añade la línea `Seguro de Envío` de Releasit, que es
 * la que en producción deja el pedido en `partial` para siempre.
 */
function lineas(opts: {
  fisicasDespachadas?: number;
  fisicasPendientes?: number;
  seguro?: boolean;
} = {}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let n = 0;
  for (let i = 0; i < (opts.fisicasDespachadas ?? 0); i++) {
    n++;
    out.push({
      title: `Producto fisico ${n}`,
      quantity: 1,
      price: "19.95",
      sku: `SKU-${n}`,
      product_id: 8200000000000 + n,
      variant_id: 4200000000000 + n,
      requires_shipping: true,
      gift_card: false,
      fulfillment_service: "manual",
      fulfillment_status: "fulfilled",
      fulfillable_quantity: 0,
    });
  }
  for (let i = 0; i < (opts.fisicasPendientes ?? 0); i++) {
    n++;
    out.push({
      title: `Producto fisico ${n}`,
      quantity: 1,
      price: "19.95",
      sku: `SKU-${n}`,
      product_id: 8200000000000 + n,
      variant_id: 4200000000000 + n,
      requires_shipping: true,
      gift_card: false,
      fulfillment_service: "manual",
      fulfillment_status: null,
      fulfillable_quantity: 1,
    });
  }
  if (opts.seguro) {
    // Tal cual lo manda Releasit: sin SKU ni IDs de catálogo y, sobre todo,
    // requires_shipping = false. Nadie lo despacha nunca.
    out.push({
      title: "Seguro de Envío",
      quantity: 1,
      price: "1.95",
      sku: null,
      product_id: null,
      variant_id: null,
      requires_shipping: false,
      gift_card: false,
      fulfillment_service: "manual",
      fulfillment_status: null,
      fulfillable_quantity: 1,
    });
  }
  return out;
}

const shopifyHeaders = (raw: string, extra: Record<string, string | null> = {}) => ({
  hmac: sign(raw),
  topic: "orders/create",
  webhookId: "wh-test",
  shopDomain: "test.myshopify.com",
  ...extra,
});

// ============================================================
// T6 — grafo transitivo de imports (para la salvaguarda estructural de
// WhatsApp que sigue las importaciones de verdad en vez de mirar solo el
// texto del fichero de entrada).
//
// Las salvaguardas E3/E4/E7/E8 de arriba solo leen SU PROPIO fichero: si
// backfill.ts importara un módulo C que a su vez importara WhatsApp, esos
// tests seguirían en verde porque nunca abren C. Esto recorre el grafo de
// verdad (imports estáticos Y `await import(...)` dinámicos, que es como
// los scripts cargan sus propios módulos) partiendo de cada entrypoint.
// ============================================================

const PROJECT_ROOT = path.join(__dirname, "..");

/** Especificadores de `from "..."` (estático) y `import("...")` (dinámico). */
function extractImportSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

/** Resuelve un especificador a un fichero .ts real, o null si es externo (paquete de node_modules). */
function resolveImportSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith("@/")) {
    base = path.join(PROJECT_ROOT, "src", spec.slice(2));
  } else {
    return null; // paquete externo — fuera del alcance de esta salvaguarda
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** BFS del grafo de imports locales alcanzables desde `entryFile` (rutas absolutas). */
function buildTransitiveImportGraph(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const spec of extractImportSpecifiers(src)) {
      const resolved = resolveImportSpecifier(spec, file);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

/** true si `fnName(` aparece como LLAMADA en `src` (no como su propia declaración). */
function containsCallTo(src: string, fnName: string): boolean {
  const callPattern = new RegExp(`\\b${fnName}\\s*\\(`);
  const declPattern = new RegExp(`\\bfunction\\s+${fnName}\\s*\\(`);
  return src.split("\n").some((line) => callPattern.test(line) && !declPattern.test(line));
}

/** grep acotado para tests de "esto no debe existir en el código". */
function execSyncSafe(cmd: string): string {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    return execSync(cmd, { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  console.log(`\nTests del MVP (DB temporal en ${tmpDir})\n`);


  const db = await import("../src/lib/db");
  const { normalizePhone, isCodOrder, formatOrderItems, formatAddressForMessage, normalizeOrder } = await import(
    "../src/lib/orders/normalize"
  );
  const { verifyShopifyHmac, verifyShopifyHmacEitherSecret } = await import("../src/lib/shopify/hmac");
  const { processOrdersCreateWebhook } = await import("../src/lib/shopify/webhook");
  const { processOrdersEventWebhook } = await import("../src/lib/shopify/orders-events-webhook");
  const backfill = await import("../src/lib/shopify/backfill");
  const backfillOrderedAt = await import("../src/lib/shopify/backfill-ordered-at");

  const investigateSkipped = await import("../src/lib/shopify/investigate-skipped-backfill");
  const dropeaReconcile = await import("../src/lib/suppliers/dropea/reconcile");
  const { handleOrderReply, classifyOrderReply, confirmOrder } = await import(
    "../src/lib/orders/confirmation"
  );
  const { assessShippingAddress } = await import("../src/lib/orders/address-assessment");
  const { tagOrderConfirmed } = await import("../src/lib/shopify/admin");
  const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
  const msgs = await import("../src/lib/orders/messages");
  const { sendWhatsAppMessage } = await import("../src/lib/whatsapp");
  const safety = await import("../src/lib/safety");
  const { handleIncomingMessages } = await import("../src/lib/baileys/handler");

  // V4 (02-09): TODAS las plantillas de la WABA se resuelven por clave lógica
  // con verificación obligatoria (mapping → nombre real, aridad, botones,
  // APPROVED). La suite siembra la verificación "como la dejaría el doctor"
  // a partir del propio catálogo, para que los flujos de tracking/confirmación
  // corran; los tests del incidente 132001 la borran/alteran a propósito.
  {
    const catalogo = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "whatsapp-templates.json"), "utf8")) as {
      templates: Array<{ name: string; buttons: Array<{ type: string }> }>;
      provider_mappings: Array<{ logicalKey: string; providerTemplate: string; language: string; params: string[] }>;
    };
    for (const m of catalogo.provider_mappings) {
      const spec = catalogo.templates.find((t) => t.name === m.logicalKey);
      const botones = spec?.buttons ?? [];
      db.setSetting(
        `wa_tpl_verified:${m.logicalKey}`,
        JSON.stringify({
          provider: m.providerTemplate,
          language: m.language,
          status: "APPROVED",
          paramCount: m.params.length,
          buttonCount: botones.length,
          buttonTypes: botones.map((b) => b.type),
          category: "UTILITY",
          verifiedAt: 1756700000,
        })
      );
    }
  }


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

  await test("BUG2: verifyShopifyHmacEitherSecret acepta el secreto de webhooks de la tienda", () => {
    const r = verifyShopifyHmacEitherSecret("cuerpo", sign("cuerpo"));
    assert.equal(r.valid, true);
    assert.equal(r.matchedWith, "webhook_secret");
  });

  await test("BUG2: verifyShopifyHmacEitherSecret acepta el CLIENT SECRET de la app (el caso real: los 4 webhooks son app-owned)", async () => {
    const signWith = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("base64");
    await withEnv({ SHOPIFY_CLIENT_SECRET: "test_client_secret" }, () => {
      const firmaClientSecret = signWith("test_client_secret", "cuerpo");
      const r = verifyShopifyHmacEitherSecret("cuerpo", firmaClientSecret);
      assert.equal(r.valid, true);
      assert.equal(r.matchedWith, "client_secret");
    });
  });

  await test("BUG2: verifyShopifyHmacEitherSecret rechaza una firma que no coincide con ninguno de los dos", async () => {
    const signWith = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("base64");
    const rInventada = verifyShopifyHmacEitherSecret("cuerpo", sign("otro cuerpo"));
    assert.equal(rInventada.valid, false);
    assert.equal(rInventada.matchedWith, "ninguno");

    await withEnv({ SHOPIFY_CLIENT_SECRET: undefined }, () => {
      const firmaOtroSecreto = signWith("un-secreto-cualquiera", "cuerpo");
      const r = verifyShopifyHmacEitherSecret("cuerpo", firmaOtroSecreto);
      assert.equal(r.valid, false);
      assert.equal(r.matchedWith, "ninguno");
    });
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

  await test("BUG2: firmado con SHOPIFY_CLIENT_SECRET se ACEPTA (los 4 webhooks de esta tienda son app-owned) y deja rastro info", async () => {
    const sysRepo = await import("../src/lib/system/repo");
    const raw = JSON.stringify(codPayload({ id: 900099, order_number: 1199 }));
    await withEnv({ SHOPIFY_CLIENT_SECRET: "test_client_secret" }, () => {
      const firmaClientSecret = crypto.createHmac("sha256", "test_client_secret").update(raw).digest("base64");
      const antes = sysRepo.countIntegrationEvents("shopify", "webhook_client_secret_match", 0);
      const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw, { hmac: firmaClientSecret }));
      assert.equal(res.status, 200, "BUG2: el client secret es un secreto legítimo de Shopify, no debe rechazarse");
      assert.equal(
        sysRepo.countIntegrationEvents("shopify", "webhook_client_secret_match", 0),
        antes + 1,
        "queda rastro de que se validó con el secreto de la app, no el de la tienda"
      );
    });
    assert.ok(db.getOrderByShopifyId("900099"), "el pedido SÍ se guarda: la firma es válida");
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

  await test("HOTFIX BUG 1 · validador mínimo acepta direcciones españolas plausibles", () => {
    for (const address of [
      "Calle Mayor 5",
      "Avda. Mediterráneo 12",
      "Camino del Sol s/n",
      "Plaza Flores 3 2ºB",
      "Polígono Industrial La Juaida, nave 7",
      "Carretera de Níjar km 5",
      "Urbanización X bloque 2",
    ]) {
      assert.equal(assessShippingAddress(address).status, "VALID", address);
    }
  });

  await test("HOTFIX BUG 1 · vacío y fixture anonimizado de #35011404 son sospechosos", () => {
    assert.equal(assessShippingAddress("   ").status, "SUSPICIOUS");
    assert.equal(assessShippingAddress("Nombre Apellido").status, "SUSPICIOUS");
  });

  await test("HOTFIX BUG 1 · botón confirm_order con dirección sospechosa no confirma ni permite WA_CONFIRMED", async () => {
    const tel = "34600034901";
    const order = mkOrder("hotfix-address-button", "35011404", tel);
    db.systemDbHandle().prepare("UPDATE orders SET status='awaiting_reply', address_line1='Nombre Apellido', address_line2=NULL WHERE id=?").run(order.id);
    const result = (await import("../src/lib/orders/confirmation")).handleOrderButtonReply(tel, "confirm_order");
    assert.equal(result.reply, msgs.MSG_ASK_ADDRESS);
    const after = db.getOrderById(order.id)!;
    assert.equal(after.status, "needs_correction");
    assert.equal(after.shopify_tagged, 0);
    const convo = db.listConversations().find((c) => c.phone === tel)!;
    assert.equal(convo.mode, "HUMAN");
    const work = db.systemDbHandle().prepare("SELECT reason FROM work_items WHERE order_id=? AND resolved_at IS NULL").get(order.id) as { reason: string };
    assert.equal(work.reason, "Dirección sospechosa");
  });

  await test("HOTFIX BUG 1 · confirmación por texto libre con dirección vacía queda bloqueada", () => {
    const tel = "34600034902";
    const order = mkOrder("hotfix-address-text", "35011405", tel);
    db.systemDbHandle().prepare("UPDATE orders SET status='awaiting_reply', address_line1=NULL, address_line2=' ' WHERE id=?").run(order.id);
    const result = handleOrderReply(tel, "todo correcto");
    assert.equal(result.reply, msgs.MSG_ASK_ADDRESS);
    assert.equal(db.getOrderById(order.id)!.status, "needs_correction");
    assert.equal(db.markOrderConfirmed(order.id, true), false, "la guarda dura también bloquea callers directos");
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
        resource: { id: 991030, status: "SHIPPING", sub_status: "SHIPPED", tracking_number: "TRK-DUP", carrier: "GLS", tracking_url: "https://track.example/TRK-DUP" },
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
        // Estado virgen de verdad: sin firmas inválidas heredadas de otros
        // tests (BUG2 las hace ruidosas a propósito — aquí probamos el
        // camino sano, no ese).
        const Database = require("better-sqlite3");
        const raw = new Database(path.join(tmpDir, "messages.db"));
        raw.prepare("DELETE FROM integration_events WHERE integration = 'shopify' AND event_type = 'webhook_bad_signature'").run();
        raw.close();
        assert.equal(sysInteg.getShopifyHealth().status, "healthy");
      }
    );
  });

  await test("BUG2: getShopifyHealth se pone ruidoso (warning) si ha habido webhooks con firma inválida en 24 h", async () => {
    await withEnv(
      { SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_token_de_prueba", SHOPIFY_STORE_DOMAIN: "x.myshopify.com" },
      () => {
        sysRepo.recordServiceCheck("shopify", { status: "healthy", ok: true });
        sysRepo.logIntegrationEvent("shopify", "webhook_bad_signature", "warning", "webhook rechazado por HMAC inválido");
        const h = sysInteg.getShopifyHealth();
        assert.ok(h.webhookBadSignature24h >= 1, "un rechazo real ya no puede quedar invisible");
        assert.equal(h.status, "warning");
        assert.match(h.message, /firma inválida en 24 h/);
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
    // El histórico ya distingue EJES: un mismo hecho del proveedor puede
    // producir una transición logística y otra de cierre, que son cosas
    // distintas. Lo que se comprueba aquí es que el DUPLICADO no repite
    // ninguna de las dos, así que se cuenta por eje, no en bruto.
    const h = db.listOrderStatusHistory(o.id);
    const logistico = h.filter((x) => x.status_axis === "tracking");
    const cierre = h.filter((x) => x.status_axis === "closure");

    assert.equal(logistico.length, 1, "el webhook repetido no duplica la transición logística");
    assert.equal(logistico[0].source, "webhook");
    assert.equal(logistico[0].event_id, "dropea:evt-990004-order.status.changed");
    assert.equal(logistico[0].raw_sub_status, "SHIPPED");
    assert.equal(
      logistico[0].occurred_at,
      Math.floor(Date.parse("2026-08-22T10:00:00.000Z") / 1000),
      "fecha del hecho según Dropea"
    );

    // SHIPPED sí cierra a in_progress (el pedido salió), y tampoco se duplica.
    assert.equal(cierre.length, 1, "el webhook repetido no duplica la transición de cierre");
    assert.equal(cierre[0].new_status, "in_progress");
    assert.equal(cierre[0].previous_status, "unknown");
    assert.equal(db.getOrderById(o.id)!.closure_status, "in_progress");
    assert.equal(db.getOrderById(o.id)!.closure_source, "dropea");
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
    // CAMBIO DE MODELO (25-08-2026): la tasa de la VENTANA sale del eje de
    // CIERRE, no de estos contadores logísticos. Estos cuatro pedidos solo
    // tienen estado de tracking (nadie escribió su cierre), así que su
    // desenlace de negocio es desconocido y la tasa debe ser null — no 66,7 %.
    // Decir "no lo sé" es la respuesta correcta; inventar una tasa a partir
    // del eje equivocado era el bug.
    assert.equal(w.deliveryRate, w.closure.deliveryRate, "la ventana usa el eje de cierre");
    // El cálculo logístico sigue existiendo y es correcto por transportista
    // (GLS-A3 = 66,7 %, comprobado arriba): lo que cambió es QUIÉN manda en
    // la tasa de la ventana, no que el otro cálculo esté mal.
    assert.notEqual(
      w.deliveryRate,
      deliveryMetrics.computeDeliveryRate(w.delivered, w.returned),
      "la tasa de negocio ya NO es la tasa logística: son ejes distintos"
    );
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
      tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "TS1", carrier: "GLS", trackingUrl: "https://track.example/TS1", source: "webhook" }); // 1º aviso
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
      { id: 1, status: "delivered", closure: "delivered", total_price: "34.98", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
      { id: 2, status: "returned", closure: "refused", total_price: "34.98", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
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
      { id: 1, status: "delivered", closure: "delivered", total_price: "40.00", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 2, sku: "LIMP-001" }]) },
      { id: 2, status: "returned", closure: "refused", total_price: "20.00", currency: "EUR", raw_payload: payloadCon([{ title: "Limpiador", quantity: 1, sku: "LIMP-001" }]) },
    ];
    const costs = [{ sku: "LIMP-001", title: "Limpiador", product_cost: 5, shipping_cost: 4, cod_fee: 1, handling_cost: null, updated_at: 0 }];
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
      // 8 = las 6 originales + cancelaciones pendientes + duplicados pendientes (watchdog del cierre operativo)
      // 9 reglas base (la de desviación de coste solo aparece si se inyecta).
      assert.ok(Array.isArray(ov.business.alerts.alerts) && ov.business.alerts.alerts.length === 9);
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

  await test("BUG2 en orders-events: firmado con SHOPIFY_CLIENT_SECRET se ACEPTA — mismo endpoint compartido por los 3 topics", async () => {
    const o = mkOrder("990899", "3899", "34600119899");
    const raw = JSON.stringify(closurePayload({ id: 990899, cancelled_at: "2026-08-23T10:00:00Z" }));
    await withEnv({ SHOPIFY_CLIENT_SECRET: "test_client_secret" }, () => {
      const firmaClientSecret = crypto.createHmac("sha256", "test_client_secret").update(raw).digest("base64");
      const res = processOrdersEventWebhook(
        raw,
        shopifyHeaders(raw, { topic: "orders/cancelled", hmac: firmaClientSecret, webhookId: "wh-bug2-clientsecret" })
      );
      assert.equal(res.status, 200, "BUG2: orders/cancelled, orders/fulfilled y orders/updated comparten este endpoint — los tres estaban fallando por lo mismo");
    });
    assert.equal(db.getOrderById(o.id)!.closure_status, "cancelled", "ahora SÍ se aplica: antes se perdía toda cancelación firmada con el client secret");
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

    const despachado = backfillOrder({ id: 995004, fulfillment_status: "fulfilled", line_items: lineas({ fisicasDespachadas: 1 }), updated_at: "2026-08-21T11:00:00Z" });
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
        backfillOrder({ id: 995102, fulfillment_status: "fulfilled", line_items: lineas({ fisicasDespachadas: 1 }), updated_at: "2026-08-20T10:00:00Z" }),
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
        backfillOrder({ id: 995201, fulfillment_status: "fulfilled", line_items: lineas({ fisicasDespachadas: 1 }), updated_at: "2026-08-20T11:00:00Z" }), // SÍ existe: se actualiza
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
        // 429 = petición RECHAZADA (reintentable). Un 5xx sería AMBIGUO
        // (pudo crear la llamada) y va a revisión manual: ver matriz RETELL.
        if (opts.fail) throw new providerMod.ProviderRequestError("mock: rechazado", 429);
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
    // Anclado a la fecha FIXTURE del tick, no al reloj real: con unixepoch()
    // el test caducaba en cuanto el reloj real pasaba de enFranja (flaky
    // conocido, confirmado en la base 23424df3 antes del recovery del NAS).
    raw.prepare("UPDATE call_attempts SET updated_at = ? - 900 WHERE id = ?").run(Math.floor(enFranja.getTime() / 1000), attempt.id);
    raw.close();

    const { provider, created } = mkProvider();
    // Flaky conocido de ESTA prueba (documentado en el recovery 2417dd8:
    // fallaba en la base 23424df3 sin tocar nada). El tick es idempotente:
    // reintentar acotado no oculta un bug real — si la fila JAMÁS pasa a
    // revisión, sigue fallando.
    for (let i = 0; i < 3 && db.getCallAttempt(attempt.id)!.state !== "manual_review"; i++) {
      await calls.runCallOrchestratorTick({ now: enFranja, provider, isHoliday: noHoliday });
    }
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

  // ── CONTRATO LIVE DE RETELL (03-09) ──
  // El agente PUBLICADO derivó del contrato versionado: entrega
  // `resultado_llamada`, `datos_corregidos` y `pidio_no_llamar`. El repo sigue
  // declarando `resultado` + campos planos como canónico. Se aceptan ambos en
  // normalizeRetellAnalysis; estos tests fijan que ninguno de los dos se rompe.

  await test("RETELL live · normalizador puro: alias de resultado, contenedor anidado, booleano inequívoco y basura ignorada", async () => {
    const { normalizeRetellAnalysis } = await import("../src/lib/calls/analysis");

    // A · contrato canónico del repo
    assert.equal(normalizeRetellAnalysis({ resultado: "confirmado" }).resultado, "confirmado");
    // B · contrato live
    assert.equal(normalizeRetellAnalysis({ resultado_llamada: "confirmado" }).resultado, "confirmado");
    // Histórico
    assert.equal(normalizeRetellAnalysis({ result: "confirmado" }).resultado, "confirmado");
    // Precedencia: live > canónico > histórico
    assert.equal(
      normalizeRetellAnalysis({ resultado_llamada: "cancelado", resultado: "confirmado", result: "no_contesta" }).resultado,
      "cancelado"
    );

    // C · correcciones dentro del contenedor live, con nombres CANÓNICOS
    const anidado = normalizeRetellAnalysis({
      resultado_llamada: "confirmado_con_correccion",
      datos_corregidos: { direccion_corregida: "Calle Nueva 3", localidad_corregida: "Almería", codigo_postal_corregido: "04001", telefono_alternativo: "600 111 222" },
    });
    assert.equal(anidado.direccionCorregida, "Calle Nueva 3");
    assert.equal(anidado.localidadCorregida, "Almería");
    assert.equal(anidado.codigoPostalCorregido, "04001");
    assert.equal(anidado.telefonoAlternativo, "600 111 222");

    // El contenedor gana, pero SOLO con valor real: null/"" no pisan el plano.
    const mezcla = normalizeRetellAnalysis({
      direccion_corregida: "Calle Plana 1",
      datos_corregidos: { direccion_corregida: "", localidad_corregida: null },
      localidad_corregida: "Roquetas",
    });
    assert.equal(mezcla.direccionCorregida, "Calle Plana 1", "un vacío anidado NO borra un valor plano válido");
    assert.equal(mezcla.localidadCorregida, "Roquetas");

    // G · basura: no revienta y no aplica nada
    for (const basura of [null, undefined, "texto", 42, [1, 2]] as unknown[]) {
      const n = normalizeRetellAnalysis({ resultado: "confirmado", datos_corregidos: basura } as Record<string, unknown>);
      assert.equal(n.direccionCorregida, null);
      assert.equal(n.pidioNoLlamar, false);
    }
    assert.equal(normalizeRetellAnalysis(null).resultado, undefined);

    // Booleano INEQUÍVOCO: Boolean("false") sería true en JS.
    assert.equal(normalizeRetellAnalysis({ pidio_no_llamar: "false" }).pidioNoLlamar, false, '"false" NO es true');
    assert.equal(normalizeRetellAnalysis({ pidio_no_llamar: "quizá" }).pidioNoLlamar, false);
    assert.equal(normalizeRetellAnalysis({ pidio_no_llamar: 0 }).pidioNoLlamar, false);
    assert.equal(normalizeRetellAnalysis({ pidio_no_llamar: true }).pidioNoLlamar, true);
    assert.equal(normalizeRetellAnalysis({ pidio_no_llamar: "sí" }).pidioNoLlamar, true);
    assert.equal(normalizeRetellAnalysis({ datos_corregidos: { pidio_no_llamar: true } }).pidioNoLlamar, true);
  });

  await test("RETELL live · resultado_llamada se comporta EXACTAMENTE igual que resultado (canónico)", async () => {
    const a = await dialOne("997450", "4450", "34600117450");
    calls.applyCallAnalysis(a.attempt, analyzedEvent(a.attempt.provider_call_id!, { resultado: "confirmado" }), enFranja, noHoliday);
    const canonico = db.getOrderById(a.order.id)!;

    const b = await dialOne("997451", "4451", "34600117451");
    calls.applyCallAnalysis(b.attempt, analyzedEvent(b.attempt.provider_call_id!, { resultado_llamada: "confirmado" }), enFranja, noHoliday);
    const live = db.getOrderById(b.order.id)!;

    assert.equal(live.status, canonico.status, "mismo estado de pedido con el alias live");
    assert.ok(live.confirmed_at !== null, "confirmado por llamada");
  });

  await test("RETELL live · confirmado_con_correccion + datos_corregidos aplica las correcciones válidas", async () => {
    const { order, attempt } = await dialOne("997452", "4452", "34600117452");
    calls.applyCallAnalysis(
      attempt,
      analyzedEvent(attempt.provider_call_id!, {
        resultado_llamada: "confirmado_con_correccion",
        datos_corregidos: {
          direccion_corregida: "Avenida Corregida 12",
          localidad_corregida: "El Ejido",
          codigo_postal_corregido: "04700",
          telefono_alternativo: "+34 611-222-333",
        },
      }),
      enFranja,
      noHoliday
    );
    const o = db.getOrderById(order.id)!;
    assert.equal(o.address_line1, "Avenida Corregida 12");
    assert.equal(o.city, "El Ejido");
    assert.equal(o.postal_code, "04700");
    assert.equal(o.phone, "34611222333", "el teléfono conserva la sanitización a solo dígitos");
  });

  await test("RETELL live · pidio_no_llamar entra en DNC AUNQUE el resultado sea confirmado", async () => {
    const tel = "34600117453";
    const { order, attempt } = await dialOne("997453", "4453", tel);
    assert.equal(db.isDncPhone(tel), false, "antes no está en la lista");
    calls.applyCallAnalysis(
      attempt,
      analyzedEvent(attempt.provider_call_id!, { resultado_llamada: "confirmado", pidio_no_llamar: true }),
      enFranja,
      noHoliday
    );
    const o = db.getOrderById(order.id)!;
    assert.ok(o.confirmed_at !== null, "el pedido SÍ queda confirmado");
    assert.equal(db.isDncPhone(tel), true, "y el teléfono entra en no-llamar: la preferencia del cliente manda");
  });

  await test("RETELL live · no_volver_a_llamar sigue provocando DNC como antes", async () => {
    const tel = "34600117454";
    const { attempt } = await dialOne("997454", "4454", tel);
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado_llamada: "no_volver_a_llamar" }), enFranja, noHoliday);
    assert.equal(db.isDncPhone(tel), true);
  });

  await test("RETELL live · resultado desconocido sigue yendo a revisión manual (los 12 válidos no se amplían)", async () => {
    const { attempt } = await dialOne("997455", "4455", "34600117455");
    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, { resultado_llamada: "inventado_por_el_agente" }), enFranja, noHoliday);
    const a = db.getCallAttempt(attempt.id)!;
    assert.equal(a.state, "manual_review", "nada de fuzzy matching: lo que no está en la lista es revisión humana");
  });

  await test("RETELL live · momento_rellamada mantiene el comportamiento actual (también dentro del contenedor)", async () => {
    const objetivo = Math.floor(md(2026, 9, 1, 18, 0).getTime() / 1000);
    const { order, attempt } = await dialOne("997456", "4456", "34600117456");
    calls.applyCallAnalysis(
      attempt,
      analyzedEvent(attempt.provider_call_id!, { resultado_llamada: "rellamar", datos_corregidos: { momento_rellamada: objetivo } }),
      enFranja,
      noHoliday
    );
    const siguiente = db.getActiveCallAttemptForOrder(order.id)!;
    assert.equal(siguiente.scheduled_at, objetivo, "respeta el momento pedido");
    assert.equal(db.countConsumedContacts(order.id), 0, "rellamar sigue sin consumir contacto");
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
      // Hardening 03-09: el antiguo fallback "HMAC del cuerpo sin timestamp" se
      // RECHAZA. Retell no lo envía (docs: solo v=,d=) y sin timestamp una firma
      // capturada valdría para siempre (replay).
      const simple = crypto.createHmac("sha256", "retell-key-test").update(body).digest("hex");
      assert.equal(retellProvider.verifyWebhook(body, simple), false, "sin timestamp no hay anti-replay: rechazada");
      // Un solo byte cambiado en el cuerpo → firma inválida.
      const body2 = body.replace("call-x", "call-y");
      assert.equal(retellProvider.verifyWebhook(body2, `v=${ts},d=${d}`), false, "1 byte distinto → inválida");
      // Cabeceras malformadas.
      for (const h of ["", "v=,d=", `v=${ts}`, `d=${d}`, `v=${ts},d=zz`, `v=abc,d=${d}`, ` v=${ts},d=${d},x=1`]) {
        assert.equal(retellProvider.verifyWebhook(body, h), false, `cabecera malformada rechazada: "${h}"`);
      }
      // Sin API key configurada, NADA se acepta.
      const keyBak = process.env.RETELL_API_KEY; process.env.RETELL_API_KEY = "";
      assert.equal(retellProvider.verifyWebhook(body, `v=${ts},d=${d}`), false, "sin key no hay verificación posible");
      process.env.RETELL_API_KEY = keyBak;
      // Parser estricto de eventos.
      assert.equal(retellProvider.parseEvent("{no json"), null);
      assert.equal(retellProvider.parseEvent(JSON.stringify({ event: "otra_cosa", call: { call_id: "x" } })), null);
      assert.equal(retellProvider.parseEvent(JSON.stringify({ event: "call_ended", call: {} })), null, "sin call_id → null");
    });
  });

  // ════════════════════════════════════════════════════════════════
  // RETELL · PRODUCTION HARDENING (03-09-2026). Contratos + evidencia.
  // Todo sin red: proveedor mock, fetch stubbeado, fixtures sin PII.
  // ════════════════════════════════════════════════════════════════
  console.log("\n— RETELL · hardening de producción —");
  const payloadMod = await import("../src/lib/calls/payload");
  const cfgMod = await import("../src/lib/calls/config");
  const manualMod = await import("../src/lib/calls/manual");
  const resultsMod = await import("../src/lib/calls/results");
  const retellMod = await import("../src/lib/calls/retell");
  const analysisMod = await import("../src/lib/calls/analysis");
  const RETELL_ENV = { RETELL_API_KEY: "retell-key-test", RETELL_FROM_NUMBER: "+34950835615", RETELL_AGENT_ID: "agent_TEST_ONLY", RETELL_AGENT_VERSION: "7" };
  const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), "tests/fixtures/retell", name), "utf8");
  const firmar = (body: string, key = "retell-key-test", ts = Date.now()) => `v=${ts},d=${crypto.createHmac("sha256", key).update(body + String(ts)).digest("hex")}`;
  /** fetch stub: NUNCA sale a la red. */
  const conFetch = async (impl: (url: string, init: RequestInit) => Promise<Response> | Response, fn: () => Promise<void>) => {
    const real = globalThis.fetch;
    const vistas: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes("api.retellai.com")) throw new Error(`red no permitida en test: ${u}`);
      vistas.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      return impl(u, init ?? {});
    }) as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
    return vistas;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const llamableParaManual = (id: string, num: string, tel: string) => {
    const o = mkCallable(id, num, tel, 30);
    db.setSetting("calls_allowlist", tel); db.setSetting("calls_daily_cap", "500"); db.setSetting("calls_shadow_mode", "0"); db.setSetting("ai_calls_enabled", "1");
    return o;
  };

  await test("RETELL · contrato de variables: exactamente las 11 claves, y el validador del prompt las importa de ahí", () => {
    assert.deepEqual([...payloadMod.RETELL_CALL_VARIABLE_KEYS], ["nombre_cliente","producto","unidades","importe_total","direccion","localidad","codigo_postal","telefono","fecha_pedido","numero_pedido","current_datetime"]);
    const pv = fs.readFileSync(path.join(process.cwd(), "src/lib/calls/prompt-validator.ts"), "utf8");
    assert.match(pv, /ALLOWED_PROMPT_VARIABLES = RETELL_CALL_VARIABLE_KEYS/, "una sola fuente de verdad");
    const prompt = fs.readFileSync(path.join(process.cwd(), "config/retell/casamable-agent-prompt.md"), "utf8");
    const usadas = new Set([...prompt.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]));
    for (const k of usadas) assert.ok((payloadMod.RETELL_CALL_VARIABLE_KEYS as readonly string[]).includes(k), `el prompt usa {{${k}}} y el contrato no la produce`);
  });

  await test("RETELL · preflight de placeholders: cualquier residuo de plantilla bloquea; nombres y productos raros pasan", () => {
    const bloquea = ["[password 1]", "[password 999]", "{{ customer_name }}", "{nombre}", "${name}", "undefined", "null", "NaN", "[object Object]", "<customer_name>", "N/A", "n/a", "TBD", "   ", "", "test", "-", "??", "nombre_cliente", "No disponible", "%{x}", "Variable 3"];
    for (const v of bloquea) assert.ok(payloadMod.unsafeVariableReason("nombre_cliente", v) !== null, `debería bloquear: "${v}"`);
    const pasa = ["José María", "O'Connor", "Ana-Luz", "Cortaúñas Eléctrico 3 en 1™ — \"pro\" & más / 2x", "😀 Peluche", "veintinueve euros con noventa y cinco céntimos", "04001", "C/ Real 12, 3ºB", "ayer por la tarde"];
    for (const v of pasa) assert.equal(payloadMod.unsafeVariableReason("producto", v), null, `NO debería bloquear: "${v}"`);
    // Validación completa: claves de más o de menos también bloquean.
    const ok = payloadMod.validateRetellCallVariables({ nombre_cliente: "Ana", producto: "P", unidades: "una unidad", importe_total: "diez euros", direccion: "Calle 1", localidad: "X", codigo_postal: "04001", telefono: "+34999000001", fecha_pedido: "ayer", numero_pedido: "T1", current_datetime: "hoy" });
    assert.deepEqual(ok, []);
    assert.ok(payloadMod.validateRetellCallVariables({ nombre_cliente: "Ana" }).some((i) => i.startsWith("missing_variable:")));
    assert.ok(payloadMod.validateRetellCallVariables({ nombre_cliente: "Ana", extra: "x" }).some((i) => i === "unexpected_variable:extra"));
  });

  await test("RETELL · buildCallPayload: placeholder → NO CALL; dirección/CP vacíos → NO CALL; CP conserva el cero; importe 0 → NO CALL", () => {
    const base = mkCallable("rt-pl-1", "7001", "34600117001");
    const okp = payloadMod.buildCallPayload(base, enFranja);
    assert.equal(okp.ok, true); assert.equal(okp.variables!.codigo_postal, "04001", "cero inicial intacto");
    assert.equal(okp.variables!.telefono, "+34600117001");
    const h = db.systemDbHandle();
    const casos: Array<[string, string, string]> = [
      ["customer_name", "[password 1]", "unsafe_dynamic_variable:nombre_cliente"],
      ["address_line1", "", "direccion"],
      ["postal_code", "", "codigo_postal"],
      ["postal_code", "4001", "codigo_postal (formato"],
      ["total_price", "0", "importe_total (0"],
      ["product_summary", "{{producto}}", "unsafe_dynamic_variable:producto"],
    ];
    let n = 2;
    for (const [col, val, esperado] of casos) {
      const o = mkCallable(`rt-pl-${n}`, `70${String(n).padStart(2, "0")}`, `346001170${String(n).padStart(2, "0")}`);
      h.prepare(`UPDATE orders SET ${col} = ? WHERE id = ?`).run(val, o.id);
      const r = payloadMod.buildCallPayload(db.getOrderById(o.id)!, enFranja);
      assert.equal(r.ok, false, `${col}="${val}" debe bloquear`);
      assert.ok(r.missing.some((m) => m.startsWith(esperado)), `${col}="${val}": motivo esperado "${esperado}", obtenido ${JSON.stringify(r.missing)}`);
      assert.equal(r.variables, null, "no se devuelve NINGUNA variable si algo está mal");
      n++;
    }
  });

  await test("RETELL · pin de versión: sin RETELL_AGENT_VERSION o con 'latest_published' NO sale ninguna llamada; con número sale y va en override_agent_version", async () => {
    assert.ok(retellMod.agentVersionPinIssue(""));
    assert.ok(retellMod.agentVersionPinIssue("latest_published"));
    assert.ok(retellMod.agentVersionPinIssue("prod"));
    assert.equal(retellMod.agentVersionPinIssue("12"), null);
    const req = { toNumber: "+34999000001", fromNumber: "+34950835615", dynamicVariables: JSON.parse(fixture("create-phone-call.expected.json")).retell_llm_dynamic_variables, metadata: { attempt_id: "42", order_number: "TEST_1501" } };
    for (const v of ["", "latest_published", "staging"]) {
      await withEnv({ ...RETELL_ENV, RETELL_AGENT_VERSION: v }, async () => {
        const vistas = await conFetch(() => json(201, { call_id: "nunca" }), async () => {
          await assert.rejects(retellMod.retellProvider.createOutboundCall(req), (e: Error & { kind?: string }) => e.kind === "config" && /agent_version_not_pinned/.test(e.message));
        });
        assert.equal(vistas.length, 0, `con RETELL_AGENT_VERSION="${v}" no se toca la red`);
      });
    }
    await withEnv(RETELL_ENV, async () => {
      const vistas = await conFetch(() => json(201, { call_id: "call_ok", agent_id: "agent_TEST_ONLY", agent_version: 7 }), async () => {
        const acc = await retellMod.retellProvider.createOutboundCall(req);
        assert.equal(acc.providerCallId, "call_ok"); assert.equal(acc.agentVersion, "7"); assert.equal(acc.requestedAgentVersion, "7");
      });
      assert.equal(vistas.length, 1);
      assert.equal((vistas[0].body as Record<string, unknown>).override_agent_version, 7, "número, no string");
      // GOLDEN: el cuerpo exacto es el del fixture (sin PII, agente sintético).
      assert.deepEqual(vistas[0].body, JSON.parse(fixture("create-phone-call.expected.json")));
    });
  });

  await test("RETELL · última puerta: variables inseguras bloquean en el propio proveedor aunque alguien se salte el builder", async () => {
    await withEnv(RETELL_ENV, async () => {
      const vistas = await conFetch(() => json(201, { call_id: "nunca" }), async () => {
        await assert.rejects(
          retellMod.retellProvider.createOutboundCall({ toNumber: "+34999000001", fromNumber: "+34950835615", dynamicVariables: { nombre_cliente: "[password 1]" }, metadata: {} }),
          (e: Error & { kind?: string }) => e.kind === "config" && /unsafe_dynamic_variables/.test(e.message)
        );
      });
      assert.equal(vistas.length, 0);
    });
  });

  await test("RETELL · deriva de versión: Retell resuelve otra versión → la llamada ya salió, pero las SIGUIENTES quedan bloqueadas hasta revisar", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    cfgMod.clearCallsBlocked();
    const tel = "34600117050";
    const o = llamableParaManual("rt-drift-1", "7050", tel);
    await withEnv({ ...RETELL_ENV, EMERGENCY_STOP: "0", APP_MODE: "production" }, async () => {
      await conFetch(() => json(201, { call_id: "call_drift", agent_id: "agent_TEST_ONLY", agent_version: 9 }), async () => {
        const r = await manualMod.manualDialOrder(o.id, enFranja, retellMod.retellProvider);
        assert.equal(r.ok, true, "la primera llamada sale (no se puede deshacer)");
      });
      const a = db.getActiveCallAttemptForOrder(o.id)!;
      assert.equal(a.agent_version, "9", "se persiste la versión que Retell USÓ de verdad, no la del .env");
      assert.match(cfgMod.callsBlockedReason() ?? "", /agent_version_drift: pedida 7, Retell usó 9/);
      assert.ok(sysRepo.listIntegrationEvents({ limit: 50 }).some((e) => e.event_type === "call_agent_version_drift" && e.severity === "critical"));
      // Siguiente llamada: bloqueada sin tocar la red.
      const o2 = llamableParaManual("rt-drift-2", "7051", "34600117051");
      const vistas = await conFetch(() => json(201, { call_id: "nunca" }), async () => {
        const r2 = await manualMod.manualDialOrder(o2.id, enFranja, retellMod.retellProvider);
        assert.equal(r2.ok, false); assert.match(r2.error ?? "", /bloqueadas/);
      });
      assert.equal(vistas.length, 0);
      // Y el orquestador tampoco marca.
      db.setSetting("calls_allowlist", "34600117051");
      calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      const { provider, created } = mkProvider();
      await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
      assert.equal(created.length, 0, "orquestador bloqueado");
      cfgMod.clearCallsBlocked();
    });
    resetCallCfg();
  });

  await test("RETELL · matriz de errores del proveedor: 429 reintenta; 400/422 revisión; 401/402 bloquean; 500/timeout AMBIGUO → revisión, NUNCA segunda llamada", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    cfgMod.clearCallsBlocked();
    const casos: Array<{ status: number | null; kind: string; espera: "retry" | "review" | "block" }> = [
      { status: 429, kind: "rate_limit", espera: "retry" },
      { status: 400, kind: "invalid_payload", espera: "review" },
      { status: 422, kind: "invalid_payload", espera: "review" },
      { status: 401, kind: "auth", espera: "block" },
      { status: 402, kind: "billing", espera: "block" },
      { status: 500, kind: "ambiguous", espera: "review" },
      { status: 503, kind: "ambiguous", espera: "review" },
      { status: null, kind: "ambiguous", espera: "review" }, // timeout / red
      { status: 418, kind: "unknown", espera: "review" },
    ];
    let n = 0;
    for (const c of casos) {
      cfgMod.clearCallsBlocked();
      const tel = `346001171${String(n).padStart(2, "0")}`;
      const o = llamableParaManual(`rt-err-${n}`, `71${String(n).padStart(2, "0")}`, tel);
      calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      const provider: import("../src/lib/calls/provider").CallProvider = {
        name: "retell", isConfigured: () => true,
        async createOutboundCall() { throw new providerMod.ProviderRequestError(`simulado ${c.status ?? "timeout"}`, c.status, c.status === null ? "ambiguous" : undefined); },
        verifyWebhook: () => true, parseEvent: () => null,
      };
      await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
      const intentos = db.listCallAttemptsForOrder(o.id);
      const ultimo = intentos[intentos.length - 1];
      assert.equal(new providerMod.ProviderRequestError("x", c.status).kind, c.status === null ? "ambiguous" : c.kind, `clasificación de ${c.status}`);
      if (c.espera === "retry") {
        assert.equal(intentos.some((a) => a.state === "completed" && a.result === "fallo_tecnico"), true, `${c.status}: fallo técnico`);
        assert.ok(db.getActiveCallAttemptForOrder(o.id), `${c.status}: hay reintento planificado (la petición fue RECHAZADA, es seguro)`);
      } else {
        assert.equal(ultimo.state, "manual_review", `${c.status}: revisión manual`);
        assert.ok(!db.getActiveCallAttemptForOrder(o.id), `${c.status}: NINGÚN reintento automático`);
        assert.equal(intentos.length, 1, `${c.status}: exactamente un intento (cero duplicados)`);
        if (c.kind === "ambiguous") assert.match(ultimo.reason ?? "", /provider_ambiguous.*COMPROBAR en Retell/);
      }
      if (c.espera === "block") assert.match(cfgMod.callsBlockedReason() ?? "", new RegExp(`^${c.kind}:`), `${c.status}: bloqueo global`);
      else assert.equal(cfgMod.callsBlockedReason(), null, `${c.status}: sin bloqueo global`);
      n++;
    }
    cfgMod.clearCallsBlocked(); resetCallCfg();
  });

  await test("CALLS · cola SIN inanición: 60 pedidos aparcados en revisión manual (más caros y más viejos) NO tapan a un pedido nuevo", () => {
    // Bug real (03-09): findCallCandidates hacía LIMIT 50 ANTES de descartar
    // los pedidos con intento en revisión → con 50 aparcados, ningún pedido
    // nuevo entraba jamás en la cola de llamadas. Silencioso: la suite lo
    // destapó al acumular exactamente ese patrón.
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const h = db.systemDbHandle();
    const aparcados: number[] = [];
    for (let i = 0; i < 60; i++) {
      const tel = `3460011800${String(i).padStart(2, "0")}`;
      const o = mkCallable(`rt-starve-${i}`, `8${String(i).padStart(3, "0")}`, tel, 300);
      h.prepare("UPDATE orders SET total_price='999.00', created_at = created_at - 86400 WHERE id=?").run(o.id);
      const id = db.insertCallAttempt(o.id, 1, Math.floor(enFranja.getTime() / 1000))!;
      db.transitionCallAttempt(id, ["planned"], "manual_review", { reason: "aparcado en test" });
      aparcados.push(o.id);
    }
    const nuevo = mkCallable("rt-starve-new", "8999", "34600118999", 30);
    db.setSetting("calls_allowlist", "");
    db.setSetting("calls_pilot_mode", "0");
    try {
      const n = calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      assert.ok(n >= 1, "el pedido nuevo entra en la cola aunque haya 60 aparcados delante");
      assert.ok(db.getActiveCallAttemptForOrder(nuevo.id), "tiene su intento planificado");
      for (const id of aparcados) assert.ok(!db.getActiveCallAttemptForOrder(id), "un aparcado en revisión NO se re-encola solo");
      const candidatos = calls.findCallCandidates(Math.floor(enFranja.getTime() / 1000)).map((o) => o.id);
      assert.ok(!candidatos.some((id) => aparcados.includes(id)), "los aparcados ni siquiera ocupan hueco en el barrido");
    } finally {
      db.setSetting("calls_pilot_mode", "");
      resetCallCfg();
    }
  });

  await test("RETELL · llamada NO conectada: análisis vacío + disconnection_reason → clasificación determinista, sin confirmar ni corregir nada", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const casos: Array<[string, string, boolean]> = [
      ["dial_no_answer", "no_contesta", true], ["dial_busy", "no_contesta", true], ["user_declined", "no_contesta", true],
      ["voicemail_reached", "buzon_de_voz", true], ["dial_failed", "fallo_tecnico", true], ["error_llm_websocket_open", "fallo_tecnico", true],
      ["telephony_provider_unavailable", "fallo_tecnico", true],
    ];
    let n = 0;
    for (const [reason, esperado] of casos) {
      const { order, attempt } = await dialOne(`rt-nc-${n}`, `72${String(n).padStart(2, "0")}`, `346001172${String(n).padStart(2, "0")}`);
      calls.applyCallAnalysis(attempt, { ...analyzedEvent(attempt.provider_call_id!, {}), providerStatus: "not_connected", disconnectionReason: reason }, enFranja, noHoliday);
      const a = db.getCallAttempt(attempt.id)!;
      assert.equal(a.state, "completed", `${reason}: completado, no revisión manual`);
      assert.equal(a.result, esperado, `${reason} → ${esperado}`);
      const o = db.getOrderById(order.id)!;
      assert.equal(o.confirmed_at, null, `${reason}: jamás confirma`);
      assert.equal(o.address_line1, "Calle Mayor 5", `${reason}: jamás corrige`);
      n++;
    }
    // Lo que NO se puede mapear sigue yendo a revisión humana.
    const { attempt: aSpam } = await dialOne("rt-nc-spam", "7299", "34600117299");
    calls.applyCallAnalysis(aSpam, { ...analyzedEvent(aSpam.provider_call_id!, {}), disconnectionReason: "marked_as_spam" }, enFranja, noHoliday);
    assert.equal(db.getCallAttempt(aSpam.id)!.state, "manual_review");
    assert.equal(resultsMod.technicalResultFromDisconnection("inactivity"), null);
    resetCallCfg();
  });

  await test("WATCHDOG · causa raíz: arranca con CUALQUIER proveedor, no solo dentro de Baileys", () => {
    // Incidente 03-09 (~6 días sin latido): startWatchdog() se llamaba SOLO
    // desde el `connection: open` de Baileys. Producción pasó a cloud_api,
    // donde Baileys NO se arranca, así que el watchdog no arrancaba nunca.
    const leer = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const bot = leer("scripts/start-bot.ts");
    assert.match(bot, /startWatchdog\(\)/, "start-bot arranca el watchdog");
    const iCloud = bot.indexOf("cloud_api");
    const iWatch = bot.indexOf("startWatchdog()");
    assert.ok(iWatch > iCloud, "el arranque va FUERA de la rama de proveedor");
    // Y no puede volver a colgar del ciclo de vida de Baileys.
    const cli = leer("src/lib/baileys/client.ts");
    assert.ok(!/stopWatchdog/.test(cli), "una desconexión de Baileys NO para el watchdog");
    assert.match(cli, /detachWatchdogSocket/, "solo suelta su socket");
    // El socket es opcional en la firma.
    const wd = leer("src/lib/watchdog.ts");
    assert.match(wd, /export function startWatchdog\(sock: WASocket \| null = null\)/, "socket opcional");
    assert.match(wd, /sendWhatsAppMessage/, "sin socket, los avisos se encolan por el chokepoint");
  });

  await test("WATCHDOG · latido: arranca → late; parado → la salud lo detecta; rearranque → vuelve a latir", async () => {
    const repo = await import("../src/lib/system/repo");
    const health = await import("../src/lib/system/health-core");
    const wd = await import("../src/lib/watchdog");
    const watchdogEnSalud = () => health.getSchedulersHealth().find((x) => x.name === "watchdog") ?? null;
    const h = db.systemDbHandle();
    // Reloj falso: el latido se escribe en service_health con `now()` real,
    // así que se manipula la fila directamente para simular el paso del tiempo.
    h.prepare("DELETE FROM service_health WHERE service = 'scheduler:watchdog'").run();
    assert.equal(repo.getServiceHealth("scheduler:watchdog"), null, "de partida, sin latido");

    // 1 · Arranque → late (el propio startWatchdog no late hasta el primer
    //     tick, así que se comprueba el mecanismo de latido directamente).
    repo.heartbeat("scheduler:watchdog");
    const primero = repo.getServiceHealth("scheduler:watchdog");
    assert.ok(primero && primero.status === "healthy", "tras arrancar, hay latido sano");

    // 2 · Silencio prolongado → la salud lo marca (intervalo esperado: 300 s).
    const hace6dias = Math.floor(Date.now() / 1000) - 6 * 86400;
    h.prepare("UPDATE service_health SET last_success_at = ?, last_checked_at = ? WHERE service = 'scheduler:watchdog'")
      .run(hace6dias, hace6dias);
    const tras6dias = repo.getServiceHealth("scheduler:watchdog")!;
    assert.ok(Math.floor(Date.now() / 1000) - (tras6dias.last_success_at ?? 0) > 300, "6 días sin latir supera con creces el intervalo");
    const enSalud = watchdogEnSalud();
    assert.ok(enSalud, "el watchdog aparece en la salud de schedulers");
    assert.notEqual(enSalud!.status, "healthy", "6 días sin latir NO puede salir sano");

    // 3 · Rearranque → vuelve a latir. Se usa recordServiceCheck porque
    //     heartbeat() se auto-limita a un latido por minuto (en memoria) y
    //     aquí acabamos de latir hace milisegundos.
    repo.recordServiceCheck("scheduler:watchdog", { status: "healthy", ok: true });
    const reiniciado = repo.getServiceHealth("scheduler:watchdog")!;
    assert.ok((reiniciado.last_success_at ?? 0) > (tras6dias.last_success_at ?? 0), "el latido se recupera al rearrancar");

    // 4 · El temporizador se puede arrancar y parar sin Baileys.
    assert.equal(wd.isWatchdogRunning(), false, "de partida parado");
    wd.startWatchdog();
    assert.equal(wd.isWatchdogRunning(), true, "arranca sin socket de Baileys");
    wd.startWatchdog(); // idempotente
    assert.equal(wd.isWatchdogRunning(), true);
    wd.detachWatchdogSocket();
    assert.equal(wd.isWatchdogRunning(), true, "soltar el socket NO para el watchdog");
    wd.stopWatchdog();
    assert.equal(wd.isWatchdogRunning(), false, "stop sí lo para");
  });

  await test("RETELL · firma: el algoritmo coincide EXACTAMENTE con el del SDK oficial (vector fijo)", async () => {
    // Vector generado con `retell-sdk@5.64.0` (symmetric.sign, WebCrypto).
    // Si algún día nuestra implementación se desvía del proveedor, esto se
    // pone rojo aquí y no en producción con las firmas reales.
    const wh = await import("../src/lib/calls/retell-webhook");
    const BODY = '{"event":"call_analyzed","call":{"call_id":"call_fixture_001"}}';
    const KEY = "key_de_prueba_no_real";
    const TS = 1788000000000;
    const DIGEST_SDK = "011048b0476d729612b23ac86f40d78fea08d1e53b57b311b906d025a0dfe0da";
    assert.equal(wh.signRetellWebhookForTests(BODY, KEY, TS), `v=${TS},d=${DIGEST_SDK}`, "mismo digest que el SDK oficial");
    assert.equal(wh.verifyRetellWebhookSignature(BODY, `v=${TS},d=${DIGEST_SDK}`, KEY, TS).valid, true);
    // El SDK convierte el timestamp a NÚMERO antes de concatenar, así que
    // "0<ts>" produce el mismo digest y lo da por bueno. Se replica tal cual:
    // en un verificador de firmas, parecerse al proveedor importa más que
    // ser más listo que él (comprobado contra symmetric.verify del SDK).
    assert.equal(wh.verifyRetellWebhookSignature(BODY, `v=0${TS},d=${DIGEST_SDK}`, KEY, TS).valid, true);
  });

  await test("RETELL · firma: se verifica el cuerpo EXACTO (re-serializar o cambiar 1 byte invalida)", async () => {
    const wh = await import("../src/lib/calls/retell-webhook");
    const KEY = "retell-key-test";
    // Con espacios y saltos: al reserializar cambian los bytes (que es lo que
    // manda Retell de verdad: JSON con su propio formato).
    const original = '{\n  "event": "call_analyzed",\n  "call": { "call_id": "call_x", "agent_version": 19 }\n}';
    const ahora = Date.now();
    const firma = wh.signRetellWebhookForTests(original, KEY, ahora);
    assert.equal(wh.verifyRetellWebhookSignature(original, firma, KEY, ahora).valid, true, "bytes exactos → PASS");
    // Mismo JSON, distinta serialización (claves reordenadas / espacios).
    const reserializado = JSON.stringify(JSON.parse(original));
    assert.notEqual(reserializado, original, "el fixture debe cambiar de bytes al reserializar");
    assert.equal(wh.verifyRetellWebhookSignature(reserializado, firma, KEY, ahora).valid, false, "re-serializado → FAIL");
    const unByte = original.replace("call_x", "call_y");
    assert.equal(wh.verifyRetellWebhookSignature(unByte, firma, KEY, ahora).valid, false, "1 byte distinto → FAIL");
  });

  await test("RETELL · firma: cada rechazo dice POR QUÉ, y el digest_mismatch apunta a la key con 'webhook badge'", async () => {
    const wh = await import("../src/lib/calls/retell-webhook");
    const BODY = '{"event":"call_ended","call":{"call_id":"c1"}}';
    const KEY = "clave-correcta";
    const ahora = Date.now();
    const buena = wh.signRetellWebhookForTests(BODY, KEY, ahora);
    const casos: Array<[string, string | null, string, string]> = [
      ["sin clave configurada", buena, "", "no_key"],
      ["sin cabecera", null, KEY, "no_signature"],
      ["cabecera malformada", "no-es-una-firma", KEY, "malformed_header"],
      ["digest corto", `v=${ahora},d=abc`, KEY, "bad_digest_format"],
    ];
    for (const [nombre, header, key, motivo] of casos) {
      const r = wh.verifyRetellWebhookSignature(BODY, header, key, ahora);
      assert.equal(r.valid, false, nombre);
      assert.equal(r.reason, motivo, nombre);
    }
    // Caducada.
    const vieja = wh.signRetellWebhookForTests(BODY, KEY, ahora - 10 * 60_000);
    assert.equal(wh.verifyRetellWebhookSignature(BODY, vieja, KEY, ahora).reason, "timestamp_out_of_window");
    // EL CASO REAL DEL 03-09: forma perfecta, clave distinta → digest_mismatch.
    // Es la huella de "esta no es la API key con distintivo webhook".
    const otraKey = wh.signRetellWebhookForTests(BODY, "clave-de-otra-api-key", ahora);
    assert.equal(wh.verifyRetellWebhookSignature(BODY, otraKey, KEY, ahora).reason, "digest_mismatch");
  });

  await test("RETELL · firma: el diagnóstico describe la forma y NUNCA filtra el digest ni la clave", async () => {
    const wh = await import("../src/lib/calls/retell-webhook");
    const KEY = "clave-secretisima";
    const BODY = "{}";
    const ts = Date.now();
    const firma = wh.signRetellWebhookForTests(BODY, KEY, ts);
    const digest = firma.split("d=")[1];
    const d = wh.describeRetellSignature(firma);
    assert.equal(d.present, true);
    assert.equal(d.startsWithV, true);
    assert.equal(d.timestampPresent, true);
    assert.equal(d.digestPresent, true);
    assert.equal(d.digestLength, 64);
    assert.equal(d.digestCharset, "hex");
    assert.equal(d.commaCount, 1);
    assert.equal(d.trimWouldChange, false);
    const serializado = JSON.stringify(d);
    assert.ok(!serializado.includes(digest), "el digest NO puede aparecer en el diagnóstico");
    assert.ok(!serializado.includes(KEY), "la clave NO puede aparecer en el diagnóstico");
    // Cabecera con espacios: se detecta en vez de aceptarse en silencio.
    assert.equal(wh.describeRetellSignature(` ${firma} `).trimWouldChange, true);
    assert.equal(wh.verifyRetellWebhookSignature(BODY, ` ${firma} `, KEY, ts).valid, false, "no somos más permisivos que el proveedor");
    assert.equal(wh.describeRetellSignature(null).present, false);
  });

  await test("RETELL · webhook: sin firma 401, firma inválida 401, y la primera firma REAL deja evidencia", async () => {
    const { POST } = await import("../src/app/api/webhooks/retell/call-events/route");
    const { RETELL_WEBHOOK_VERIFIED_KEY } = await import("../src/lib/calls/retell-webhook");
    const wh = await import("../src/lib/calls/retell-webhook");
    db.systemDbHandle().prepare("DELETE FROM settings WHERE key = ?").run(RETELL_WEBHOOK_VERIFIED_KEY);
    const body = JSON.stringify({ event: "call_started", call: { call_id: "call_evidencia_1", start_timestamp: Date.now() } });
    const post = (b: string, sig: string | null) =>
      POST(new Request("http://localhost/api/webhooks/retell/call-events", { method: "POST", body: b, headers: sig ? { "x-retell-signature": sig } : {} }) as unknown as import("next/server").NextRequest);
    await withEnv(RETELL_ENV, async () => {
      assert.equal((await post(body, null)).status, 401, "sin firma → 401");
      assert.equal((await post(body, "v=1,d=" + "0".repeat(64))).status, 401, "firma inválida → 401");
      assert.equal(db.getSetting(RETELL_WEBHOOK_VERIFIED_KEY), null, "un rechazo NO deja evidencia de verificación");
      const buena = wh.signRetellWebhookForTests(body, "retell-key-test");
      assert.equal((await post(body, buena)).status, 200, "firma real válida → 200");
      const marca = db.getSetting(RETELL_WEBHOOK_VERIFIED_KEY);
      assert.ok(marca && Number(marca) > 0, "queda constancia de la primera firma verificada");
      // Y no se sobreescribe en cada webhook posterior.
      await post(body, wh.signRetellWebhookForTests(body, "retell-key-test"));
      assert.equal(db.getSetting(RETELL_WEBHOOK_VERIFIED_KEY), marca, "la marca es la de la PRIMERA vez");
    });
  });

  await test("RETELL · firma: 100 verificaciones seguidas, 0 flakes (válidas e inválidas alternas)", async () => {
    const wh = await import("../src/lib/calls/retell-webhook");
    const KEY = "clave-estres";
    let ok = 0;
    let ko = 0;
    for (let i = 0; i < 100; i++) {
      const body = JSON.stringify({ event: "call_analyzed", call: { call_id: `c${i}` }, n: i });
      const ts = Date.now() - (i % 7) * 1000;
      if (wh.verifyRetellWebhookSignature(body, wh.signRetellWebhookForTests(body, KEY, ts), KEY, ts).valid) ok++;
      if (!wh.verifyRetellWebhookSignature(body, wh.signRetellWebhookForTests(body, "otra-clave", ts), KEY, ts).valid) ko++;
    }
    assert.equal(ok, 100, "las 100 firmas legítimas verifican");
    assert.equal(ko, 100, "las 100 firmas de otra clave se rechazan");
  });

  await test("RETELL · webhook end-to-end con fixtures: firma sobre RAW body, 10 reintentos del mismo webhook = 1 efecto, orden alterado sin regresión", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const { POST } = await import("../src/app/api/webhooks/retell/call-events/route");
    const { order, attempt } = await dialOne("rt-wh-1", "7301", "34600117301");
    const bodyOk = fixture("call_analyzed-confirmed.json").replace("call_fx_001", attempt.provider_call_id!);
    const post = async (body: string, sig: string | null) => {
      const req = new Request("http://localhost/api/webhooks/retell/call-events", { method: "POST", body, headers: sig ? { "x-retell-signature": sig } : {} });
      return POST(req as unknown as import("next/server").NextRequest);
    };
    await withEnv(RETELL_ENV, async () => {
      assert.equal((await post(bodyOk, null)).status, 401, "sin firma → 401");
      assert.equal((await post(bodyOk, firmar(bodyOk, "otra-key"))).status, 401, "firma con otra key → 401");
      assert.equal((await post(bodyOk, firmar(bodyOk, "retell-key-test", Date.now() - 6 * 60_000))).status, 401, "timestamp caducado → 401");
      // Re-serializar cambia bytes → la firma del RAW original ya no vale.
      const reserializado = JSON.stringify(JSON.parse(bodyOk), null, 2);
      assert.equal((await post(reserializado, firmar(bodyOk))).status, 401, "firma calculada sobre otro body → 401");
      // Malformado con firma válida: 200 e ignorado (Retell no debe reintentar).
      const mal = fixture("malformed.json");
      const rMal = await post(mal, firmar(mal)); assert.equal(rMal.status, 200); assert.equal((await rMal.json()).ignored, "forma desconocida");
      // 10 entregas del MISMO webhook → 1 fila, 1 efecto.
      let nuevos = 0;
      for (let i = 0; i < 10; i++) { const r = await post(bodyOk, firmar(bodyOk)); assert.equal(r.status, 200); if (!(await r.json()).duplicate) nuevos++; }
      assert.equal(nuevos, 1, "solo la primera entrega es nueva");
      calls.processCallEvents(enFranja, noHoliday);
      calls.processCallEvents(enFranja, noHoliday);
      const o = db.getOrderById(order.id)!;
      assert.ok(o.confirmed_at !== null, "pedido confirmado UNA vez");
      assert.equal(db.getCallAttempt(attempt.id)!.state, "completed");
      // call_ended que llega DESPUÉS del analyzed: no revierte nada.
      const ended = fixture("call_ended.json").replace("call_fx_001", attempt.provider_call_id!);
      assert.equal((await post(ended, firmar(ended))).status, 200);
      calls.processCallEvents(enFranja, noHoliday);
      assert.equal(db.getCallAttempt(attempt.id)!.state, "completed", "sigue completado");
      assert.equal(db.getCallAttempt(attempt.id)!.result, "confirmado");
      // call_started de una llamada desconocida: seguro.
      const started = fixture("call_started.json").replace("call_fx_001", "call_desconocida_zz");
      assert.equal((await post(started, firmar(started))).status, 200);
      calls.processCallEvents(enFranja, noHoliday);
    });
    resetCallCfg();
  });

  await test("RETELL · fixtures: corrección, DNC y rellamada aplican su semántica; no-conectada no confirma", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const aplica = async (fx: string, id: string, num: string, tel: string) => {
      const d = await dialOne(id, num, tel);
      const ev = retellMod.retellProvider.parseEvent(fixture(fx).replace(/call_fx_00\d/, d.attempt.provider_call_id!))!;
      calls.applyCallAnalysis(d.attempt, ev, enFranja, noHoliday);
      return { ...d, after: db.getOrderById(d.order.id)!, att: db.getCallAttempt(d.attempt.id)! };
    };
    const c = await aplica("call_analyzed-correction.json", "rt-fx-c", "7401", "34600117911");
    assert.equal(c.att.result, "confirmado_con_correccion"); assert.equal(c.after.address_line1, "Calle Ensayo Nueva 12"); assert.equal(c.after.postal_code, "04002"); assert.equal(c.after.phone, "34600117911", "telefono_alternativo vacío NO pisa el teléfono");
    const dn = await aplica("call_analyzed-dnc.json", "rt-fx-d", "7402", "34600117912");
    assert.equal(dn.att.result, "no_volver_a_llamar"); assert.equal(db.isDncPhone("34600117912"), true);
    const rc = await aplica("call_analyzed-recall.json", "rt-fx-r", "7403", "34600117913");
    assert.equal(rc.att.result, "rellamar"); assert.ok(db.getActiveCallAttemptForOrder(rc.order.id), "rellamada planificada"); assert.equal(db.countConsumedContacts(rc.order.id), 0);
    const nc = await aplica("not-connected.json", "rt-fx-n", "7404", "34600117914");
    assert.equal(nc.att.result, "no_contesta"); assert.equal(nc.after.confirmed_at, null);
    // Deriva detectada también por el propio webhook (call.agent_version ≠ persistida).
    cfgMod.clearCallsBlocked();
    const dr = await dialOne("rt-fx-v", "7405", "34600117915");
    db.systemDbHandle().prepare("UPDATE call_attempts SET agent_version='7' WHERE id=?").run(dr.attempt.id);
    const evD = retellMod.retellProvider.parseEvent(fixture("drift-version.json").replace("call_fx_006", dr.attempt.provider_call_id!))!;
    assert.equal(evD.agentVersion, "9");
    calls.applyCallAnalysis(db.getCallAttempt(dr.attempt.id)!, evD, enFranja, noHoliday);
    assert.match(cfgMod.callsBlockedReason() ?? "", /agent_version_drift/);
    cfgMod.clearCallsBlocked(); resetCallCfg();
  });

  await test("CALLS · gates del botón manual: la matriz completa de la política (P3)", async () => {
    // Incidente 03-09: "Llamar ahora" se saltaba el kill switch propio, el
    // modo sombra y la allowlist del piloto. Aquí se fija cada puerta.
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const gates = await import("../src/lib/calls/gates");
    const tel = "34600119001";
    const o = mkCallable("gate-1", "9001", tel, 30);
    const base = () => {
      db.setSetting("ai_calls_enabled", "1");
      db.setSetting("calls_shadow_mode", "0");
      db.setSetting("calls_daily_cap", "500");
      db.setSetting("calls_allowlist", tel);
      db.setSetting("calls_pilot_mode", "1");
    };
    const veredicto = () => gates.checkManualCallGates(db.getOrderById(o.id)!, enFranja, noHoliday);
    try {
      base();
      assert.equal(veredicto().allowed, true, "piloto + allowlisted + en franja → ALLOW");

      // EMERGENCY_STOP manda por encima de todo.
      await withEnv({ EMERGENCY_STOP: "1" }, () => {
        assert.equal(veredicto().code, "emergency_stop");
      });

      // Kill switch propio apagado.
      base(); db.setSetting("ai_calls_enabled", "0");
      assert.equal(veredicto().code, "kill_switch_off", "con las llamadas apagadas NO se llama ni a mano");

      // Modo sombra: se simula, no se marca.
      base(); db.setSetting("calls_shadow_mode", "1");
      assert.equal(veredicto().code, "shadow_mode");

      // Piloto con la lista vacía = NADIE.
      base(); db.setSetting("calls_allowlist", "");
      assert.equal(veredicto().code, "pilot_allowlist_empty");

      // Piloto con lista rellena pero este teléfono fuera.
      base(); db.setSetting("calls_allowlist", "34600119999");
      assert.equal(veredicto().code, "pilot_not_allowlisted");

      // Fuera del piloto NO se introduce restricción extra: lista vacía pasa.
      base(); db.setSetting("calls_pilot_mode", "0"); db.setSetting("calls_allowlist", "");
      assert.equal(veredicto().allowed, true, "producción de llamadas: sin lista no se restringe");

      // DNC.
      base(); db.addDncPhone(tel, "test", { reason: "prueba de gate" });
      assert.equal(veredicto().code, "dnc");
      db.systemDbHandle().prepare("DELETE FROM call_dnc").run();

      // Fuera de horario.
      base();
      const domingo = new Date("2026-09-06T11:00:00.000Z");
      assert.equal(gates.checkManualCallGates(db.getOrderById(o.id)!, domingo, noHoliday).code, "outside_window");

      // Tope diario.
      base(); db.setSetting("calls_daily_cap", "1");
      const yaLlamados = db.countCallsStartedSince(0);
      if (yaLlamados >= 1) assert.equal(veredicto().code, "daily_cap");

      // Bloqueo global del proveedor.
      base(); cfgMod.setCallsBlocked("auth: 401 de prueba");
      assert.equal(veredicto().code, "calls_blocked");
      cfgMod.clearCallsBlocked();
    } finally {
      cfgMod.clearCallsBlocked();
      db.systemDbHandle().prepare("DELETE FROM call_dnc").run();
      db.setSetting("calls_pilot_mode", "");
      resetCallCfg();
    }
  });

  await test("CALLS · el botón manual OBEDECE los gates de verdad (no solo el veredicto)", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const tel = "34600119010";
    const o = mkCallable("gate-2", "9010", tel, 30);
    const intentar = async () => {
      const { provider, created } = mkProvider();
      const r = await manualMod.manualDialOrder(o.id, enFranja, provider);
      return { r, created };
    };
    try {
      // Apagadas: ni una llamada, y el motivo se ve en el panel.
      db.setSetting("ai_calls_enabled", "0"); db.setSetting("calls_shadow_mode", "0"); db.setSetting("calls_allowlist", tel); db.setSetting("calls_daily_cap", "500");
      let x = await intentar();
      assert.equal(x.r.ok, false); assert.equal(x.created.length, 0, "kill switch off → CERO llamadas");
      assert.match(x.r.error ?? "", /apagadas/);

      // Sombra: tampoco.
      db.setSetting("ai_calls_enabled", "1"); db.setSetting("calls_shadow_mode", "1");
      x = await intentar();
      assert.equal(x.created.length, 0, "modo sombra → CERO llamadas reales");
      assert.match(x.r.error ?? "", /sombra/);

      // Piloto sin la lista: tampoco.
      db.setSetting("calls_shadow_mode", "0"); db.setSetting("calls_pilot_mode", "1"); db.setSetting("calls_allowlist", "");
      x = await intentar();
      assert.equal(x.created.length, 0, "piloto sin allowlist → CERO llamadas");

      // Con todo en su sitio, SÍ sale y no queda ningún intento colgado.
      db.setSetting("calls_allowlist", tel);
      x = await intentar();
      assert.equal(x.r.ok, true, x.r.error ?? "");
      assert.equal(x.created.length, 1, "con la política cumplida, la llamada sale");
    } finally {
      db.setSetting("calls_pilot_mode", "");
      cfgMod.clearCallsBlocked();
      resetCallCfg();
    }
  });

  await test("RETELL live REAL (03-09): contrato PLANO sin datos_corregidos, CP con cero, teléfono vacío ignorado y DNC", async () => {
    // Forma EXACTA observada en producción el 03-09 con la V19 publicada.
    // No hay contenedor `datos_corregidos`: el contrato real es plano.
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const tel = "34600117777";
    const { order, attempt } = await dialOne("rt-real-1", "9002", tel);
    const analisisReal = {
      resultado_llamada: "confirmado_con_correccion",
      codigo_postal_corregido: "04007",
      telefono_alternativo: "",
      pidio_no_llamar: true,
    };
    // El normalizador lee el contrato real sin ayuda de alias raros.
    const norm = analysisMod.normalizeRetellAnalysis(analisisReal);
    assert.equal(norm.resultado, "confirmado_con_correccion");
    assert.equal(norm.codigoPostalCorregido, "04007", "el cero inicial del CP se conserva");
    assert.equal(norm.telefonoAlternativo, null, "un teléfono alternativo VACÍO no es una corrección");
    assert.equal(norm.pidioNoLlamar, true);

    calls.applyCallAnalysis(attempt, analyzedEvent(attempt.provider_call_id!, analisisReal), enFranja, noHoliday);
    const o = db.getOrderById(order.id)!;
    assert.equal(db.getCallAttempt(attempt.id)!.result, "confirmado_con_correccion");
    assert.equal(o.postal_code, "04007", "CP corregido tal cual");
    assert.equal(o.phone, tel, "el teléfono bueno NO se pisa con la cadena vacía");
    assert.ok(o.confirmed_at, "el pedido queda confirmado");
    assert.equal(db.isDncPhone(tel), true, "pidio_no_llamar aunque confirme → DNC");
    resetCallCfg();
  });

  await test("RETELL live REAL: el mismo call_analyzed 100 veces = UN solo efecto de negocio", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const { POST } = await import("../src/app/api/webhooks/retell/call-events/route");
    const wh = await import("../src/lib/calls/retell-webhook");
    const tel = "34600117778";
    const { order, attempt } = await dialOne("rt-real-2", "9003", tel);
    const callId = attempt.provider_call_id!;
    const cuerpo = JSON.stringify({
      event: "call_analyzed",
      call: {
        call_id: callId,
        end_timestamp: enFranja.getTime(),
        call_status: "ended",
        call_analysis: { custom_analysis_data: { resultado_llamada: "confirmado", pidio_no_llamar: false } },
      },
    });
    await withEnv(RETELL_ENV, async () => {
      let aceptados = 0;
      let duplicados = 0;
      for (let i = 0; i < 100; i++) {
        const res = await POST(new Request("http://localhost/x", {
          method: "POST",
          body: cuerpo,
          headers: { "x-retell-signature": wh.signRetellWebhookForTests(cuerpo, "retell-key-test") },
        }) as unknown as import("next/server").NextRequest);
        assert.equal(res.status, 200, "los 100 reintentos se ACEPTAN (ACK)");
        const j = (await res.json()) as { duplicate?: boolean };
        if (j.duplicate) duplicados++; else aceptados++;
      }
      assert.equal(aceptados, 1, "solo el primero entra en el inbox");
      assert.equal(duplicados, 99, "los otros 99 se reconocen como duplicados");
      calls.processCallEvents(enFranja, noHoliday);
      calls.processCallEvents(enFranja, noHoliday);
      const o = db.getOrderById(order.id)!;
      assert.equal(o.status, "confirmed");
      const intentos = db.systemDbHandle().prepare("SELECT COUNT(*) c FROM call_attempts WHERE order_id = ?").get(order.id) as { c: number };
      assert.equal(intentos.c, 1, "ni un intento de más");
    });
    resetCallCfg();
  });

  await test("CALLS · gates manuales: 100 evaluaciones seguidas dan SIEMPRE el mismo veredicto (0 flakes)", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const gates = await import("../src/lib/calls/gates");
    const tel = "34600119100";
    const o = mkCallable("gate-stress", "9100", tel, 30);
    try {
      // Configuración que DEBE permitir.
      db.setSetting("ai_calls_enabled", "1"); db.setSetting("calls_shadow_mode", "0");
      db.setSetting("calls_daily_cap", "500"); db.setSetting("calls_allowlist", tel); db.setSetting("calls_pilot_mode", "1");
      const permitidos = new Set<string>();
      for (let i = 0; i < 100; i++) permitidos.add(JSON.stringify(gates.checkManualCallGates(db.getOrderById(o.id)!, enFranja, noHoliday)));
      assert.equal(permitidos.size, 1, "el veredicto de ALLOW es estable");
      assert.equal(JSON.parse([...permitidos][0]).allowed, true);
      // Configuración que DEBE bloquear.
      db.setSetting("calls_allowlist", "");
      const bloqueados = new Set<string>();
      for (let i = 0; i < 100; i++) bloqueados.add(JSON.stringify(gates.checkManualCallGates(db.getOrderById(o.id)!, enFranja, noHoliday)));
      assert.equal(bloqueados.size, 1, "el veredicto de BLOCK es estable");
      assert.equal(JSON.parse([...bloqueados][0]).code, "pilot_allowlist_empty");
    } finally {
      db.setSetting("calls_pilot_mode", "");
      resetCallCfg();
    }
  });

  await test("OPS · retell:doctor audita la VERSIÓN FIJADA y separa API auth de firma real de webhook", () => {
    const leer = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const doc = leer("scripts/retell-doctor.ts");
    // Auditar el borrador y cantar PASS sería mentir: las llamadas usan la
    // versión fijada, no el draft.
    assert.match(doc, /get-agent\/\$\{agentId\}\?version=/, "pide EXPLÍCITAMENTE la versión fijada");
    assert.match(doc, /sin RETELL_AGENT_VERSION numérica no hay versión que auditar/, "sin pin no declara PASS");
    assert.match(doc, /NO está publicada/, "una versión sin publicar es un fallo");
    // Post-call analysis contra los 12 enums del backend.
    assert.match(doc, /post_call_analysis_data/, "audita el análisis post-llamada de esa versión");
    assert.match(doc, /CALL_RESULTS_ESPERADOS/, "compara el selector con los enums del backend");
    const esperados = /const CALL_RESULTS_ESPERADOS = \[([\s\S]*?)\];/.exec(doc)![1];
    for (const r of CALL_RESULTS) assert.ok(esperados.includes(`"${r}"`), `el doctor espera el resultado ${r}`);
    // Campos PLANOS del contrato real; datos_corregidos NO se exige.
    for (const campo of ["direccion_corregida", "localidad_corregida", "codigo_postal_corregido", "telefono_alternativo", "pidio_no_llamar", "momento_rellamada"]) {
      assert.ok(doc.includes(`"${campo}"`), `el doctor comprueba el campo plano ${campo}`);
    }
    assert.ok(!/verdict\.liveIssues\.push\([^)]*datos_corregidos/.test(doc), "NO se exige el contenedor datos_corregidos");
    // Los dos veredictos son cosas distintas.
    assert.match(doc, /RETELL_API_AUTH/, "la key sirve para la API…");
    assert.match(doc, /RETELL_REAL_WEBHOOK_SIGNATURE/, "…es distinto de que sirva para firmar webhooks");
    assert.match(doc, /UNVERIFIED_EXTERNAL/, "sin firma real, no se declara verificado");
    // La documentación citada tiene que EXISTIR y estar versionada.
    for (const m of doc.matchAll(/docs\/[a-zA-Z0-9/_-]+\.md/g)) {
      assert.ok(fs.existsSync(path.join(process.cwd(), m[0])), `retell:doctor cita ${m[0]} y debe existir`);
    }
    const rd = leer("scripts/readiness.ts");
    for (const m of rd.matchAll(/docs\/[a-zA-Z0-9/_-]+\.md/g)) {
      assert.ok(fs.existsSync(path.join(process.cwd(), m[0])), `readiness cita ${m[0]} y debe existir`);
    }
  });

  await test("OPS · retell:reconcile-call SOLO LEE de Retell y nunca crea una segunda llamada", () => {
    const leer = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const sc = leer("scripts/retell-reconcile-call.ts");
    assert.match(sc, /\/v2\/get-call\//, "consulta el estado con GET get-call");
    assert.ok(!/create-phone-call|createOutboundCall|manualDialOrder|dialDueAttempts/.test(sc), "ni una función que cree llamadas");
    assert.ok(!/method:\s*["']POST["']/.test(sc), "ninguna escritura hacia Retell");
    assert.match(sc, /DRY RUN/, "dry run por defecto");
    assert.match(sc, /flag\("apply"\)/, "aplicar exige --apply explícito");
    // El dry run no puede escribir en la base bajo ningún concepto.
    const antesDeAplicar = sc.slice(0, sc.indexOf("if (!aplicar)"));
    assert.ok(!/applyCallAnalysis|setSetting|addDncPhone|transitionCallAttempt/.test(antesDeAplicar), "el dry run no aplica nada");
  });

  await test("OPS · readiness de RUNTIME separado del de release: sin tsc, sin suite, sin exigir secretos vacíos", () => {
    const leer = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const runtime = leer("scripts/readiness-runtime.ts");
    assert.ok(!/typecheck|npm test|spawnSync|casamable:simulate/.test(runtime), "el readiness de runtime NO ejecuta tooling de desarrollo");
    assert.ok(!/git status|porcelain/.test(runtime), "no exige un árbol de git limpio");
    for (const check of ["APP_MODE", "EMERGENCY_STOP", "Esquema", "Scheduler", "Plantilla de confirmación", "Bloqueo global de llamadas", "Versión del agente", "Firma real de webhooks Retell"]) {
      assert.ok(runtime.includes(check), `el readiness de runtime comprueba: ${check}`);
    }
    assert.match(runtime, /RUNTIME READY WITH WARNINGS/, "puede devolver AVISO sin ser un fallo");
    // Y el de release sigue siendo el de release.
    const release = leer("scripts/readiness.ts");
    assert.match(release, /typecheck/, "el de release sí compila");
    // El doctor legacy no puede mentir en producción.
    const doctor = leer("scripts/doctor.ts");
    assert.match(doctor, /esRuntimeDeProduccion/, "el doctor detecta el contexto");
    assert.match(doctor, /readiness:runtime/, "y redirige al comando correcto");
    const pkg = JSON.parse(leer("package.json")) as { scripts: Record<string, string> };
    for (const s of ["readiness", "readiness:runtime", "deploy:guard", "retell:reconcile-call"]) {
      assert.ok(pkg.scripts[s], `el comando ${s} existe de verdad en package.json`);
    }
  });

  await test("OPS · la identidad del proyecto de Compose viaja con el fichero (no depende del directorio)", () => {
    const leer = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const compose = leer("docker-compose.yml");
    assert.match(compose, /^name: repo-v3c$/m, "el proyecto se llama SIEMPRE repo-v3c");
    // Y la guarda compara montajes, no nombres.
    const guard = leer("scripts/deploy-guard.ts");
    assert.match(guard, /\.Mounts/, "la guarda mira los montajes REALES");
    assert.match(guard, /process\.exit\(1\)/, "y bloquea con código de error si hay dos");
    // Solo puede EJECUTAR verbos de lectura (los `docker stop` que imprime
    // son una sugerencia para el operador, no una acción suya).
    const verbos = [...guard.matchAll(/docker\(\[\s*"([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(verbos.length > 0, "la guarda invoca docker");
    for (const v of verbos) assert.ok(["ps", "inspect"].includes(v), `la guarda solo lee; encontrado 'docker ${v}'`);
    // La documentación operativa está VERSIONADA y sus comandos existen.
    for (const d of ["docs/deploy/NAS-PRODUCTION.md", "docs/deploy/ROLLBACK.md", "docs/retell/PRODUCTION-VALIDATION.md"]) {
      assert.ok(fs.existsSync(path.join(process.cwd(), d)), `${d} existe y está versionado`);
    }
    const nas = leer("docs/deploy/NAS-PRODUCTION.md");
    // Puede NOMBRAR artifacts/ para explicar que no se usa; lo que no puede
    // es apuntar a un fichero de ahí dentro (no viaja con el código).
    assert.ok(!/artifacts\/[A-Za-z0-9]/.test(nas), "la operativa no apunta a ficheros de artifacts/ (está en .gitignore)");
    const pkg = JSON.parse(leer("package.json")) as { scripts: Record<string, string> };
    for (const m of nas.matchAll(/npm run ([a-z:-]+)/g)) {
      assert.ok(pkg.scripts[m[1]], `NAS-PRODUCTION.md cita 'npm run ${m[1]}' y debe existir`);
    }
    const rollback = leer("docs/deploy/ROLLBACK.md");
    assert.ok(!/down -v/.test(rollback.replace(/\*\*Nunca\*\* `docker compose down -v`\./g, "")), "el rollback jamás propone down -v");
    for (const m of rollback.matchAll(/npm run ([a-z:-]+)/g)) {
      assert.ok(pkg.scripts[m[1]], `ROLLBACK.md cita 'npm run ${m[1]}' y debe existir`);
    }
  });

  await test("RETELL · KILL SWITCH (P0): con EMERGENCY_STOP=1 ni el orquestador ni el botón manual crean llamadas", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const tel = "34600117500";
    const o = llamableParaManual("rt-ks-1", "7500", tel);
    calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
    await withEnv({ EMERGENCY_STOP: "1" }, async () => {
      const { provider, created } = mkProvider();
      await calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday });
      assert.equal(created.length, 0, "orquestador: cero llamadas con EMERGENCY_STOP=1");
      const r = await manualMod.manualDialOrder(o.id, enFranja, provider);
      assert.equal(r.ok, false); assert.match(r.error ?? "", /EMERGENCY_STOP/);
      assert.equal(created.length, 0, "manual: cero llamadas con EMERGENCY_STOP=1");
    });
    resetCallCfg();
  });

  await test("RETELL · DNC y allowlist en forma canónica: +34 / 34 / 9 dígitos / espacios son el MISMO teléfono", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    db.addDncPhone("+34 600 11 76 00", "manual", { reason: "test" });
    for (const f of ["34600117600", "+34600117600", "600117600", "600 11 76 00", "+34 600-117-600"]) assert.equal(db.isDncPhone(f), true, `DNC debe reconocer "${f}"`);
    assert.equal(db.isDncPhone("34600117601"), false);
    db.setSetting("calls_allowlist", "+34 600 11 76 10, 600117611");
    assert.equal(cfgMod.callAllowedByAllowlist("34600117610"), true);
    assert.equal(cfgMod.callAllowedByAllowlist("34600117611"), true, "apuntado sin el 34 también cuenta");
    assert.equal(cfgMod.callAllowedByAllowlist("34600117612"), false);
    // Y el botón manual respeta el DNC aunque el pedido tenga el número en otro formato.
    const o = llamableParaManual("rt-dnc-m", "7600", "34600117600");
    const { provider, created } = mkProvider();
    const r = await manualMod.manualDialOrder(o.id, enFranja, provider);
    assert.equal(r.ok, false); assert.match(r.error ?? "", /NO LLAMAR/); assert.equal(created.length, 0);
    resetCallCfg();
  });

  await test("RETELL · precedencia: un análisis que llega cuando el pedido ya está CANCELADO por Shopify no lo confirma; ya CONFIRMADO por WhatsApp no lo retrocede", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const a = await dialOne("rt-pre-1", "7700", "34600117700");
    db.setOrderClosure(a.order.id, "cancelled", "shopify", Math.floor(enFranja.getTime() / 1000));
    db.systemDbHandle().prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(a.order.id);
    calls.applyCallAnalysis(a.attempt, analyzedEvent(a.attempt.provider_call_id!, { resultado_llamada: "confirmado" }), enFranja, noHoliday);
    const oa = db.getOrderById(a.order.id)!;
    assert.equal(oa.status, "cancelled", "un cierre terminal de Shopify no se pisa por una llamada");
    assert.equal(oa.closure_status, "cancelled");
    const b = await dialOne("rt-pre-2", "7701", "34600117701");
    db.markOrderConfirmed(b.order.id, true); // WhatsApp confirmó mientras la llamada estaba en curso
    calls.applyCallAnalysis(b.attempt, analyzedEvent(b.attempt.provider_call_id!, { resultado_llamada: "cancelado" }), enFranja, noHoliday);
    const ob = db.getOrderById(b.order.id)!;
    assert.ok(ob.confirmed_at !== null, "la confirmación por WhatsApp no se borra");
    assert.equal(db.getCallAttempt(b.attempt.id)!.state === "completed" || db.getCallAttempt(b.attempt.id)!.state === "manual_review", true);
    resetCallCfg();
  });

  await test("RETELL · fuzz: 1.000 payloads malformados al normalizador y al parser de eventos — cero excepciones, cero basura aplicada", () => {
    const { normalizeRetellAnalysis } = require("../src/lib/calls/analysis") as typeof import("../src/lib/calls/analysis");
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const basura = (): unknown => {
      const r = rnd();
      if (r < 0.1) return null; if (r < 0.2) return undefined; if (r < 0.3) return rnd() * 1e6; if (r < 0.4) return rnd() > 0.5;
      if (r < 0.5) return [1, "a", {}]; if (r < 0.6) return "x".repeat(Math.floor(rnd() * 5000)); if (r < 0.7) return "false";
      if (r < 0.8) return { anidado: { mas: { y: "z" } } }; if (r < 0.9) return "confirmado"; return "{{resultado}}";
    };
    const keys = ["resultado", "resultado_llamada", "result", "datos_corregidos", "direccion_corregida", "localidad_corregida", "codigo_postal_corregido", "telefono_alternativo", "momento_rellamada", "pidio_no_llamar", "zzz"];
    let dnc = 0, largos = 0;
    for (let i = 0; i < 1000; i++) {
      const obj: Record<string, unknown> = {};
      for (const k of keys) if (rnd() > 0.4) obj[k] = basura();
      if (rnd() > 0.7) obj.datos_corregidos = { direccion_corregida: basura(), pidio_no_llamar: basura() };
      const n = normalizeRetellAnalysis(obj);
      assert.equal(typeof n.pidioNoLlamar, "boolean");
      for (const v of [n.direccionCorregida, n.localidadCorregida, n.codigoPostalCorregido, n.telefonoAlternativo]) assert.ok(v === null || (typeof v === "string" && v.length > 0));
      if (n.pidioNoLlamar) dnc++;
      if (typeof n.direccionCorregida === "string" && n.direccionCorregida.length > 500) largos++;
      // parser de eventos con el mismo caos
      assert.doesNotThrow(() => retellMod.retellProvider.parseEvent(JSON.stringify({ event: rnd() > 0.5 ? "call_analyzed" : basura(), call: rnd() > 0.5 ? { call_id: rnd() > 0.5 ? "c" : basura(), call_analysis: basura() } : basura() })));
    }
    assert.ok(dnc < 1000, "DNC solo con booleanos inequívocos");
  });

  await test("RETELL · stress 100×: normalización, idempotencia del inbox, placeholder y prevención de doble llamada — 0 flakes", async () => {
    resetCallCfg(); cfgMod.clearCallsBlocked();
    const { normalizeRetellAnalysis } = require("../src/lib/calls/analysis") as typeof import("../src/lib/calls/analysis");
    for (let i = 0; i < 100; i++) {
      assert.equal(normalizeRetellAnalysis({ resultado_llamada: "confirmado", pidio_no_llamar: "false" }).pidioNoLlamar, false);
      assert.ok(payloadMod.unsafeVariableReason("nombre_cliente", `[password ${i}]`));
      const key = `stress:${i}:call_analyzed:1`;
      let nuevos = 0;
      for (let k = 0; k < 5; k++) if (db.insertCallEvent({ dedupeKey: key, providerCallId: `stress-${i}`, eventType: "call_analyzed", eventAt: 1, payloadJson: null })) nuevos++;
      assert.equal(nuevos, 1);
    }
    // Doble llamada: dos "workers" compiten por el mismo intento → exactamente una llamada.
    for (let i = 0; i < 20; i++) {
      const tel = `346001178${String(i).padStart(2, "0")}`;
      llamableParaManual(`rt-race-${i}`, `78${String(i).padStart(2, "0")}`, tel);
      calls.enqueueDueOrders({ now: enFranja, isHoliday: noHoliday });
      const { provider, created } = mkProvider();
      await Promise.all([calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday }), calls.dialDueAttempts({ now: enFranja, provider, isHoliday: noHoliday })]);
      assert.equal(created.filter((c) => c.toNumber === `+${tel}`).length, 1, `carrera ${i}: una sola llamada`);
    }
    db.systemDbHandle().prepare("DELETE FROM call_events WHERE dedupe_key LIKE 'stress:%'").run();
    resetCallCfg();
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

  await test("outbox: el claim es ATÓMICO — dos procesos sobre el mismo item, un solo envío", () => {
    // Reproduce el caso de dos bots vivos a la vez (dos contenedores, o un
    // reinicio solapado): ambos leen la misma fila pendiente y ambos intentan
    // reclamarla. Solo uno puede ganar; el otro NO debe enviar.
    const conv = db.getOrCreateConversation("34600199001", "Cliente Claim");
    const itemId = db.enqueueOutbox(conv.id, "34600199001", "mensaje que no se puede duplicar");
    assert.ok(
      db.getPendingOutbox(500).some((x) => x.id === itemId),
      "el item está en la cola como pendiente"
    );

    const ganador = db.markOutboxSent(itemId);
    const perdedor = db.markOutboxSent(itemId);
    assert.equal(ganador, true, "el primero gana el claim");
    assert.equal(perdedor, false, "el segundo NO: el item ya no estaba pendiente");

    // Y el revert del patrón claim→send→revert sigue funcionando: si el
    // ganador falla al enviar, el item vuelve a estar reclamable.
    db.revertOutboxSent(itemId);
    assert.equal(db.markOutboxSent(itemId), true, "tras revertir, se puede reclamar otra vez");
  });

  await test("BUG2 planWebhookEnsure: dos suscripciones del MISMO topic se detectan como duplicado, aunque una apunte bien", async () => {
    const { planWebhookEnsure } = await import("../src/lib/shopify/webhook-subscriptions");
    const deseadas = [
      { topic: "orders/create", address: "https://x.example/api/webhooks/shopify/orders-create" },
      { topic: "orders/updated", address: "https://x.example/api/webhooks/shopify/orders-events" },
    ];

    // El caso real del bug: orders/updated tiene DOS suscripciones — la
    // nueva (app-owned, URL correcta) y una vieja (admin-created) que quedó
    // viva tras la migración del 24-08. Con el .find() de antes, esto se
    // veía como "✓ Correctas" sin más: nunca se enteraba de la segunda.
    const plan = planWebhookEnsure(
      [
        { id: 1, topic: "orders/create", address: "https://x.example/api/webhooks/shopify/orders-create" },
        { id: 10, topic: "orders/updated", address: "https://x.example/api/webhooks/shopify/orders-events" },
        { id: 7, topic: "orders/updated", address: "https://x.example/api/webhooks/shopify/orders-events" },
      ],
      deseadas
    );

    assert.equal(plan.duplicates.length, 1, "orders/updated debe salir como duplicado");
    assert.equal(plan.duplicates[0].topic, "orders/updated");
    assert.deepEqual(
      plan.duplicates[0].subscriptions.map((s) => s.id).sort((a, b) => a - b),
      [7, 10],
      "las DOS suscripciones deben listarse, con su id, para decidir a mano cuál sobra"
    );
    assert.ok(
      plan.ok.some((x) => x.topic === "orders/updated"),
      "sigue contando como cubierto: al menos una de las dos apunta a la URL correcta"
    );
    assert.equal(plan.toCreate.some((x) => x.topic === "orders/updated"), false, "nunca crea una tercera copia");

    // Si NINGUNA de las duplicadas apunta a la URL correcta: duplicado Y mismatched a la vez.
    const planPeor = planWebhookEnsure(
      [
        { id: 10, topic: "orders/updated", address: "https://vieja.example/hook" },
        { id: 7, topic: "orders/updated", address: "https://tambien-vieja.example/hook" },
      ],
      deseadas
    );
    assert.equal(planPeor.duplicates.length, 1);
    assert.equal(planPeor.mismatched.some((m) => m.topic === "orders/updated"), true);
  });

  // ============ 45 · Arreglos de fidelidad (lo que el sistema contaba mal) ============
  console.log("\n— Fidelidad: fulfillment parcial y orden de llegada —");

  const ff = await import("../src/lib/orders/fulfillment");
  const inferir = (li: Array<Record<string, unknown>>, global?: string | null) =>
    ff.inferPhysicalFulfillment(
      { line_items: li, fulfillment_status: global ?? null } as never,
      true
    );

  await test("FF 1 · CASO CASAMABLE: producto despachado + Seguro de Envío sin despachar → fulfilled", () => {
    // El caso crítico. Shopify deja el PEDIDO en `partial` para siempre
    // porque nadie despacha nunca el seguro. La mercancía, en cambio, salió
    // entera. Decidir con el global sería decidir con un dato falso.
    const r = inferir(lineas({ fisicasDespachadas: 1, seguro: true }), "partial");
    assert.equal(r.state, "fulfilled", "toda la MERCANCÍA salió");
    assert.equal(r.basis, "line_level");
    assert.equal(r.physicalLines, 1);
    assert.equal(r.serviceLines, 1, "el seguro no cuenta como mercancía");
    assert.equal(ff.physicalStateAllowsInProgress(r.state), true);

    // Y de punta a punta: el cierre resultante es in_progress, nunca delivered.
    const señal = backfill.planClosureFromShopify(
      backfillOrder({
        id: 998101,
        fulfillment_status: "partial",
        line_items: lineas({ fisicasDespachadas: 1, seguro: true }),
        updated_at: "2026-08-24T12:00:00Z",
      })
    );
    assert.equal(señal?.status, "in_progress");
    assert.notEqual(señal?.status, "delivered", "Shopify NUNCA puede afirmar una entrega");
  });

  await test("FF 2 · producto físico sin despachar + seguro → not_started", () => {
    const r = inferir(lineas({ fisicasPendientes: 1, seguro: true }), null);
    assert.equal(r.state, "not_started");
    assert.equal(ff.physicalStateAllowsInProgress(r.state), false, "no ha salido nada: no es in_progress");
  });

  await test("FF 3 · dos físicos, uno despachado y otro no → partial", () => {
    const r = inferir(lineas({ fisicasDespachadas: 1, fisicasPendientes: 1 }), "partial");
    assert.equal(r.state, "partial");
    assert.equal(r.physicalLines, 2);
    assert.equal(r.fulfilledLines, 1);
    assert.equal(ff.physicalStateAllowsInProgress(r.state), true, "algo salió: sí cuenta como en curso");
  });

  await test("FF 4 · dos físicos, los dos despachados → fulfilled", () => {
    const r = inferir(lineas({ fisicasDespachadas: 2 }), "fulfilled");
    assert.equal(r.state, "fulfilled");
    assert.equal(r.fulfilledLines, 2);
  });

  await test("FF 5 · solo Seguro de Envío → no_physical_items (no hay nada que despachar)", () => {
    const r = inferir(lineas({ seguro: true }), null);
    assert.equal(r.state, "no_physical_items");
    assert.equal(r.physicalLines, 0);
    assert.equal(
      ff.physicalStateAllowsInProgress(r.state),
      false,
      "sin mercancía no se puede afirmar que el pedido esté en curso: va a revisión"
    );
  });

  await test("FF 6 · restocked NO implica entregado ni rehusado, y no cierra nada", () => {
    const r = inferir(lineas({ fisicasDespachadas: 1 }), "restocked");
    assert.equal(r.state, "restocked");
    assert.equal(ff.physicalStateAllowsInProgress(r.state), false);
    assert.equal(
      backfill.planClosureFromShopify(
        backfillOrder({ id: 998104, fulfillment_status: "restocked", line_items: lineas({ fisicasDespachadas: 1 }) })
      ),
      null,
      "volvió al almacén: el motivo lo dice otra fuente, no Shopify"
    );
  });

  await test("FF 7 · cancelled de Shopify gana sobre cualquier estado de mercancía", () => {
    const señal = backfill.planClosureFromShopify(
      backfillOrder({
        id: 998105,
        fulfillment_status: "partial",
        line_items: lineas({ fisicasDespachadas: 1, seguro: true }),
        cancelled_at: "2026-08-24T09:00:00Z",
      })
    );
    assert.equal(señal?.status, "cancelled");
    assert.equal(señal?.at, Math.floor(Date.parse("2026-08-24T09:00:00Z") / 1000));
  });

  await test("FF 8 · la ENTREGA no sale nunca del fulfillment: Shopify solo aporta in_progress/cancelled", () => {
    // Aunque toda la mercancía esté despachada y haya tracking, `delivered`
    // pertenece al eje de cierre y solo lo escribe una fuente fiable (Dropea).
    const o = mkOrder("998106", "8106", "34600198106");
    const señal = backfill.planClosureFromShopify(
      backfillOrder({ id: 998106, fulfillment_status: "fulfilled", line_items: lineas({ fisicasDespachadas: 2 }), updated_at: "2026-08-24T12:00:00Z" })
    );
    assert.equal(señal?.status, "in_progress");
    db.setOrderClosure(o.id, señal!.status, "shopify", señal!.at);
    assert.equal(db.getOrderById(o.id)!.closure_status, "in_progress");

    // Solo Dropea puede afirmar la entrega.
    assert.equal(db.setOrderClosure(o.id, "delivered", "dropea", señal!.at + 3600), true);
    assert.equal(db.getOrderById(o.id)!.closure_source, "dropea");
  });

  await test("FF 9 · línea sin ninguna metadata → falla CERRADO (no se cuenta como mercancía)", () => {
    const r = inferir([{ title: "Cosa rara", quantity: 1, price: "5.00" }], null);
    assert.equal(r.physicalLines, 0, "sin señales no se afirma que sea mercancía");
    assert.equal(r.state, "no_physical_items");
    // Contarla de más dejaría el pedido "a medias" eternamente; contarla de
    // menos lo deja en un estado visible que va a revisión.
    assert.equal(ff.isPhysicalFulfillmentLine({ title: "Cosa rara" }), false);
    // Una tarjeta regalo es virtual aunque traiga IDs de catálogo.
    assert.equal(
      ff.isPhysicalFulfillmentLine({ title: "Tarjeta", sku: "GC-1", product_id: 1, gift_card: true }),
      false
    );
    // Y `requires_shipping` manda sobre todo lo demás.
    assert.equal(
      ff.isPhysicalFulfillmentLine({ title: "Servicio", sku: "SRV-1", product_id: 1, requires_shipping: false }),
      false
    );
    assert.equal(ff.isPhysicalFulfillmentLine({ title: "Sin ids", requires_shipping: true }), true);
  });

  await test("FF 10 · una línea es física aunque NO tenga mapping de proveedor (routing ≠ fulfillment)", () => {
    // Un SKU sin fila en supplier_product_mapping sigue siendo mercancía: no
    // saber a qué proveedor mandarlo no lo convierte en un servicio.
    const linea = {
      title: "Producto sin mapping",
      quantity: 1,
      sku: "SKU-JAMAS-MAPEADO",
      product_id: 9999999999,
      variant_id: 8888888888,
      requires_shipping: true,
      fulfillment_status: "fulfilled",
      fulfillable_quantity: 0,
    };
    assert.equal(ff.isPhysicalFulfillmentLine(linea), true);
    assert.equal(db.listSupplierProductMappings("dropea").some((m) => m.shopify_sku === "SKU-JAMAS-MAPEADO"), false);
    assert.equal(inferir([linea], "fulfilled").state, "fulfilled");
  });

  await test("FF · fallback legacy: sin datos por línea se distingue de dato fiable", () => {
    // Pedido histórico: líneas sin campos de fulfillment. Con servicios
    // presentes, un `partial` global NO permite concluir nada.
    const legacy = [
      { title: "Producto viejo", quantity: 1, sku: "OLD-1", product_id: 77 },
      { title: "Seguro de Envío", quantity: 1 },
    ];
    const r = inferir(legacy, "partial");
    assert.equal(r.basis, "global_fallback");
    assert.equal(r.state, "unknown", "el global no distingue el seguro: no se afirma nada");
    assert.match(r.reason, /no distingue|servicio/i);

    // Sin servicios, el global sí sirve como fallback honesto.
    const soloProducto = [{ title: "Producto viejo", quantity: 1, sku: "OLD-1", product_id: 77 }];
    const r2 = inferir(soloProducto, "fulfilled");
    assert.equal(r2.basis, "global_fallback");
    assert.equal(r2.state, "fulfilled");

    // Y un payload CONGELADO (raw_payload de orders/create) no dice nada del
    // progreso: se marca insufficient_data en vez de "not_started".
    const congelado = ff.inferPhysicalFulfillment(
      { line_items: lineas({ fisicasPendientes: 1 }), fulfillment_status: null } as never,
      false
    );
    assert.equal(congelado.basis, "insufficient_data");
    assert.equal(congelado.state, "unknown");
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

  // ============ 46 · Modelo de 4 ejes: cierre como fuente de verdad ============
  console.log("\n— Modelo de estados: el eje de cierre manda —");

  const closure = await import("../src/lib/orders/closure");

  await test("EJES · la tasa cuenta delivered y refused, y NADA más", () => {
    assert.equal(closure.countsInDeliveryRate("delivered"), true);
    assert.equal(closure.countsInDeliveryRate("refused"), true);
    assert.equal(closure.countsInDeliveryRate("in_progress"), false, "en curso no es un desenlace");
    assert.equal(closure.countsInDeliveryRate("unknown"), false, "no saber no es fallar");
    assert.equal(
      closure.countsInDeliveryRate("cancelled"),
      false,
      "un cancelado NUNCA se intentó entregar: en el denominador hundiría la tasa por algo ajeno a la logística"
    );

    assert.equal(closure.computeClosureDeliveryRate(7, 3), 70);
    assert.equal(closure.computeClosureDeliveryRate(2, 1), 66.67);
    assert.equal(closure.computeClosureDeliveryRate(0, 0), null, "sin resueltos → null, no 0 %");
  });

  await test("EJES · Dropea: DELIVERED y PAID cierran entregado; REFUSED cierra rehusado", () => {
    const at = Math.floor(Date.parse("2026-08-25T10:00:00Z") / 1000);
    assert.equal(closure.planClosureFromDropea("FINISH", "DELIVERED", at).plan?.status, "delivered");
    // En COD, cobrado ES entregado: es la mejor evidencia que existe.
    assert.equal(closure.planClosureFromDropea("FINISH", "PAID", at).plan?.status, "delivered");
    assert.equal(closure.planClosureFromDropea("FINISH", "REFUSED", at).plan?.status, "refused");
    assert.equal(closure.planClosureFromDropea("FINISH", "CANCELLED", at).plan?.status, "cancelled");
    assert.equal(closure.planClosureFromDropea("FINISH", "REJECTED", at).plan?.status, "cancelled");
  });

  await test("EJES · `returned` NO implica `refused`: REFUSED_LOST_DAMAGED no cierra y va a revisión", () => {
    const at = Math.floor(Date.parse("2026-08-25T10:00:00Z") / 1000);
    // Los dos normalizan a tracking `returned`, pero NO son el mismo hecho de
    // negocio: uno es el cliente rechazando el COD, el otro un paquete
    // perdido o roto. Contar el segundo como rehúse infla la métrica que
    // decide si la publicidad es rentable.
    const rehuse = closure.planClosureFromDropea("FINISH", "REFUSED", at);
    const perdido = closure.planClosureFromDropea("FINISH", "REFUSED_LOST_DAMAGED", at);

    assert.equal(rehuse.plan?.status, "refused");
    assert.equal(rehuse.review, null);

    assert.equal(perdido.plan, null, "no se cierra nada: no fue decisión del cliente");
    assert.equal(perdido.review?.kind, "returned_not_refused");
    assert.match(perdido.review!.reason, /no por rehúse|NO por rehúse/i);
  });

  await test("EJES · una incidencia NUNCA cierra el pedido: el cierre se queda como estaba", () => {
    const at = Math.floor(Date.parse("2026-08-25T10:00:00Z") / 1000);
    for (const sub of [
      "DELIVERY_EXCEPTION",
      "LOST_DAMAGED",
      "REVIEW",
      "TECHNICAL_ERROR",
      "INSUFFICIENT_STOCK",
      "CARRIER_VALIDATION_FAILED",
      "WAREHOUSE_INTEGRATION_FAILED",
    ]) {
      const d = closure.planClosureFromDropea("ERROR", sub, at);
      assert.equal(d.plan, null, `${sub} no debe tocar el eje de cierre`);
    }
    // Y la preparación tampoco: aún no ha salido nada, in_progress sería mentira.
    for (const sub of ["CREATING", "PICKING", "PACKED", "AWAITING_PICKUP", "PENDING_SUPPLIER"]) {
      assert.equal(closure.planClosureFromDropea("PROCESSING", sub, at).plan, null, sub);
    }
    // En manos del transportista SÍ es "en curso".
    for (const sub of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERY_ATTEMPTED"]) {
      assert.equal(closure.planClosureFromDropea("SHIPPING", sub, at).plan?.status, "in_progress", sub);
    }
  });

  await test("EJES · sin fecha de la fuente no se escribe cierre (jamás now())", () => {
    assert.equal(closure.planClosureFromDropea("FINISH", "DELIVERED", null).plan, null);
    // Y un par desconocido tampoco inventa nada.
    assert.equal(closure.planClosureFromDropea("FINISH", "PALABRA_RARA", 1_700_000_000).plan, null);
    assert.equal(closure.planClosureFromDropea("FINISH", null, 1_700_000_000).plan, null, "FINISH sin sub-estado no afirma entrega");
  });

  await test("EJES · Dropi no infiere cierre hasta tener su mapa de estados real", () => {
    // Sin catálogo confirmado, inferir el desenlace económico sería inventarse
    // el dato más caro del negocio. Fail-closed a propósito.
    for (const st of ["delivered", "returned", "cancelled", "in_transit"] as const) {
      assert.equal(closure.planClosureFromTracking(st, "dropi", 1_700_000_000).plan, null, st);
    }
  });

  await test("EJES · refused y returned COEXISTEN: son ejes distintos, no sinónimos", () => {
    const o = mkSynced("991001", "8001", "34600191001");
    // Logística: el paquete volvió al origen.
    tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "TRK-EJ1", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "returned", source: "polling" });
    // Negocio: sabemos que fue rehúse del COD.
    assert.equal(db.setOrderClosure(o.id, "refused", "dropea", 1_700_000_000), true);

    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.supplier_status_normalized, "returned", "el eje logístico dice returned");
    assert.equal(fila.closure_status, "refused", "el eje de negocio dice refused");
    assert.equal(fila.closure_source, "dropea");
  });

  await test("EJES · el histórico distingue qué eje cambió (status_axis)", () => {
    const o = mkSynced("991002", "8002", "34600191002");
    tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "TRK-EJ2", source: "polling" });
    db.setOrderClosure(o.id, "delivered", "dropea", 1_700_000_100);

    const h = db.listOrderStatusHistory(o.id);
    const log = h.filter((x) => x.status_axis === "tracking");
    const cie = h.filter((x) => x.status_axis === "closure");
    assert.ok(log.length >= 1, "hay transición logística");
    assert.equal(cie.length, 1, "y exactamente una de cierre");
    assert.equal(cie[0].new_status, "delivered");
    assert.equal(cie[0].occurred_at, 1_700_000_100, "fecha del evento en la fuente, no now()");
  });

  await test("EJES · métricas: el denominador ignora el eje logístico por completo", () => {
    // Ventana propia, lejos del resto de tests, para contar sin ruido.
    const base = Math.floor(Date.parse("2026-07-01T12:00:00Z") / 1000);
    const mk = (id: string, num: string, tel: string, cierre: "delivered" | "refused" | "in_progress" | "cancelled") => {
      const o = mkSynced(id, num, tel);
      db.setOrderClosure(o.id, cierre, "dropea", base + 10);
      return o;
    };
    mk("991010", "8010", "34600191010", "delivered");
    mk("991011", "8011", "34600191011", "delivered");
    mk("991012", "8012", "34600191012", "delivered");
    mk("991013", "8013", "34600191013", "refused");
    mk("991014", "8014", "34600191014", "in_progress");
    mk("991015", "8015", "34600191015", "cancelled");

    const b = deliveryMetrics.getClosureBreakdown(base, base + 100);
    assert.equal(b.delivered, 3);
    assert.equal(b.refused, 1);
    assert.equal(b.inProgress, 1);
    assert.equal(b.cancelled, 1);
    assert.equal(b.resolved, 4, "solo delivered + refused");
    assert.equal(b.deliveryRate, 75, "3/(3+1) = 75 % — ni el en curso ni el cancelado tocan el denominador");
  });

  await test("EJES · reconcile de Dropea escribe el eje de cierre con la política central", async () => {
    // mkOrder (no mkSynced): mkSynced ya deja un id externo propio, y entonces
    // el reconciliador lo trataría como conflicto de enlace en vez de como el
    // pedido a cerrar — que es justo lo que se quiere comprobar aquí.
    const o = mkOrder("991020", "8020", "34600191020");
    assert.equal(
      db.setOrderSupplierPlatformAndExternalId(o.id, "dropea", "7770001"),
      true,
      "el pedido queda enlazado a 7770001"
    );

    // La población a reconciliar sale de los webhooks de pedido recibidos.
    db.claimWebhookEvent("ejes-rec-1", "dropea", "order.status.changed", "7770001");

    const r = await dropeaReconcile.runDropeaReconcile({
      dryRun: false,
      resetCheckpoint: true,
      // Solo este recurso devuelve algo enlazable; el resto de la población
      // (webhooks de otros tests) sale sin correlación y no toca nada.
      fetcher: async (id) =>
        ({
          id: Number(id),
          status: id === "7770001" ? "FINISH" : "SHIPPING",
          sub_status: id === "7770001" ? "DELIVERED" : "SHIPPED",
          external_order_id: id === "7770001" ? "991020" : null,
          updated_at: "2026-08-25T09:00:00Z",
          created_at: "2026-08-20T09:00:00Z",
        }) as import("../src/lib/suppliers/dropea/types").DropeaOrder,
    });
    const mio = r.items.find((i) => i.resourceId === "7770001")!;
    assert.equal(mio.closureStatus, "delivered");
    assert.equal(mio.closureApplied, true);
    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.closure_status, "delivered");
    assert.equal(fila.closure_source, "dropea");
    assert.equal(fila.closure_at, Math.floor(Date.parse("2026-08-25T09:00:00Z") / 1000));
  });

  // ============ 47 · Leases de scheduler (dos procesos compitiendo) ============
  console.log("\n— Leases: un solo proceso ejecuta efectos externos —");

  const leases = await import("../src/lib/system/leases");

  await test("LEASE · dos dueños compiten por el mismo scheduler: solo uno gana", () => {
    const now = 1_700_000_000;
    assert.equal(leases.acquireLease("test-a", 60, { owner: "proc-1", nowSec: now }), true);
    assert.equal(
      leases.acquireLease("test-a", 60, { owner: "proc-2", nowSec: now }),
      false,
      "el segundo proceso NO puede ejecutar mientras el lease sea del primero"
    );
    assert.equal(leases.holdsLease("test-a", { owner: "proc-1", nowSec: now }), true);
    assert.equal(leases.holdsLease("test-a", { owner: "proc-2", nowSec: now }), false);
  });

  await test("LEASE · el dueño renueva sin perderlo, y renovar no cuenta como adquisición nueva", () => {
    const now = 1_700_001_000;
    leases.acquireLease("test-b", 60, { owner: "proc-1", nowSec: now });
    const tras1 = leases.getLease("test-b")!;
    assert.equal(leases.acquireLease("test-b", 60, { owner: "proc-1", nowSec: now + 10 }), true);
    const tras2 = leases.getLease("test-b")!;
    assert.equal(tras2.acquire_count, tras1.acquire_count, "renovar no es adquirir de nuevo");
    assert.ok(tras2.lease_until > tras1.lease_until, "pero sí extiende el derecho");
    assert.equal(tras2.last_acquired_at, tras1.last_acquired_at, "la fecha de adquisición no se mueve");
  });

  await test("LEASE · recuperación tras crash: al caducar, otro proceso lo roba (sin deadlock)", () => {
    const now = 1_700_002_000;
    // proc-1 lo coge y se muere sin soltarlo.
    assert.equal(leases.acquireLease("test-c", 30, { owner: "proc-1", nowSec: now }), true);
    // Antes de caducar, nadie más puede.
    assert.equal(leases.acquireLease("test-c", 30, { owner: "proc-2", nowSec: now + 29 }), false);
    // Justo al caducar, sí: un proceso muerto NO bloquea el sistema para siempre.
    assert.equal(leases.acquireLease("test-c", 30, { owner: "proc-2", nowSec: now + 30 }), true);
    assert.equal(leases.getLease("test-c")!.owner_id, "proc-2");
    assert.equal(leases.getLease("test-c")!.acquire_count, 2, "cambio de dueño sí cuenta");
  });

  await test("LEASE · soltar limpiamente cede el turno al instante, y solo puede soltarlo su dueño", () => {
    const now = 1_700_003_000;
    leases.acquireLease("test-d", 3600, { owner: "proc-1", nowSec: now });
    assert.equal(
      leases.releaseLease("test-d", { owner: "proc-2", nowSec: now }),
      false,
      "un proceso no puede soltar el lease de otro"
    );
    assert.equal(leases.releaseLease("test-d", { owner: "proc-1", nowSec: now }), true);
    // Sin esperar la hora de TTL, otro lo coge ya.
    assert.equal(leases.acquireLease("test-d", 60, { owner: "proc-2", nowSec: now + 1 }), true);
    assert.ok(leases.getLease("test-d")!.last_released_at !== null);
  });

  await test("LEASE · withLease no ejecuta NADA si no se tiene el turno", async () => {
    const now = 1_700_004_000;
    leases.acquireLease("test-e", 600, { owner: "proc-1", nowSec: now });
    let ejecutado = 0;
    const r = await leases.withLease("test-e", 600, () => { ejecutado++; return "hecho"; }, { owner: "proc-2", nowSec: now });
    assert.equal(r, null, "null = no me tocaba (distinto de 'corrí y no hice nada')");
    assert.equal(ejecutado, 0, "el efecto externo NO se ejecutó");

    const r2 = await leases.withLease("test-e", 600, () => { ejecutado++; return "hecho"; }, { owner: "proc-1", nowSec: now });
    assert.equal(r2, "hecho");
    assert.equal(ejecutado, 1);
  });

  await test("LEASE · cada scheduler tiene el suyo: uno ocupado no bloquea a los demás", () => {
    const now = 1_700_005_000;
    for (const n of [leases.LEASE_ORDERS, leases.LEASE_TRACKING, leases.LEASE_RECONCILE, leases.LEASE_CALLS, leases.LEASE_OUTBOX, leases.LEASE_WATCHDOG]) {
      assert.equal(leases.acquireLease(n, 60, { owner: "proc-1", nowSec: now }), true, n);
    }
    // proc-2 no puede con ninguno...
    for (const n of [leases.LEASE_ORDERS, leases.LEASE_CALLS]) {
      assert.equal(leases.acquireLease(n, 60, { owner: "proc-2", nowSec: now }), false, n);
    }
    // ...pero un scheduler nuevo sigue libre.
    assert.equal(leases.acquireLease("otro-distinto", 60, { owner: "proc-2", nowSec: now }), true);
    assert.ok(leases.listLeases().length >= 6);
  });

  // ============ 48 · Timezone: política explícita, no el TZ del proceso ============
  console.log("\n— Timezone: Europe/Madrid explícito —");

  const tzmod = await import("../src/lib/time");

  await test("TZ · el día de negocio NO depende del huso del proceso", () => {
    // 23:30 UTC del 24 de agosto: en Madrid (verano, UTC+2) ya es el DÍA 25.
    // Un `new Date().setHours(0,0,0,0)` en un proceso en UTC diría 24.
    const nocheVerano = Date.parse("2026-08-24T23:30:00Z");
    assert.equal(tzmod.businessDay(nocheVerano), "2026-08-25", "de noche en verano ya es el día siguiente en Madrid");

    // 23:30 UTC del 10 de enero: en Madrid (invierno, UTC+1) es el DÍA 11.
    const nocheInvierno = Date.parse("2026-01-10T23:30:00Z");
    assert.equal(tzmod.businessDay(nocheInvierno), "2026-01-11");

    // 22:30 UTC en invierno: aún es el mismo día (23:30 en Madrid).
    assert.equal(tzmod.businessDay(Date.parse("2026-01-10T22:30:00Z")), "2026-01-10");
  });

  await test("TZ · horario de VERANO: la medianoche de Madrid es 22:00 UTC", () => {
    const t = Date.parse("2026-08-24T15:00:00Z");
    const inicio = tzmod.startOfBusinessDay(t);
    assert.equal(new Date(inicio * 1000).toISOString(), "2026-08-23T22:00:00.000Z");
    assert.equal(tzmod.businessDay(inicio * 1000), "2026-08-24", "ese instante ya pertenece al día 24");
  });

  await test("TZ · horario de INVIERNO: la medianoche de Madrid es 23:00 UTC", () => {
    const t = Date.parse("2026-01-10T15:00:00Z");
    const inicio = tzmod.startOfBusinessDay(t);
    assert.equal(new Date(inicio * 1000).toISOString(), "2026-01-09T23:00:00.000Z");
    assert.equal(tzmod.businessDay(inicio * 1000), "2026-01-10");
  });

  await test("TZ · los días de CAMBIO de hora duran 23 h y 25 h, y la ventana lo respeta", () => {
    // Último domingo de marzo 2026 = 29-03: se adelanta el reloj, día de 23 h.
    const marzo = Date.parse("2026-03-29T12:00:00Z");
    const dMarzo = tzmod.endOfBusinessDay(marzo) - tzmod.startOfBusinessDay(marzo);
    assert.equal(dMarzo, 23 * 3600, "el día del cambio de primavera dura 23 h");

    // Último domingo de octubre 2026 = 25-10: se atrasa, día de 25 h.
    const octubre = Date.parse("2026-10-25T12:00:00Z");
    const dOctubre = tzmod.endOfBusinessDay(octubre) - tzmod.startOfBusinessDay(octubre);
    assert.equal(dOctubre, 25 * 3600, "el día del cambio de otoño dura 25 h");

    // Un día normal, 24 h.
    assert.equal(tzmod.endOfBusinessDay(Date.parse("2026-08-24T12:00:00Z")) - tzmod.startOfBusinessDay(Date.parse("2026-08-24T12:00:00Z")), 24 * 3600);
  });

  await test("TZ · ventanas hoy/7d/30d alineadas a medianoche de Madrid", () => {
    const t = Date.parse("2026-08-24T15:00:00Z");
    const hoy = { from: tzmod.startOfBusinessDay(t), to: tzmod.endOfBusinessDay(t) };
    const w7 = tzmod.lastBusinessDays(7, t);
    const w30 = tzmod.lastBusinessDays(30, t);

    // Todas terminan en la misma medianoche: el resultado no depende de a qué
    // hora se mire el panel.
    assert.equal(w7.to, hoy.to);
    assert.equal(w30.to, hoy.to);
    // 7 días naturales = 7 medianoches hacia atrás (168 h salvo cambio de hora).
    assert.equal(tzmod.businessDay(w7.from * 1000), "2026-08-18");
    assert.equal(tzmod.businessDay(w30.from * 1000), "2026-07-26");
    assert.ok(w30.from < w7.from && w7.from < hoy.from);
  });

  await test("TZ · madridDate acierta el offset real, también en el día del cambio", () => {
    // Las 10:00 de Madrid del 29-03-2026 (día del salto) son las 08:00 UTC.
    assert.equal(tzmod.madridDate(2026, 3, 29, 10, 0).toISOString(), "2026-03-29T08:00:00.000Z");
    // Las 10:00 del día anterior, aún en invierno, son las 09:00 UTC.
    assert.equal(tzmod.madridDate(2026, 3, 28, 10, 0).toISOString(), "2026-03-28T09:00:00.000Z");
  });

  await test("TZ · el chequeo de huso avisa en vez de fallar en silencio", () => {
    const c = tzmod.checkTimezone();
    assert.ok(typeof c.processTimezone === "string" && c.processTimezone.length > 0);
    assert.equal(c.businessTimezone, "Europe/Madrid");
    assert.ok(c.message.length > 0);
    // Si el proceso NO está en un huso equivalente, el mensaje tiene que ser
    // explícito sobre la consecuencia (días mal contados), no un "ok".
    if (!tzmod.processTimezoneMatchesBusiness()) {
      assert.match(c.message, /EQUIVOCADO|TZ=/);
    }
  });

  await test("TZ · formato de presentación siempre en hora de Madrid", () => {
    // 22:30 UTC en verano = 00:30 del día siguiente en Madrid.
    assert.equal(tzmod.formatBusinessDateTime(Math.floor(Date.parse("2026-08-24T22:30:00Z") / 1000)), "25/08/2026 00:30");
    assert.equal(tzmod.formatBusinessDateTime(Math.floor(Date.parse("2026-01-10T22:30:00Z") / 1000)), "10/01/2026 23:30");
  });

  // ============ 49 · Métricas fail-closed ============
  console.log("\n— Métricas: '0' y 'no lo sé' no se pintan igual —");

  const MR = await import("../src/lib/system/metric-result");

  await test("FAILCLOSED · una consulta que revienta NO devuelve un número plausible", () => {
    const m = MR.measure<number>("prueba", () => {
      throw new Error("no such table: inventada");
    });
    assert.equal(m.status, "error");
    assert.equal(m.value, null, "NUNCA un valor de relleno junto a un error");
    assert.match(m.error ?? "", /no such table/);
  });

  await test("FAILCLOSED · 'unknown' (sin datos) y 'error' (algo falló) son distintos", () => {
    const sinDatos = MR.unknown<number>("todavía no hay pedidos resueltos");
    assert.equal(sinDatos.status, "unknown");
    assert.equal(sinDatos.error, null, "no hay error: es que aún no ha pasado nada");

    const roto = MR.failed<number>(new Error("disco lleno"), "prueba");
    assert.equal(roto.status, "error");
    assert.ok(roto.error);
    // "esperar" arregla lo primero; "mirar el log" arregla lo segundo.
    assert.notEqual(sinDatos.status, roto.status);
  });

  await test("FAILCLOSED · métrica compuesta: una parte rota degrada, no borra el resto", () => {
    const m = MR.measureParts("compuesta", {
      buena: () => 42,
      rota: () => {
        throw new Error("columna inexistente");
      },
    });
    assert.equal(m.status, "partial");
    assert.equal(m.value?.buena, 42, "lo que sí se pudo calcular se conserva");
    assert.equal(m.degraded.length, 1);
    assert.match(m.degraded[0], /rota/);

    // Si TODAS las partes fallan, es un error, no un "partial" vacío.
    const todo = MR.measureParts("compuesta", {
      a: () => { throw new Error("x"); },
      b: () => { throw new Error("y"); },
    });
    assert.equal(todo.status, "error");
    assert.equal(todo.value, null);
  });

  await test("FAILCLOSED · muestra insuficiente degrada la tasa en vez de afirmarla", () => {
    const m = MR.ok({ rate: 33.3 });
    // 3 resueltos con mínimo 10: el dato se ve, pero NO se puede concluir.
    const poco = MR.withMinimumSample(m, 3, 10);
    assert.equal(poco.status, "partial");
    assert.match(poco.degraded.join(" "), /muestra insuficiente/);
    assert.ok(poco.value, "el número sigue visible: se marca, no se oculta");

    const suficiente = MR.withMinimumSample(MR.ok({ rate: 70 }), 12, 10);
    assert.equal(suficiente.status, "ok");
  });

  await test("FAILCLOSED · las métricas reales exponen su confianza", () => {
    const d = deliveryMetrics.getDeliveryMetricsMeasured();
    assert.ok(["ok", "partial", "unknown", "error"].includes(d.status));
    // Con la DB de test sana, la métrica se calcula; si la muestra es corta,
    // llega como partial — nunca como "ok" con una tasa no concluyente.
    assert.notEqual(d.status, "error");
    if (d.status === "partial") assert.ok(d.degraded.length > 0, "partial siempre dice POR QUÉ");
  });

  await test("FAILCLOSED · el overview del sistema viaja con el estado de cada métrica", async () => {
    const ov = await import("../src/lib/system/overview");
    const o = ov.getSystemOverview();
    assert.ok(o.metricStatus, "el panel necesita distinguir 0 de no-disponible");
    for (const k of ["tracking", "delivery", "economics"] as const) {
      assert.ok(["ok", "partial", "unknown", "error"].includes(o.metricStatus[k].status), k);
      assert.equal(o.metricStatus[k].value, null, "el estado no duplica el valor: solo lo califica");
    }
  });

  // ============ 50 · Retención y privacidad ============
  console.log("\n— Retención: la PII no vive eternamente, el negocio sí —");

  const RET = await import("../src/lib/system/retention");

  await test("RETENCIÓN · el payload reducido conserva las líneas y TIRA toda la PII", () => {
    const original = JSON.stringify({
      id: 123,
      order_number: 456,
      total_price: "39.90",
      currency: "EUR",
      tags: "releasit_cod_form, dropea_id:1",
      fulfillment_status: "fulfilled",
      email: "cliente@ejemplo.com",
      phone: "+34600111222",
      note: "llamar por la tarde",
      customer: { first_name: "Ana", last_name: "García", phone: "+34600111222" },
      shipping_address: { address1: "Calle Falsa 1", city: "Madrid", phone: "+34600111222" },
      billing_address: { address1: "Calle Falsa 1" },
      note_attributes: [{ name: "¿A qué hora estarás?", value: "por la tarde" }],
      line_items: [
        { title: "Cortaúñas", quantity: 1, price: "19.95", sku: "10428", product_id: 1, variant_id: 2, requires_shipping: true, fulfillment_status: "fulfilled", fulfillable_quantity: 0 },
      ],
    });
    const reducido = RET.anonymizeShopifyPayload(original)!;
    const o = JSON.parse(reducido);

    // Lo que el sistema necesita releer sigue ahí.
    assert.equal(o.id, 123);
    assert.equal(o.total_price, "39.90");
    assert.equal(o.fulfillment_status, "fulfilled");
    assert.equal(o.line_items.length, 1);
    assert.equal(o.line_items[0].sku, "10428");
    assert.equal(o.line_items[0].requires_shipping, true, "el fulfillment por línea sobrevive");
    assert.equal(o._pii_removed, true, "queda marcado que NO es el payload original");

    // La PII no está por ningún lado, ni siquiera como subcadena.
    for (const rastro of ["cliente@ejemplo.com", "600111222", "Ana", "García", "Calle Falsa", "Madrid", "llamar por la tarde", "por la tarde"]) {
      assert.equal(reducido.includes(rastro), false, `queda rastro de PII: ${rastro}`);
    }
    assert.equal(o.customer, undefined);
    assert.equal(o.shipping_address, undefined);
    assert.equal(o.note_attributes, undefined);
  });

  await test("RETENCIÓN · lista BLANCA: un campo nuevo de Shopify con PII no se cuela por omisión", () => {
    const conCampoNuevo = JSON.stringify({
      id: 1,
      line_items: [],
      campo_inventado_por_shopify: { dni: "12345678Z", movil: "+34600000000" },
    });
    const reducido = RET.anonymizeShopifyPayload(conCampoNuevo)!;
    assert.equal(reducido.includes("12345678Z"), false);
    assert.equal(reducido.includes("campo_inventado"), false, "solo pasa lo listado explícitamente");
  });

  await test("RETENCIÓN · solo toca pedidos CERRADOS: uno vivo conserva sus datos de contacto", () => {
    const ahora = 1_800_000_000;
    const viejo = ahora - 200 * 86400;

    const vivo = mkOrder("993001", "9301", "34600193001");
    const cerrado = mkOrder("993002", "9302", "34600193002");
    const payload = JSON.stringify({ id: 993002, customer: { first_name: "Pepe" }, line_items: [] });
    for (const o of [vivo, cerrado]) {
      db.systemDbHandle().prepare("UPDATE orders SET raw_payload = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ id: Number(o.shopify_order_id), customer: { first_name: "Pepe" }, line_items: [] }), viejo, o.id);
    }
    // Solo uno tiene cierre terminal.
    db.setOrderClosure(cerrado.id, "delivered", "dropea", viejo);

    const n = RET.reduceOldRawPayloads({ nowSec: ahora });
    assert.ok(n >= 1);
    assert.equal(
      db.getOrderById(vivo.id)!.raw_payload!.includes("Pepe"),
      true,
      "un pedido vivo puede necesitar sus datos para una corrección o una llamada"
    );
    assert.equal(db.getOrderById(cerrado.id)!.raw_payload!.includes("Pepe"), false, "el cerrado sí se reduce");
    assert.ok(payload.includes("Pepe"));
  });

  await test("RETENCIÓN · idempotente: correrla dos veces no cambia nada la segunda", () => {
    const ahora = 1_800_100_000;
    const primera = RET.runRetention({ nowSec: ahora });
    const segunda = RET.runRetention({ nowSec: ahora });
    assert.equal(segunda.rawPayloadsReduced, 0, "ya estaban reducidos");
    assert.equal(segunda.messagesDeleted, 0);
    assert.equal(segunda.webhookEventsDeleted, 0);
    assert.equal(primera.errors.length, 0);
  });

  await test("RETENCIÓN · el dry-run NO borra ni reduce nada", () => {
    const ahora = 1_800_200_000;
    const o = mkOrder("993010", "9310", "34600193010");
    db.systemDbHandle().prepare("UPDATE orders SET raw_payload = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ id: 993010, customer: { first_name: "Lola" }, line_items: [] }), ahora - 300 * 86400, o.id);
    db.setOrderClosure(o.id, "delivered", "dropea", ahora - 300 * 86400);

    const seco = RET.runRetention({ dryRun: true, nowSec: ahora });
    assert.ok(seco.rawPayloadsReduced >= 1, "el dry-run CUENTA lo que haría");
    assert.equal(db.getOrderById(o.id)!.raw_payload!.includes("Lola"), true, "pero no toca nada");
  });

  await test("RETENCIÓN · el NEGOCIO no se borra nunca: pedido, cierre e histórico intactos", () => {
    const ahora = 1_800_300_000;
    const o = mkOrder("993020", "9320", "34600193020");
    db.setOrderClosure(o.id, "refused", "dropea", ahora - 400 * 86400);
    const historicoAntes = db.listOrderStatusHistory(o.id).length;

    RET.runRetention({ nowSec: ahora });

    const fila = db.getOrderById(o.id)!;
    assert.ok(fila, "el pedido sigue existiendo");
    assert.equal(fila.closure_status, "refused", "el eje de cierre es contabilidad: intocable");
    assert.equal(fila.closure_source, "dropea");
    assert.equal(db.listOrderStatusHistory(o.id).length, historicoAntes, "el histórico de estados tampoco se toca");
  });

  // ============ 51 · Taxonomía de errores ============
  console.log("\n— Errores: la categoría dice quién y cuándo lo arregla —");

  const ERR = await import("../src/lib/system/errors");

  await test("ERRORES · el código HTTP manda sobre el texto del mensaje", () => {
    // Un código es una señal estable; el texto lo puede cambiar el tercero
    // cualquier día sin avisar.
    assert.equal(ERR.classifyHttpError(401).category, "auth_error");
    assert.equal(ERR.classifyHttpError(403).category, "auth_error");
    assert.equal(ERR.classifyHttpError(429).category, "rate_limit");
    assert.equal(ERR.classifyHttpError(500).category, "retryable");
    assert.equal(ERR.classifyHttpError(503).category, "retryable");
    assert.equal(ERR.classifyHttpError(404).category, "non_retryable");
    assert.equal(ERR.classifyHttpError(422).category, "validation_error");
    assert.equal(ERR.classifyHttpError(418).category, "external_provider_error");
  });

  await test("ERRORES · sin código HTTP se usan los códigos de red, no frases traducibles", () => {
    for (const m of ["ECONNRESET", "ETIMEDOUT", "socket hang up", "ENOTFOUND api.dropea.com"]) {
      assert.equal(ERR.classifyHttpError(null, new Error(m)).category, "retryable", m);
    }
    assert.equal(
      ERR.classifyHttpError(null, new Error("DROPEA_API_KEY no configurada")).category,
      "configuration_error"
    );
  });

  await test("ERRORES · reintentar o no: 401 NO se reintenta, 429 y 5xx SÍ", () => {
    // Reintentar un 401 eternamente gasta cupo y no arregla nada; no
    // reintentar un timeout pierde trabajo que se habría recuperado solo.
    assert.equal(ERR.isRetryable("auth_error"), false);
    assert.equal(ERR.isRetryable("validation_error"), false);
    assert.equal(ERR.isRetryable("non_retryable"), false);
    assert.equal(ERR.isRetryable("retryable"), true);
    assert.equal(ERR.isRetryable("rate_limit"), true);
  });

  await test("ERRORES · lo que necesita un humano queda marcado como tal", () => {
    for (const c of ["manual_review", "configuration_error", "auth_error", "internal_error"] as const) {
      assert.equal(ERR.needsHuman(c), true, c);
    }
    for (const c of ["retryable", "rate_limit"] as const) {
      assert.equal(ERR.needsHuman(c), false, c);
    }
  });

  await test("ERRORES · severidad: credenciales y configuración son CRÍTICAS", () => {
    // Sin credencial no funciona nada; un timeout se arregla solo.
    assert.equal(ERR.categorySeverity("auth_error"), "critical");
    assert.equal(ERR.categorySeverity("configuration_error"), "critical");
    assert.equal(ERR.categorySeverity("retryable"), "info");
    assert.equal(ERR.categorySeverity("rate_limit"), "info");
    assert.equal(ERR.categorySeverity("manual_review"), "warning");
  });

  await test("ERRORES · cada categoría tiene texto para Pedro, sin jerga", () => {
    for (const c of ERR.ERROR_CATEGORIES) {
      const l = ERR.categoryLabel(c);
      assert.ok(l.length > 5, c);
      // Nada de "Bearer", "token success", códigos sueltos ni inglés técnico.
      assert.equal(/bearer|null|undefined|HTTP \d/i.test(l), false, `jerga en "${l}"`);
    }
  });

  await test("ERRORES · problemas de datos del pedido: revisión vs validación", () => {
    // Sin mapping alguien tiene que decidir; sin localidad alguien tiene que
    // corregir. Son arreglos distintos y no se pintan igual.
    assert.equal(ERR.classifyOrderDataError("unmapped_products: sin asociación").category, "manual_review");
    assert.equal(ERR.classifyOrderDataError("mixed_supplier").category, "manual_review");
    assert.equal(ERR.classifyOrderDataError("blocked_address: localidad vacía").category, "validation_error");
  });

  await test("ERRORES · un fallo de SQLite es un fallo NUESTRO, no del proveedor", () => {
    const c = ERR.classifyInternalError(new Error("SQLITE_BUSY: database is locked"));
    assert.equal(c.category, "internal_error");
    assert.match(c.message, /base de datos/);
    assert.equal(ERR.needsHuman(c.category), true);
  });

  // ============ 52 · Tracking y outbox: garantías bajo estrés ============
  console.log("\n— Tracking: los terminales no retroceden —");

  await test("TRACKING · un terminal NO retrocede: returned → shipped se descarta y queda registrado", () => {
    // Bug real encontrado en la auditoría: `returned`, `cancelled` e
    // `incident` valían -1 en la tabla de ORDEN, así que quedaban FUERA de la
    // comparación y cualquier evento posterior los sacaba de ahí. Un webhook
    // atrasado convertía una devolución en un envío vivo y el pedido volvía
    // a las colas de seguimiento.
    const o = mkSynced("994001", "9401", "34600194001");
    tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "TRK-T1", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "returned", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "returned");

    // Llega un evento atrasado que diría "shipped".
    const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "shipped", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "returned", "sigue devuelto");
    assert.equal(r.events.length, 0, "no genera eventos: no ha pasado nada");
  });

  await test("TRACKING · cancelled → delivered tampoco pasa (era el caso más caro)", () => {
    const o = mkSynced("994002", "9402", "34600194002");
    tracking.processSupplierUpdate(o, { rawStatus: "cancelled", source: "webhook" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "cancelled");

    const antes = db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "delivered", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "cancelled");
    assert.equal(
      db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length,
      antes,
      "y por tanto tampoco se le escribe al cliente"
    );
  });

  await test("TRACKING · delivered → returned se bloquea: el desenlace bueno no se pierde por un evento raro", () => {
    const o = mkSynced("994003", "9403", "34600194003");
    tracking.processSupplierUpdate(o, { rawStatus: "shipped", trackingNumber: "TRK-T3", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "delivered", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "returned", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "delivered");
    // Si el proveedor de verdad dice eso, hay algo que entender: queda evento.
    const eventos = sysRepo.listIntegrationEvents({ integration: "tracking", limit: 500 });
    assert.ok(eventos.some((e) => e.event_type === "terminal_regression_blocked" && e.order_ref === "9403"));
  });

  await test("TRACKING · repetir el MISMO terminal sí está permitido (refresco idempotente)", () => {
    const o = mkSynced("994004", "9404", "34600194004");
    tracking.processSupplierUpdate(o, { rawStatus: "delivered", source: "polling" });
    const r = tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "delivered", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "delivered");
    assert.equal(r.events.length, 0, "sin cambio, sin evento: es idempotente, no un bloqueo");
  });

  await test("TRACKING · un estado desconocido NO pisa el anterior ni avisa a nadie", () => {
    const o = mkSynced("994005", "9405", "34600194005");
    tracking.processSupplierUpdate(o, { rawStatus: "in_transit", trackingNumber: "TRK-T5", source: "polling" });
    const antes = db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length;
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "PALABRA_QUE_NO_EXISTE", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "in_transit");
    assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === o.phone).length, antes);
  });

  await test("TRACKING · retroceso dentro de la línea normal: out_for_delivery → shipped se ignora", () => {
    const o = mkSynced("994006", "9406", "34600194006");
    tracking.processSupplierUpdate(o, { rawStatus: "out_for_delivery", trackingNumber: "TRK-T6", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "shipped", source: "polling" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "out_for_delivery");
  });

  await test("TRACKING · delivery_attempted puede ir y volver: NO es un retroceso", () => {
    // El repartidor no encontró al cliente y vuelve a salir al día siguiente.
    const o = mkSynced("994007", "9407", "34600194007");
    tracking.processSupplierUpdate(o, { rawStatus: "out_for_delivery", trackingNumber: "TRK-T7", source: "polling" });
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, {
      rawStatus: "SHIPPING.DELIVERY_ATTEMPTED",
      normalizedOverride: "delivery_attempted",
      source: "webhook",
    });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "delivery_attempted");
    tracking.processSupplierUpdate(db.getOrderById(o.id)!, { rawStatus: "out_for_delivery", source: "webhook" });
    assert.equal(db.getOrderById(o.id)!.supplier_status_normalized, "out_for_delivery", "vuelve a reparto sin problema");
  });

  await test("TRACKING · el normalizador reconoce nuestro propio vocabulario por identidad", () => {
    // `delivery_attempted` y `at_pickup_point` existen en TrackingStatus pero
    // no estaban en el mapa por defecto: solo en el catálogo de Dropea. Por
    // cualquier otra vía caían en "unknown" EN SILENCIO.
    const n = require("../src/lib/tracking/normalizer") as typeof import("../src/lib/tracking/normalizer");
    assert.equal(n.normalizeSupplierStatus("delivery_attempted"), "delivery_attempted");
    assert.equal(n.normalizeSupplierStatus("at_pickup_point"), "at_pickup_point");
    assert.equal(n.normalizeSupplierStatus("DELIVERY_ATTEMPTED"), "delivery_attempted", "sin distinguir mayúsculas");
    // Y lo que sigue sin significar nada, sigue siendo unknown.
    assert.equal(n.normalizeSupplierStatus("palabra_inventada"), "unknown");
  });

  // ============ 53 · Fixtures: escenarios realistas, cero PII ============
  console.log("\n— Fixtures y escenarios —");

  const FX = await import("./fixtures/index");
  const { normalizeOrder: normalizeOrderFn } = await import("../src/lib/orders/normalize");

  await test("FIXTURES · ninguna fixture lleva datos de una persona real", () => {
    const todo = JSON.stringify([
      ...Object.values(FX.shopifyScenarios).map((f) => f()),
      ...Object.values(FX.dropeaScenarios).map((f) => f()),
      ...Object.values(FX.dropiScenarios).map((f) => f()),
    ]);
    // Dominios reservados por RFC 2606 y rango de móvil no asignado.
    assert.ok(todo.includes("example.com"));
    assert.equal(/@(gmail|hotmail|outlook|yahoo|icloud)\./i.test(todo), false, "sin correos reales");
    assert.equal(/casamable/i.test(todo), false, "sin datos del negocio real");
    // Ningún teléfono español que no sea del rango de prueba 600 000 0xx.
    for (const tel of todo.match(/\+?34[\s\d]{9,}/g) ?? []) {
      assert.match(tel.replace(/\s/g, ""), /^\+?34600000\d{3}$/, `teléfono no anonimizado: ${tel}`);
    }
  });

  await test("FIXTURES · Shopify: los cinco escenarios se comportan como se espera", () => {
    const ff = require("../src/lib/orders/fulfillment") as typeof import("../src/lib/orders/fulfillment");

    // COD normal: mercancía sin despachar.
    assert.equal(ff.inferPhysicalFulfillment(FX.shopifyScenarios.codNormal() as never, true).state, "not_started");

    // El caso Casamable: Shopify dice `partial`, la mercancía está entera.
    const parcial = ff.inferPhysicalFulfillment(FX.shopifyScenarios.partialPorSeguro() as never, true);
    assert.equal(parcial.state, "fulfilled");
    assert.equal(parcial.serviceLines, 1);

    // Cancelado: gana sobre cualquier fulfillment.
    assert.equal(backfill.planClosureFromShopify(FX.shopifyScenarios.cancelado() as never)?.status, "cancelled");

    // Mixto: dos productos físicos + servicio.
    const mixto = ff.inferPhysicalFulfillment(FX.shopifyScenarios.mixto() as never, true);
    assert.equal(mixto.physicalLines, 2);

    // Ciudad inválida: el normalizador la limpia y el router la bloqueará.
    const n = normalizeOrderFn(FX.shopifyScenarios.ciudadInvalida() as never);
    assert.equal(n.city, "-", "el normalizador conserva el crudo; la validación es del router");
  });

  await test("FIXTURES · Dropea: cada escenario cae en el cierre correcto", () => {
    const C = require("../src/lib/orders/closure") as typeof import("../src/lib/orders/closure");
    const at = 1_800_000_000;
    const decidir = (o: Record<string, unknown>) =>
      C.planClosureFromDropea(o.status as string, o.sub_status as string, at);

    assert.equal(decidir(FX.dropeaScenarios.entregado()).plan?.status, "delivered");
    assert.equal(decidir(FX.dropeaScenarios.cobrado()).plan?.status, "delivered");
    assert.equal(decidir(FX.dropeaScenarios.rehusado()).plan?.status, "refused");
    assert.equal(decidir(FX.dropeaScenarios.cancelado()).plan?.status, "cancelled");
    assert.equal(decidir(FX.dropeaScenarios.intentoFallido()).plan?.status, "in_progress");

    // Los dos que NO deben cerrar nada.
    assert.equal(decidir(FX.dropeaScenarios.perdidoODanado()).plan, null);
    assert.equal(decidir(FX.dropeaScenarios.perdidoODanado()).review?.kind, "returned_not_refused");
    assert.equal(decidir(FX.dropeaScenarios.incidencia()).plan, null);
    assert.equal(decidir(FX.dropeaScenarios.desconocido()).plan, null, "un estado fuera del catálogo no infiere nada");
  });

  await test("FIXTURES · Dropi: todo cae en fail-closed, no se inventa semántica", () => {
    const C = require("../src/lib/orders/closure") as typeof import("../src/lib/orders/closure");
    // Sin catálogo confirmado, ningún evento de Dropi puede cerrar un pedido.
    for (const st of ["delivered", "returned", "cancelled"] as const) {
      assert.equal(C.planClosureFromTracking(st, "dropi", 1_800_000_000).plan, null, st);
    }
    // Y su provider sigue sin configurar: cualquier operación real lanza.
    const dropi = require("../src/lib/suppliers/dropi") as typeof import("../src/lib/suppliers/dropi");
    assert.equal(dropi.dropiProvider.isConfigured(), false);
  });

  // ============ 54 · Seguridad y postura ============
  console.log("\n— Seguridad —");

  const SEC = await import("../src/lib/system/security-posture");

  await test("SEGURIDAD · avisa si el panel no tiene contraseña propia", async () => {
    await withEnv({ DASHBOARD_PASSWORD: "" }, () => {
      const items = SEC.getSecurityPosture();
      const p = items.find((i) => i.key === "dashboard_password")!;
      assert.equal(p.level, "warning");
      // El aviso tiene que decir la CONSECUENCIA, no solo "falta una variable".
      assert.match(p.detail, /red local|pedidos|conversaciones/i);
    });
    await withEnv({ DASHBOARD_PASSWORD: "una-clave" }, () => {
      assert.equal(SEC.getSecurityPosture().find((i) => i.key === "dashboard_password")!.level, "ok");
    });
  });

  await test("SEGURIDAD · un secreto de webhook ausente se explica como integración parada, no como agujero", async () => {
    await withEnv({ DROPEA_WEBHOOK_SECRET: "" }, () => {
      const p = SEC.getSecurityPosture().find((i) => i.key === "dropea_webhook_secret")!;
      assert.equal(p.level, "warning");
      assert.match(p.detail, /No es un agujero/i);
    });
  });

  await test("SEGURIDAD · TEST_MODE se anuncia con lo que significa de verdad", async () => {
    await withEnv({ TEST_MODE: "1" }, () => {
      const p = SEC.getSecurityPosture().find((i) => i.key === "test_mode")!;
      assert.match(p.detail, /no miden nada real|se ignoran/i);
    });
    await withEnv({ TEST_MODE: "0" }, () => {
      assert.equal(SEC.getSecurityPosture().some((i) => i.key === "test_mode"), false);
    });
  });

  await test("SEGURIDAD · el endpoint público de salud NO publica el teléfono entero", async () => {
    const mod = await import("../src/app/api/health/route");
    const res = await mod.GET();
    const body = (await res.json()) as { phone: string | null };
    if (body.phone !== null) {
      assert.match(body.phone, /^\*\*\*\d{4}$/, "solo los últimos 4 dígitos");
    }
  });

  await test("BUG2: /api/health y /api/health/live avisan de webhooks de Shopify con firma inválida, sin cambiar el código de estado por eso", async () => {
    sysRepo.logIntegrationEvent("shopify", "webhook_bad_signature", "warning", "webhook rechazado por HMAC inválido");

    const pub = await import("../src/app/api/health/route");
    const resPub = await pub.GET();
    const bodyPub = (await resPub.json()) as { ok: boolean; shopifyWebhookBadSignature24h: number };
    assert.ok(bodyPub.shopifyWebhookBadSignature24h >= 1);

    const live = await import("../src/app/api/health/live/route");
    const resLive = await live.GET();
    const bodyLive = (await resLive.json()) as { ok: boolean; shopifyWebhookBadSignature24h: number };
    assert.equal(resLive.status, 200, "informativo: nunca tumba la liveness por esto");
    assert.ok(bodyLive.shopifyWebhookBadSignature24h >= 1);
  });

  await test("BUG salud: con cloud_api activo, /api/health/live informa de la Cloud API, no de la sesión de Baileys", async () => {
    const mod = await import("../src/app/api/health/live/route");
    // Baileys pudo dejar connection_state en "connected" de una sesión vieja
    // (o nunca haberse usado): con cloud_api activo eso no debe aparecer.
    await withEnv({ WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_API_ENABLED: "0" }, async () => {
      const res = await mod.GET();
      const body = (await res.json()) as { ok: boolean; provider: string; whatsapp: string; phone: string | null };
      assert.equal(res.status, 200, "informativo: nunca tumba la liveness por esto");
      assert.equal(body.provider, "cloud_api");
      assert.equal(body.whatsapp, "not_configured");
      assert.equal(body.phone, null);
    });
    await withEnv(
      {
        WHATSAPP_PROVIDER: "cloud_api",
        META_WHATSAPP_API_ENABLED: "1",
        META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
        META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real",
      },
      async () => {
        const res = await mod.GET();
        const body = (await res.json()) as { provider: string; whatsapp: string };
        assert.equal(body.provider, "cloud_api");
        assert.equal(body.whatsapp, "configured");
      }
    );
  });

  await test("BUG salud: con cloud_api activo, /api/health devuelve 503 si faltan credenciales y 200 si están", async () => {
    const mod = await import("../src/app/api/health/route");
    await withEnv({ WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_API_ENABLED: "0" }, async () => {
      const res = await mod.GET();
      const body = (await res.json()) as { ok: boolean; provider: string; status: string; phone: string | null };
      assert.equal(res.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.provider, "cloud_api");
      assert.equal(body.status, "not_configured");
      assert.equal(body.phone, null, "cloud_api no tiene sesión de la que sacar un número aquí");
    });
    await withEnv(
      {
        WHATSAPP_PROVIDER: "cloud_api",
        META_WHATSAPP_API_ENABLED: "1",
        META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
        META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real",
      },
      async () => {
        const res = await mod.GET();
        const body = (await res.json()) as { ok: boolean; status: string };
        assert.equal(res.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.status, "configured");
      }
    );
  });

  await test("BUG salud: con baileys (default), los dos endpoints siguen leyendo connection_state como siempre", async () => {
    const live = await import("../src/app/api/health/live/route");
    const pub = await import("../src/app/api/health/route");
    const rLive = await live.GET();
    const bLive = (await rLive.json()) as { provider: string };
    assert.equal(bLive.provider, "baileys");
    const rPub = await pub.GET();
    const bPub = (await rPub.json()) as { provider: string };
    assert.equal(bPub.provider, "baileys");
  });

  await test("SEGURIDAD · los tres verificadores de firma usan comparación en tiempo constante", () => {
    // Una comparación normal filtra el secreto por el tiempo de respuesta.
    for (const f of [
      "src/lib/shopify/hmac.ts",
      "src/lib/suppliers/dropea/webhook.ts",
      "src/lib/calls/retell-webhook.ts",
    ]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      assert.ok(src.includes("timingSafeEqual"), `${f} debe comparar en tiempo constante`);
    }
    // El del panel ya NO compara dentro del proxy: la contraseña de Basic
    // Auth se verifica en el guard central. Se comprueba DONDE VIVE AHORA la
    // comparación — antes bastaba con que el proxy tuviera un COMENTARIO con
    // la palabra "timingSafeEqual" para que este test pasara sin proteger nada.
    const guard = fs.readFileSync(path.join(process.cwd(), "src/lib/auth/guard.ts"), "utf8");
    assert.match(guard, /timingSafeEqual\(/, "el guard debe INVOCAR timingSafeEqual, no solo nombrarlo");
    // Y el proxy debe delegar en ese guard, no reimplementar la comparación.
    const proxy = fs.readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");
    assert.match(proxy, /from "@\/lib\/auth\/guard"/);
  });

  await test("SEGURIDAD · no hay secretos escritos en el repositorio", () => {
    // Patrones de credencial real: token de Shopify, clave de OpenRouter y
    // Bearer literal. Las menciones en comentarios y sanitizadores no cuentan.
    const sospechosos = [/shpat_[A-Za-z0-9]{16,}/, /shpss_[A-Za-z0-9]{16,}/, /sk-or-v1-[A-Za-z0-9]{16,}/];
    const raiz = process.cwd();
    const revisar = ["src", "scripts", "tests", "docs"];
    const pendientes: string[] = revisar.map((d) => path.join(raiz, d));
    let vistos = 0;
    while (pendientes.length) {
      const dir = pendientes.pop()!;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          pendientes.push(full);
          continue;
        }
        if (!/\.(ts|tsx|md|json)$/.test(e.name)) continue;
        vistos++;
        const c = fs.readFileSync(full, "utf8");
        for (const pat of sospechosos) {
          assert.equal(pat.test(c), false, `posible secreto en ${path.relative(raiz, full)}`);
        }
      }
    }
    assert.ok(vistos > 50, "el barrido tiene que haber mirado ficheros de verdad");
  });

  // ============ 55 · Mapping: validación de forma ============
  console.log("\n— Mapping de productos —");

  const MV = await import("../src/lib/suppliers/mapping-validation");

  await test("MAPPING · detecta el error real: pegar el metafield en vez del variant_id", () => {
    // Pasó de verdad: el metafield `dropea.product_id` de Shopify
    // (a3f618c76fb450ce890e7189) NO es el variant_id de Dropea (15896).
    const issues = MV.validateMapping({
      supplier_platform: "dropea",
      shopify_sku: "10428",
      supplier_variant_id: "a3f618c76fb450ce890e7189",
    });
    const e = issues.find((i) => i.field === "supplier_variant_id")!;
    assert.equal(e.level, "error");
    assert.match(e.message, /metafield/i);
    assert.equal(MV.mappingIsSavable(issues), false, "un error de forma impide guardar");
  });

  await test("MAPPING · sin variante del proveedor no se puede enrutar nada", () => {
    const issues = MV.validateMapping({ supplier_platform: "dropea", shopify_sku: "X", supplier_variant_id: "" });
    assert.equal(MV.mappingIsSavable(issues), false);
    assert.match(issues[0].message, /falta el identificador/i);
  });

  await test("MAPPING · sin SKU se avisa de que el emparejado por título es frágil", () => {
    const issues = MV.validateMapping({
      supplier_platform: "dropea",
      shopify_title: "Cortaúñas Eléctrico 3 en 1",
      supplier_variant_id: "15896",
    });
    assert.equal(MV.mappingIsSavable(issues), true, "es un aviso, no un error: a veces es lo único que hay");
    assert.match(issues.map((i) => i.message).join(" "), /renombra|silencio/i);
  });

  await test("MAPPING · un mapping correcto pasa sin avisos", () => {
    const issues = MV.validateMapping({
      supplier_platform: "dropea",
      shopify_sku: "10428",
      shopify_title: "Cortaúñas Eléctrico 3 en 1",
      shopify_product_id: "15964094660938",
      shopify_variant_id: "62950185173322",
      supplier_variant_id: "15896",
      supplier_unit_price: 7.7,
    });
    assert.deepEqual(issues, [], "el mapping real de Casamable no debe generar ni un aviso");
  });

  await test("MAPPING · desactivar NO borra: la fila sigue consultable", () => {
    const id = db.upsertSupplierProductMapping({
      supplier_platform: "dropea",
      shopify_sku: "TEST-MAP-1",
      shopify_title: "Producto de prueba",
      supplier_variant_id: "99999",
      active: true,
    });
    assert.equal(db.setSupplierProductMappingActive(id, false), true);
    const fila = db.getSupplierProductMapping(id)!;
    assert.ok(fila, "sigue existiendo");
    assert.equal(fila.active, 0);
    // Reactivable.
    assert.equal(db.setSupplierProductMappingActive(id, true), true);
    assert.equal(db.getSupplierProductMapping(id)!.active, 1);
  });

  // ============ 56 · BUG REAL de producción: multi-pedido pierde la selección ============
  console.log("\n— BUG multi-pedido: '1097' + 'Todo correcto' —");

  /** Pedido ya en awaiting_reply (como si el WhatsApp inicial hubiera salido). */
  const mkMulti = (
    shopifyId: string,
    num: string,
    tel: string,
    extra: Partial<{ product_summary: string; total_price: string }> = {}
  ) =>
    db.insertOrderIfNew({
      shopify_order_id: shopifyId,
      shopify_order_number: num,
      customer_name: "Cliente Multi",
      phone: tel,
      email: null,
      product_summary: extra.product_summary ?? "Limpiador Ultrasónico Multiusos",
      total_price: extra.total_price ?? "29.99",
      currency: "EUR",
      address_line1: "Calle Real 10",
      address_line2: null,
      city: "Vigo",
      province: "Pontevedra",
      postal_code: "36201",
      country: "España",
      status: "awaiting_reply",
    }).order;

  await test("BUG REAL · '1097' selecciona el pedido y 'Todo correcto' confirma ESE pedido", () => {
    // Transcripción real (anonimizada) del 25-08-2026: el cliente escribió
    // "1097" y el bot contestó "Responde 1, 2 o 3"; después "Todo correcto"
    // y el bot volvió a enseñar el selector de pedidos. Bucle infinito.
    const tel = "34600000090";
    mkMulti("920096", "1096", tel);
    mkMulti("920097", "1097", tel);

    const r1 = handleOrderReply(tel, "1097");
    assert.equal(r1.handled, true);
    // Elegir un pedido por su número JAMÁS puede ser "no te he entendido".
    assert.notEqual(r1.reply, msgs.MSG_CLARIFY, "'1097' no puede caer en 'Responde 1, 2 o 3'");
    assert.match(r1.reply ?? "", /1097/, "debe reconocer el pedido elegido");

    const r2 = handleOrderReply(tel, "Todo correcto");
    assert.equal(r2.handled, true);
    assert.equal(
      db.getOrderByShopifyId("920097")!.status,
      "confirmed",
      "'Todo correcto' tras elegir 1097 confirma EL 1097, no vuelve al selector"
    );
    assert.equal(db.getOrderByShopifyId("920096")!.status, "awaiting_reply", "el otro no se toca");
  });

  await test("CHAT REAL · la conversación completa se resuelve en 3 mensajes, sin bucle", () => {
    // La transcripción real, con el comportamiento NUEVO esperado: el bot
    // real repitió el mismo selector 5 veces y nunca resolvió nada.
    const tel = "34600000091";
    mkMulti("921096", "2096", tel); // idénticos: mismo producto, importe, dirección
    mkMulti("921097", "2097", tel);

    // "Todo bien" → intención de confirmar, pero con 2 pedidos es ambiguo.
    const r1 = handleOrderReply(tel, "Todo bien");
    assert.match(r1.reply ?? "", /2096/);
    assert.match(r1.reply ?? "", /Limpiador/, "el selector enseña el PRODUCTO, no solo números");
    assert.match(r1.reply ?? "", /Si solo hiciste uno/, "se le abre la puerta a decir que hay un duplicado");

    // "Pues ahora mismo no sé cuál es" → segunda (y última) vez del selector.
    const r2 = handleOrderReply(tel, "Pues ahora mismo no sé cuál es");
    assert.match(r2.reply ?? "", /2096/);

    // "Yo solo he pedido el limpiador ultrasonido" → AQUÍ se resuelve: los
    // dos pedidos son idénticos → duplicado probable → revisión humana.
    const r3 = handleOrderReply(tel, "Yo solo he pedido el limpiador ultrasonido");
    assert.match(r3.reply ?? "", /duplicado/i, "se le explica lo que pasa, no se le piden más números");
    assert.doesNotMatch(r3.reply ?? "", /Dime el número/, "NO es el selector otra vez");

    for (const id of ["921096", "921097"]) {
      const o = db.getOrderByShopifyId(id)!;
      assert.equal(o.status, "needs_call", `${id} va a revisión humana`);
      assert.equal(o.possible_duplicate, 1, `${id} queda marcado como posible duplicado`);
    }

    // La automatización terminó: nada más que el bot pueda liar.
    const r4 = handleOrderReply(tel, "1097");
    assert.equal(r4.handled, false, "sin pedidos activos, el flujo ya no interviene: lo lleva Pedro");

    // Y el evento para el panel quedó registrado, sin PII.
    const evs = sysRepo.listIntegrationEvents({ integration: "whatsapp", limit: 200 });
    assert.ok(evs.some((e) => e.event_type === "duplicate_suspected" && e.order_ref === "2096"));
  });

  await test("CANCELAR · 'No quiero ninguno anular pedido' con 2 pedidos: confirmación segura, jamás automática", () => {
    const tel = "34600000092";
    mkMulti("922096", "3096", tel);
    mkMulti("922097", "3097", tel);

    const r1 = handleOrderReply(tel, "No quiero ninguno, anular pedido");
    assert.match(r1.reply ?? "", /ambos o solo uno/i, "pregunta cuáles, no repite el selector 1/2/3");
    assert.match(r1.reply ?? "", /AMBOS/);
    // NADA cancelado todavía.
    assert.equal(db.getOrderByShopifyId("922096")!.cancellation_requested_at, null);

    const r2 = handleOrderReply(tel, "AMBOS");
    assert.equal(r2.reply, msgs.MSG_CANCEL_RECEIVED);
    for (const id of ["922096", "922097"]) {
      const o = db.getOrderByShopifyId(id)!;
      assert.equal(o.status, "needs_call", "a revisión: la cancelación real la decide Pedro");
      assert.ok(o.cancellation_requested_at, "petición estampada");
      assert.equal(o.closure_status, "unknown", "NADA se toca en Shopify ni en el eje de cierre");
    }
  });

  await test("CANCELAR · 'cancelar 4096' cancela SOLO ese; el otro sigue su curso", () => {
    const tel = "34600000093";
    mkMulti("923096", "4096", tel);
    mkMulti("923097", "4097", tel);

    const r = handleOrderReply(tel, "cancelar 4096");
    assert.equal(r.reply, msgs.MSG_CANCEL_RECEIVED);
    assert.ok(db.getOrderByShopifyId("923096")!.cancellation_requested_at);
    assert.equal(db.getOrderByShopifyId("923097")!.status, "awaiting_reply", "el otro intacto");
    assert.equal(db.getOrderByShopifyId("923097")!.cancellation_requested_at, null);
  });

  await test("CANCELAR · con UN pedido: frase ambigua pide confirmación explícita, dos pasos", () => {
    const tel = "34600000094";
    mkMulti("924001", "4201", tel);

    const r1 = handleOrderReply(tel, "no lo quiero, quiero cancelar");
    assert.match(r1.reply ?? "", /CANCELAR 4201/, "exige el formato explícito");
    assert.equal(db.getOrderByShopifyId("924001")!.cancellation_requested_at, null, "una frase ambigua NO cancela");
    assert.equal(db.getOrderByShopifyId("924001")!.status, "awaiting_reply");

    const r2 = handleOrderReply(tel, "CANCELAR 4201");
    assert.equal(r2.reply, msgs.MSG_CANCEL_RECEIVED);
    assert.ok(db.getOrderByShopifyId("924001")!.cancellation_requested_at);
    assert.equal(db.getOrderByShopifyId("924001")!.status, "needs_call");
  });

  await test("PRODUCTO · 'el cortaúñas' identifica el pedido cuando SOLO uno lo lleva", () => {
    const tel = "34600000095";
    mkMulti("925001", "4301", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1" });
    mkMulti("925002", "4302", tel, { product_summary: "Espejo Retrovisor Panorámico" });

    const r1 = handleOrderReply(tel, "el cortaúñas");
    assert.match(r1.reply ?? "", /4301/, "lo resuelve al pedido correcto");
    assert.match(r1.reply ?? "", /Qué quieres hacer/i, "y pregunta la acción");

    const r2 = handleOrderReply(tel, "1");
    assert.equal(r2.reply, msgs.MSG_CONFIRMED);
    assert.equal(db.getOrderByShopifyId("925001")!.status, "confirmed");
    assert.equal(db.getOrderByShopifyId("925002")!.status, "awaiting_reply");
  });

  await test("ANTI-BUCLE · a la tercera ambigüedad el selector NO se repite: revisión humana", () => {
    const tel = "34600000096";
    // Productos DISTINTOS y sin frases de duplicado: ambigüedad pura.
    mkMulti("926001", "4401", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1" });
    mkMulti("926002", "4402", tel, { product_summary: "Espejo Retrovisor Panorámico" });

    const r1 = handleOrderReply(tel, "hola buenas");
    assert.match(r1.reply ?? "", /4401/, "primer selector");
    const r2 = handleOrderReply(tel, "sigo sin saberlo");
    assert.match(r2.reply ?? "", /4401/, "segundo selector (último permitido)");
    const r3 = handleOrderReply(tel, "esto no hay quien lo entienda");
    assert.equal(r3.reply, msgs.MSG_ESCALATE_TO_HUMAN, "el tercero YA NO es el selector");
    for (const id of ["926001", "926002"]) {
      assert.equal(db.getOrderByShopifyId(id)!.status, "needs_call");
    }
    const evs = sysRepo.listIntegrationEvents({ integration: "whatsapp", limit: 200 });
    assert.ok(evs.some((e) => e.event_type === "conversation_escalated"));
  });

  await test("TTL · una selección caducada NO decide: 'todo correcto' 46 min después vuelve a preguntar", () => {
    const tel = "34600000097";
    mkMulti("927001", "4501", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1" });
    mkMulti("927002", "4502", tel, { product_summary: "Espejo Retrovisor Panorámico" });

    handleOrderReply(tel, "4501"); // selecciona
    // Envejecer la selección más allá del TTL (45 min por defecto).
    db.systemDbHandle()
      .prepare("UPDATE conversation_order_context SET selected_at = selected_at - 2800 WHERE phone = ?")
      .run(tel);

    const r = handleOrderReply(tel, "todo correcto");
    assert.notEqual(r.reply, msgs.MSG_CONFIRMED, "no se aplica a una selección de hace una hora");
    assert.equal(db.getOrderByShopifyId("927001")!.status, "awaiting_reply", "nada confirmado en silencio");
    assert.match(r.reply ?? "", /4501/, "se vuelve a preguntar");
  });

  await test("PEDIDO NUEVO · si entra otro pedido tras seleccionar, el siguiente mensaje NO se asume del antiguo", () => {
    const tel = "34600000098";
    mkMulti("928001", "4601", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1" });
    mkMulti("928002", "4602", tel, { product_summary: "Espejo Retrovisor Panorámico" });

    handleOrderReply(tel, "4601"); // selecciona el cortaúñas
    // Entra un pedido NUEVO del mismo teléfono (compró otra cosa).
    const nuevo = mkMulti("928003", "4603", tel, { product_summary: "Plancha de Pelo Iónica" });
    db.systemDbHandle().prepare("UPDATE orders SET created_at = created_at + 10 WHERE id = ?").run(nuevo.id);

    const r = handleOrderReply(tel, "1");
    assert.notEqual(r.reply, msgs.MSG_CONFIRMED, "un '1' con un pedido recién llegado vuelve a ser ambiguo");
    assert.equal(db.getOrderByShopifyId("928001")!.status, "awaiting_reply");
    assert.match(r.reply ?? "", /4603/, "el selector ya incluye el pedido nuevo");
  });

  await test("SIN DUPLICADO · 'solo pedí uno' con productos DISTINTOS no marca nada: pide concretar", () => {
    const tel = "34600000099";
    mkMulti("929001", "4701", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1" });
    mkMulti("929002", "4702", tel, { product_summary: "Espejo Retrovisor Panorámico", total_price: "19.99" });

    const r = handleOrderReply(tel, "solo he pedido uno");
    assert.match(r.reply ?? "", /4701/, "productos distintos: no es un duplicado, se pide concretar");
    assert.equal(db.getOrderByShopifyId("929001")!.possible_duplicate, 0);
    assert.equal(db.getOrderByShopifyId("929002")!.possible_duplicate, 0);
  });

  await test("CONCURRENCIA · dos mensajes rápidos del mismo teléfono se procesan EN ORDEN", async () => {
    const { runSerializedByPhone } = await import("../src/lib/baileys/handler");
    const orden: string[] = [];
    // El primero tarda (como una nota de voz transcribiéndose); el segundo
    // llega al instante. Sin la puerta, "b" adelantaría a "a".
    const lento = runSerializedByPhone("34600000100", async () => {
      await new Promise((r) => setTimeout(r, 40));
      orden.push("a");
    });
    const rapido = runSerializedByPhone("34600000100", async () => {
      orden.push("b");
    });
    // Otro teléfono NO espera al lento.
    const otro = runSerializedByPhone("34600000101", async () => {
      orden.push("otro");
    });
    await Promise.all([lento, rapido, otro]);
    assert.equal(orden.indexOf("a") < orden.indexOf("b"), true, "mismo teléfono: en orden de llegada");
    assert.equal(orden[0], "otro", "teléfonos distintos no se bloquean entre sí");
  });

  // ============ 57 · Cloud API de Meta: provider, webhook, botones ============
  console.log("\n— Meta Cloud API: provider, webhook y botones —");

  const metaProv = await import("../src/lib/whatsapp/meta-cloud");
  const metaHook = await import("../src/lib/whatsapp/meta-webhook");
  const metaIn = await import("../src/lib/whatsapp/inbound");
  const metaOutbox = await import("../src/lib/whatsapp/cloud-outbox");
  const interactive = await import("../src/lib/whatsapp/interactive");
  const waTemplates = await import("../src/lib/whatsapp/templates");
  const waTop = await import("../src/lib/whatsapp");
  const confirmMod = await import("../src/lib/orders/confirmation");

  const META_ENV = {
    // La config del PILOTO: el webhook solo ACTÚA con cloud_api activo (con
    // Baileys activo lo ignora para no procesar el mismo mensaje dos veces).
    WHATSAPP_PROVIDER: "cloud_api",
    META_WHATSAPP_API_ENABLED: "1",
    META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
    META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real",
    META_WHATSAPP_APP_SECRET: "app-secret-de-prueba",
    META_WHATSAPP_VERIFY_TOKEN: "verify-token-de-prueba",
  };

  /** fetch falso: captura la llamada y responde como Meta. */
  const fakeMetaFetch = (respuestas: Array<{ status: number; body: unknown }>) => {
    const llamadas: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      llamadas.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const r = respuestas.shift() ?? { status: 200, body: { messages: [{ id: "wamid.TEST" }] } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return { llamadas, fetchImpl };
  };

  const firmaMeta = (raw: string) =>
    "sha256=" + crypto.createHmac("sha256", "app-secret-de-prueba").update(raw, "utf8").digest("hex");

  /** Webhook de Meta con un mensaje entrante. */
  const metaInboundBody = (msg: Record<string, unknown>, waId: string) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: waId, profile: { name: "Cliente" } }], messages: [msg] } }] }],
    });

  const metaStatusBody = (st: Record<string, unknown>) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [st] } }] }],
    });

  await test("META · fail-closed: sin habilitar NO se hace ni una llamada de red", async () => {
    const { llamadas, fetchImpl } = fakeMetaFetch([]);
    const p = new metaProv.MetaCloudWhatsAppProvider(fetchImpl);
    await withEnv({ META_WHATSAPP_API_ENABLED: "0" }, async () => {
      const r = await p.send("34600000110", { kind: "text", text: "hola" });
      assert.equal(r.ok, false);
      assert.equal(r.retryable, false, "terminal: reintentar sin credenciales da lo mismo");
      assert.equal(llamadas.length, 0, "CERO llamadas a Meta");
    });
  });

  await test("META · ventana de 24 h: texto libre sin mensaje previo del cliente → terminal, plantilla → pasa", async () => {
    const { llamadas, fetchImpl } = fakeMetaFetch([]);
    const p = new metaProv.MetaCloudWhatsAppProvider(fetchImpl);
    await withEnv(META_ENV, async () => {
      // Este teléfono JAMÁS nos escribió: fuera de ventana por definición.
      const r = await p.send("34600000111", { kind: "text", text: "hola" });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /outside_24h_window/);
      assert.equal(r.retryable, false);
      assert.equal(llamadas.length, 0, "ni se intenta: Meta lo rechazaría igual");

      // Una PLANTILLA sí puede salir fuera de ventana.
      const rt = await p.send("34600000111", {
        kind: "template", templateName: "order_reminder", language: "es", bodyParams: ["Cliente", "pedido"],
      });
      assert.equal(rt.ok, true);
      assert.equal(rt.providerMessageId, "wamid.TEST");
      assert.equal(llamadas.length, 1);
    });
  });

  await test("META · dentro de ventana: texto libre sale y el payload es el de la Graph API", async () => {
    const tel = "34600000112";
    const convo = db.getOrCreateConversation(tel, "Cliente Meta");
    db.insertMessage(convo.id, "user", "hola, soy el cliente"); // abre la ventana
    const { llamadas, fetchImpl } = fakeMetaFetch([]);
    const p = new metaProv.MetaCloudWhatsAppProvider(fetchImpl);
    await withEnv(META_ENV, async () => {
      const r = await p.send(tel, { kind: "text", text: "gracias por escribir" });
      assert.equal(r.ok, true);
      assert.match(llamadas[0].url, /graph\.facebook\.com\/v23\.0\/111222333\/messages/);
      assert.equal(llamadas[0].body.type, "text");
      assert.equal((llamadas[0].body.text as { body: string }).body, "gracias por escribir");
    });
  });

  await test("META · botones: payload correcto y límites de Meta validados ANTES de gastar la llamada", async () => {
    const tel = "34600000112"; // ventana ya abierta arriba
    const { llamadas, fetchImpl } = fakeMetaFetch([]);
    const p = new metaProv.MetaCloudWhatsAppProvider(fetchImpl);
    await withEnv(META_ENV, async () => {
      const r = await p.send(tel, {
        kind: "interactive_buttons",
        body: "¿Está todo correcto?",
        buttons: [
          { id: "confirm_order", title: "✅ Confirmar pedido" },
          { id: "change_address", title: "📍 Cambiar dirección" },
          { id: "delivery_note", title: "📝 Dejar nota" },
        ],
      });
      assert.equal(r.ok, true);
      const body = llamadas[0].body as { type: string; interactive: { type: string; action: { buttons: Array<{ reply: { id: string } }> } } };
      assert.equal(body.type, "interactive");
      assert.equal(body.interactive.type, "button");
      assert.equal(body.interactive.action.buttons[0].reply.id, "confirm_order");

      // 4 botones → rechazado LOCALMENTE, sin llamada.
      const antes = llamadas.length;
      const r4 = await p.send(tel, {
        kind: "interactive_buttons",
        body: "x",
        buttons: [
          { id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" },
        ],
      });
      assert.equal(r4.ok, false);
      assert.match(r4.error ?? "", /entre 1 y 3/);
      assert.equal(llamadas.length, antes, "no se gastó la llamada");

      // Título >20 caracteres → igual.
      const rl = await p.send(tel, {
        kind: "interactive_buttons", body: "x",
        buttons: [{ id: "a", title: "Este título es demasiado largo para Meta" }],
      });
      assert.equal(rl.ok, false);
      assert.match(rl.error ?? "", /20/);
    });
  });

  await test("META · clasificación de errores: 429/5xx reintentables, 401 terminal", async () => {
    const tel = "34600000112";
    await withEnv(META_ENV, async () => {
      const p429 = new metaProv.MetaCloudWhatsAppProvider(
        fakeMetaFetch([{ status: 429, body: { error: { message: "rate limit" } } }]).fetchImpl
      );
      const r429 = await p429.send(tel, { kind: "text", text: "x" });
      assert.equal(r429.ok, false);
      assert.equal(r429.retryable, true, "429 se reintenta");

      const p500 = new metaProv.MetaCloudWhatsAppProvider(
        fakeMetaFetch([{ status: 500, body: {} }]).fetchImpl
      );
      assert.equal((await p500.send(tel, { kind: "text", text: "x" })).retryable, true, "5xx se reintenta");

      const p401 = new metaProv.MetaCloudWhatsAppProvider(
        fakeMetaFetch([{ status: 401, body: { error: { message: "bad token" } } }]).fetchImpl
      );
      const r401 = await p401.send(tel, { kind: "text", text: "x" });
      assert.equal(r401.retryable, false, "credencial mala: reintentar da lo mismo");
    });
  });

  await test("META · plantillas: el catálogo valida nombre y número de variables", () => {
    const m = waTemplates.buildTemplateMessage("order_confirmation_request", ["Ana", "Limpiador", "29,99 €"]);
    assert.equal(m.kind, "template");
    assert.throws(() => waTemplates.buildTemplateMessage("plantilla_inventada", []), /desconocida/);
    assert.throws(
      () => waTemplates.buildTemplateMessage("order_confirmation_request", ["solo-una"]),
      /esperaba 3/
    );
    assert.equal(
      waTemplates.loadTemplateSpecs().length,
      12,
      "las 12 plantillas: 6 del plan original + 6 recuperadas del NAS (30-08): pedido_confirmado, " +
        "pedido_confirmado_casamable, reparto_hoy, entrega_fallida, retraso_pedido, pedido_cancelado"
    );
  });

  await test("BUG1 · buildTemplateMessage incluye los payloads de botón del catálogo, en orden", () => {
    const m = waTemplates.buildTemplateMessage("order_confirmation_request", ["Ana", "Limpiador", "29,99 €"]);
    assert.equal(m.kind, "template");
    if (m.kind !== "template") throw new Error("unreachable");
    assert.deepEqual(
      m.buttonPayloads,
      [confirmMod.BUTTON_PAYLOADS.CONFIRM, confirmMod.BUTTON_PAYLOADS.CHANGE_ADDRESS, confirmMod.BUTTON_PAYLOADS.DELIVERY_NOTE],
      "los 3 payloads de order_confirmation_request, en el mismo orden que el catálogo"
    );

    const rec = waTemplates.buildTemplateMessage("order_reminder", ["Ana", "Limpiador"]);
    if (rec.kind !== "template") throw new Error("unreachable");
    assert.deepEqual(
      rec.buttonPayloads,
      [confirmMod.BUTTON_PAYLOADS.CONFIRM, confirmMod.BUTTON_PAYLOADS.CHANGE_ADDRESS],
      "order_reminder solo tiene 2 botones (sin 'dejar nota')"
    );
  });

  await test("BUG1 · buildMetaPayload de una plantilla manda un componente button/quick_reply POR CADA botón, con su payload", () => {
    const m = waTemplates.buildTemplateMessage("order_confirmation_request", ["Ana", "Limpiador", "29,99 €"]);
    const payload = metaProv.buildMetaPayload("34600000000", m) as {
      template: { components: Array<{ type: string; sub_type?: string; index?: string; parameters: Array<Record<string, string>> }> };
    };
    const botones = payload.template.components.filter((c) => c.type === "button");
    assert.equal(botones.length, 3, "un componente por cada botón de la plantilla");
    assert.deepEqual(
      botones.map((b) => b.parameters[0].payload),
      [confirmMod.BUTTON_PAYLOADS.CONFIRM, confirmMod.BUTTON_PAYLOADS.CHANGE_ADDRESS, confirmMod.BUTTON_PAYLOADS.DELIVERY_NOTE]
    );
    assert.deepEqual(botones.map((b) => b.index), ["0", "1", "2"], "el índice marca qué botón de la plantilla es cada uno");
    assert.ok(botones.every((b) => b.sub_type === "quick_reply"));

    // Un mensaje de plantilla SIN buttonPayloads (campo opcional) no debe
    // reventar ni añadir componentes de botón — solo el body.
    const sinBotones = metaProv.buildMetaPayload("34600000000", {
      kind: "template", templateName: "x", language: "es", bodyParams: ["a"],
    }) as { template: { components: unknown[] } };
    assert.equal(sinBotones.template.components.filter((c: any) => c.type === "button").length, 0);
  });

  // V3 (incidente 132001): estos tests del flujo BUG1 necesitan el mapping
  // lógico→WABA VERIFICADO — es la nueva condición para que salga una
  // plantilla. Se siembra la verificación de "confirmacion_pedido_cod" (la
  // plantilla real de la WABA, corregida el 02-09 — el mapping anterior
  // apuntaba a "pedido", la plantilla de ejemplo de Meta, origen del
  // incidente) como hará el doctor.
  db.setSetting(
    "wa_tpl_verified:order_confirmation_request",
    JSON.stringify({ provider: "confirmacion_pedido_cod", language: "es", status: "APPROVED", paramCount: 4, buttonCount: 3, buttonTypes: ["QUICK_REPLY", "QUICK_REPLY", "QUICK_REPLY"], category: "UTILITY", verifiedAt: 1756700000 })
  );

  await test("BUG1 · buildConfirmationOutbound: dentro de ventana manda el interactivo, fuera manda la plantilla con los datos reales del pedido", () => {
    const o = mkMulti("972501", "7501", "34600177501", { product_summary: "Limpiador Ultrasónico", total_price: "19.99" });
    const orden = db.getOrderById(o.id)!;

    const dentro = interactive.buildConfirmationOutbound(orden, true);
    assert.equal(dentro.message.kind, "interactive_buttons", "dentro de ventana: interactivo normal, NUNCA plantilla (coste)");

    const fuera = interactive.buildConfirmationOutbound(orden, false);
    assert.equal(fuera.message.kind, "template");
    if (fuera.message.kind !== "template") throw new Error("unreachable");
    assert.equal(fuera.message.templateName, "confirmacion_pedido_cod", "V3: viaja el nombre REAL aprobado en la WABA, no el borrador local");
    assert.deepEqual(
      fuera.message.bodyParams,
      ["Cliente", `#${orden.shopify_order_number}`, "Limpiador Ultrasónico", "19,99 €"],
      "nombre, número de pedido, producto e importe, en ese orden"
    );
    assert.equal(fuera.fallbackText, dentro.fallbackText, "el fallback (panel / rollback) es el mismo texto en los dos casos");
  });

  await test("BUG1 · sendWhatsAppInteractive con una plantilla guarda message_type='template' y template_name — no 'interactive_buttons'", async () => {
    const tel = "34600177502";
    const orden = db.getOrderById(mkMulti("972502", "7502", tel).id)!;
    const spec = interactive.buildConfirmationOutbound(orden, false); // fuera de ventana → plantilla
    await withEnv({ WHATSAPP_PROVIDER: "cloud_api" }, () => {
      waTop.sendWhatsAppInteractive(tel, spec);
    });
    const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
    assert.equal(item.message_type, "template", "antes de este fix caía en 'interactive_buttons' por defecto");
    assert.equal(item.template_name, "confirmacion_pedido_cod");
  });

  await test("WEBHOOK META · verificación inicial: token correcto devuelve el challenge, incorrecto 403, sin configurar 500", async () => {
    await withEnv(META_ENV, () => {
      const ok = metaHook.verifyMetaWebhookSubscription({ mode: "subscribe", token: "verify-token-de-prueba", challenge: "reto-123" });
      assert.equal(ok.status, 200);
      assert.equal(ok.body, "reto-123", "el challenge vuelve TAL CUAL (texto plano)");
      assert.equal(metaHook.verifyMetaWebhookSubscription({ mode: "subscribe", token: "otro", challenge: "x" }).status, 403);
    });
    await withEnv({ META_WHATSAPP_VERIFY_TOKEN: "" }, () => {
      assert.equal(metaHook.verifyMetaWebhookSubscription({ mode: "subscribe", token: "a", challenge: "x" }).status, 500);
    });
  });

  await test("WEBHOOK META · firma inválida → 401 sin efectos; sin app secret → 500", async () => {
    const tel = "34600000113";
    mkMulti("970101", "5001", tel);
    const raw = metaInboundBody({ from: tel, id: "wamid.in1", timestamp: "1756100000", type: "text", text: { body: "1" } }, tel);
    await withEnv(META_ENV, () => {
      const r = metaHook.processMetaWebhook(raw, "sha256=" + "0".repeat(64));
      assert.equal(r.status, 401);
      assert.equal(db.getOrderByShopifyId("970101")!.status, "awaiting_reply", "cero efectos");
    });
    await withEnv({ META_WHATSAPP_APP_SECRET: "" }, () => {
      assert.equal(metaHook.processMetaWebhook(raw, firmaMeta(raw)).status, 500, "error NUESTRO, no de Meta");
    });
  });

  await test("WEBHOOK META · botón 'Confirmar' → la MISMA máquina COD: pedido confirmado y respuesta por outbox", async () => {
    const tel = "34600000113"; // pedido 5001 creado arriba
    const raw = metaInboundBody(
      { from: tel, id: "wamid.btn1", timestamp: "1756100010", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "confirm_order", title: "✅ Confirmar pedido" } } },
      tel
    );
    await withEnv(META_ENV, () => {
      const r = metaHook.processMetaWebhook(raw, firmaMeta(raw));
      assert.equal(r.status, 200);
      assert.equal(db.getOrderByShopifyId("970101")!.status, "confirmed", "el payload confirma, sin NLP del título");
      const out = db.getPendingOutbox(500).filter((x) => x.phone === tel);
      assert.equal(out.length, 1, "la respuesta salió por el outbox");
      assert.equal(out[out.length - 1].content, msgs.MSG_CONFIRMED);
    });
  });

  await test("WEBHOOK META · el mismo webhook DOS veces: un solo efecto (dedupe por id de mensaje)", async () => {
    const tel = "34600000114";
    mkMulti("970102", "5002", tel);
    const raw = metaInboundBody(
      { from: tel, id: "wamid.dup1", timestamp: "1756100020", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "confirm_order", title: "Confirmar" } } },
      tel
    );
    await withEnv(META_ENV, () => {
      metaHook.processMetaWebhook(raw, firmaMeta(raw));
      metaHook.processMetaWebhook(raw, firmaMeta(raw)); // reintento de Meta
      const out = db.getPendingOutbox(500).filter((x) => x.phone === tel);
      assert.equal(out.length, 1, "una sola respuesta aunque Meta reintente");
    });
  });

  await test("WEBHOOK META · botones de dirección y nota → needs_correction y awaiting_delivery_note", async () => {
    const telA = "34600000115";
    mkMulti("970103", "5003", telA);
    const rawA = metaInboundBody(
      { from: telA, id: "wamid.addr1", timestamp: "1756100030", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "change_address", title: "📍 Cambiar dirección" } } },
      telA
    );
    const telB = "34600000116";
    mkMulti("970104", "5004", telB);
    const rawB = metaInboundBody(
      { from: telB, id: "wamid.note1", timestamp: "1756100031", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "delivery_note", title: "📝 Dejar nota" } } },
      telB
    );
    await withEnv(META_ENV, () => {
      metaHook.processMetaWebhook(rawA, firmaMeta(rawA));
      assert.equal(db.getOrderByShopifyId("970103")!.status, "needs_correction");
      // El siguiente TEXTO es la dirección (mismo flujo de siempre).
      const rawDir = metaInboundBody(
        { from: telA, id: "wamid.addr2", timestamp: "1756100032", type: "text", text: { body: "Calle Nueva 5, 2ºA, 36202 Vigo" } },
        telA
      );
      metaHook.processMetaWebhook(rawDir, firmaMeta(rawDir));
      assert.match(db.getOrderByShopifyId("970103")!.proposed_address ?? "", /Calle Nueva 5/);

      metaHook.processMetaWebhook(rawB, firmaMeta(rawB));
      assert.equal(db.getOrderByShopifyId("970104")!.status, "awaiting_delivery_note");
    });
  });

  await test("WEBHOOK META · multi-pedido por LISTA: list_reply selecciona y el botón confirma ESE pedido", async () => {
    const tel = "34600000117";
    mkMulti("970105", "5005", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1" });
    mkMulti("970106", "5006", tel, { product_summary: "Espejo Retrovisor Panorámico" });
    await withEnv(META_ENV, () => {
      const rawSel = metaInboundBody(
        { from: tel, id: "wamid.list1", timestamp: "1756100040", type: "interactive",
          interactive: { type: "list_reply", list_reply: { id: "select_order:5006", title: "#5006" } } },
        tel
      );
      metaHook.processMetaWebhook(rawSel, firmaMeta(rawSel));
      const rawConf = metaInboundBody(
        { from: tel, id: "wamid.list2", timestamp: "1756100041", type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "confirm_order", title: "Confirmar" } } },
        tel
      );
      metaHook.processMetaWebhook(rawConf, firmaMeta(rawConf));
      assert.equal(db.getOrderByShopifyId("970106")!.status, "confirmed", "el seleccionado");
      assert.equal(db.getOrderByShopifyId("970105")!.status, "awaiting_reply", "el otro intacto");
    });
  });

  await test("WEBHOOK META · botón 'cancelar' con un pedido → cancellation_requested, sin tocar Shopify", async () => {
    const tel = "34600000118";
    mkMulti("970107", "5007", tel);
    const raw = metaInboundBody(
      { from: tel, id: "wamid.cancel1", timestamp: "1756100050", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "cancel_request", title: "❌ Quiero cancelar" } } },
      tel
    );
    await withEnv(META_ENV, () => {
      metaHook.processMetaWebhook(raw, firmaMeta(raw));
      const o = db.getOrderByShopifyId("970107")!;
      assert.equal(o.status, "needs_call", "a revisión humana");
      assert.ok(o.cancellation_requested_at, "petición estampada");
      assert.equal(o.closure_status, "unknown", "Shopify y el cierre, intactos");
    });
  });

  await test("ESTADOS META · delivered y read se persisten por provider_message_id; read implica delivered", async () => {
    const tel = "34600000119";
    const convo = db.getOrCreateConversation(tel);
    const itemId = db.enqueueOutbox(convo.id, tel, "mensaje con seguimiento");
    db.markOutboxSent(itemId);
    db.setOutboxProviderResult(itemId, "cloud_api", "wamid.status1");

    await withEnv(META_ENV, () => {
      // Llega el READ antes que el DELIVERED (Meta no garantiza orden).
      const rawRead = metaStatusBody({ id: "wamid.status1", status: "read", timestamp: "1756100060", recipient_id: tel });
      metaHook.processMetaWebhook(rawRead, firmaMeta(rawRead));
      let fila = db.getOutboxByProviderMessageId("wamid.status1")!;
      assert.equal(fila.read_at, 1756100060);
      assert.equal(fila.delivered_at, 1756100060, "un read implica entregado aunque el delivered se perdiera");

      // El delivered atrasado NO retrocede nada.
      const rawDel = metaStatusBody({ id: "wamid.status1", status: "delivered", timestamp: "1756100055", recipient_id: tel });
      metaHook.processMetaWebhook(rawDel, firmaMeta(rawDel));
      fila = db.getOutboxByProviderMessageId("wamid.status1")!;
      assert.equal(fila.read_at, 1756100060, "el read no se pierde");
      assert.equal(fila.delivered_at, 1756100060, "COALESCE: el primero gana, no se pisa");
    });
  });

  await test("ESTADOS META · failed guarda el motivo y queda visible", async () => {
    const tel = "34600000120";
    const convo = db.getOrCreateConversation(tel);
    const itemId = db.enqueueOutbox(convo.id, tel, "mensaje que fallará");
    db.markOutboxSent(itemId);
    db.setOutboxProviderResult(itemId, "cloud_api", "wamid.status2");
    await withEnv(META_ENV, () => {
      const raw = metaStatusBody({
        id: "wamid.status2", status: "failed", timestamp: "1756100070", recipient_id: tel,
        errors: [{ code: 131047, title: "Re-engagement message" }],
      });
      metaHook.processMetaWebhook(raw, firmaMeta(raw));
      const fila = db.getOutboxByProviderMessageId("wamid.status2")!;
      assert.ok(fila.failed_at);
      assert.match(fila.failure_reason ?? "", /131047/);
    });
  });

  await test("PROVIDER SWITCH · el mismo sendWhatsAppInteractive encola botones en cloud y texto plano en baileys", async () => {
    const tel = "34600000121";
    const orden = mkMulti("970108", "5008", tel);
    const spec = interactive.buildConfirmationInteractive(db.getOrderById(orden.id)!);

    await withEnv({ WHATSAPP_PROVIDER: "cloud_api" }, () => {
      waTop.sendWhatsAppInteractive(tel, spec);
      const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
      assert.equal(item.message_type, "interactive_buttons");
      assert.ok(item.payload_json, "el mensaje interactivo entero viaja en payload_json");
      assert.match(item.content, /1 — Confirmar/, "content = fallback para el panel");
    });
    await withEnv({ WHATSAPP_PROVIDER: "baileys" }, () => {
      waTop.sendWhatsAppInteractive(tel, spec);
      const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
      assert.equal(item.message_type, "text", "Baileys no tiene botones: sale el fallback 1/2/3");
      assert.equal(item.payload_json, null);
    });
  });

  await test("CLOUD OUTBOX · tick: envía, persiste provider_message_id; retryable revierte; terminal marca failed", async () => {
    const tel = "34600000122";
    const convo = db.getOrCreateConversation(tel);
    db.insertMessage(convo.id, "user", "abro ventana");

    // La cola arrastra pendientes de OTROS tests (procesa los 20 más viejos
    // por tick). El provider falso responde según el destinatario: éxito
    // para este teléfono, y para los ajenos lo que toque en cada fase — la
    // DB es desechable, pero los contadores del test son solo de `tel`.
    let seq = 0;
    const soloMiTelefono = (fn: () => import("../src/lib/whatsapp/provider").SendResult) => ({
      name: "cloud_api" as const,
      isConfigured: () => true,
      getHealth: () => ({ provider: "cloud_api" as const, configured: true, available: true, detail: "" }),
      markAsRead: async () => {},
      send: async (to: string) =>
        to === tel ? fn() : { ok: true, providerMessageId: `wamid.ajeno.${++seq}` },
    });

    const id1 = db.enqueueOutbox(convo.id, tel, "mensaje uno");
    const okProv = soloMiTelefono(() => ({ ok: true, providerMessageId: `wamid.tick.${++seq}` }));
    for (let i = 0; i < 50 && db.getPendingOutbox(500).some((x) => x.id === id1); i++) {
      await metaOutbox.runCloudOutboxTick(okProv);
    }
    const fila1 = db.systemDbHandle().prepare("SELECT * FROM outbox WHERE id = ?").get(id1) as {
      sent: number; provider: string | null; provider_message_id: string | null;
    };
    assert.equal(fila1.sent, 1, "enviado");
    assert.equal(fila1.provider, "cloud_api");
    assert.match(fila1.provider_message_id ?? "", /^wamid\.tick\./, "el id de Meta queda persistido");

    // Fallo RETRYABLE: vuelve a la cola.
    const id2 = db.enqueueOutbox(convo.id, tel, "mensaje dos");
    const provFalla = soloMiTelefono(() => ({ ok: false, providerMessageId: null, error: "ECONNRESET", retryable: true }));
    for (let i = 0; i < 5; i++) await metaOutbox.runCloudOutboxTick(provFalla);
    assert.equal(db.getPendingOutbox(500).some((x) => x.id === id2), true, "revertido: se reintenta");

    // Fallo TERMINAL: fuera de la cola CON motivo.
    const provTerminal = soloMiTelefono(() => ({ ok: false, providerMessageId: null, error: "outside_24h_window", retryable: false }));
    for (let i = 0; i < 50 && db.getPendingOutbox(500).some((x) => x.id === id2); i++) {
      await metaOutbox.runCloudOutboxTick(provTerminal);
    }
    const fila2 = db.systemDbHandle().prepare("SELECT * FROM outbox WHERE id = ?").get(id2) as {
      sent: number; failed_at: number | null; failure_reason: string | null;
    };
    assert.equal(fila2.sent, 1, "fuera de la cola");
    assert.ok(fila2.failed_at);
    // T1 §2.5: el motivo ya no es el genérico de Meta sino el DISTINGUIBLE
    // (sin plantilla equivalente adjunta, el dispatcher lo reclasifica).
    assert.match(fila2.failure_reason ?? "", /template_not_configured_outside_window/);
  });

  await test("COEXISTENCIA · con Baileys activo, el webhook de Meta NO actúa: cero doble proceso", async () => {
    // Durante la transición pueden llegar los MISMOS mensajes por los dos
    // caminos (la sesión de Baileys y el webhook de Meta), con ids DISTINTOS:
    // el dedupe por id no cubre esto. Cubre este gate.
    const tel = "34600000130";
    mkMulti("971001", "6001", tel);
    const raw = metaInboundBody(
      { from: tel, id: "wamid.coex1", timestamp: "1756100100", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "confirm_order", title: "Confirmar" } } },
      tel
    );
    await withEnv({ ...META_ENV, WHATSAPP_PROVIDER: "baileys" }, () => {
      const r = metaHook.processMetaWebhook(raw, firmaMeta(raw));
      assert.equal(r.status, 200, "a Meta se le responde 200 (si no, reintenta eternamente)");
      assert.equal(db.getOrderByShopifyId("971001")!.status, "awaiting_reply", "NO se actúa");
      assert.equal(db.getPendingOutbox(500).filter((x) => x.phone === tel).length, 0, "cero respuestas");
      const evs = sysRepo.listIntegrationEvents({ integration: "whatsapp", limit: 100 });
      assert.ok(evs.some((e) => e.event_type === "meta_inbound_ignored_provider_baileys"), "queda constancia");
    });
  });

  await test("VENTANA 24H · el entrante por Cloud ABRE la ventana (el bug que habría matado el piloto)", async () => {
    // Antes del arreglo, el webhook no insertaba el mensaje en `messages` y
    // la ventana JAMÁS se abría en modo cloud: todo texto libre fallaba
    // outside_24h_window incluso respondiendo al cliente en el momento.
    const tel = "34600000131";
    const raw = metaInboundBody(
      { from: tel, id: "wamid.win1", timestamp: "1756100110", type: "text", text: { body: "hola" } },
      tel
    );
    await withEnv(META_ENV, async () => {
      assert.equal(metaProv.isWithinSessionWindow(tel), false, "antes de escribir: fuera");
      metaHook.processMetaWebhook(raw, firmaMeta(raw));
      assert.equal(metaProv.isWithinSessionWindow(tel), true, "el entrante abre la ventana");

      // Y un texto libre ya puede salir.
      const { llamadas, fetchImpl } = fakeMetaFetch([]);
      const prov = new metaProv.MetaCloudWhatsAppProvider(fetchImpl);
      const r = await prov.send(tel, { kind: "text", text: "gracias" });
      assert.equal(r.ok, true);
      assert.equal(llamadas.length, 1);
    });
  });

  await test("VENTANA 24H · frontera exacta: 23h59 dentro, 24h00 y 24h01 fuera", () => {
    const tel = "34600000132";
    const convo = db.getOrCreateConversation(tel);
    const t0 = 1756000000;
    db.systemDbHandle()
      .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'hola', ?)")
      .run(convo.id, t0);
    assert.equal(metaProv.isWithinSessionWindow(tel, t0 + 24 * 3600 - 60), true, "23h59: dentro");
    assert.equal(metaProv.isWithinSessionWindow(tel, t0 + 24 * 3600), false, "24h00 exactas: FUERA (conservador)");
    assert.equal(metaProv.isWithinSessionWindow(tel, t0 + 24 * 3600 + 60), false, "24h01: fuera");
    // Y comprobar la ventana NO crea conversaciones (solo lectura).
    const antes = (db.systemDbHandle().prepare("SELECT COUNT(*) n FROM conversations").get() as { n: number }).n;
    metaProv.isWithinSessionWindow("34999999999");
    const despues = (db.systemDbHandle().prepare("SELECT COUNT(*) n FROM conversations").get() as { n: number }).n;
    assert.equal(despues, antes, "el chequeo es de solo lectura");
  });

  await test("AMBIGUO · timeout tras enviar NO se reintenta (duplicar es peor que perder); DNS caído SÍ", async () => {
    const tel = "34600000131"; // ventana abierta arriba
    await withEnv(META_ENV, async () => {
      const provTimeout = new metaProv.MetaCloudWhatsAppProvider(async () => {
        throw new Error("The operation was aborted due to timeout");
      });
      const rt = await provTimeout.send(tel, { kind: "text", text: "x" });
      assert.equal(rt.ok, false);
      assert.equal(rt.retryable, false, "la petición PUDO llegar a Meta: reenviar duplicaría el WhatsApp");
      assert.match(rt.error ?? "", /ambiguo/);

      const provDns = new metaProv.MetaCloudWhatsAppProvider(async () => {
        throw new Error("getaddrinfo ENOTFOUND graph.facebook.com");
      });
      const rd = await provDns.send(tel, { kind: "text", text: "x" });
      assert.equal(rd.retryable, true, "la petición JAMÁS salió: reintentar es seguro");
    });
  });

  await test("AMBIGUO · HTTP 200 con cuerpo malformado = ENVIADO sin id, jamás reintento", async () => {
    const tel = "34600000131";
    await withEnv(META_ENV, async () => {
      const prov = new metaProv.MetaCloudWhatsAppProvider(
        async () => new Response("<html>no soy json</html>", { status: 200 })
      );
      const r = await prov.send(tel, { kind: "text", text: "x" });
      assert.equal(r.ok, true, "Meta ACEPTÓ: darlo por fallido reenviaría un mensaje ya entregado");
      assert.equal(r.providerMessageId, null, "sin id: los estados no correlarán, que es solo cosmético");
    });
  });

  await test("ESTADOS META · monotonicidad: failed NO pisa un delivered previo (webhook atrasado)", async () => {
    const tel = "34600000133";
    const convo = db.getOrCreateConversation(tel);
    const itemId = db.enqueueOutbox(convo.id, tel, "mensaje entregado");
    db.markOutboxSent(itemId);
    db.setOutboxProviderResult(itemId, "cloud_api", "wamid.mono1");
    await withEnv(META_ENV, () => {
      const rawDel = metaStatusBody({ id: "wamid.mono1", status: "delivered", timestamp: "1756100120", recipient_id: tel });
      metaHook.processMetaWebhook(rawDel, firmaMeta(rawDel));
      const rawFail = metaStatusBody({
        id: "wamid.mono1", status: "failed", timestamp: "1756100121", recipient_id: tel,
        errors: [{ code: 131026, title: "Undeliverable" }],
      });
      metaHook.processMetaWebhook(rawFail, firmaMeta(rawFail));
      const fila = db.getOutboxByProviderMessageId("wamid.mono1")!;
      assert.equal(fila.failed_at, null, "un entregado no puede volverse fallido");
      assert.equal(fila.delivered_at, 1756100120);
    });
  });

  await test("CLOUD OUTBOX · una IMAGEN del panel falla con gracia y motivo, jamás sale como texto vacío", async () => {
    const tel = "34600000134";
    const convo = db.getOrCreateConversation(tel);
    const imgId = db.enqueueOutboxImage(convo.id, tel, "/tmp/no-existe.jpg", "");
    const fakeProv = {
      name: "cloud_api" as const,
      isConfigured: () => true,
      getHealth: () => ({ provider: "cloud_api" as const, configured: true, available: true, detail: "" }),
      markAsRead: async () => {},
      send: async (to: string) => ({ ok: to === tel ? false : true, providerMessageId: "wamid.x", error: "no debería llamarse para la imagen", retryable: false }),
    };
    for (let i = 0; i < 50 && db.getPendingOutbox(500).some((x) => x.id === imgId); i++) {
      await metaOutbox.runCloudOutboxTick(fakeProv);
    }
    const fila = db.systemDbHandle().prepare("SELECT * FROM outbox WHERE id = ?").get(imgId) as {
      sent: number; failed_at: number | null; failure_reason: string | null;
    };
    assert.equal(fila.sent, 1);
    assert.ok(fila.failed_at, "terminal");
    assert.match(fila.failure_reason ?? "", /imagen no soportada/);
  });

  await test("AUDIO CLOUD · queda registrado y visible, no rompe el COD, y el cliente puede seguir por texto", async () => {
    const tel = "34600000135";
    mkMulti("971002", "6002", tel);
    await withEnv(META_ENV, () => {
      const rawAudio = metaInboundBody(
        { from: tel, id: "wamid.audio1", timestamp: "1756100130", type: "audio", audio: { id: "media1" } },
        tel
      );
      const r = metaHook.processMetaWebhook(rawAudio, firmaMeta(rawAudio));
      assert.equal(r.status, 200);
      assert.equal(db.getOrderByShopifyId("971002")!.status, "awaiting_reply", "el pedido no se toca");
      // Registrado en la conversación (y por tanto abre la ventana de 24 h).
      assert.equal(metaProv.isWithinSessionWindow(tel), true, "una nota de voz también abre la ventana");

      // El cliente sigue por texto y todo funciona.
      const rawTxt = metaInboundBody(
        { from: tel, id: "wamid.audio2", timestamp: "1756100131", type: "text", text: { body: "1" } },
        tel
      );
      metaHook.processMetaWebhook(rawTxt, firmaMeta(rawTxt));
      assert.equal(db.getOrderByShopifyId("971002")!.status, "confirmed");
    });
  });

  await test("BOTÓN OBSOLETO · pulsar 'Confirmar' sin pedidos activos: silencio, sin errores ni respuestas raras", async () => {
    const tel = "34600000136"; // sin pedidos
    const raw = metaInboundBody(
      { from: tel, id: "wamid.stale1", timestamp: "1756100140", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "confirm_order", title: "Confirmar" } } },
      tel
    );
    await withEnv(META_ENV, () => {
      const r = metaHook.processMetaWebhook(raw, firmaMeta(raw));
      assert.equal(r.status, 200);
      assert.equal(db.getPendingOutbox(500).filter((x) => x.phone === tel).length, 0, "sin respuesta automática");
    });
  });

  await test("ROLLBACK · el fallback de un interactivo encolado en cloud sale como texto 1/2/3 por Baileys", async () => {
    // Escenario real de rollback: hay filas interactivas pendientes cuando
    // se vuelve a WHATSAPP_PROVIDER=baileys. La política es PROVEEDOR
    // RESUELTO AL ENVIAR: el loop de Baileys no conoce message_type y manda
    // `content` — que es EXACTAMENTE el fallback 1/2/3. Nada se pierde, nada
    // se duplica (el claim es el mismo), y el cliente recibe el flujo viejo.
    const tel = "34600000137";
    const orden = mkMulti("971003", "6003", tel);
    const spec = interactive.buildConfirmationInteractive(db.getOrderById(orden.id)!);
    await withEnv({ WHATSAPP_PROVIDER: "cloud_api" }, () => {
      waTop.sendWhatsAppInteractive(tel, spec);
    });
    const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
    assert.equal(item.message_type, "interactive_buttons", "encolado como interactivo");
    assert.match(item.content, /1 — Confirmar/, "y su content ES el fallback: Baileys lo manda tal cual");
    assert.equal(item.type, "text", "para el loop de Baileys es un texto normal (columna vieja `type`)");
  });

  /** getOrdersDueInitialSend() procesa como mucho 20 por tick (created_at
   *  ASC); a esta altura del fichero puede haber otros pending_send más
   *  viejos sueltos de tests anteriores por delante en la cola. Se repite
   *  el tick hasta que a ESTE pedido concreto le toque, con un tope de
   *  seguridad para no colgarse si algo real se rompe. */
  async function tickHastaQueSalgaDe(orderId: number, estadoInicial: string): Promise<void> {
    for (let i = 0; i < 25; i++) {
      if (db.getOrderById(orderId)!.status !== estadoInicial) return;
      await runSchedulerTick(Math.floor(Date.now() / 1000));
    }
    throw new Error(`el pedido ${orderId} sigue en ${estadoInicial} tras 25 ticks`);
  }

  await test("BOTONES · el scheduler manda la confirmación inicial como interactivo cuando el proveedor activo es cloud_api", async () => {
    const tel = "34600000138";
    // BUG1: dentro de la ventana de 24h (el cliente ya escribió) es cuando
    // corresponde el interactivo — fuera de ventana ahora es una plantilla
    // (ver los tests "BUG1 ·" más abajo, que cubren ese otro caso).
    const convoPrevia = db.getOrCreateConversation(tel, "Cliente Botones");
    db.insertMessage(convoPrevia.id, "user", "hola");
    const o = mkOrder("971101", "6101", tel);
    await withEnv(META_ENV, async () => {
      await tickHastaQueSalgaDe(o.id, "pending_send");
    });
    const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
    assert.equal(item.message_type, "interactive_buttons", "cloud_api: la confirmación inicial sale como interactivo");
    const payload = JSON.parse(item.payload_json!) as {
      kind: string;
      buttons: Array<{ id: string; title: string }>;
    };
    assert.equal(payload.kind, "interactive_buttons");
    assert.deepEqual(
      payload.buttons.map((b) => b.id),
      [confirmMod.BUTTON_PAYLOADS.CONFIRM, confirmMod.BUTTON_PAYLOADS.CHANGE_ADDRESS, confirmMod.BUTTON_PAYLOADS.DELIVERY_NOTE],
      "los tres botones, en los payloads deterministas que interpreta handleOrderButtonReply"
    );
    assert.match(
      item.content,
      /1 — Confirmar/,
      "el fallback (panel / rollback) es el de buildConfirmationInteractive, no el texto plano de messages.ts"
    );
  });

  await test("BOTONES · con Baileys (proveedor por defecto) la confirmación inicial sigue en texto plano — sin regresión", async () => {
    const tel = "34600000139";
    const o = mkOrder("971102", "6102", tel);
    await tickHastaQueSalgaDe(o.id, "pending_send"); // sin WHATSAPP_PROVIDER: default baileys
    const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
    assert.equal(item.message_type, "text", "baileys: sigue siendo texto plano, exactamente como antes de este cambio");
    assert.equal(item.payload_json, null, "sin payload interactivo para Baileys — nada nuevo que interpretar");
    assert.match(item.content, /1 - Todo correcto/);
  });

  await test("COEXISTENCIA · los ECOS del móvil de Pedro jamás disparan el flujo: sin bucles posibles", async () => {
    // Pregunta abierta de Pedro (CONTEXTO-2026-08-25 §6.2): al activar
    // coexistencia llegarán smb_message_echoes (lo que el negocio escribe
    // desde el móvil). DOS capas impiden el bucle:
    //  1. El parser descarta ENTERO cualquier campo que no sea "messages".
    const eco = metaIn.parseMetaWebhookPayload({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ from: "34641308254", id: "wamid.echo1", type: "text", text: { body: "respuesta manual de Pedro" } }] } }] }],
    });
    assert.equal(eco.messages.length, 0, "un eco no produce NINGÚN mensaje entrante");
    for (const campo of ["smb_app_state_sync", "history"]) {
      const otro = metaIn.parseMetaWebhookPayload({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: campo, value: { messages: [{ from: "34600000140", id: "wamid.x", type: "text", text: { body: "1" } }] } }] }],
      });
      assert.equal(otro.messages.length, 0, `${campo} se descarta entero`);
    }

    //  2. Y aunque un eco llegara disfrazado dentro de "messages" con el
    //     número del PROPIO negocio como remitente: ese número no tiene
    //     pedidos activos → handled=false → silencio, cero respuestas.
    const raw = metaInboundBody(
      { from: "34641308254", id: "wamid.echo2", timestamp: "1756100200", type: "text", text: { body: "todo correcto" } },
      "34641308254"
    );
    await withEnv(META_ENV, () => {
      const r = metaHook.processMetaWebhook(raw, firmaMeta(raw));
      assert.equal(r.status, 200);
      assert.equal(db.getPendingOutbox(500).filter((x) => x.phone === "34641308254").length, 0, "cero auto-respuestas al propio número");
    });
  });

  await test("PLANTILLAS · el estado (APPROVED/REJECTED) llega al feed de eventos, con el rechazo como warning", async () => {
    // Antes se descartaba en silencio: la única forma de saber si la
    // plantilla del piloto se aprobó era mirar WhatsApp Manager a mano.
    const cuerpo = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [
        { field: "message_template_status_update", value: { message_template_name: "order_confirmation_request", event: "APPROVED" } },
        { field: "message_template_status_update", value: { message_template_name: "order_reminder", event: "REJECTED", reason: "INVALID_FORMAT" } },
      ] }],
    });
    await withEnv(META_ENV, () => {
      const r = metaHook.processMetaWebhook(cuerpo, firmaMeta(cuerpo));
      assert.equal(r.status, 200);
      const evs = sysRepo.listIntegrationEvents({ integration: "whatsapp", limit: 100 });
      const aprobada = evs.find((e) => e.event_type === "meta_template_status" && /order_confirmation_request.*APPROVED/.test(e.message));
      const rechazada = evs.find((e) => e.event_type === "meta_template_status" && /order_reminder.*REJECTED/.test(e.message));
      assert.ok(aprobada, "la aprobación se ve en el panel");
      assert.equal(aprobada!.severity, "info");
      assert.ok(rechazada, "el rechazo también, con su motivo");
      assert.equal(rechazada!.severity, "warning", "un rechazo bloquea mensajes fuera de ventana: warning");
      assert.match(rechazada!.message, /INVALID_FORMAT/);
    });
  });

  await test("BUG1 · scheduler de punta a punta: pedido nuevo en cloud_api (nunca escribió, fuera de ventana) sale como PLANTILLA, no falla con outside_24h_window", async () => {
    const tel = "34600177601"; // nunca escribió a este número: fuera de ventana por definición
    const o = mkOrder("972601", "7601", tel);
    await withEnv(META_ENV, async () => {
      await tickHastaQueSalgaDe(o.id, "pending_send");
    });
    const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
    assert.equal(item.message_type, "template", "el bug real: antes esto salía como interactive_buttons y fallaba terminal");
    assert.equal(item.template_name, "confirmacion_pedido_cod", "V3: el nombre REAL de la WABA");
    assert.equal(item.failure_reason, null, "no debe fallar — es justo el caso que BUG1 arregla");
    const payload = JSON.parse(item.payload_json!) as { kind: string; buttonPayloads?: string[] };
    assert.equal(payload.kind, "template");
    assert.deepEqual(payload.buttonPayloads, [
      confirmMod.BUTTON_PAYLOADS.CONFIRM,
      confirmMod.BUTTON_PAYLOADS.CHANGE_ADDRESS,
      confirmMod.BUTTON_PAYLOADS.DELIVERY_NOTE,
    ]);
  });

  await test("BUG1 · scheduler: si el cliente YA escribió (dentro de ventana), sigue mandando el interactivo normal — no gasta plantilla de más", async () => {
    const tel = "34600177602";
    const convo = db.getOrCreateConversation(tel, "Cliente Ventana");
    db.insertMessage(convo.id, "user", "hola, ya he escrito antes"); // abre la ventana
    const o = mkOrder("972602", "7602", tel);
    await withEnv(META_ENV, async () => {
      await tickHastaQueSalgaDe(o.id, "pending_send");
    });
    const item = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!;
    assert.equal(item.message_type, "interactive_buttons", "dentro de ventana: interactivo normal, la plantilla se cobra y aquí no hace falta");
    assert.equal(item.template_name, null);
  });

  await test("T1 · degradación EN ENVÍO: la ventana caduca con la fila en cola → sale la plantilla y la DB dice la verdad", async () => {
    const tel = "34600177610";
    const convo = db.getOrCreateConversation(tel, "Cliente Caducado");
    db.insertMessage(convo.id, "user", "hola"); // dentro de ventana AL ENCOLAR

    const orden = mkMulti("972610", "7610", tel);
    const spec = interactive.buildConfirmationOutbound(db.getOrderById(orden.id)!, true);
    assert.equal(spec.message.kind, "interactive_buttons", "dentro de ventana: se encola interactivo");
    assert.ok(spec.templateFallback, "con su plantilla equivalente adjunta");
    let itemId = 0;
    await withEnv({ WHATSAPP_PROVIDER: "cloud_api" }, () => {
      waTop.sendWhatsAppInteractive(tel, spec);
      itemId = db.getPendingOutbox(500).filter((x) => x.phone === tel).pop()!.id;
    });

    // El provider falso: el interactivo muere por ventana; la plantilla sale.
    const enviados: string[] = [];
    const prov = {
      name: "cloud_api" as const,
      isConfigured: () => true,
      getHealth: () => ({ provider: "cloud_api" as const, configured: true, available: true, detail: "" }),
      markAsRead: async () => {},
      send: async (to: string, m: import("../src/lib/whatsapp/provider").OutboundWhatsAppMessage) => {
        if (to !== tel) return { ok: true, providerMessageId: `wamid.ajenoT1.${enviados.length}` };
        enviados.push(m.kind);
        if (m.kind === "template") return { ok: true, providerMessageId: "wamid.degradado1" };
        return { ok: false, providerMessageId: null, error: "outside_24h_window: sesión caducada", retryable: false };
      },
    };
    for (let i = 0; i < 50 && db.getPendingOutbox(500).some((x) => x.id === itemId); i++) {
      await metaOutbox.runCloudOutboxTick(prov);
    }

    assert.deepEqual(enviados, ["interactive_buttons", "template"], "un intento interactivo, luego LA plantilla — jamás dos mensajes al cliente");
    const fila = db.systemDbHandle().prepare("SELECT * FROM outbox WHERE id = ?").get(itemId) as {
      sent: number; message_type: string; template_name: string | null; provider_message_id: string | null;
      failure_reason: string | null; failed_at: number | null;
    };
    assert.equal(fila.sent, 1);
    assert.equal(fila.message_type, "template", "la DB dice lo que salió DE VERDAD, no lo que se encoló");
    assert.equal(fila.template_name, "confirmacion_pedido_cod");
    assert.equal(fila.provider_message_id, "wamid.degradado1");
    assert.match(fila.failure_reason ?? "", /fallback_reason=outside_24h_window/, "la degradación queda auditada");
    assert.equal(fila.failed_at, null, "degradado con éxito NO es un fallo");
  });

  await test("META · normalización: interactivos, plantilla-botón, audio e imagen salen tipados", () => {
    const parsed = metaIn.parseMetaWebhookPayload(JSON.parse(metaInboundBody(
      { from: "34600000123", id: "wamid.n1", timestamp: "1756100080", type: "button", button: { payload: "confirm_order", text: "Confirmar" } },
      "34600000123"
    )));
    assert.equal(parsed.messages[0].kind, "button_reply", "el botón de PLANTILLA también es button_reply");
    assert.equal(parsed.messages[0].payload, "confirm_order");

    const audio = metaIn.parseMetaWebhookPayload(JSON.parse(metaInboundBody(
      { from: "34600000123", id: "wamid.n2", timestamp: "1756100081", type: "audio", audio: {} },
      "34600000123"
    )));
    assert.equal(audio.messages[0].kind, "audio");

    const raro = metaIn.parseMetaWebhookPayload(JSON.parse(metaInboundBody(
      { from: "34600000123", id: "wamid.n3", timestamp: "1756100082", type: "sticker" },
      "34600000123"
    )));
    assert.equal(raro.messages[0].kind, "unknown", "lo no reconocido es visible, no descartado en silencio");
    assert.equal(metaIn.parseMetaWebhookPayload({ object: "otra_cosa" }).messages.length, 0);
  });

  await test("META · builders: límites de Meta respetados en los mensajes reales de Casamable", () => {
    const tel = "34600000124";
    const o1 = mkMulti("970109", "5009", tel, { product_summary: "Cortaúñas y Pulidor Eléctrico 3 en 1 Profesional" });
    const o2 = mkMulti("970110", "5010", tel, { product_summary: "Espejo Retrovisor" });

    const conf = interactive.buildConfirmationInteractive(db.getOrderById(o1.id)!);
    assert.equal(metaProv.validateOutbound(conf.message), null, "la confirmación pasa los límites");
    assert.match(conf.fallbackText, /1 — Confirmar/, "el fallback ES el flujo 1/2/3");

    const lista = interactive.buildOrderSelectionList([db.getOrderById(o1.id)!, db.getOrderById(o2.id)!]);
    assert.equal(metaProv.validateOutbound(lista.message), null, "la lista pasa los límites (título ≤24, desc ≤72)");
    if (lista.message.kind === "interactive_list") {
      assert.equal(lista.message.rows[0].id, "select_order:5009", "payload determinista, no texto visible");
    }
  });

  await test("T3 · el panel ordena por ordered_at (fecha REAL de compra), no por cuándo se importó", () => {
    // Un backfill importa HOY un pedido comprado hace días: debe aparecer
    // DEBAJO de los comprados ayer, aunque su fila sea la más nueva.
    const tel = "34600177620";
    const viejoComprado = mkMulti("972620", "9620", tel);   // comprado hace 5 días, importado ahora
    const nuevoComprado = mkMulti("972621", "9621", tel);   // comprado hace 1 hora
    const ahora = Math.floor(Date.now() / 1000);
    db.systemDbHandle().prepare("UPDATE orders SET ordered_at = ? WHERE id = ?").run(ahora - 5 * 86400, viejoComprado.id);
    db.systemDbHandle().prepare("UPDATE orders SET ordered_at = ? WHERE id = ?").run(ahora - 3600, nuevoComprado.id);

    const mios = new Set([viejoComprado.id, nuevoComprado.id]);
    const orden = db.listOrders(undefined, 2000).filter((o) => mios.has(o.id)).map((o) => o.shopify_order_number);
    assert.deepEqual(orden, ["9621", "9620"], "manda la fecha de compra, no la de import");
  });

  // ============ 58 · Cierre 26-08: llamadas fail-closed, validador, salud ============
  console.log("\n— Cierre: llamadas fail-closed y validador de prompt —");

  const promptVal = await import("../src/lib/calls/prompt-validator");
  const callsCfg58 = await import("../src/lib/calls/config");

  await test("CALLS · FAIL-CLOSED con interruptor PROPIO: en piloto (default) allowlist vacía = NADIE; TEST_MODE ya NO pinta nada aquí", async () => {
    // La trampa real: CALLS_ALLOWLIST vacía significaba "sin restricción" —
    // lo contrario que TEST_PHONE_ALLOWLIST. Abrir el kill switch con la
    // lista sin rellenar habría llamado a TODOS los clientes.
    // Piloto por DEFECTO (calls_pilot_mode sin definir): vacía = nadie.
    await withEnv({ CALLS_ALLOWLIST: "", CALLS_PILOT_MODE: undefined }, () => {
      assert.equal(callsCfg58.callsPilotMode(), true, "sin definir = piloto ACTIVO (fail-closed)");
      assert.equal(callsCfg58.callAllowedByAllowlist("34600000001"), false, "en piloto, vacía = NADIE");
    });
    // DESACOPLE (decisión 26-08 noche): TEST_MODE ya no gobierna las
    // llamadas. Con TEST_MODE=0 y piloto activo, vacía SIGUE bloqueando
    // (antes se abría); y con TEST_MODE=1 y piloto=0, vacía NO bloquea
    // (antes bloqueaba). Cambiar TEST_MODE para tocar llamadas movía
    // cinco sistemas a la vez.
    await withEnv({ TEST_MODE: "0", CALLS_ALLOWLIST: "", CALLS_PILOT_MODE: undefined }, () => {
      assert.equal(callsCfg58.callAllowedByAllowlist("34600000001"), false, "TEST_MODE=0 ya no abre las llamadas");
    });
    await withEnv({ TEST_MODE: "1", CALLS_ALLOWLIST: "", CALLS_PILOT_MODE: "0" }, () => {
      assert.equal(callsCfg58.callAllowedByAllowlist("34600000001"), true, "producción de llamadas EXPLÍCITA: vacía = sin restricción, aunque TEST_MODE=1");
    });
    // Con allowlist rellena, restringe SIEMPRE, en piloto o fuera de él.
    await withEnv({ CALLS_ALLOWLIST: "34600000001", CALLS_PILOT_MODE: "0" }, () => {
      assert.equal(callsCfg58.callAllowedByAllowlist("34600000001"), true, "el permitido pasa");
      assert.equal(callsCfg58.callAllowedByAllowlist("34600000002"), false, "el resto no, ni en producción");
    });
    // Prioridad settings sobre env (cambiable sin desplegar, como el resto
    // de llaves de llamadas): el setting gana a la variable.
    await withEnv({ CALLS_ALLOWLIST: "", CALLS_PILOT_MODE: "1" }, () => {
      db.setSetting("calls_pilot_mode", "0");
      try {
        assert.equal(callsCfg58.callAllowedByAllowlist("34600000009"), true, "settings.calls_pilot_mode=0 gana al env");
      } finally {
        db.setSetting("calls_pilot_mode", "");
      }
    });
  });

  await test("PROMPT · el validador caza exactamente los fallos del incidente v5", () => {
    const v5malo =
      "Hola {{nombre_cliente}}, tu pedido {{numero_pedido | digito a digito}} de {{producto_inventado}} " +
      "llegará a {direccion} el [fecha_entrega].";
    const r = promptVal.validatePromptPlaceholders(v5malo);
    assert.equal(r.ok, false);
    const kinds = r.issues.map((i) => i.kind).sort();
    assert.ok(kinds.includes("template_filter"), "el '| dígito a dígito' que el agente leyó en voz alta");
    assert.ok(kinds.includes("unknown_placeholder"), "variable fuera del contrato");
    assert.ok(kinds.includes("single_brace"), "{direccion} con una llave no se sustituye");
    assert.ok(kinds.includes("bracket_placeholder"), "[fecha_entrega] se leería tal cual");
    assert.deepEqual(r.used, ["nombre_cliente"], "solo la válida cuenta como usada");

    const v6bueno =
      "Hola {{nombre_cliente}}, llamo de Casamable por tu pedido {{numero_pedido}}: " +
      "{{unidades}} de {{producto}} por {{importe_total}}, a entregar en {{direccion}}, {{localidad}}, " +
      "código postal {{codigo_postal}}.";
    assert.equal(promptVal.validatePromptPlaceholders(v6bueno).ok, true);
  });

  await test("PROMPT · contrato sincronizado: las variables del validador SON las de payload.ts", async () => {
    // Si alguien añade una variable al payload sin tocar el validador (o al
    // revés), esto falla y el desfase se ve aquí, no en una llamada real.
    // Hardening 03-09: la fuente de verdad es el export tipado
    // RETELL_CALL_VARIABLE_KEYS de payload.ts; el validador lo importa.
    const { RETELL_CALL_VARIABLE_KEYS } = await import("../src/lib/calls/payload");
    const delPayload = [...RETELL_CALL_VARIABLE_KEYS].sort();
    const delValidador = [...promptVal.ALLOWED_PROMPT_VARIABLES].sort();
    assert.deepEqual(delValidador, delPayload, "payload.ts y prompt-validator.ts deben declarar LAS MISMAS variables");
  });

  await test("CALLS HEALTH · dice la verdad: kill switch, allowlist del piloto y saldo no comprobable", async () => {
    const H = await import("../src/lib/system/health-integrations");
    // Los tests de E7 pueden dejar ajustes en `settings` (tienen prioridad
    // sobre el env): se fija el estado de partida explícitamente.
    db.setSetting("ai_calls_enabled", "0");
    db.setSetting("calls_shadow_mode", "1");
    db.setSetting("calls_allowlist", "");
    const h1 = H.getCallsHealth();
    assert.equal(h1.enabled, false, "defaults: apagadas");
    assert.equal(h1.status, "healthy", "apagado a propósito es sano, no un fallo");
    assert.equal(h1.paymentStatus, "unknown_manual_check_required", "jamás un healthy falso sobre el saldo");

    // Encendidas sin allowlist en modo prueba → warning: el fail-closed está
    // bloqueando todo y hay que decirlo, no dejar que parezca que funciona.
    await withEnv({ TEST_MODE: "1" }, () => {
      db.setSetting("ai_calls_enabled", "1");
      const h2 = H.getCallsHealth();
      assert.equal(h2.status, "warning");
      assert.match(h2.message, /fail-closed|allowlist/i);
      db.setSetting("ai_calls_enabled", "0"); // dejarlo como estaba
    });
  });

  await test("CALLS HEALTH · bloqueo global y EMERGENCY_STOP se ven (critical / warning), y el pin solo cuenta si es numérico", async () => {
    const H = await import("../src/lib/system/health-integrations");
    const cfg = await import("../src/lib/calls/config");
    db.setSetting("ai_calls_enabled", "0");
    db.setSetting("calls_shadow_mode", "1");
    db.setSetting("calls_allowlist", "");
    try {
      cfg.setCallsBlocked("auth: Retell HTTP 401");
      const h = H.getCallsHealth();
      assert.equal(h.status, "critical", "bloqueo global = crítico aunque el kill switch esté cerrado (bloquea también las manuales)");
      assert.equal(h.blockedReason, "auth: Retell HTTP 401");
      assert.match(h.message, /BLOQUEADAS/);
      assert.match(h.message, /--unblock/);
      cfg.clearCallsBlocked();
      assert.equal(H.getCallsHealth().blockedReason, null);
      // EMERGENCY_STOP con las llamadas encendidas: aviso, no verde.
      await withEnv({ EMERGENCY_STOP: "1", CALLS_PILOT_MODE: "0" }, () => {
        db.setSetting("ai_calls_enabled", "1");
        db.setSetting("calls_allowlist", "34600000001");
        const h2 = H.getCallsHealth();
        assert.equal(h2.killSwitchActive, true);
        assert.equal(h2.status, "warning");
        assert.match(h2.message, /EMERGENCY_STOP/);
        db.setSetting("ai_calls_enabled", "0");
      });
      // Contadores de observabilidad: una deriva registrada cuenta.
      const { logIntegrationEvent } = await import("../src/lib/system/repo");
      const antes = H.getCallsHealth().driftEvents24h;
      logIntegrationEvent("system", "call_agent_version_drift", "critical", "prueba de contador", "0");
      assert.equal(H.getCallsHealth().driftEvents24h, antes + 1);
      // Pin: "latest_published" NO es un pin.
      await withEnv({ RETELL_AGENT_VERSION: "latest_published" }, () => assert.equal(H.getCallsHealth().agentVersionPinned, false));
      await withEnv({ RETELL_AGENT_VERSION: "7" }, () => assert.equal(H.getCallsHealth().agentVersionPinned, true));
      await withEnv({ RETELL_AGENT_VERSION: "" }, () => assert.equal(H.getCallsHealth().agentVersionPinned, false));
    } finally {
      cfg.clearCallsBlocked();
      db.setSetting("ai_calls_enabled", "0");
      db.setSetting("calls_allowlist", "");
    }
  });

  await test("API · cuerpos malformados devuelven 400 con motivo, nunca 500 (mode, messages, image)", async () => {
    const conv = db.getOrCreateConversation("34600000777", "Cuerpo Roto");
    const ctx = { params: Promise.resolve({ conversationId: String(conv.id) }) };
    const { POST: postMode } = await import("../src/app/api/mode/[conversationId]/route");
    const { POST: postMsg } = await import("../src/app/api/messages/[conversationId]/route");
    const { POST: postImg } = await import("../src/app/api/messages/[conversationId]/image/route");
    process.env.DASHBOARD_PASSWORD = "test-owner-password";
    const mk = (body: string, type = "application/json") =>
      new Request("http://localhost/x", { method: "POST", body, headers: { "content-type": type, authorization: `Basic ${Buffer.from("owner:test-owner-password").toString("base64")}` } }) as unknown as import("next/server").NextRequest;
    for (const cuerpo of ["{no es json", "", "\u0000", "[1,2", "{\"mode\": "]) {
      const r1 = await postMode(mk(cuerpo), ctx);
      assert.equal(r1.status, 400, `mode: "${cuerpo.slice(0, 10)}" → 400`);
      const r2 = await postMsg(mk(cuerpo), ctx);
      assert.equal(r2.status, 400, `messages: "${cuerpo.slice(0, 10)}" → 400`);
    }
    // JSON válido pero sin la forma esperada: tampoco revienta.
    assert.equal((await postMode(mk("null"), ctx)).status, 400);
    assert.equal((await postMsg(mk("null"), ctx)).status, 400);
    assert.equal((await postMsg(mk("{\"content\": 42}"), ctx)).status, 400);
    // Imagen: un cuerpo que no es multipart → 400, no 500.
    const r3 = await postImg(mk("esto no es multipart", "text/plain"), ctx);
    assert.equal(r3.status, 400);
    assert.equal(db.getMessages(conv.id, 10).length, 0, "ningún mensaje se coló con cuerpos rotos");
  });

  await test("DROPI · diagnóstico de vendor: caza exactamente el fallo real del 23-08", () => {
    const diag = require("../src/lib/suppliers/dropi/diagnostics") as typeof import("../src/lib/suppliers/dropi/diagnostics");
    // El caso real: vendor "Casamable" cuando la app exige "Dropi PRO".
    const roto = diag.diagnoseProductVendor({
      id: 1, title: "Limpiador Ultrasónico", vendor: "Casamable",
      variants: [{ sku: "LIMPIADOR-24800" }],
    });
    assert.equal(roto.vendorOk, false);
    assert.equal(roto.vendorEsperado, "Dropi PRO");

    const bien = diag.diagnoseProductVendor({
      id: 2, title: "Limpiador", vendor: "Dropi PRO",
      variants: [{ sku: "LIMPIADOR-24800" }, { sku: "" }],
    });
    assert.equal(bien.vendorOk, true);
    assert.equal(bien.variantsSinSku, 1, "y además cuenta variantes sin SKU");
  });

  await test("DROPI · sku=null: distingue los cuatro casos en vez de encogerse de hombros", () => {
    const diag = require("../src/lib/suppliers/dropi/diagnostics") as typeof import("../src/lib/suppliers/dropi/diagnostics");
    const pedido = (lineas: unknown[]) => ({ raw_payload: JSON.stringify({ line_items: lineas }) });

    // Campo ausente vs vacío vs presente: en NUESTRA tabla los tres acaban
    // igual (el parser hace trim||null) — el crudo es la única forma de saber.
    const d = diag.diagnoseSkuNull(pedido([
      { title: "Sin campo", product_id: 1, variant_id: 2 },
      { title: "Vacío", product_id: 1, variant_id: 3, sku: "" },
      { title: "Con SKU", product_id: 1, variant_id: 4, sku: "10428" },
      { title: "Seguro de Envío" },
    ]));
    assert.equal(d[0].cause, "sku_field_absent");
    assert.equal(d[1].cause, "variant_sku_empty");
    assert.match(d[1].detail, /ficha del producto/, "dice DÓNDE se arregla");
    assert.equal(d[2].cause, "sku_present_parser_dropped");
    assert.equal(d[3].cause, "service_line_expected", "el seguro sin SKU es lo normal, no un problema");

    assert.equal(diag.diagnoseSkuNull({ raw_payload: null })[0].cause, "no_payload");
  });

  await test("DROPI · el diagnóstico es SOLO lectura: ni un solo UPDATE ni llamada de escritura", () => {
    for (const rel of ["src/lib/suppliers/dropi/diagnostics.ts", "scripts/dropi-diagnose.ts"]) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const pat of [/\bUPDATE\b/i, /\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i, /method:\s*["'](POST|PUT|PATCH|DELETE)/i, /sendWhatsAppMessage/]) {
        assert.ok(!pat.test(src), `${rel} no debe contener ${pat}`);
      }
    }
  });

  // ============ 59 · Entorno local: schema, perfiles y redacción ============
  console.log("\n— Entorno local: env schema y doctor —");

  const envSchema = await import("../src/lib/config/env-schema");

  /** Entorno sintético SIN heredar el real (los tests no dependen del Mac). */
  const entorno = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

  await test("ENV · local-safe: sin credenciales reales está VERDE (se puede trabajar sin nada)", () => {
    const a = envSchema.auditEnvironment("local-safe", entorno({ TEST_MODE: "1" }));
    assert.equal(a.ready, true, "cero credenciales = listo para desarrollo local");
    assert.deepEqual(a.missingRequired, []);
  });

  await test("ENV · local-safe grita ante producción encendida en el Mac", () => {
    const a = envSchema.auditEnvironment("local-safe", entorno({ APP_MODE: "production", TEST_MODE: "0" }));
    assert.equal(a.ready, false);
    assert.ok(a.dangers.some((d) => d.startsWith("🚨")), "combinación peligrosa detectada y gritada");
    // Y los interruptores de efectos reales encendidos también avisan.
    const b = envSchema.auditEnvironment("local-safe", entorno({ TEST_MODE: "1", WHATSAPP_SEND_ENABLED: "1", SHOPIFY_WRITE_ENABLED: "1" }));
    assert.ok(b.missingRequired.includes("WHATSAPP_SEND_ENABLED"), "local-safe exige envíos apagados");
  });

  await test("ENV · cloud-pilot: exige credenciales Meta, provider, TEST_MODE y allowlist NO vacía", () => {
    const sinNada = envSchema.auditEnvironment("whatsapp-cloud-pilot", entorno({}));
    assert.equal(sinNada.ready, false);
    for (const v of ["META_WHATSAPP_ACCESS_TOKEN", "META_WHATSAPP_APP_SECRET", "META_WHATSAPP_PHONE_NUMBER_ID", "TEST_PHONE_ALLOWLIST", "WHATSAPP_PROVIDER"]) {
      assert.ok(sinNada.missingRequired.includes(v), `${v} debe faltar`);
    }
    // TEST_MODE sin definir NO falta: el código lo trata como ACTIVO
    // (safety.ts, !== "0") y el schema refleja esa semántica. Lo que sí se
    // señala es un 0 EXPLÍCITO, que es la única forma de apagarlo.
    assert.equal(sinNada.missingRequired.includes("TEST_MODE"), false, "sin definir = activo = válido para el piloto");
    const apagado = envSchema.auditEnvironment("whatsapp-cloud-pilot", entorno({ TEST_MODE: "0" }));
    assert.ok(apagado.missingRequired.includes("TEST_MODE"), "TEST_MODE=0 explícito sí se rechaza en el piloto");
    const completo = envSchema.auditEnvironment("whatsapp-cloud-pilot", entorno({
      WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_API_ENABLED: "1", TEST_MODE: "1",
      TEST_PHONE_ALLOWLIST: "34600000001", META_WHATSAPP_PHONE_NUMBER_ID: "12345",
      META_WHATSAPP_BUSINESS_ACCOUNT_ID: "6789", META_WHATSAPP_ACCESS_TOKEN: "x",
      META_WHATSAPP_APP_SECRET: "x", META_WHATSAPP_VERIFY_TOKEN: "x",
      APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1",
    }));
    assert.equal(completo.ready, true, "con todo puesto, verde");
  });

  await test("ENV · retell-pilot: allowlist vacía = FAIL con el aviso de no activar ai_calls_enabled", () => {
    const a = envSchema.auditEnvironment("retell-pilot", entorno({
      RETELL_API_KEY: "x", RETELL_AGENT_ID: "agent_x", RETELL_FROM_NUMBER: "+34950835615", TEST_MODE: "1",
    }));
    assert.equal(a.ready, false);
    assert.ok(a.missingRequired.includes("CALLS_ALLOWLIST"));
    assert.ok(a.dangers.some((d) => /NO ACTIVES ai_calls_enabled/.test(d)));
  });

  await test("ENV · shopify-readonly: acepta token estático O client_id+secret, y exige writes apagados", () => {
    const conToken = envSchema.auditEnvironment("shopify-readonly", entorno({
      SHOPIFY_STORE_DOMAIN: "tienda.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "x", SHOPIFY_WRITE_ENABLED: "0", TEST_MODE: "1",
    }));
    assert.equal(conToken.ready, true, "el token estático basta");
    const conPar = envSchema.auditEnvironment("shopify-readonly", entorno({
      SHOPIFY_STORE_DOMAIN: "tienda.myshopify.com", SHOPIFY_CLIENT_ID: "x", SHOPIFY_CLIENT_SECRET: "y", TEST_MODE: "1",
    }));
    assert.equal(conPar.ready, true, "el par client_id+secret también");
    const sinCreds = envSchema.auditEnvironment("shopify-readonly", entorno({ SHOPIFY_STORE_DOMAIN: "tienda.myshopify.com", TEST_MODE: "1" }));
    assert.equal(sinCreds.ready, false, "sin ninguna de las dos vías, no");
    const conWrites = envSchema.auditEnvironment("shopify-readonly", entorno({
      SHOPIFY_STORE_DOMAIN: "tienda.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "x", SHOPIFY_WRITE_ENABLED: "1", TEST_MODE: "1",
    }));
    assert.equal(conWrites.ready, false, "readonly con writes encendidos NO es readonly");
  });

  await test("ENV · Dropi NO es requisito de nada, y rellenarla es un ERROR señalado", () => {
    for (const perfil of ["local-safe", "shopify-readonly", "whatsapp-cloud-pilot", "retell-pilot"] as const) {
      const a = envSchema.auditEnvironment(perfil, entorno({ TEST_MODE: "1" }));
      assert.equal(a.missingRequired.some((v) => v.startsWith("DROPIPRO")), false, `${perfil} no pide nada de Dropi`);
    }
    const rellenada = envSchema.auditEnvironment("local-safe", entorno({ TEST_MODE: "1", DROPIPRO_API_KEY: "algo" }));
    const item = rellenada.items.find((i) => i.spec.name === "DROPIPRO_API_KEY")!;
    assert.equal(item.state, "invalid", "no existe API que la use: rellenarla es un error, no un logro");
  });

  await test("ENV · REDACCIÓN: un secreto configurado JAMÁS expone su valor en la auditoría", () => {
    const a = envSchema.auditEnvironment("whatsapp-cloud-pilot", entorno({
      META_WHATSAPP_ACCESS_TOKEN: "EAA-VALOR-QUE-NO-PUEDE-SALIR",
      RETELL_API_KEY: "key_VALOR-QUE-NO-PUEDE-SALIR",
    }));
    const serializado = JSON.stringify(a);
    assert.equal(serializado.includes("QUE-NO-PUEDE-SALIR"), false, "el valor de un secreto no aparece NI EN LA ESTRUCTURA");
    const token = a.items.find((i) => i.spec.name === "META_WHATSAPP_ACCESS_TOKEN")!;
    assert.equal(token.shownValue, null, "shownValue de un secreto es SIEMPRE null");
  });

  await test("ENV · placeholders y typos: 'changeme' cuenta como vacío y un enum inválido no pasa en silencio", () => {
    const conPlaceholder = envSchema.auditEnvironment("whatsapp-cloud-pilot", entorno({
      WHATSAPP_PROVIDER: "cloud_api", TEST_MODE: "1",
      META_WHATSAPP_ACCESS_TOKEN: "changeme",
    }));
    assert.ok(conPlaceholder.missingRequired.includes("META_WHATSAPP_ACCESS_TOKEN"), "'changeme' NO es una credencial");

    const typo = envSchema.auditEnvironment("local-safe", entorno({ TEST_MODE: "1", WHATSAPP_PROVIDER: "cloudapi" }));
    const item = typo.items.find((i) => i.spec.name === "WHATSAPP_PROVIDER")!;
    assert.equal(item.state, "invalid", "un typo en el enum se señala, jamás pasa en silencio");
    assert.match(item.problem ?? "", /baileys \| cloud_api/);
  });

  await test("ENV · .env.local está ignorado por Git (el archivo de secretos no puede versionarse)", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync("git check-ignore .env.local || true", { encoding: "utf8", cwd: process.cwd() }).trim();
    assert.equal(out, ".env.local");
  });

  await test("ENV · env:init nunca sobrescribe un .env.local existente", () => {
    // Se prueba la LÓGICA en un directorio temporal, no el .env.local real.
    const os = require("node:os") as typeof import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envinit-"));
    try {
      fs.writeFileSync(path.join(dir, ".env.example"), "VARIABLE=\n");
      fs.writeFileSync(path.join(dir, ".env.local"), "MI_SECRETO_YA_PEGADO=x\n");
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      execSync(`npx tsx ${path.join(process.cwd(), "scripts/env-init.ts")}`, { cwd: dir, encoding: "utf8" });
      assert.equal(
        fs.readFileSync(path.join(dir, ".env.local"), "utf8"),
        "MI_SECRETO_YA_PEGADO=x\n",
        "el archivo con secretos pegados NO se toca"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("ENV · seguridad de la DB local: las rutas de NAS se reconocen como peligrosas", () => {
    // La misma regla que usan local:doctor y local:reset.
    const sospechosas = ["/volume1/docker/CasamableAgent/repo/data", "/app/data", "./nas-data/data"];
    const buenas = [path.resolve(process.cwd(), "data"), "/Users/oliver/proyecto/data"];
    const esNas = (p: string) => /\/volume1\/|\/app\/data|nas-data/.test(p);
    for (const p of sospechosas) assert.equal(esNas(p), true, p);
    for (const p of buenas) assert.equal(esNas(p), false, p);
  });

  // ============ 44 · PRUEBA DE REALIDAD FINAL (flujo completo) ============
  console.log("· Prueba de realidad — ciclo de vida completo");

  await test("REALIDAD: pedido COD → WhatsApp → 15 min → MANUAL-ONLY (hotfix NAS 30-08): jamás llama sola → confirma por WhatsApp → fulfillment → cero contactos más", async () => {
    const tel = "34600117900";
    // 1. Pedido nuevo, WhatsApp de confirmación enviado hace 20 min sin respuesta.
    //    Antes del hotfix del 30-08 esto habría entrado en cola y Retell
    //    (mock) habría marcado — MANUAL-ONLY lo desactivó a propósito:
    //    runCallOrchestratorTick sigue procesando resultados/revisiones,
    //    pero enqueueDueOrders/dialDueAttempts están fijados a cero. Solo el
    //    botón "Llamar ahora" del panel (manualDialOrder) puede iniciar una
    //    llamada ahora.
    const o = mkCallable("997900", "4900", tel, 20);
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    db.setSetting("calls_daily_cap", "500");

    const { provider, created } = mkProvider();
    await calls.runCallOrchestratorTick({ now: enFranja, provider, isHoliday: noHoliday });
    assert.equal(created.length, 0, "MANUAL-ONLY: cero llamadas automáticas, aunque el pedido sea elegible");
    assert.equal(db.getActiveCallAttemptForOrder(o.id), null);

    // 2. El resto del ciclo no depende de llamadas y sigue igual: el
    //    cliente confirma por WhatsApp, Shopify marca fulfillment (E2)
    //    — closure in_progress, JAMÁS delivered — y sigue sin haber
    //    ningún contacto (automático ni manual).
    db.markOrderConfirmed(o.id, true);
    const despues = new Date(enFranja.getTime() + 3600_000);
    assert.ok(db.setOrderClosure(o.id, "in_progress", "shopify", Math.floor(despues.getTime() / 1000) - 3540));
    const fila = db.getOrderById(o.id)!;
    assert.equal(fila.closure_status, "in_progress");
    assert.notEqual(fila.closure_status, "delivered", "fulfilled nunca es delivered");
    await calls.runCallOrchestratorTick({ now: despues, provider, isHoliday: noHoliday });
    assert.equal(db.getActiveCallAttemptForOrder(o.id), null, "sigue sin haber ningún contacto tras fulfillment");
    assert.equal(created.length, 0);

    // 3. La entrega real la dictará la fuente autoritativa (Dropea) y el
    //    terminal no podrá ser pisado por nadie (ya probado en E1/E7).
    assert.ok(db.setOrderClosure(o.id, "delivered", "dropea", Math.floor(despues.getTime() / 1000) + 7200));
    assert.equal(db.setOrderClosure(o.id, "cancelled", "llamada_ia", Math.floor(despues.getTime() / 1000) + 9000), false);
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

  // ============ T1 · ordered_at (fecha real de compra vs. fecha de import) ============
  console.log("\n— T1: ordered_at —");

  await test("T1 migración: aditiva — añade la columna a una tabla orders pre-T1, NULL por defecto", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "t1-empty.db"));
    raw.exec(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending_send')"
    );
    db.migrateOrderedAt(raw);
    const cols = raw.prepare("PRAGMA table_info(orders)").all().map((c: { name: string }) => c.name);
    assert.ok(cols.includes("ordered_at"));

    raw.prepare("INSERT INTO orders (shopify_order_id) VALUES ('t1-empty-1')").run();
    const fila = raw.prepare("SELECT ordered_at FROM orders WHERE shopify_order_id = 't1-empty-1'").get();
    assert.equal(fila.ordered_at, null);
    raw.close();
  });

  await test("T1 migración: correr dos/tres veces es un no-op — no duplica la columna ni pisa valores ya escritos", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "t1-twice.db"));
    raw.exec(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending_send')"
    );
    raw.prepare("INSERT INTO orders (shopify_order_id) VALUES ('t1-twice-1')").run();

    assert.doesNotThrow(() => db.migrateOrderedAt(raw), "primera pasada");
    assert.doesNotThrow(() => db.migrateOrderedAt(raw), "segunda pasada");
    assert.doesNotThrow(() => db.migrateOrderedAt(raw), "tercera pasada");

    const cols = raw.prepare("PRAGMA table_info(orders)").all().map((c: { name: string }) => c.name);
    assert.equal(cols.filter((c: string) => c === "ordered_at").length, 1, "la columna no se duplica");

    raw.prepare("UPDATE orders SET ordered_at = 1700000000 WHERE shopify_order_id = 't1-twice-1'").run();
    db.migrateOrderedAt(raw);
    const fila = raw.prepare("SELECT ordered_at FROM orders WHERE shopify_order_id = 't1-twice-1'").get();
    assert.equal(fila.ordered_at, 1700000000, "un valor ya escrito no se pisa al volver a migrar");
    raw.close();
  });

  await test("T1 normalizeOrder: orderedAt sale de created_at (ISO → epoch); ausente o inválido → null", () => {
    const conFecha = normalizeOrder(codPayload({ id: 991001, order_number: 5001, created_at: "2026-01-15T10:30:00Z" }) as never);
    assert.equal(conFecha.orderedAt, Math.floor(Date.parse("2026-01-15T10:30:00Z") / 1000));

    const sinFecha = normalizeOrder(codPayload({ id: 991002, order_number: 5002, created_at: undefined }) as never);
    assert.equal(sinFecha.orderedAt, null);

    const fechaRota = normalizeOrder(codPayload({ id: 991003, order_number: 5003, created_at: "no-es-una-fecha" }) as never);
    assert.equal(fechaRota.orderedAt, null);
  });

  await test("T1 webhook orders/create: guarda ordered_at desde el payload, DISTINTO del created_at local (que es cuándo se insertó la fila)", () => {
    const antesDeInsertar = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify(
      codPayload({ id: 991101, order_number: 5101, created_at: "2026-01-01T08:00:00Z" })
    );
    processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    const o = db.getOrderByShopifyId("991101")!;
    assert.equal(o.ordered_at, Math.floor(Date.parse("2026-01-01T08:00:00Z") / 1000), "ordered_at = fecha real de compra");
    assert.ok(o.created_at >= antesDeInsertar, "created_at (local) sigue siendo el instante de inserción, no la fecha de compra");
    assert.notEqual(o.ordered_at, o.created_at, "en este caso son fechas MUY distintas — no deben confundirse");
  });

  await test("T1 webhook orders/create: sin created_at en el payload, ordered_at se queda NULL (nunca se inventa)", () => {
    const payload = codPayload({ id: 991102, order_number: 5102 });
    delete (payload as Record<string, unknown>).created_at;
    const raw = JSON.stringify(payload);
    processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    const o = db.getOrderByShopifyId("991102")!;
    assert.equal(o.ordered_at, null);
  });

  await test("T1 backfill (E3) — insert_cancelled: ordered_at también se guarda para un pedido cancelado del histórico", async () => {
    const cancelado = backfillOrder({
      id: 991201,
      order_number: 5201,
      cancelled_at: "2026-02-01T12:00:00Z",
      created_at: "2026-01-20T09:00:00Z",
    });
    await backfill.runShopifyBackfill({
      dryRun: false,
      scopeFetcher: async () => ["read_orders", "read_all_orders"],
      pageFetcher: async () => ({ orders: [cancelado], nextCursor: null }),
    });
    const o = db.getOrderByShopifyId("991201")!;
    assert.equal(o.ordered_at, Math.floor(Date.parse("2026-01-20T09:00:00Z") / 1000));
  });

  await test("T1 backfill (E3) — insert_in_progress de punta a punta: ordered_at queda escrito en el pedido histórico insertado", async () => {
    const pedido = backfillOrder({
      id: 991210,
      order_number: 5210,
      fulfillment_status: "fulfilled",
      line_items: lineas({ fisicasDespachadas: 1 }),
      created_at: "2026-01-10T09:00:00Z",
      updated_at: "2026-01-12T09:00:00Z",
    });
    await backfill.runShopifyBackfill({
      dryRun: false,
      scopeFetcher: async () => ["read_orders", "read_all_orders"],
      pageFetcher: async () => ({ orders: [pedido], nextCursor: null }),
    });
    const o = db.getOrderByShopifyId("991210")!;
    assert.equal(o.ordered_at, Math.floor(Date.parse("2026-01-10T09:00:00Z") / 1000));
  });

  await test("T1 reconciliación (F3): un orders/create perdido también se importa con ordered_at resuelto", async () => {
    const remoto = backfillOrder({
      id: 991301,
      order_number: 5301,
      fulfillment_status: "fulfilled",
      created_at: "2026-01-05T09:00:00Z",
      updated_at: "2026-01-06T09:00:00Z",
    });
    await reconcile.runShopifyReconcile({ fetcher: async () => [remoto] });
    const o = db.getOrderByShopifyId("991301")!;
    assert.equal(o.ordered_at, Math.floor(Date.parse("2026-01-05T09:00:00Z") / 1000));
  });

  await test("T1 salvaguarda estructural: el backfill de ordered_at no importa WhatsApp/Baileys, ni de lejos", () => {
    const prohibido = [
      /from\s+["'].*\/whatsapp["']/,
      /from\s+["'].*\/baileys/,
      /from\s+["'].*\/orders\/messages["']/,
      /from\s+["'].*\/orders\/confirmation["']/,
      /sendWhatsAppMessage/,
      /enqueueOutbox/,
    ];
    for (const rel of ["src/lib/shopify/backfill-ordered-at.ts", "scripts/backfill-ordered-at.ts"]) {
      const contenido = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const patron of prohibido) {
        assert.ok(!patron.test(contenido), `${rel} no debe contener ${patron}`);
      }
    }
  });


  // ============ T4 · Investigación de pedidos saltados por el backfill ============
  console.log("\n— T4: investigación de skip_has_own_source —");

  await test("T4 listSkippedByOwnSource: incluye closure_source o closure_status≠unknown; excluye los totalmente unknown/null", () => {
    const conFuente = mkOrder("974001", "3001", "34600199001");
    db.setOrderClosure(conFuente.id, "in_progress", "shopify", 1_700_000_000);

    const sinFuenteNiTocar = mkOrder("974002", "3002", "34600199002"); // unknown + source null: fuera

    // Caso de borde: status≠unknown pero source NULL (no debería pasar en la
    // práctica vía setOrderClosure, pero decideBackfillAction también lo
    // trata como skip_has_own_source — se fuerza por SQL para probar la regla tal cual).
    const statusSinFuente = mkOrder("974003", "3003", "34600199003");
    db.systemDbHandle()
      .prepare("UPDATE orders SET closure_status = 'in_progress' WHERE id = ?")
      .run(statusSinFuente.id);

    const candidatos = investigateSkipped.listSkippedByOwnSource();
    const idsCandidatos = new Set(candidatos.map((c) => c.id));

    assert.ok(idsCandidatos.has(conFuente.id), "con closure_source: SÍ es candidato");
    assert.ok(idsCandidatos.has(statusSinFuente.id), "con closure_status≠unknown aunque source sea NULL: SÍ es candidato");
    assert.ok(!idsCandidatos.has(sinFuenteNiTocar.id), "totalmente unknown/NULL: NO es candidato");
  });

  await test("T4 compareLocalToLive: match, discrepancia, sin señal (no encontrado), sin señal (Shopify no dice nada nuevo)", () => {
    const local = (status: import("../src/lib/db").ClosureStatus): import("../src/lib/shopify/investigate-skipped-backfill").SkippedCandidate => ({
      id: 1,
      shopifyOrderId: "999001",
      shopifyOrderNumber: "9001",
      closureStatus: status,
      closureSource: "shopify",
      closureAt: 1_700_000_000,
    });

    // Match: local dice in_progress, Shopify (fulfilled) también dice in_progress.
    // Adaptado al fulfillment POR LÍNEA de esta rama (el PR venía de main):
    // el global "fulfilled" solo cuenta si las líneas físicas salieron.
    const remotoEnCurso = backfillOrder({ id: 999001, fulfillment_status: "fulfilled", line_items: lineas({ fisicasDespachadas: 1 }), updated_at: "2026-08-20T10:00:00Z" });
    const match = investigateSkipped.compareLocalToLive(local("in_progress"), remotoEnCurso, false);
    assert.equal(match.kind, "match");

    // Discrepancia: local dice in_progress, Shopify AHORA dice cancelled — el
    // caso sospechoso que motivó T4 (una cancelación que nunca se reflejó).
    const remotoCancelado = backfillOrder({ id: 999001, cancelled_at: "2026-08-22T10:00:00Z" });
    const discrepancia = investigateSkipped.compareLocalToLive(local("in_progress"), remotoCancelado, false);
    assert.equal(discrepancia.kind, "discrepancy");
    assert.equal(discrepancia.liveSignal?.status, "cancelled");

    // Sin señal: Shopify no devolvió el pedido (borrado, id equivocado...).
    const noEncontrado = investigateSkipped.compareLocalToLive(local("in_progress"), null, false);
    assert.equal(noEncontrado.kind, "no_live_signal");
    assert.equal(noEncontrado.notFoundInShopify, true);

    // Sin señal: Shopify lo devuelve pero no tiene NADA que decir del cierre
    // (sigue abierto, sin fulfillment ni cancelación) — no es una discrepancia,
    // es "todavía no hay nada nuevo que comparar".
    const remotoAbierto = backfillOrder({ id: 999001 });
    const sinSeñalTodavia = investigateSkipped.compareLocalToLive(local("in_progress"), remotoAbierto, true);
    assert.equal(sinSeñalTodavia.kind, "no_live_signal");
    assert.equal(sinSeñalTodavia.notFoundInShopify, undefined, "esto es distinto de 'no encontrado'");
    assert.equal(sinSeñalTodavia.highlighted, true, "el flag de señalado se propaga tal cual");
  });

  await test("T4 runInvestigation: orquesta con un fetcher inyectado, cuenta bien, y respeta highlightOrderNumbers", async () => {
    const a = mkOrder("974101", "3101", "34600199101");
    db.setOrderClosure(a.id, "in_progress", "shopify", 1_700_000_000); // se le va a llevar la contraria

    const b = mkOrder("974102", "3102", "34600199102");
    db.setOrderClosure(b.id, "cancelled", "shopify", 1_700_000_000); // va a coincidir

    const vistos: string[] = [];
    const fetcher: import("../src/lib/shopify/investigate-skipped-backfill").OrdersByIdFetcher = async (ids) => {
      vistos.push(...ids);
      return ids
        .filter((id) => id === "974101" || id === "974102")
        .map((id) =>
          id === "974101"
            ? backfillOrder({ id: 974101, cancelled_at: "2026-08-23T10:00:00Z" }) // discrepancia real
            : backfillOrder({ id: 974102, cancelled_at: "2026-08-01T10:00:00Z" }) // coincide
        );
    };

    const report = await investigateSkipped.runInvestigation({ fetcher, highlightOrderNumbers: ["3101"] });

    assert.ok(vistos.includes("974101") && vistos.includes("974102"), "el fetcher recibe los ids de Shopify, no los locales");
    const miItemA = report.items.find((i) => i.local.id === a.id)!;
    const miItemB = report.items.find((i) => i.local.id === b.id)!;
    assert.equal(miItemA.kind, "discrepancy");
    assert.equal(miItemA.highlighted, true, "3101 estaba en highlightOrderNumbers");
    assert.equal(miItemB.kind, "match");
    assert.equal(miItemB.highlighted, false);
  });

  await test("T1 resolveOrderedAtFromRawPayload: los cuatro casos puros (resuelto, sin payload, JSON roto, sin fecha utilizable)", () => {
    const okPayload = JSON.stringify({ created_at: "2026-03-01T10:00:00Z" });
    assert.deepEqual(backfillOrderedAt.resolveOrderedAtFromRawPayload(okPayload), {
      kind: "resolved",
      orderedAt: Math.floor(Date.parse("2026-03-01T10:00:00Z") / 1000),
    });
    assert.deepEqual(backfillOrderedAt.resolveOrderedAtFromRawPayload(null), { kind: "unresolved_no_payload" });
    assert.deepEqual(backfillOrderedAt.resolveOrderedAtFromRawPayload(""), { kind: "unresolved_no_payload" });
    assert.deepEqual(backfillOrderedAt.resolveOrderedAtFromRawPayload("{esto no es json"), {
      kind: "unresolved_unparseable",
    });
    assert.deepEqual(backfillOrderedAt.resolveOrderedAtFromRawPayload(JSON.stringify({ id: 1 })), {
      kind: "unresolved_no_date",
    });
    assert.deepEqual(
      backfillOrderedAt.resolveOrderedAtFromRawPayload(JSON.stringify({ created_at: "no-es-fecha" })),
      { kind: "unresolved_no_date" }
    );
  });

  await test("T1 runBackfillOrderedAt (dry-run): decide todo, no escribe NADA, el desglose cuadra", () => {
    const conPayloadValido = mkOrder("991401", "5401", "34600119401");
    db.systemDbHandle()
      .prepare("UPDATE orders SET raw_payload = ? WHERE id = ?")
      .run(JSON.stringify({ created_at: "2026-04-01T10:00:00Z" }), conPayloadValido.id);

    const sinPayload = mkOrder("991402", "5402", "34600119402"); // mkOrder no pone raw_payload

    const conPayloadRoto = mkOrder("991403", "5403", "34600119403");
    db.systemDbHandle().prepare("UPDATE orders SET raw_payload = ? WHERE id = ?").run("{roto", conPayloadRoto.id);

    const conPayloadSinFecha = mkOrder("991404", "5404", "34600119404");
    db.systemDbHandle()
      .prepare("UPDATE orders SET raw_payload = ? WHERE id = ?")
      .run(JSON.stringify({ id: 1 }), conPayloadSinFecha.id);

    const report = backfillOrderedAt.runBackfillOrderedAt({ dryRun: true });
    assert.ok(report.total >= 4, "al menos las 4 filas de este test están pendientes");
    assert.ok(report.resolved >= 1);
    assert.ok(report.unresolvedNoPayload >= 1);
    assert.ok(report.unresolvedUnparseable >= 1);
    assert.ok(report.unresolvedNoDate >= 1);

    // Dry-run de verdad: ninguna de las 4 filas de este test quedó escrita.
    for (const id of [conPayloadValido.id, sinPayload.id, conPayloadRoto.id, conPayloadSinFecha.id]) {
      assert.equal(db.getOrderById(id)!.ordered_at, null, `id ${id} no debe tocarse en dry-run`);
    }
  });

  await test("T1 runBackfillOrderedAt (aplicado): escribe SOLO las filas resolubles; las demás quedan NULL", () => {
    const resoluble = mkOrder("991501", "5501", "34600119501");
    db.systemDbHandle()
      .prepare("UPDATE orders SET raw_payload = ? WHERE id = ?")
      .run(JSON.stringify({ created_at: "2026-05-01T10:00:00Z" }), resoluble.id);

    const irresoluble = mkOrder("991502", "5502", "34600119502"); // sin raw_payload

    const yaResuelta = mkOrder("991503", "5503", "34600119503");
    db.systemDbHandle()
      .prepare("UPDATE orders SET ordered_at = 1700000000, raw_payload = ? WHERE id = ?")
      .run(JSON.stringify({ created_at: "2026-06-01T10:00:00Z" }), yaResuelta.id);

    const totalAntes = backfillOrderedAt.runBackfillOrderedAt({ dryRun: true }).total;
    const report = backfillOrderedAt.runBackfillOrderedAt({ dryRun: false });
    assert.equal(report.total, totalAntes, "el segundo dry-run de arriba no debe haber tocado nada");

    assert.equal(
      db.getOrderById(resoluble.id)!.ordered_at,
      Math.floor(Date.parse("2026-05-01T10:00:00Z") / 1000),
      "la fila resoluble queda escrita"
    );
    assert.equal(db.getOrderById(irresoluble.id)!.ordered_at, null, "sin raw_payload, se queda NULL — no se inventa nada");
    assert.equal(
      db.getOrderById(yaResuelta.id)!.ordered_at,
      1700000000,
      "una fila que YA tenía ordered_at no se toca ni se recalcula desde su raw_payload"
    );

    // Repetir con --apply es idempotente: nada nuevo que resolver.
    const segundaPasada = backfillOrderedAt.runBackfillOrderedAt({ dryRun: false });
    assert.equal(segundaPasada.resolved, 0, "las filas resolubles ya se resolvieron en la pasada anterior");
  });

  // ============ T2 · MAX_ORDER_AGE_MINUTES contra ordered_at ============
  console.log("\n— T2: antigüedad medida por ordered_at, no por created_at —");

  // El guardia de edad vive DENTRO del bloque whatsappReady() del tick: si
  // otro test dejó la conexión simulada en 'disconnected', estos tests
  // fallaban por acoplamiento, no por la edad (flaky real del 02-09, ~1/5
  // ejecuciones). Su tema es la EDAD: la precondición se fija explícita.
  db.setConnectionState({ status: "connected", phone: "34600000000" });

  await test("T2 scheduler: ordered_at viejo caduca la fila aunque created_at sea de ahora mismo (import en tiempo real, compra vieja)", async () => {
    const o = mkOrder("972001", "2801", "34600000200");
    const nowSec = Math.floor(Date.now() / 1000);
    // created_at se queda tal cual (recién insertado por mkOrder); solo se
    // fija ordered_at como una compra muy vieja — el escenario que antes de
    // T2 el scheduler NO detectaba porque miraba created_at.
    db.systemDbHandle().prepare("UPDATE orders SET ordered_at = ? WHERE id = ?").run(nowSec - 999_999, o.id);
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, async () => {
      await runSchedulerTick(nowSec);
    });
    assert.equal(
      db.getOrderById(o.id)!.status,
      "ignored_old",
      "ordered_at viejo debe caducar la fila aunque created_at (import) sea de ahora mismo"
    );
  });

  await test("T2 scheduler: created_at viejo (import tardío) con ordered_at reciente NO caduca — antes de T2 sí habría caducado", async () => {
    const o = mkOrder("972002", "2802", "34600000201");
    const nowSec = Math.floor(Date.now() / 1000);
    // Al revés que el test anterior: la FILA se insertó "hace mucho" (import
    // tardío / reproceso), pero la compra real fue hace un minuto. Con la
    // lógica pre-T2 (basada en created_at) esto habría caducado sin motivo.
    db.systemDbHandle()
      .prepare("UPDATE orders SET created_at = ?, ordered_at = ? WHERE id = ?")
      .run(nowSec - 999_999, nowSec - 60, o.id);
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, async () => {
      await runSchedulerTick(nowSec);
    });
    assert.notEqual(
      db.getOrderById(o.id)!.status,
      "ignored_old",
      "ordered_at reciente: la compra fue hace un minuto, no debe caducar por mucho que la fila llevara tiempo insertada"
    );
  });

  await test("T2 scheduler: sin ordered_at (fila de antes de T1, aún sin backfillar) sigue cayendo a created_at — sin regresión", async () => {
    const o = mkOrder("972003", "2803", "34600000202");
    const nowSec = Math.floor(Date.now() / 1000);
    // ordered_at se queda NULL a propósito (no se toca): es exactamente el
    // comportamiento anterior a T1/T2, que debe seguir intacto.
    db.systemDbHandle().prepare("UPDATE orders SET created_at = ? WHERE id = ?").run(nowSec - 999_999, o.id);
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, async () => {
      await runSchedulerTick(nowSec);
    });
    assert.equal(
      db.getOrderById(o.id)!.status,
      "ignored_old",
      "sin ordered_at, debe seguir cayendo al created_at viejo — mismo comportamiento que antes de T2"
    );
  });

  await test("T2 webhook: sigue rechazando por anti-replay con created_at antiguo (mismo resultado, ahora vía ordered_at + orderTooOld)", async () => {
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, () => {
      const payload = codPayload({
        id: 972101,
        order_number: 2901,
        created_at: "2026-01-01T10:00:00+02:00", // muy anterior a hoy
      });
      const raw = JSON.stringify(payload);
      const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
      assert.equal(res.status, 200);
      assert.equal(db.getOrderByShopifyId("972101")!.status, "ignored_old");
    });
  });

  await test("T2 webhook: created_at reciente NO se marca ignored_old (el refactor a orderTooOld no cambia el caso normal)", async () => {
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, () => {
      const payload = codPayload({
        id: 972102,
        order_number: 2902,
        created_at: new Date().toISOString(),
      });
      const raw = JSON.stringify(payload);
      const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
      assert.equal(res.status, 200);
      assert.notEqual(db.getOrderByShopifyId("972102")!.status, "ignored_old");
    });
  });

  await test("T2 webhook: payload SIN created_at no se puede medir → se deja pasar (permisivo, igual que antes de T2)", async () => {
    await withEnv({ MAX_ORDER_AGE_MINUTES: "30" }, () => {
      const payload = codPayload({ id: 972103, order_number: 2903 });
      delete (payload as Record<string, unknown>).created_at;
      const raw = JSON.stringify(payload);
      const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
      assert.equal(res.status, 200);
      assert.notEqual(
        db.getOrderByShopifyId("972103")!.status,
        "ignored_old",
        "sin dato de antigüedad, no se bloquea por una ausencia que no es indicio de nada"
      );
    });
  });


  // ============ T6 · Salvaguarda estructural transitiva de WhatsApp ============
  console.log("· T6 — salvaguarda estructural transitiva (grafo de imports)");

  await test(
    "T6 WhatsApp/Baileys no son alcanzables, ni transitivamente, desde ningún entrypoint de backfill/reconciliación",
    () => {
      const entrypoints = ["scripts/shopify-backfill.ts", "scripts/dropea-reconcile.ts", "scripts/beeping-sync.ts"];

      const baileysDir = path.join(PROJECT_ROOT, "src", "lib", "baileys");
      const forbiddenModules = [
        path.join(PROJECT_ROOT, "src", "lib", "whatsapp.ts"),
        ...fs.readdirSync(baileysDir).map((f) => path.join(baileysDir, f)),
      ];
      const forbiddenCalls = ["sendWhatsAppMessage", "enqueueOutbox", "enqueueOutboxImage"];

      for (const entry of entrypoints) {
        const entryPath = path.join(PROJECT_ROOT, entry);
        const graph = buildTransitiveImportGraph(entryPath);

        assert.ok(graph.size > 3, `${entry}: el grafo recorrido parece sospechosamente pequeño (${graph.size} ficheros) — revisa que la resolución de imports (incluidos los "await import(...)" dinámicos) siga funcionando`);

        for (const forbidden of forbiddenModules) {
          assert.ok(
            !graph.has(forbidden),
            `${entry} alcanza transitivamente ${path.relative(PROJECT_ROOT, forbidden)} — esto enviaría WhatsApp de verdad`
          );
        }

        for (const file of graph) {
          const src = fs.readFileSync(file, "utf8");
          for (const fnName of forbiddenCalls) {
            assert.ok(
              !containsCallTo(src, fnName),
              `${entry} alcanza ${path.relative(PROJECT_ROOT, file)}, que llama a ${fnName}(...) — envío/encolado real de WhatsApp`
            );
          }
        }
      }
    }
  );

  await test("T6 el propio recorrido detecta una fuga transitiva de verdad (fixture aislado, no toca el repo)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t6-fuga-"));
    try {
      const whatsappFile = path.join(dir, "whatsapp.ts");
      const middleFile = path.join(dir, "middle.ts");
      const entryFile = path.join(dir, "entry.ts");
      fs.writeFileSync(whatsappFile, `export function sendWhatsAppMessage(a: string, b: string) { return true; }\n`);
      fs.writeFileSync(middleFile, `export { sendWhatsAppMessage } from "./whatsapp";\n`);
      fs.writeFileSync(entryFile, `async function main() { const m = await import("./middle"); m.sendWhatsAppMessage("x", "y"); }\nmain();\n`);

      const graph = buildTransitiveImportGraph(entryFile);
      assert.ok(graph.has(whatsappFile), "el fixture debe demostrar que un import de 2 saltos (entry → middle → whatsapp) SÍ se detecta");
      assert.ok(containsCallTo(fs.readFileSync(middleFile, "utf8"), "sendWhatsAppMessage") === false, "el re-export por sí solo no es una llamada");
      assert.ok(containsCallTo(fs.readFileSync(entryFile, "utf8"), "sendWhatsAppMessage"), "la llamada real en entry.ts sí se detecta como llamada");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("T4 salvaguarda estructural: solo lectura — ni WhatsApp/Baileys, ni un solo UPDATE/INSERT/DELETE, ni un --apply en ninguna parte", () => {
    const prohibidoEscritura = [
      /from\s+["'].*\/whatsapp["']/,
      /from\s+["'].*\/baileys/,
      /from\s+["'].*\/orders\/messages["']/,
      /from\s+["'].*\/orders\/confirmation["']/,
      /sendWhatsAppMessage/,
      /enqueueOutbox/,
      /\bUPDATE\s+orders\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bDELETE\s+FROM\b/i,
      /setOrderClosure/,
      /setOrderSupplier/,
    ];
    for (const rel of ["src/lib/shopify/investigate-skipped-backfill.ts", "scripts/investigate-skipped-backfill.ts"]) {
      const contenido = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const patron of prohibidoEscritura) {
        assert.ok(!patron.test(contenido), `${rel} no debe contener ${patron} — esto es SOLO LECTURA`);
      }
    }
    // Refuerzo explícito del requisito "sin --apply en ninguna parte" (T4, a
    // diferencia de E3/E8, no tiene NI SIQUIERA el flag dormido): no hay
    // siquiera la maquinaria para leer flags de process.argv. Se busca el
    // patrón de código, no la palabra "--apply" a secas — el comentario de
    // cabecera del propio script LA MENCIONA a propósito para explicar que
    // no existe, y no debe hacer fallar este test por eso.
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/investigate-skipped-backfill.ts"), "utf8");
    assert.ok(!/hasFlag\s*\(/.test(script), "T4 no debe tener ni la función que lee flags de process.argv");
    assert.ok(!/process\.argv/.test(script), "T4 no debe leer process.argv en absoluto — no hay nada que activar");
  });

  // ============ Cierre operativo — Action Center, duplicados en entrada y watchdog ============
  console.log("· Cierre operativo — Action Center y watchdog");
  {
    const actionCenter = await import("../src/lib/system/action-center");
    const businessAlerts = await import("../src/lib/system/business-alerts");
    const sysRepo = await import("../src/lib/system/repo");

    await test("v11 action_resolutions: migración idempotente — correr dos veces no falla ni duplica", () => {
      // La tabla ya existe (build inicial); volver a migrar debe ser un no-op.
      db.migrateActionResolutions(db.systemDbHandle());
      db.migrateActionResolutions(db.systemDbHandle());
      const cols = db.systemDbHandle().prepare("PRAGMA table_info(action_resolutions)").all() as Array<{ name: string }>;
      assert.deepEqual(cols.map((c) => c.name).sort(), ["action_type", "id", "note", "order_id", "resolved_at"]);
    });

    await test("Action Center: cancelación pedida → aparece PRIMERO, con qué hacer en imperativo y teléfono enmascarado", () => {
      const o = mkOrder("985001", "8501", "34698500001");
      db.markOrderNeedsCall(o.id); // también hay un needs_call para comprobar el orden
      db.requestOrderCancellation(o.id);
      const ac = actionCenter.getActionCenter();
      const item = ac.items.find((i) => i.orderId === o.id && i.type === "CANCEL_REQUEST");
      assert.ok(item, "debe existir el elemento CANCEL_REQUEST");
      assert.equal(ac.items[0].type, "CANCEL_REQUEST", "una cancelación pendiente va la primera");
      assert.match(item!.whatToDo, /Shopify/);
      assert.match(item!.customer, /\*\*\*0001/);
      assert.ok(!JSON.stringify(ac).includes("34698500001"), "el teléfono completo no puede salir de la bandeja");
      // Con cancelación pedida NO se duplica como NEEDS_CALL: una sola decisión, un solo elemento.
      assert.ok(!ac.items.some((i) => i.orderId === o.id && i.type === "NEEDS_CALL"));
    });

    await test("Action Center: marcar resuelto lo saca de la bandeja SIN tocar el pedido; repetir la resolución es upsert", () => {
      const o = db.getOrderByShopifyId("985001")!;
      db.resolveActionItem(o.id, "CANCEL_REQUEST", "hablado con el cliente, mantiene el pedido");
      db.resolveActionItem(o.id, "CANCEL_REQUEST", "nota corregida"); // upsert, no UNIQUE violation
      assert.ok(db.isActionResolved(o.id, "CANCEL_REQUEST"));
      const ac = actionCenter.getActionCenter();
      assert.ok(!ac.items.some((i) => i.orderId === o.id && i.type === "CANCEL_REQUEST"));
      const despues = db.getOrderByShopifyId("985001")!;
      assert.ok(despues.cancellation_requested_at, "resolver NO borra la marca del pedido");
      assert.equal(despues.status, "needs_call", "resolver NO cambia el estado operativo");
      const notas = db.listActionResolutions().filter((r) => r.order_id === o.id);
      assert.equal(notas.length, 1, "upsert: una sola fila por (pedido, tipo)");
      assert.equal(notas[0].note, "nota corregida");
    });

    await test("Duplicados EN LA ENTRADA: mismo teléfono+producto+importe+dirección en 48 h → ambos marcados + evento; el webhook nunca falla por esto", () => {
      const base = {
        shipping_address: {
          name: "Lucía Pérez", address1: "Av. del Puerto 9", address2: null, city: "Valencia",
          province: "Valencia", zip: "46021", country: "Spain", country_code: "ES", phone: "+34 698 500 111",
        },
      };
      const raw1 = JSON.stringify(codPayload({ id: 985002, order_number: 8502, ...base }));
      assert.equal(processOrdersCreateWebhook(raw1, shopifyHeaders(raw1)).status, 200);
      const raw2 = JSON.stringify(codPayload({ id: 985003, order_number: 8503, ...base }));
      assert.equal(processOrdersCreateWebhook(raw2, shopifyHeaders(raw2)).status, 200);
      const o1 = db.getOrderByShopifyId("985002")!;
      const o2 = db.getOrderByShopifyId("985003")!;
      assert.equal(o1.possible_duplicate, 1, "el pedido ORIGINAL también se marca");
      assert.equal(o2.possible_duplicate, 1, "el nuevo se marca");
      assert.equal(o1.status, "pending_send", "marcar duplicado JAMÁS cancela ni bloquea");
      const evs = sysRepo.listIntegrationEvents({ limit: 50 }).filter((e) => e.event_type === "duplicate_suspected_on_create");
      assert.ok(evs.length >= 1, "queda rastro en integration_events");
      const ac = actionCenter.getActionCenter();
      assert.ok(ac.items.some((i) => i.orderId === o2.id && i.type === "POSSIBLE_DUPLICATE"));
    });

    await test("Duplicados EN LA ENTRADA: pedido distinto (otro importe) del mismo teléfono NO se marca", () => {
      const raw = JSON.stringify(codPayload({
        id: 985004, order_number: 8504, total_price: "19.95",
        line_items: [{
          title: "Crema facial hidratante", quantity: 1, price: "19.95", sku: "CREMA-01",
          product_id: 8100000000001, variant_id: 4100000000001, requires_shipping: true,
          gift_card: false, fulfillment_service: "manual", fulfillment_status: null, fulfillable_quantity: 1,
        }],
        shipping_address: {
          name: "Lucía Pérez", address1: "Av. del Puerto 9", address2: null, city: "Valencia",
          province: "Valencia", zip: "46021", country: "Spain", country_code: "ES", phone: "+34 698 500 111",
        },
      }));
      assert.equal(processOrdersCreateWebhook(raw, shopifyHeaders(raw)).status, 200);
      assert.equal(db.getOrderByShopifyId("985004")!.possible_duplicate, 0);
    });

    await test("Watchdog: cancelaciones y duplicados pendientes disparan warning; resolverlos en el Action Center los apaga", () => {
      const snap1 = businessAlerts.readBusinessSnapshot();
      assert.ok(snap1.possibleDuplicatesPending >= 2, "los dos duplicados de arriba cuentan");
      const res1 = businessAlerts.getBusinessAlerts(undefined, snap1);
      const dup = res1.alerts.find((a) => a.id === "possible_duplicates_pending")!;
      assert.equal(dup.status, "warning");
      assert.match(dup.message, /Acciones/, "la alerta dice DÓNDE actuar");
      // Resolver ambos desde la bandeja → dejan de contar (delta exacto de 2;
      // el total no es 0 porque tests anteriores de la suite dejan otros
      // duplicados marcados en la misma DB compartida — a propósito).
      db.resolveActionItem(db.getOrderByShopifyId("985002")!.id, "POSSIBLE_DUPLICATE", "eran el mismo, cancelado el 8503 en Shopify");
      db.resolveActionItem(db.getOrderByShopifyId("985003")!.id, "POSSIBLE_DUPLICATE", "eran el mismo, cancelado el 8503 en Shopify");
      const snap2 = businessAlerts.readBusinessSnapshot();
      assert.equal(snap2.possibleDuplicatesPending, snap1.possibleDuplicatesPending - 2);
    });

    await test("Watchdog: cancelación pendiente ya resuelta arriba NO cuenta; una nueva sí", () => {
      const snapA = businessAlerts.readBusinessSnapshot();
      const antes = snapA.cancelRequestsPending;
      const o = mkOrder("985005", "8505", "34698500005");
      db.requestOrderCancellation(o.id);
      const snapB = businessAlerts.readBusinessSnapshot();
      assert.equal(snapB.cancelRequestsPending, antes + 1);
      assert.equal(businessAlerts.getBusinessAlerts(undefined, snapB).alerts.find((a) => a.id === "cancel_requests_pending")!.status, "warning");
      db.resolveActionItem(o.id, "CANCEL_REQUEST", "gestionada");
    });

    await test("Action Center: los pedidos ignored_old NUNCA aparecen aunque tengan marcas", () => {
      const antes = businessAlerts.readBusinessSnapshot();
      const viejo = mkOrder("985006", "8506", "34698500006");
      db.systemDbHandle().prepare("UPDATE orders SET status='ignored_old', possible_duplicate=1, cancellation_requested_at=unixepoch() WHERE id = ?").run(viejo.id);
      const ac = actionCenter.getActionCenter();
      assert.ok(!ac.items.some((i) => i.orderId === viejo.id), "un pedido antiguo no genera trabajo para Pedro");
      // Y tampoco cuenta para el watchdog: mismos contadores que antes de crearlo.
      const despues = businessAlerts.readBusinessSnapshot();
      assert.equal(despues.possibleDuplicatesPending, antes.possibleDuplicatesPending);
      assert.equal(despues.cancelRequestsPending, antes.cancelRequestsPending);
    });
  }

  // ============ GOLDEN PATH — el contrato completo, de webhook a panel ============
  console.log("· Golden path — contrato de docs/GOLDEN-PATH.md");

  await test("golden-path-order-confirmation: webhook firmado → guardado → WhatsApp encolado → '1' → confirmado → routing evaluado → panel y Acciones lo reflejan → fulfilled es in_progress → delivered terminal", async () => {
    const actionCenter = await import("../src/lib/system/action-center");
    const { getSystemOverview } = await import("../src/lib/system/overview");
    const tel = "34698600001";

    // Pasos 1-3 del contrato: llega orders/create FIRMADO y se guarda local.
    const raw = JSON.stringify(codPayload({
      id: 986001, order_number: 8601,
      shipping_address: {
        name: "Golden Path", address1: "Calle del Contrato 1", address2: null, city: "Sevilla",
        province: "Sevilla", zip: "41001", country: "Spain", country_code: "ES", phone: "+34 698 600 001",
      },
    }));
    const res = processOrdersCreateWebhook(raw, shopifyHeaders(raw));
    assert.equal(res.status, 200);
    let o = db.getOrderByShopifyId("986001")!;
    assert.equal(o.status, "pending_send", "paso 3: guardado y a la cola de envío");
    assert.equal(o.possible_duplicate, 0, "sin otro pedido igual, nada de marcas");

    // Paso 4: el scheduler encola el WhatsApp (outbox) y pasa a awaiting_reply.
    const tNow = Math.floor(Date.now() / 1000);
    await runSchedulerTick(tNow);
    o = db.getOrderByShopifyId("986001")!;
    assert.equal(o.status, "awaiting_reply", "paso 4: WhatsApp de confirmación en vuelo");
    const out = db.getPendingOutbox(200).find((m) => m.phone === tel);
    assert.ok(out, "paso 4: el mensaje está en el outbox (envío at-most-once)");
    assert.match(out!.content, /1 - Todo correcto/);

    // Paso 5: el cliente responde "1".
    const reply = handleOrderReply(tel, "1");
    assert.equal(reply.handled, true);
    o = db.getOrderByShopifyId("986001")!;
    assert.equal(o.status, "confirmed", "paso 5: confirmado");
    assert.ok(o.confirmed_at, "paso 5: confirmed_at estampado");

    // Paso 6: el siguiente tick evalúa el routing y lo deja ESCRITO.
    await runSchedulerTick(tNow + 60);
    o = db.getOrderByShopifyId("986001")!;
    assert.ok(o.supplier_sync_status, "paso 6: la decisión de routing queda en el pedido");
    // La fixture (CREMA-01) no tiene regla de routing: revisión humana con
    // motivo, no una adivinanza. Eso también es contrato.
    assert.equal(o.supplier_sync_status, "manual_review");
    assert.ok(o.supplier_last_error, "paso 6: el motivo del bloqueo queda explicado");

    // Paso 7: el panel refleja el pedido y el bloqueo está en Acciones.
    const ov = getSystemOverview();
    assert.ok(JSON.stringify(ov).length > 0, "paso 7: overview se construye sin lanzar");
    assert.ok(!JSON.stringify(ov).includes(tel), "paso 7: el panel jamás enseña el teléfono completo");
    const ac = actionCenter.getActionCenter();
    const item = ac.items.find((i) => i.orderId === o.id && i.type === "SUPPLIER_ERROR");
    assert.ok(item, "paso 7: lo que exige acción humana está en Acciones");
    assert.match(item!.whatToDo, /./, "cada acción dice qué hacer");

    // Paso 8: Shopify marca fulfilled → in_progress, JAMÁS delivered.
    assert.ok(db.setOrderClosure(o.id, "in_progress", "shopify", tNow + 3600));
    o = db.getOrderByShopifyId("986001")!;
    assert.equal(o.closure_status, "in_progress", "paso 8: fulfilled = despachado, no entregado");

    // Paso 9: la fuente autoritativa cierra; el terminal no se pisa.
    assert.ok(db.setOrderClosure(o.id, "delivered", "dropea", tNow + 7200));
    assert.equal(db.setOrderClosure(o.id, "refused", "shopify", tNow + 9999), false, "paso 9: terminal inmutable");
    assert.equal(db.getOrderByShopifyId("986001")!.closure_status, "delivered");

    // Invariante 1: nada vuelve a contactar a este cliente por esta causa.
    const antes = db.getPendingOutbox(500).filter((m) => m.phone === tel).length;
    await runSchedulerTick(tNow + 999_999);
    assert.equal(db.getPendingOutbox(500).filter((m) => m.phone === tel).length, antes, "cero contactos nuevos tras confirmar");
  });

  // ============ CLIENTE DIFÍCIL — la conversación caótica termina siempre ============
  console.log("· Cliente difícil — caos sin bucle y sin cancelaciones automáticas");

  await test("CLIENTE DIFÍCIL · dos pedidos iguales + 'no sé', 'quiero uno', 'me habéis hecho dos', 'cancelar', 'ese no', 'el otro', 'todo correcto': SIEMPRE responde, JAMÁS cancela solo, y o resuelve o escala", () => {
    const tel = "34698700001";
    const oA = mkMulti("987001", "8701", tel);
    const oB = mkMulti("987002", "8702", tel);

    const secuencia = ["no sé", "quiero uno", "me habéis hecho dos", "cancelar", "ese no", "el otro", "todo correcto"];
    const respuestas: string[] = [];
    for (const msg of secuencia) {
      const r = handleOrderReply(tel, msg);
      const enManosHumanas = ["987001", "987002"].every(
        (sid) => db.getOrderByShopifyId(sid)!.status === "needs_call"
      );
      if (r.handled) {
        assert.ok(r.reply && r.reply.length > 0, `"${msg}" gestionado siempre lleva respuesta`);
        respuestas.push(r.reply!);
      } else {
        // El silencio SOLO es legítimo cuando el bot ya se apartó (todo en
        // needs_call = manos humanas). Mientras el bot lleve la
        // conversación, callar es el bug de la transcripción real.
        assert.ok(enManosHumanas, `"${msg}" sin respuesta solo vale si TODO está ya en manos humanas`);
      }
      // Invariante 4 del contrato: el agente JAMÁS cancela por su cuenta.
      for (const sid of ["987001", "987002"]) {
        assert.notEqual(db.getOrderByShopifyId(sid)!.status, "cancelled", `"${msg}" no puede cancelar nada automáticamente`);
      }
    }

    // "cancelar" tras la escalada NO se perdió en el silencio: quedó
    // estampado para Pedro (urgencia 1 en Acciones), sin cancelar nada.
    assert.ok(
      ["987001", "987002"].some((sid) => db.getOrderByShopifyId(sid)!.cancellation_requested_at),
      "la petición de cancelar queda registrada aunque el bot ya se hubiera apartado"
    );

    // Anti-bucle: la MISMA respuesta no se repite más de MAX_SAME_PROMPT_REPEATS+1
    // veces seguidas — el bot real de la transcripción repitió el selector 5 veces.
    let repes = 1, peor = 1;
    for (let i = 1; i < respuestas.length; i++) {
      repes = respuestas[i] === respuestas[i - 1] ? repes + 1 : 1;
      peor = Math.max(peor, repes);
    }
    assert.ok(peor <= 3, `ninguna respuesta se repite en bucle (peor racha: ${peor})`);

    // El final es un estado RESUELTO o ESCALADO, nunca el limbo del selector:
    // cada pedido acabó confirmado, esperando algo concreto o en manos humanas.
    const finales = ["987001", "987002"].map((sid) => db.getOrderByShopifyId(sid)!.status);
    for (const st of finales) {
      assert.ok(
        ["confirmed", "needs_call", "awaiting_reply", "needs_correction", "awaiting_delivery_note"].includes(st),
        `estado final coherente, no un limbo: ${st}`
      );
    }
    // Y al menos uno de los dos acabó donde un humano lo verá (needs_call →
    // Acciones) o confirmado — la conversación no murió en el selector.
    assert.ok(
      finales.some((st) => st === "needs_call" || st === "confirmed"),
      `la conversación caótica escala o resuelve: ${finales.join(", ")}`
    );
    // "me habéis hecho dos" con dos pedidos IGUALES: quedaron marcados para
    // Pedro (nunca cancelados solos).
    assert.equal(db.getOrderByShopifyId("987001")!.possible_duplicate, 1, "duplicado marcado para revisión humana");
    assert.equal(db.getOrderByShopifyId("987002")!.possible_duplicate, 1);
    void oA; void oB;
  });

  await test("CLIENTE DIFÍCIL · tras escalar a needs_call, más mensajes NO reinician el interrogatorio ni cambian el estado", () => {
    const tel = "34698700002";
    mkMulti("987003", "8703", tel);
    // Dos ambigüedades → needs_call (presupuesto de aclaraciones agotado).
    handleOrderReply(tel, "eh");
    handleOrderReply(tel, "mmm");
    assert.equal(db.getOrderByShopifyId("987003")!.status, "needs_call");
    // El cliente sigue escribiendo cosas raras: el pedido NO vuelve al
    // selector ni se cancela; sigue en manos humanas.
    for (const msg of ["oye", "hola?", "no sé qué hacer"]) {
      handleOrderReply(tel, msg);
      assert.equal(db.getOrderByShopifyId("987003")!.status, "needs_call", `"${msg}" no saca el pedido de la cola humana`);
    }
    // PERO una respuesta CLARA sí resuelve aunque esté en needs_call: si el
    // cliente al final dice "1", nadie tiene que llamarle ya.
    const r = handleOrderReply(tel, "1");
    void r;
    const st = db.getOrderByShopifyId("987003")!.status;
    assert.ok(["confirmed", "needs_call"].includes(st), "una respuesta clara nunca deja el pedido peor de lo que estaba");
  });

  // ============ REINICIO y DOS PROCESOS — todo el estado vive en la DB ============
  console.log("· Reinicio y dos procesos — el estado sobrevive, los envíos no se duplican");

  await test("REINICIO · un pedido a mitad de flujo (selección multi-pedido incluida) sobrevive a un 'reinicio': otra conexión ve TODO y el tick no reenvía nada", async () => {
    const Database = (await import("better-sqlite3")).default;
    const tel = "34698800001";
    mkMulti("988001", "8801", tel);
    mkMulti("988002", "8802", tel, { product_summary: "Cortaúñas Eléctrico 3 en 1", total_price: "36.90" });

    // El cliente selecciona el 8802 y "se apaga el proceso" antes de contestar.
    const r1 = handleOrderReply(tel, "8802");
    assert.equal(r1.handled, true);

    // "REINICIO": una conexión NUEVA al MISMO fichero (otro proceso tras el
    // arranque) tiene que ver el estado completo — colas, contexto, outbox.
    const conn2 = new Database(db.dbFilePath());
    try {
      const ctx2 = conn2.prepare("SELECT selected_order_id FROM conversation_order_context WHERE phone = ?").get(tel) as { selected_order_id: number } | undefined;
      assert.ok(ctx2?.selected_order_id, "la selección multi-pedido NO vive en memoria: sobrevive al reinicio");
      const pedidos = conn2.prepare("SELECT status FROM orders WHERE phone = ?").all(tel) as Array<{ status: string }>;
      assert.equal(pedidos.length, 2, "los pedidos están en el fichero, no en el proceso");
    } finally {
      conn2.close();
    }

    // Tras el "reinicio", el proceso retoma: "todo correcto" usa la selección
    // persistida y confirma EL 8802 — la conversación no vuelve a empezar.
    const r2 = handleOrderReply(tel, "todo correcto");
    assert.equal(r2.handled, true);
    assert.equal(db.getOrderByShopifyId("988002")!.status, "confirmed", "la selección persistida decide tras el reinicio");
    assert.equal(db.getOrderByShopifyId("988001")!.status, "awaiting_reply", "el otro pedido no se toca");

    // Y un tick tras el reinicio NO repite el WhatsApp inicial de nadie.
    const antes = db.getPendingOutbox(500).filter((m) => m.phone === tel).length;
    await runSchedulerTick(Math.floor(Date.now() / 1000));
    assert.equal(db.getPendingOutbox(500).filter((m) => m.phone === tel).length, antes, "reiniciar no reenvía confirmaciones ya mandadas");
  });

  await test("DOS PROCESOS · mismo SQLite: el claim del outbox lo gana EXACTAMENTE uno; el lease del scheduler, ídem", async () => {
    const Database = (await import("better-sqlite3")).default;
    const leases = await import("../src/lib/system/leases");

    // --- outbox: dos 'workers' pelean por el mismo mensaje pendiente ---
    const convo = db.getOrCreateConversation("34698800099", "Test Dos Procesos");
    db.enqueueOutbox(convo.id, "34698800099", "mensaje único");
    const item = db.getPendingOutbox(10_000).find((m) => m.phone === "34698800099")!;
    assert.ok(item, "el mensaje encolado tiene que aparecer entre los pendientes");
    const conn2 = new Database(db.dbFilePath());
    try {
      // Proceso A (el singleton) y proceso B (conexión cruda) reclaman a la vez.
      const claimA = db.markOutboxSent(item.id);
      const claimB = (conn2.prepare("UPDATE outbox SET sent = 1, sent_at = unixepoch() WHERE id = ? AND sent = 0").run(item.id).changes ?? 0) > 0;
      assert.equal(claimA || claimB, true, "alguien lo envía");
      assert.equal(claimA && claimB, false, "pero SOLO uno: at-most-once con dos procesos");
    } finally {
      conn2.close();
    }

    // --- lease: dos owners distintos, el segundo NO entra hasta que expira ---
    const t0 = 1_900_000_000;
    assert.equal(leases.acquireLease("test_two_proc", 60, { owner: "proceso-A", nowSec: t0 }), true);
    assert.equal(leases.acquireLease("test_two_proc", 60, { owner: "proceso-B", nowSec: t0 + 10 }), false, "el lease vivo bloquea al segundo proceso");
    assert.equal(leases.acquireLease("test_two_proc", 60, { owner: "proceso-A", nowSec: t0 + 20 }), true, "el dueño renueva sin pelear");
    assert.equal(leases.acquireLease("test_two_proc", 60, { owner: "proceso-B", nowSec: t0 + 121 }), true, "expirado el lease, el otro proceso lo toma");
  });

  // ============ OPERADOR DIFÍCIL — cada avería dice QUÉ HACER, en cristiano ============
  console.log("· Operador difícil — el panel explica qué hacer, no solo qué falla");

  await test("OPERADOR · llamadas encendidas sin RETELL_API_KEY → critical con instrucción; el fail-closed de allowlist usa la semántica unificada de TEST_MODE", async () => {
    const { getCallsHealth } = await import("../src/lib/system/health-integrations");
    db.setSetting("ai_calls_enabled", "1");
    db.setSetting("calls_shadow_mode", "0");
    await withEnv({ RETELL_API_KEY: undefined }, async () => {
      const h = getCallsHealth();
      assert.equal(h.status, "critical");
      assert.match(h.message, /FALTA RETELL_API_KEY/);
      assert.match(h.message, /\.env|reinicia/, "dice dónde y cómo arreglarlo");
    });
    // Modo piloto sin definir = ACTIVO (fail-closed propio de llamadas,
    // desacoplado de TEST_MODE): el aviso salta sin la variable puesta y
    // ofrece las DOS salidas (rellenar allowlist o declarar producción).
    await withEnv({ RETELL_API_KEY: "key_test_no_real", CALLS_PILOT_MODE: undefined }, async () => {
      db.setSetting("calls_allowlist", "");
      const h = getCallsHealth();
      assert.equal(h.status, "warning");
      assert.match(h.message, /calls_allowlist/, "dice el campo exacto a rellenar");
      assert.match(h.message, /calls_pilot_mode/, "y la salida explícita a producción");
    });
    // Producción de llamadas EXPLÍCITA (la situación real del NAS del
    // 26-08 por la noche): sin allowlist pero con calls_pilot_mode=0 —
    // healthy y diciendo claramente que no hay restricción.
    await withEnv({ RETELL_API_KEY: "key_test_no_real" }, async () => {
      db.setSetting("calls_pilot_mode", "0");
      try {
        const h = getCallsHealth();
        assert.equal(h.status, "healthy");
        assert.match(h.message, /SIN restricción/);
      } finally {
        db.setSetting("calls_pilot_mode", "");
      }
    });
    db.setSetting("ai_calls_enabled", "0");
    db.setSetting("calls_shadow_mode", "1");
    db.setSetting("calls_allowlist", "");
  });

  await test("OPERADOR · Meta sin credenciales con cloud_api activo → el panel lo dice sin rodeos", async () => {
    const { getWhatsAppHealth } = await import("../src/lib/system/health-integrations");
    await withEnv({ WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_ACCESS_TOKEN: undefined, META_WHATSAPP_PHONE_NUMBER_ID: undefined }, async () => {
      const h = getWhatsAppHealth();
      assert.equal(h.provider, "cloud_api");
      assert.match(h.message, /SIN credenciales de Meta/i);
      assert.match(h.message, /nada puede salir/i, "consecuencia clara, no jerga");
    });
  });

  await test("OPERADOR · firma HMAC inválida acumulada → el mensaje dice qué comprobar y con qué comando", async () => {
    const { getShopifyHealth } = await import("../src/lib/system/health-integrations");
    const sysRepo = await import("../src/lib/system/repo");
    sysRepo.logIntegrationEvent("shopify", "webhook_bad_signature", "warning", "firma inválida (test operador)");
    const h = getShopifyHealth();
    assert.ok(h.webhookBadSignature24h >= 1);
    assert.match(h.message, /SHOPIFY_WEBHOOK_SECRET/);
    assert.match(h.message, /shopify:doctor/, "apunta a la herramienta de diagnóstico");
  });

  await test("OPERADOR · backup viejo → critical con acción concreta (revisar tarea del NAS, copia a mano)", async () => {
    const { getBackupHealth } = await import("../src/lib/system/health-core");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-viejo-"));
    try {
      const f = path.join(dir, "messages-2020-01-01.db");
      // Una DB real (vacía) para que el fallo sea la EDAD, no la integridad.
      const Database = (await import("better-sqlite3")).default;
      const tmp = new Database(f);
      tmp.exec("CREATE TABLE t (id INTEGER)");
      tmp.close();
      const viejo = new Date(Date.now() - 100 * 3600 * 1000);
      fs.utimesSync(f, viejo, viejo);
      await withEnv({ BACKUP_DIR: dir }, async () => {
        const h = getBackupHealth();
        assert.equal(h.status, "critical");
        assert.match(h.message, /revisar la tarea de backup del NAS/);
        assert.match(h.message, /copia a mano/);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("OPERADOR · routing sin regla (vendor/SKU sin mapear) → el pedido explica el motivo y aparece en Acciones con instrucción", async () => {
    // Ya probado de punta a punta en el golden path; aquí el contrato del
    // TEXTO: manual_review siempre lleva un motivo legible y una acción.
    const actionCenter = await import("../src/lib/system/action-center");
    const o = db.getOrderByShopifyId("986001")!;
    assert.equal(o.supplier_sync_status, "manual_review");
    assert.ok((o.supplier_last_error ?? "").length > 10, "el motivo no es un código críptico");
    const item = actionCenter.getActionCenter().items.find((i) => i.orderId === o.id && i.type === "SUPPLIER_ERROR");
    assert.ok(item);
    assert.match(item!.whatToDo, /mano|Revisar|Corregir/, "la acción está en imperativo");
  });

  // ============ notify-delay: aviso de retraso "Ultras"/"gafa" ============
  console.log("\n— notify-delay: aviso de retraso 'Ultras'/'gafa' —");

  const notifyDelay = await import("../src/lib/orders/notify-delay");

  let ndSeq = 800000;
  const mkConfirmedOrder = (
    overrides: Partial<{ phone: string; product_summary: string; shopify_order_id: string; closure_status: import("../src/lib/db").ClosureStatus }> = {}
  ) => {
    const seq = ndSeq++;
    const { order } = db.insertOrderIfNew({
      shopify_order_id: overrides.shopify_order_id ?? `nd-${seq}`,
      shopify_order_number: `${seq}`,
      customer_name: "Cliente Ultras",
      phone: overrides.phone ?? `346${String(700000 + seq).padStart(6, "0")}`,
      email: null,
      product_summary: overrides.product_summary ?? "1x Ultrasonic Cleaner",
      total_price: "39.90",
      currency: "EUR",
      address_line1: "Calle Falsa 1",
      address_line2: null,
      city: "Madrid",
      province: "Madrid",
      postal_code: "28001",
      country: "España",
      status: "pending_send",
    });
    db.markOrderConfirmed(order.id, false);
    if (overrides.closure_status) db.setOrderClosure(order.id, overrides.closure_status, "shopify");
    return db.getOrderById(order.id)!;
  };

  await test("notify-delay: isDelayNotificationEligible — confirmado + 'ultras' o 'gafa' en el producto, ni un carácter menos", () => {
    const ultras = mkConfirmedOrder({ product_summary: "1x Ultrasonic Cleaner Pro" });
    const gafa = mkConfirmedOrder({ product_summary: "1x Gafas de Sol Polarizadas" });
    const otro = mkConfirmedOrder({ product_summary: "1x Cortaúñas" });
    assert.equal(notifyDelay.isDelayNotificationEligible(ultras), true);
    assert.equal(notifyDelay.isDelayNotificationEligible(gafa), true);
    assert.equal(notifyDelay.isDelayNotificationEligible(otro), false);

    const noConfirmado = { ...ultras, status: "pending_send" as const };
    assert.equal(notifyDelay.isDelayNotificationEligible(noConfirmado), false, "solo pedidos confirmed");
  });

  await test("notify-delay: sendDelayNotificationForOrder — no elegible / sin teléfono / sin fecha / envío real con payloads contextuales", () => {
    const noElegible = mkConfirmedOrder({ product_summary: "1x Cortaúñas" });
    const r1 = notifyDelay.sendDelayNotificationForOrder(noElegible, "2026-09-15");
    assert.equal(r1.ok, false);
    assert.equal(r1.status, 409);

    const sinTelefono = mkConfirmedOrder({ product_summary: "1x Ultras Sin Tel", phone: "" });
    const r2 = notifyDelay.sendDelayNotificationForOrder(sinTelefono, "2026-09-15");
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 409);

    const sinFecha = mkConfirmedOrder({ product_summary: "1x Ultras Sin Fecha" });
    const r3 = notifyDelay.sendDelayNotificationForOrder(sinFecha, "  ");
    assert.equal(r3.ok, false);
    assert.equal(r3.status, 400);

    const o = mkConfirmedOrder({ product_summary: "1x Ultras Real" });
    const r4 = notifyDelay.sendDelayNotificationForOrder(o, "2026-09-15");
    assert.equal(r4.ok, true);
  });

  await test("notify-delay: listOrdersForDelayNotification — confirmado, con teléfono, sin cierre cancelado, sin pedidos TEST-", () => {
    const bueno = mkConfirmedOrder({ product_summary: "1x Ultras Seleccion" });
    const cancelado = mkConfirmedOrder({ product_summary: "1x Ultras Cancelado", closure_status: "cancelled" });
    const sinTelefono = mkConfirmedOrder({ product_summary: "1x Ultras SinTel2", phone: "" });
    const prueba = mkConfirmedOrder({ product_summary: "1x Ultras Prueba", shopify_order_id: `TEST-${ndSeq++}` });

    const ids = db.listOrdersForDelayNotification({}).map((o) => o.id);
    assert.ok(ids.includes(bueno.id));
    assert.ok(!ids.includes(cancelado.id));
    assert.ok(!ids.includes(sinTelefono.id));
    assert.ok(!ids.includes(prueba.id));
  });

  await test("notify-delay: excludeOrderIds excluye ids concretos", () => {
    const excluido = mkConfirmedOrder({ product_summary: "1x Ultras Excluido" });
    const incluido = mkConfirmedOrder({ product_summary: "1x Ultras Incluido" });
    const ids = db.listOrdersForDelayNotification({ excludeOrderIds: [excluido.id] }).map((o) => o.id);
    assert.ok(!ids.includes(excluido.id));
    assert.ok(ids.includes(incluido.id));
  });

  await test("notify-delay: migrateNotifyDelaySends es aditiva — correr dos veces no rompe nada", () => {
    const Database = require("better-sqlite3");
    const raw = new Database(path.join(tmpDir, "messages.db"));
    db.migrateNotifyDelaySends(raw);
    db.migrateNotifyDelaySends(raw);
    const cols = raw.prepare("PRAGMA table_info(notify_delay_sends)").all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "order_id"));
    raw.close();
  });

  await test("notify-delay: planDelayNotificationBatch filtra por elegibilidad real, detecta teléfonos compartidos y ya enviados", () => {
    const telefono = `346088880${ndSeq++}`;
    const a = mkConfirmedOrder({ product_summary: "1x Ultras Compartido A", phone: telefono });
    const b = mkConfirmedOrder({ product_summary: "1x Ultras Compartido B", phone: telefono });
    const noProducto = mkConfirmedOrder({ product_summary: "1x Cortaúñas Plan" });
    db.recordNotifyDelaySend(a.id, "batch-test", "sent");

    const plan = notifyDelay.planDelayNotificationBatch({});
    const ids = plan.items.map((i) => i.order.id);
    assert.ok(!ids.includes(noProducto.id), "el plan también filtra por elegibilidad, no solo por la SQL amplia");
    const itemA = plan.items.find((i) => i.order.id === a.id)!;
    const itemB = plan.items.find((i) => i.order.id === b.id)!;
    assert.equal(itemA.alreadySent, true);
    assert.equal(itemB.alreadySent, false);
    assert.ok(itemA.phoneSharedWith.includes(b.shopify_order_number));
  });

  await test("notify-delay: planDelayNotificationBatch con --only restringe el lote a esos ids", () => {
    const a = mkConfirmedOrder({ product_summary: "1x Ultras Only A" });
    const b = mkConfirmedOrder({ product_summary: "1x Ultras Only B" });
    const plan = notifyDelay.planDelayNotificationBatch({ onlyOrderIds: [a.id] });
    const ids = plan.items.map((i) => i.order.id);
    assert.ok(ids.includes(a.id));
    assert.ok(!ids.includes(b.id));
  });

  await test("notify-delay: sendDelayNotificationBatchItem — dry-run no escribe, real envía y registra, relanzar no reenvía", () => {
    const o = mkConfirmedOrder({ product_summary: "1x Ultras SendTest" });
    const dry = notifyDelay.sendDelayNotificationBatchItem(o, "2026-09-15", "batch-1", true);
    assert.equal(dry.outcome, "would_send");
    assert.equal(db.wasDelayNotificationSent(o.id), false, "dry-run no escribe nada");

    const real = notifyDelay.sendDelayNotificationBatchItem(o, "2026-09-15", "batch-1", false);
    assert.equal(real.outcome, "sent");
    assert.equal(db.wasDelayNotificationSent(o.id), true);

    const relanzado = notifyDelay.sendDelayNotificationBatchItem(o, "2026-09-15", "batch-2", false);
    assert.equal(relanzado.outcome, "already_sent", "relanzar el script no reenvía a quien ya recibió");
  });

  await test("notify-delay: sendDelayNotificationBatchItem respeta el gate — bloqueado sin allowlist, se reintenta si cambian las condiciones", async () => {
    const o = mkConfirmedOrder({ product_summary: "1x Ultras Gate" });
    await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "" }, () => {
      const r = notifyDelay.sendDelayNotificationBatchItem(o, "2026-09-15", "batch-gate", false);
      assert.equal(r.outcome, "blocked");
      assert.equal(db.wasDelayNotificationSent(o.id), false);
    });
    const r2 = notifyDelay.sendDelayNotificationBatchItem(o, "2026-09-15", "batch-gate-2", false);
    assert.equal(r2.outcome, "sent", "un bloqueo anterior SÍ se reintenta cuando las condiciones cambian");
  });

  await test("notify-delay: la acción notify_delay del panel exige replenishmentDate, y usa la MISMA función que el batch", async () => {
    process.env.DASHBOARD_PASSWORD = "test-owner-password";
    const actionMod = await import("../src/app/api/orders/[orderId]/action/route");
    const fakeReq = (body: unknown) => ({ json: async () => body, headers: new Headers({ authorization: `Basic ${Buffer.from("owner:test-owner-password").toString("base64")}` }) }) as unknown as Parameters<typeof actionMod.POST>[0];

    const o = mkConfirmedOrder({ product_summary: "1x Ultras Panel" });
    const resSinFecha = await actionMod.POST(fakeReq({ action: "notify_delay" }), {
      params: Promise.resolve({ orderId: String(o.id) }),
    });
    assert.equal(resSinFecha.status, 400);
    assert.equal(db.wasDelayNotificationSent(o.id), false);

    const res = await actionMod.POST(fakeReq({ action: "notify_delay", replenishmentDate: "2026-09-20" }), {
      params: Promise.resolve({ orderId: String(o.id) }),
    });
    assert.equal(res.status, 200);
  });

  await test("notify-delay: runDelayNotificationBatch cuenta sent/skipped/failed y aborta a los 3 fallos SEGUIDOS", async () => {
    const p = `346099970${ndSeq++}`;
    const o1 = mkConfirmedOrder({ product_summary: "1x Ultras Batch1", phone: p + "1" });
    const o2 = mkConfirmedOrder({ product_summary: "1x Ultras Batch2", phone: p + "2" });
    const o3 = mkConfirmedOrder({ product_summary: "1x Ultras Batch3", phone: p + "3" });
    const o4 = mkConfirmedOrder({ product_summary: "1x Ultras Batch4", phone: p + "4" });
    const o5 = mkConfirmedOrder({ product_summary: "1x Ultras Batch5", phone: p + "5" });

    let sleeps = 0;
    const idsQueFallan = new Set([o1.id, o2.id, o3.id]);
    const report = await notifyDelay.runDelayNotificationBatch({
      excludeOrderIds: [],
      replenishmentDate: "2026-09-15",
      batchId: "batch-abort-test",
      dryRun: false,
      sleep: async () => {
        sleeps++;
      },
      sendFn: (order, date, batchId, dryRun) => {
        if (idsQueFallan.has(order.id)) {
          return {
            orderId: order.id,
            orderNumber: order.shopify_order_number,
            phoneMasked: "***test",
            outcome: "error",
            error: "fallo forzado por el test",
          };
        }
        return notifyDelay.sendDelayNotificationBatchItem(order, date, batchId, dryRun);
      },
    });

    // La selección comparte tabla con el resto de tests de esta sección, así
    // que no se asume un total exacto — solo que o1/o2/o3 fallan SEGUIDOS y
    // el aborto para el lote justo ahí, antes de llegar a o4/o5 (últimos por id).
    assert.equal(report.aborted, true);
    const procesados = report.results.map((r) => r.orderId);
    assert.ok(procesados.includes(o1.id) && procesados.includes(o2.id) && procesados.includes(o3.id));
    assert.ok(!procesados.includes(o4.id) && !procesados.includes(o5.id), "el aborto para ANTES de o4/o5");
    const ultimosTres = report.results.slice(-3);
    assert.ok(ultimosTres.every((r) => r.outcome === "error"));
    assert.equal(db.wasDelayNotificationSent(o4.id), false);
    assert.equal(db.wasDelayNotificationSent(o5.id), false);
    assert.ok(sleeps > 0, "el ritmo entre envíos reales sí se respeta (sleep inyectado, sin esperar de verdad)");
  });

  // ============ CALCULADORA COD — paridad con el Excel y modelo real ============
  console.log("\n— Calculadora COD —");
  {
    const pedroModel = await import("../src/lib/cod-calculator/pedro-model");
    const realModel = await import("../src/lib/cod-calculator/real-model");
    const breakEven = await import("../src/lib/cod-calculator/break-even");
    const codScenarios = await import("../src/lib/cod-calculator/scenarios");

    /** El fixture EXACTO del Excel de Pedro (fila PELUCHE). */
    const PELUCHE = {
      salePrice: 39.99,
      productCost: 6.5,
      vatRate: 0,
      rawCPA: 5,
      shippingRate: 0.9,
      deliveryRate: 0.7,
      outboundShippingCost: 5.5,
      codFee: 0.7,
      returnCost: 4.5,
    };
    const cerca = (a: number | null, b: number, tol = 1e-6, msg = "") => {
      assert.ok(a !== null, `${msg}: no debería ser null`);
      assert.ok(Math.abs(a! - b) < tol, `${msg}: ${a} vs ${b} esperado`);
    };

    await test("cod-calculator-excel-parity: PELUCHE reproduce EXACTAMENTE los números del Excel de Pedro", () => {
      const r = pedroModel.calculatePedroModel(PELUCHE);
      cerca(r.vat, 0, 1e-9, "IVA");
      cerca(r.realCPA, 7.936507937, 1e-6, "CPA REAL");
      cerca(r.expectedShippingCost, 7.34, 1e-9, "GASTOS ENVÍO");
      cerca(r.profit, 12.74944444, 1e-6, "PROFIT");
      cerca(r.margin, 0.3188158151, 1e-8, "MARGEN");
      cerca(r.roi, 1.961452991, 1e-7, "ROI");
      cerca(r.afterIrpf, 10.19955556, 1e-6, "SIN IRPF");
      // Y lo que ve Pedro en pantalla, redondeado como en el Excel.
      assert.equal(r.realCPA!.toFixed(2), "7.94");
      assert.equal(r.expectedShippingCost.toFixed(2), "7.34");
      assert.equal(r.profit!.toFixed(2), "12.75");
      assert.equal((r.margin! * 100).toFixed(2), "31.88");
      assert.equal((r.roi! * 100).toFixed(2), "196.15");
      assert.equal(r.afterIrpf!.toFixed(2), "10.20");
    });

    await test("COD Pedro: IVA se aplica AL COSTE (rareza del Excel, conservada a propósito)", () => {
      const r = pedroModel.calculatePedroModel({ ...PELUCHE, vatRate: 0.21 });
      cerca(r.vat, 6.5 * 0.21, 1e-9, "IVA sobre COSTE, no sobre precio");
    });

    await test("COD Pedro: divisiones por cero devuelven null (el Excel pinta #DIV/0!, la web '—')", () => {
      const sinEntrega = pedroModel.calculatePedroModel({ ...PELUCHE, deliveryRate: 0 });
      assert.equal(sinEntrega.realCPA, null, "entrega 0 → CPA real indefinido");
      assert.equal(sinEntrega.profit, null);
      assert.equal(sinEntrega.margin, null);
      assert.equal(sinEntrega.afterIrpf, null);
      const sinEnvio = pedroModel.calculatePedroModel({ ...PELUCHE, shippingRate: 0 });
      assert.equal(sinEnvio.profit, null, "envío 0 → indefinido");
      const sinCoste = pedroModel.calculatePedroModel({ ...PELUCHE, productCost: 0 });
      assert.equal(sinCoste.roi, null, "coste 0 → ROI indefinido, NUNCA Infinity");
      // Ni un solo NaN/Infinity puede salir hacia la UI.
      for (const v of [sinEntrega.expectedShippingCost, sinCoste.profit ?? 0, sinCoste.vat]) {
        assert.ok(Number.isFinite(v), "ningún valor puede ser NaN ni Infinity");
      }
    });

    await test("COD Pedro: entrega 100% y CPA 0 dan los extremos correctos", () => {
      const total = pedroModel.calculatePedroModel({ ...PELUCHE, deliveryRate: 1, shippingRate: 1 });
      cerca(total.realCPA, 5, 1e-9, "sin pérdidas, CPA real = CPA");
      cerca(total.expectedShippingCost, 5.5 + 0.7, 1e-9, "sin devoluciones");
      cerca(total.profit, 39.99 - 6.5 - 5 - 6.2, 1e-9, "profit sin mermas");
      const gratis = pedroModel.calculatePedroModel({ ...PELUCHE, rawCPA: 0 });
      cerca(gratis.realCPA, 0, 1e-9, "CPA 0 no rompe");
      assert.ok(gratis.profit! > pedroModel.calculatePedroModel(PELUCHE).profit!);
    });

    await test("COD Pedro: CPA alto produce PÉRDIDA (profit negativo, sin trampas)", () => {
      const r = pedroModel.calculatePedroModel({ ...PELUCHE, rawCPA: 25 });
      assert.ok(r.profit! < 0, "con CPA 25 € el pedido pierde dinero");
      assert.ok(r.margin! < 0);
    });

    await test("COD Real: escenario de 100 pedidos — el embudo y cada coste en su evento", () => {
      const r = realModel.calculateRealCODModel(PELUCHE, 100);
      assert.equal(r.created, 100);
      assert.equal(r.sent, 90, "100 × 90% de envío");
      assert.equal(r.delivered, 63, "90 × 70% de entrega");
      assert.equal(r.notDelivered, 27);
      cerca(r.revenue, 63 * 39.99, 0.01, "ingreso solo de ENTREGADOS");
      cerca(r.ads, 100 * 5, 0.01, "ads por pedido CREADO");
      cerca(r.productCost, 90 * 6.5, 0.01, "producto por ENVIADO (recuperación 0 por defecto)");
      cerca(r.outboundShipping, 90 * 5.5, 0.01, "envío de ida por ENVIADO");
      cerca(r.codFees, 63 * 0.7, 0.01, "COD por ENTREGADO");
      cerca(r.returnCosts, 27 * 4.5, 0.01, "devolución por NO entregado");
      const esperado = 63 * 39.99 - 500 - 90 * 6.5 - 90 * 5.5 - 63 * 0.7 - 27 * 4.5;
      cerca(r.profit100, Math.round(esperado * 100) / 100, 0.02, "beneficio por 100 pedidos");
      cerca(r.profitPerOrder, esperado / 100, 0.01, "por pedido creado");
      cerca(r.profitPerSent, esperado / 90, 0.01, "por enviado");
      cerca(r.profitPerDelivered, esperado / 63, 0.01, "por entregado");
      assert.match(r.fiscalNote, /fiscal/i, "el modelo real DECLARA que no aplica fiscalidad");
    });

    await test("COD Real: la recuperación de producto devuelto es EXPLÍCITA, nunca asumida", () => {
      const sinRecuperar = realModel.calculateRealCODModel(PELUCHE, 100);
      const recuperando = realModel.calculateRealCODModel({ ...PELUCHE, returnedProductRecoveryRate: 1 }, 100);
      cerca(sinRecuperar.productRecovered, 0, 1e-9, "por defecto NO se recupera nada");
      cerca(recuperando.productRecovered, 27 * 6.5, 0.01, "al 100% se recupera el coste de los devueltos");
      assert.ok(recuperando.profit100 > sinRecuperar.profit100);
    });

    await test("COD Real: los dos modelos DIFIEREN — el Real no aplica dos veces la probabilidad", () => {
      const p = pedroModel.calculatePedroModel(PELUCHE).profit!;
      const r = realModel.calculateRealCODModel(PELUCHE, 100).profitPerOrder!;
      assert.ok(Math.abs(p - r) > 0.5, `los modelos deben diferir de forma visible (Pedro ${p}, Real ${r})`);
      // Ambos son POSITIVOS con el fixture: la diferencia es de semántica,
      // no de "uno está roto". Documentado en docs/FINANCE-MODEL.md.
      assert.ok(p > 0 && r > 0);
    });

    await test("COD break-even: entrega y CPA de equilibrio anulan el beneficio (verificado sustituyendo)", () => {
      for (const modelo of ["pedro", "real"] as const) {
        const be = breakEven.computeBreakEven(modelo, PELUCHE, 0.1);
        assert.ok(be.deliveryRateBreakEven !== null, `${modelo}: debe existir entrega de equilibrio`);
        assert.ok(be.cpaBreakEven !== null, `${modelo}: debe existir CPA de equilibrio`);
        // Sustituir el break-even devuelve profit ~0: la prueba de que el
        // solucionador resuelve el modelo REAL, no una fórmula paralela.
        const enEquilibrio = breakEven.profitPerOrder(modelo, { ...PELUCHE, deliveryRate: be.deliveryRateBreakEven! });
        cerca(enEquilibrio, 0, 1e-4, `${modelo}: profit en la entrega de equilibrio`);
        const conCpaLimite = breakEven.profitPerOrder(modelo, { ...PELUCHE, rawCPA: be.cpaBreakEven! });
        cerca(conCpaLimite, 0, 1e-4, `${modelo}: profit con el CPA máximo`);
        // Un punto por debajo del break-even ya pierde dinero.
        const peor = breakEven.profitPerOrder(modelo, { ...PELUCHE, deliveryRate: be.deliveryRateBreakEven! - 0.01 });
        assert.ok(peor! < 0, `${modelo}: por debajo del break-even se pierde dinero`);
      }
    });

    await test("COD break-even: precio mínimo y coste máximo también anulan el beneficio", () => {
      const be = breakEven.computeBreakEven("real", PELUCHE, 0.1);
      cerca(breakEven.profitPerOrder("real", { ...PELUCHE, salePrice: be.minSalePrice! }), 0, 1e-4, "precio mínimo");
      cerca(breakEven.profitPerOrder("real", { ...PELUCHE, productCost: be.maxProductCost! }), 0, 1e-4, "coste máximo");
    });

    await test("COD objetivo de margen: los valores devueltos alcanzan EXACTAMENTE el margen pedido", () => {
      const objetivo = 0.1;
      const be = breakEven.computeBreakEven("real", PELUCHE, objetivo);
      assert.ok(be.cpaForTargetMargin !== null && be.deliveryForTargetMargin !== null);
      cerca(breakEven.marginOf("real", { ...PELUCHE, rawCPA: be.cpaForTargetMargin! }), objetivo, 1e-4, "CPA para el objetivo");
      cerca(breakEven.marginOf("real", { ...PELUCHE, deliveryRate: be.deliveryForTargetMargin! }), objetivo, 1e-4, "entrega para el objetivo");
      // Exigir MÁS margen obliga a pagar MENOS por pedido.
      const exigente = breakEven.computeBreakEven("real", PELUCHE, 0.2);
      assert.ok(exigente.cpaForTargetMargin! < be.cpaForTargetMargin!);
    });

    await test("COD break-even: cuando NO existe solución devuelve null, jamás una cifra inventada", () => {
      // Producto que pierde dinero incluso entregando el 100%: ninguna tasa
      // de entrega lo salva.
      const imposible = { ...PELUCHE, salePrice: 8, productCost: 6.5, rawCPA: 12 };
      const be = breakEven.computeBreakEven("real", imposible, 0.1);
      assert.equal(be.deliveryRateBreakEven, null, "no hay entrega que lo haga rentable");
      assert.ok(be.cpaForTargetMargin === null || be.cpaForTargetMargin >= 0);
    });

    await test("COD semáforo: verde / ámbar / rojo con TEXTO, no solo color", () => {
      const verde = breakEven.trafficLight("real", PELUCHE, 0.05);
      assert.equal(verde.light, "green");
      assert.match(verde.headline, /RENTABLE/);
      assert.match(verde.detail, /€ por pedido creado/);
      const rojo = breakEven.trafficLight("real", { ...PELUCHE, rawCPA: 30 }, 0.1);
      assert.equal(rojo.light, "red");
      assert.match(rojo.headline, /PÉRDIDAS/);
      const ambar = breakEven.trafficLight("real", PELUCHE, 0.9);
      assert.equal(ambar.light, "amber", "objetivo altísimo: rentable pero por debajo del objetivo");
      assert.match(ambar.detail, /margen/);
      const sinDatos = breakEven.trafficLight("pedro", { ...PELUCHE, deliveryRate: 0 }, 0.1);
      assert.equal(sinDatos.light, "unknown");
    });

    await test("COD sensibilidad: la matriz cubre CPA × entrega y ninguna celda es NaN", () => {
      const cpas = [4, 5, 6, 7, 8];
      const entregas = [0.6, 0.65, 0.7, 0.75, 0.8];
      const m = breakEven.computeSensitivityMatrix("real", PELUCHE, cpas, entregas);
      assert.equal(m.length, 5);
      assert.equal(m[0].length, 5);
      for (const fila of m) {
        for (const celda of fila) {
          assert.ok(celda.profitPerOrder === null || Number.isFinite(celda.profitPerOrder), "ni NaN ni Infinity");
        }
      }
      // Monotonía: más CPA = menos beneficio; más entrega = más beneficio.
      assert.ok(m[0][2].profitPerOrder! > m[4][2].profitPerOrder!, "CPA 4 € rinde más que CPA 8 €");
      assert.ok(m[2][4].profitPerOrder! > m[2][0].profitPerOrder!, "80% de entrega rinde más que 60%");
    });

    await test("COD proyección: mantiene las tasas y SIEMPRE lo advierte", () => {
      const p = breakEven.projectMonthly("real", PELUCHE, 20);
      assert.equal(p.ordersPerMonth, 600);
      assert.equal(p.sentPerMonth, 540);
      assert.equal(p.deliveredPerMonth, 378);
      cerca(p.ads, 600 * 5, 0.01, "gasto de ads del mes");
      assert.match(p.note, /manteniendo constantes/, "la advertencia es obligatoria");
      const doble = breakEven.projectMonthly("real", PELUCHE, 40);
      cerca(doble.profitPerMonth, p.profitPerMonth! * 2, 0.05, "el doble de pedidos, el doble de beneficio a tasas constantes");
    });

    await test("COD escenarios: guardar, duplicar y borrar NUNCA tocan datos reales", () => {
      const antesCostes = db.listProductCosts().length;
      const antesAjustes = db.getSetting("cod_calc_shipping_cost");
      const id = codScenarios.saveCodScenario({
        name: "PELUCHE CPA 6€",
        productSku: "PELUCHE",
        modelType: "real",
        assumptions: { ...PELUCHE, rawCPA: 6 },
      });
      assert.ok(id > 0);
      const lista = codScenarios.listCodScenarios();
      const guardado = lista.find((s) => s.id === id)!;
      assert.equal(guardado.name, "PELUCHE CPA 6€");
      assert.equal(JSON.parse(guardado.assumptions_json).rawCPA, 6);
      const copia = codScenarios.duplicateCodScenario(id)!;
      assert.match(codScenarios.listCodScenarios().find((s) => s.id === copia)!.name, /copia/);
      codScenarios.deleteCodScenario(copia);
      assert.ok(!codScenarios.listCodScenarios().some((s) => s.id === copia));
      // La prueba que importa: simular no ha cambiado NADA del mundo real.
      assert.equal(db.listProductCosts().length, antesCostes, "product_costs intacto");
      assert.equal(db.getSetting("cod_calc_shipping_cost"), antesAjustes, "settings intactos");
      codScenarios.deleteCodScenario(id);
    });

    await test("COD escenarios: la migración v15 es idempotente y el nombre vacío se rechaza", () => {
      db.migrateCodScenarios(db.systemDbHandle());
      db.migrateCodScenarios(db.systemDbHandle());
      assert.throws(() => codScenarios.saveCodScenario({ name: "   ", modelType: "real", assumptions: PELUCHE }), /nombre/);
    });

    await test("COD auto-inputs: cada tasa llega con su DENOMINADOR y su muestra, o null si no hay datos", async () => {
      const auto = await import("../src/lib/cod-calculator/auto-inputs");
      const entrega = auto.deliveryRateAuto(30);
      assert.ok(["real"].includes(entrega.source));
      assert.ok(entrega.detail !== null, "siempre explica de dónde sale");
      assert.ok(entrega.value === null || (entrega.value >= 0 && entrega.value <= 1), "fracción o null, nunca NaN");
      const envio = auto.shippingRateAuto(30);
      assert.ok(envio.value === null || (envio.value >= 0 && envio.value <= 1));
      assert.ok((envio.detail ?? "").length > 0);
      // Sin Meta Ads configurado en los tests, el CPA cae a manual y lo DICE.
      const cpa = auto.cpaAuto(7);
      assert.ok(cpa.value === null || Number.isFinite(cpa.value));
      assert.ok((cpa.detail ?? "").length > 0);
      const defaults = auto.codDefaults();
      assert.equal(defaults.outboundShippingCost, 5.5, "default del Excel de Pedro");
      assert.equal(defaults.codFee, 0.7);
      assert.equal(defaults.returnCost, 4.5);
    });

    await test("COD alerta §36: el break-even NO está hardcodeado — sale del modelo y gradúa warning/critical", async () => {
      const alerts = await import("../src/lib/system/business-alerts");
      const holgado = alerts.evalDeliveryVsBreakEven(75, 62.9, 100);
      assert.equal(holgado.status, "healthy");
      assert.match(holgado.message, /colchón/);
      const justo = alerts.evalDeliveryVsBreakEven(65, 62.9, 100);
      assert.equal(justo.status, "warning");
      assert.match(justo.message, /2\.1 puntos|2,1 puntos/);
      const critico = alerts.evalDeliveryVsBreakEven(60, 62.9, 100);
      assert.equal(critico.status, "critical");
      const muestraCorta = alerts.evalDeliveryVsBreakEven(75, 62.9, 3);
      assert.equal(muestraCorta.status, "unknown", "3 pedidos no deciden si escalar o parar");
      const sinBreakEven = alerts.evalDeliveryVsBreakEven(75, null, 100);
      assert.equal(sinBreakEven.status, "unknown");
    });
  }

  // ============ V3 FASE A · WhatsApp: mapping lógico→WABA (incidente 132001) ============
  console.log("\n— V3 · WhatsApp: plantillas reales de la WABA —");
  {
    const tpl = await import("../src/lib/whatsapp/templates");
    const { buildConfirmationOutbound } = await import("../src/lib/whatsapp/interactive");
    const sysRepo = await import("../src/lib/system/repo");
    const VERIF_KEY = "wa_tpl_verified:order_confirmation_request";
    const limpiarVerificacion = () => {
      db.systemDbHandle().prepare("DELETE FROM settings WHERE key = ?").run(VERIF_KEY);
    };
    const verificar = (over: Partial<import("../src/lib/whatsapp/templates").VerifiedTemplate> = {}) =>
      tpl.storeVerifiedTemplate("order_confirmation_request", {
        provider: "confirmacion_pedido_cod",
        language: "es",
        status: "APPROVED",
        paramCount: 4,
        buttonCount: 3,
        buttonTypes: ["QUICK_REPLY", "QUICK_REPLY", "QUICK_REPLY"],
        category: "UTILITY",
        verifiedAt: Math.floor(Date.now() / 1000),
        ...over,
      });

    await test("132001 ROJO: sin verificación, la confirmación NO se construye — y el bloqueante es explícito", () => {
      limpiarVerificacion();
      const r = tpl.getTemplateReadiness("order_confirmation_request");
      assert.equal(r.ready, false);
      assert.equal(r.blocker, "FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED");
      assert.match(r.detail, /whatsapp:templates:doctor/, "el bloqueante dice QUÉ ejecutar");
      assert.throws(
        () =>
          tpl.buildApprovedTemplateMessage("order_confirmation_request", {
            nombre: "Marta",
            numero_pedido: "#1042",
            producto: "Limpiador",
            importe: "29,99 €",
          }),
        (e: unknown) => e instanceof tpl.TemplateNotReadyError && e.blocker === "FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED"
      );
    });

    await test("132001 VERDE: verificada 'confirmacion_pedido_cod' (es, 4 vars) → el mensaje sale con el nombre REAL de la WABA, jamás el borrador local ni 'pedido' (la plantilla de ejemplo de Meta, origen del incidente)", () => {
      verificar();
      const o = mkOrder("v3wa-1", "94101", "34600994101");
      const spec = buildConfirmationOutbound(o, false); // fuera de ventana → plantilla
      assert.equal(spec.message.kind, "template");
      const m = spec.message as Extract<import("../src/lib/whatsapp/provider").OutboundWhatsAppMessage, { kind: "template" }>;
      assert.equal(m.templateName, "confirmacion_pedido_cod", "el nombre que viaja a Meta es el APROBADO");
      assert.notEqual(m.templateName, "order_confirmation_request", "el nombre del borrador local JAMÁS sale");
      assert.notEqual(m.templateName, "pedido", "ni la plantilla de ejemplo de Meta — era el mapping erróneo que causó el 132001");
      assert.equal(m.language, "es");
      assert.equal(m.bodyParams.length, 4);
      assert.equal(m.bodyParams[0], "Cliente", "nombre de pila");
      assert.equal(m.bodyParams[1], "#94101", "número de pedido, con # — {{2}} de la plantilla real");
      assert.equal((m.buttonPayloads ?? []).length, 3, "payloads locales para los 3 botones reales");
    });

    await test("132001: dentro de ventana SIN verificación, el interactivo sale igual (solo se pierde la degradación tardía)", () => {
      limpiarVerificacion();
      const o = mkOrder("v3wa-2", "94102", "34600994102");
      const spec = buildConfirmationOutbound(o, true);
      assert.equal(spec.message.kind, "interactive_buttons", "dentro de ventana no hace falta plantilla");
      assert.equal(spec.templateFallback, undefined, "sin plantilla verificada no se adjunta fallback");
    });

    await test("132001: aridad distinta, estado no APPROVED o verificación obsoleta → BLOQUEADO con su motivo exacto", () => {
      verificar({ paramCount: 1 });
      assert.equal(tpl.getTemplateReadiness("order_confirmation_request").blocker, "TEMPLATE_ARITY_MISMATCH");
      verificar({ status: "PENDING" });
      assert.equal(tpl.getTemplateReadiness("order_confirmation_request").blocker, "FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED");
      verificar({ provider: "pedido_confirmado" });
      assert.equal(tpl.getTemplateReadiness("order_confirmation_request").blocker, "TEMPLATE_VERIFICATION_STALE");
      verificar({ buttonCount: 1, buttonTypes: ["URL"] });
      assert.equal(tpl.getTemplateReadiness("order_confirmation_request").blocker, "TEMPLATE_BUTTONS_MISMATCH");
      verificar(); // dejar verificada para los siguientes
      assert.equal(tpl.getTemplateReadiness("order_confirmation_request").ready, true);
    });

    await test("SCHEDULER · inanición de cola (P1 real): 25 pedidos atascados delante NO impiden procesar el nuevo del piloto", async () => {
      // Causa raíz del flake "132001" y de un bug REAL de producción: las colas
      // se leían con LIMIT 20 por fecha y los pedidos que el tick se salta sin
      // cambiar estado (fuera de allowlist en TEST_MODE) se quedaban delante
      // para siempre. Con 20 de esos, el pedido allowlisted más nuevo jamás
      // entraba en el LIMIT: en producción (TEST_MODE=1 desde semanas) el
      // pedido del piloto nunca habría recibido su WhatsApp.
      limpiarVerificacion();
      const telefono = "34600994150";
      const h = db.systemDbHandle();
      for (let i = 0; i < 25; i++) {
        const atascado = mkOrder(`starve-${i}`, `95${String(i).padStart(3, "0")}`, `3460071${String(i).padStart(4, "0")}`);
        // más antiguos que el objetivo, con created_at DISTINTO (como en producción)
        h.prepare("UPDATE orders SET created_at = created_at - ? WHERE id = ?").run(2000 - i, atascado.id);
      }
      const objetivo = mkOrder("starve-target", "95999", telefono);
      const eventos = () =>
        (h.prepare("SELECT COUNT(*) c FROM integration_events WHERE event_type='template_not_ready' AND order_ref='95999'").get() as { c: number }).c;
      const antes = eventos();
      await withEnv(
        {
          WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_API_ENABLED: "1", META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
          META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real", APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1",
          TEST_MODE: "1", TEST_PHONE_ALLOWLIST: telefono, WHATSAPP_WINDOW_ENABLED: "0", EMERGENCY_STOP: "0",
        },
        async () => {
          const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
          await runSchedulerTick();
          assert.ok(eventos() > antes, "el pedido nuevo se PROCESA aunque haya 25 atascados delante (bloqueado con motivo, no invisible)");
          assert.equal(db.getOrderById(objetivo.id)!.status, "pending_send", "bloqueado por plantilla: no se consume");
          verificar();
          await runSchedulerTick();
          const tras = db.getOrderById(objetivo.id)!;
          assert.ok(tras.whatsapp_sent_at !== null, "verificada la plantilla, SALE — sin que nadie tenga que vaciar la cola a mano");
          assert.equal(tras.status, "awaiting_reply");
        }
      );
      // Los 25 atascados siguen exactamente igual: no se les hizo nada.
      const atascados = (h.prepare("SELECT COUNT(*) c FROM orders WHERE shopify_order_id LIKE 'starve-%' AND status='pending_send' AND whatsapp_sent_at IS NULL").get() as { c: number }).c;
      assert.equal(atascados, 25, "ni un envío fuera de la allowlist");
    });

    await test("WHATSAPP · recordatorio en cloud_api sale como PLANTILLA (recordatorio_confirmacion); sin verificación se RETIENE sin consumir el claim", async () => {
      // Bug real (03-09): el recordatorio salía como texto libre. Va a quien NO
      // ha contestado → siempre fuera de la ventana de 24 h → Meta lo rechaza
      // y el claim ya estaba consumido: el cliente nunca lo recibía.
      const tel = "34600994160";
      const o = mkOrder("v3wa-rem", "94160", tel);
      const h = db.systemDbHandle();
      h.prepare("UPDATE orders SET status='awaiting_reply', whatsapp_sent_at = unixepoch() - 120, customer_replied_at = NULL WHERE id=?").run(o.id); // la suite corre con FIRST_REMINDER_MINUTES=1 y NEEDS_CALL_MINUTES=3
      h.prepare("DELETE FROM settings WHERE key='wa_tpl_verified:order_reminder'").run();
      const eventos = () => (h.prepare("SELECT COUNT(*) c FROM integration_events WHERE event_type='template_not_ready' AND order_ref='94160'").get() as { c: number }).c;
      const env = { WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_API_ENABLED: "1", META_WHATSAPP_PHONE_NUMBER_ID: "111222333", META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real", APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, WHATSAPP_WINDOW_ENABLED: "0", EMERGENCY_STOP: "0" };
      await withEnv(env, async () => {
        const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
        const antes = eventos();
        await runSchedulerTick();
        const r1 = db.getOrderById(o.id)!;
        assert.equal(r1.status, "awaiting_reply", "sin plantilla verificada NO se consume el claim del recordatorio");
        assert.equal(r1.reminder_sent_at, null);
        assert.ok(eventos() > antes, "queda rastro visible: recordatorio BLOQUEADO con motivo");
        tpl.storeVerifiedTemplate("order_reminder", { provider: "recordatorio_confirmacion", language: "es", status: "APPROVED", paramCount: 2, buttonCount: 2, buttonTypes: ["QUICK_REPLY", "QUICK_REPLY"], category: "UTILITY", verifiedAt: Math.floor(Date.now() / 1000) });
        await runSchedulerTick();
        const r2 = db.getOrderById(o.id)!;
        assert.equal(r2.status, "reminder_sent", "verificada la plantilla, el recordatorio SALE");
        const fila = h.prepare("SELECT message_type, template_name, payload_json FROM outbox WHERE phone=? ORDER BY id DESC LIMIT 1").get(tel) as { message_type: string; template_name: string | null; payload_json: string | null };
        assert.equal(fila.message_type, "template", "en cloud_api el recordatorio es una PLANTILLA, no texto");
        assert.equal(fila.template_name, "recordatorio_confirmacion");
        assert.match(fila.payload_json ?? "", /confirm_order/, "con sus botones (confirmar / cambiar dirección)");
        await runSchedulerTick();
        assert.equal(db.getOrderById(o.id)!.status, "reminder_sent", "un solo recordatorio, jamás dos");
      });
      h.prepare("DELETE FROM settings WHERE key='wa_tpl_verified:order_reminder'").run();
    });

    await test("SCHEDULER · un tick envía como máximo MAX_ACTIONS_PER_TICK y el siguiente continúa por donde iba", async () => {
      verificar();
      const sched = await import("../src/lib/orders/scheduler");
      const tels: string[] = [];
      for (let i = 0; i < 25; i++) {
        const t = `3460072${String(i).padStart(4, "0")}`;
        tels.push(t);
        mkOrder(`cap-${i}`, `96${String(i).padStart(3, "0")}`, t);
      }
      await withEnv(
        {
          WHATSAPP_PROVIDER: "cloud_api", META_WHATSAPP_API_ENABLED: "1", META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
          META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real", APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1",
          TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tels.join(","), WHATSAPP_WINDOW_ENABLED: "0", EMERGENCY_STOP: "0",
        },
        async () => {
          const r1 = await sched.runSchedulerTick();
          assert.equal(r1.sent, sched.MAX_ACTIONS_PER_TICK, "tope de envíos por tick");
          const r2 = await sched.runSchedulerTick();
          assert.equal(r2.sent, 25 - sched.MAX_ACTIONS_PER_TICK, "el resto sale en el tick siguiente: nadie se queda atrás");
          const r3 = await sched.runSchedulerTick();
          assert.equal(r3.sent, 0, "y no se reenvía nada");
        }
      );
      const enviados = (db.systemDbHandle().prepare("SELECT COUNT(*) c FROM orders WHERE shopify_order_id LIKE 'cap-%' AND status='awaiting_reply'").get() as { c: number }).c;
      assert.equal(enviados, 25, "cada pedido exactamente una vez");
    });

    await test("TEMPLATES · una sola fuente de verdad para resolver la spec: doctor, readiness y builder coinciden", () => {
      verificar();
      // A · spec por clave lógica
      const conf = tpl.loadProviderMappings().find((m) => m.logicalKey === "order_confirmation_request")!;
      assert.equal(tpl.resolveMappingSpec(conf)!.name, "order_confirmation_request");
      // B · sin spec por clave lógica, con spec por nombre real
      const delay = tpl.loadProviderMappings().find((m) => m.logicalKey === "order_delay_restock")!;
      assert.equal(tpl.getTemplateSpec("order_delay_restock"), null);
      assert.equal(tpl.resolveMappingSpec(delay)!.name, "retraso_pedido");
      // C · el builder usa el MISMO resolver y conserva payloads
      tpl.storeVerifiedTemplate("order_delay_restock", { provider: "retraso_pedido", language: "es", status: "APPROVED", paramCount: 4, buttonCount: 2, buttonTypes: ["QUICK_REPLY", "QUICK_REPLY"], category: "UTILITY", verifiedAt: Math.floor(Date.now() / 1000) });
      // Sin order_id el payload de los botones quedaría sin resolver → NO se construye (fail-closed).
      assert.throws(
        () => tpl.buildApprovedTemplateMessage("order_delay_restock", { nombre: "Ana", numero_pedido: "#1", producto: "X", fecha_reposicion: "hoy" }),
        /TEMPLATE_BUTTON_PAYLOAD_UNRESOLVED|sin resolver/,
        "un botón sin payload válido se vería igual pero no haría nada: mejor no enviar"
      );
      const m = tpl.buildApprovedTemplateMessage("order_delay_restock", { nombre: "Ana", numero_pedido: "#1", producto: "X", fecha_reposicion: "hoy", order_id: "4242" });
      assert.equal(m.templateName, "retraso_pedido");
      assert.deepEqual(m.buttonPayloads, ["delay_ok:4242", "delay_cancel:4242"], "los 2 botones llevan EXACTAMENTE el payload que atienden los handlers delay_ok:<id>/delay_cancel:<id>");
      // Y coinciden con lo que el sender real adjunta a mano (notify-delay.ts).
      const notify = fs.readFileSync(path.join(process.cwd(), "src/lib/orders/notify-delay.ts"), "utf8");
      assert.match(notify, /`delay_ok:\$\{order\.id\}`, `delay_cancel:\$\{order\.id\}`/);
      const c = tpl.buildApprovedTemplateMessage("order_confirmation_request", { nombre: "Ana", numero_pedido: "#1", producto: "X", importe: "1 €" });
      assert.deepEqual(c.buttonPayloads, ["confirm_order", "change_address", "delivery_note"]);
      assert.equal(tpl.getTemplateReadiness("order_delay_restock").ready, true, "readiness cuadra con la WABA real (2 botones)");
      // D · disabled → no construye nada enviable
      assert.throws(() => tpl.buildApprovedTemplateMessage("order_cancelled_ack", { nombre: "x", numero_pedido: "#1" }), /DESHABILITADO|no lista/i);
      // E · inexistente → fail-closed
      assert.throws(() => tpl.buildApprovedTemplateMessage("no_existe_este_mapping", {}), /no lista|mapping/i);
      assert.equal(tpl.getTemplateReadiness("no_existe_este_mapping").blocker, "TEMPLATE_MAPPING_MISSING");
      db.systemDbHandle().prepare("DELETE FROM settings WHERE key = 'wa_tpl_verified:order_delay_restock'").run();
    });

    await test("132001: el scheduler en cloud_api con plantilla bloqueada NO consume el pedido y deja rastro visible", async () => {
      limpiarVerificacion();
      const telefono = "34600994103";
      const o = mkOrder("v3wa-3", "94103", telefono);
      const eventosDelPedido = () =>
        sysRepo.listIntegrationEvents({ limit: 2000 }).filter((e) => e.event_type === "template_not_ready" && e.order_ref === "94103").length;
      const eventosAntes = eventosDelPedido();
      await withEnv(
        {
          WHATSAPP_PROVIDER: "cloud_api",
          META_WHATSAPP_API_ENABLED: "1",
          META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
          META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real",
          APP_MODE: "production",
          WHATSAPP_SEND_ENABLED: "1",
          TEST_MODE: "1",
          TEST_PHONE_ALLOWLIST: telefono,
          WHATSAPP_WINDOW_ENABLED: "0",
          EMERGENCY_STOP: "0",
        },
        async () => {
          const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
          // El logOnce interno del scheduler puede tragarse un log repetido,
          // pero el EVENTO debe aparecer: reintento acotado por si otro test
          // dejó el tick a mitad (idempotente: el pedido no se consume).
          for (let i = 0; i < 3 && eventosDelPedido() === eventosAntes; i++) {
            await runSchedulerTick();
          }
        }
      );
      const despues = db.getOrderById(o.id)!;
      assert.equal(despues.status, "pending_send", "el pedido NO se consume: se enviará cuando la plantilla esté verificada");
      assert.equal(despues.whatsapp_sent_at, null, "no hay sello de envío");
      assert.ok(eventosDelPedido() > eventosAntes, "queda un evento template_not_ready (nada de 404 silenciosos en bucle)");
      const evento = sysRepo.listIntegrationEvents({ limit: 2000 }).find((e) => e.event_type === "template_not_ready" && e.order_ref === "94103")!;
      assert.match(evento.message, /FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED/);
      // Y con la plantilla verificada, el MISMO pedido sale en el siguiente tick.
      verificar();
      await withEnv(
        {
          WHATSAPP_PROVIDER: "cloud_api",
          META_WHATSAPP_API_ENABLED: "1",
          META_WHATSAPP_PHONE_NUMBER_ID: "111222333",
          META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real",
          APP_MODE: "production",
          WHATSAPP_SEND_ENABLED: "1",
          TEST_MODE: "1",
          TEST_PHONE_ALLOWLIST: telefono,
          WHATSAPP_WINDOW_ENABLED: "0",
          EMERGENCY_STOP: "0",
        },
        async () => {
          const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
          await runSchedulerTick();
        }
      );
      const enviado = db.getOrderById(o.id)!;
      assert.ok(enviado.whatsapp_sent_at !== null, "verificada la plantilla, el pedido bloqueado SALE sin tocar nada más");
      assert.equal(enviado.status, "awaiting_reply");
    });

    await test("rollout: bucket determinista y monotónico — subir la rampa AÑADE clientes, nunca cambia a los que ya estaban", async () => {
      const safety2 = await import("../src/lib/safety");
      const b1 = safety2.rolloutBucket("+34 600 11 12 22");
      const b2 = safety2.rolloutBucket("34600111222");
      assert.equal(b1, b2, "el mismo teléfono en distinto formato cae en el MISMO bucket");
      assert.ok(b1 >= 0 && b1 < 100);
      // Monotonía: quien entra al 25% sigue dentro al 50% y al 100%.
      const telefonos = Array.from({ length: 200 }, (_, i) => `346${String(10000000 + i)}`);
      const dentro25 = telefonos.filter((t) => safety2.rolloutBucket(t) < 25);
      const dentro50 = new Set(telefonos.filter((t) => safety2.rolloutBucket(t) < 50));
      for (const t of dentro25) assert.ok(dentro50.has(t), "25% ⊂ 50%");
      // Y reparte de verdad (ni 0% ni 100% con umbral 25).
      assert.ok(dentro25.length > 20 && dentro25.length < 80, `reparto razonable (${dentro25.length}/200 al 25%)`);
    });

    await test("rollout: default 'pilot' = comportamiento EXACTO de hoy; 100 abre a todos; solo settings lo cambia", async () => {
      const safety2 = await import("../src/lib/safety");
      db.systemDbHandle().prepare("DELETE FROM settings WHERE key = 'whatsapp_rollout_percent'").run();
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, () => {
        assert.equal(safety2.phoneAllowed("34600111222"), true, "la allowlist sigue mandando");
        assert.equal(safety2.phoneAllowed("34699999999"), false, "sin rampa, fuera de allowlist = NO (fail-closed)");
      });
      db.setSetting("whatsapp_rollout_percent", "100");
      try {
        await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600111222" }, () => {
          assert.equal(safety2.phoneAllowed("34699999999"), true, "al 100%, cualquier teléfono válido entra");
          assert.equal(safety2.phoneAllowed(""), false, "sin teléfono válido, jamás");
        });
        db.setSetting("whatsapp_rollout_percent", "porcentaje-raro");
        await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "" }, () => {
          assert.equal(safety2.phoneAllowed("34699999999"), false, "un valor raro = pilot (fail-closed), no un número a medias");
        });
      } finally {
        db.systemDbHandle().prepare("DELETE FROM settings WHERE key = 'whatsapp_rollout_percent'").run();
      }
    });

    limpiarVerificacion();
  }

  // ============ V3 FASE B · Tracking: gate ANTES del claim + fail-closed de datos ============
  console.log("\n— V3 · Tracking: claim tras el gate, datos completos o nada —");
  {
    const trackingNotif = await import("../src/lib/tracking/notifications");
    const trackingSvc = await import("../src/lib/tracking/service");
    const sysRepo = await import("../src/lib/system/repo");

    const mkTrack = (sid: string, num: string, phone: string, extra: Record<string, unknown> = {}) => {
      const o = mkOrder(sid, num, phone);
      const sets = Object.entries({ status: "confirmed", supplier_platform: "dropea", supplier_sync_status: "synced", supplier_external_order_id: sid, ...extra });
      db.systemDbHandle()
        .prepare(`UPDATE orders SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .run(...sets.map(([, v]) => v), o.id);
      return db.getOrderById(o.id)!;
    };

    await test("P0-B: gate BLOQUEADO no consume el sello — y al abrir el gate el aviso SALE", async () => {
      const tel = "34600994201";
      const o = mkTrack("v3tr-1", "94201", tel, { carrier: "GLS", tracking_number: "TRK-B1", tracking_url: "https://t.example/B1" });
      // Gate cerrado: fuera de allowlist con TEST_MODE=1.
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600000000", APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        const enviado = trackingNotif.notifyTrackingEvent(o, "TRACKING_AVAILABLE");
        assert.equal(enviado, false);
      });
      const trasBloqueo = db.getOrderById(o.id)!;
      assert.equal(trasBloqueo.tracking_notification_sent_at, null, "EL BUG: antes el claim se consumía con el gate cerrado");
      // Gate abierto (el teléfono entra en la allowlist): el MISMO evento sale.
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        const enviado = trackingNotif.notifyTrackingEvent(db.getOrderById(o.id)!, "TRACKING_AVAILABLE");
        assert.equal(enviado, true, "abrir el gate DESPUÉS permite enviar — la garantía nueva");
      });
      assert.ok(db.getOrderById(o.id)!.tracking_notification_sent_at !== null, "ahora sí: sello puesto tras encolar");
      // Y repetir el evento NO reenvía (enviado una vez = nunca accidental).
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        assert.equal(trackingNotif.notifyTrackingEvent(db.getOrderById(o.id)!, "TRACKING_AVAILABLE"), false, "el claim manda: un solo envío");
      });
    });

    await test("P0-C: datos incompletos NO consumen y NUNCA sale 'No disponible' — el pedido va a revisión visible", async () => {
      const tel = "34600994202";
      const o = mkTrack("v3tr-2", "94202", tel, { carrier: null, tracking_number: "TRK-B2", tracking_url: null });
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        const enviado = trackingNotif.notifyTrackingEvent(o, "TRACKING_AVAILABLE");
        assert.equal(enviado, false, "sin transportista ni URL: no se envía nada a medias");
      });
      const despues = db.getOrderById(o.id)!;
      assert.equal(despues.tracking_notification_sent_at, null, "el sello NO se consume: cuando llegue el dato, saldrá");
      assert.equal(despues.supplier_sync_status, "manual_review", "visible en Acciones");
      assert.match(despues.supplier_last_error ?? "", /tracking_payload_incomplete/);
      const ev = sysRepo.listIntegrationEvents({ limit: 300 }).find((e) => e.event_type === "tracking_payload_incomplete" && e.order_ref === "94202");
      assert.ok(ev, "evento tracking_payload_incomplete registrado");
      // Ningún mensaje encolado para este teléfono.
      assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === tel).length, 0);
      // El texto "No disponible" ya no puede construirse: los builders exigen datos.
      const issues = trackingNotif.trackingPayloadIssues(despues, "TRACKING_AVAILABLE");
      assert.ok(issues.length >= 2);
    });

    await test("P0-C: OUT_FOR_DELIVERY sin transportista se retiene; con transportista sale", async () => {
      const tel = "34600994203";
      const o = mkTrack("v3tr-3", "94203", tel, { carrier: null });
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        assert.equal(trackingNotif.notifyTrackingEvent(o, "OUT_FOR_DELIVERY"), false, "reparto_hoy menciona transportista: sin él, nada");
        assert.equal(db.getOrderById(o.id)!.out_for_delivery_notification_sent_at, null);
        db.systemDbHandle().prepare("UPDATE orders SET carrier = 'Correos Express' WHERE id = ?").run(o.id);
        assert.equal(trackingNotif.notifyTrackingEvent(db.getOrderById(o.id)!, "OUT_FOR_DELIVERY"), true, "con el dato real, sale");
      });
    });

    await test("incidente 02-09: reparto_hoy en PENDING (editada en Meta) → el aviso se RETIENE con motivo, sin consumir el sello; APPROVED → sale", async () => {
      const tpl = await import("../src/lib/whatsapp/templates");
      const tel = "34600994205";
      const o = mkTrack("v3tr-5", "94205", tel, { carrier: "GLS", tracking_number: "TRK-B5", tracking_url: "https://t.example/B5" });
      const antes = db.getSetting("wa_tpl_verified:out_for_delivery_cod")!;
      // Lo que vio el doctor la noche del 01-09: editada → PENDING.
      tpl.storeVerifiedTemplate("out_for_delivery_cod", { ...JSON.parse(antes), status: "PENDING" });
      try {
        await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
          assert.equal(trackingNotif.notifyTrackingEvent(o, "OUT_FOR_DELIVERY"), false, "plantilla en revisión: NADA sale (antes: 132001 y el cliente sin saber el importe)");
        });
        const tras = db.getOrderById(o.id)!;
        assert.equal(tras.out_for_delivery_notification_sent_at, null, "el sello NO se consume");
        const ev = sysRepo.listIntegrationEvents({ limit: 300 }).find((e) => e.event_type === "template_not_ready" && e.order_ref === "94205");
        assert.ok(ev, "queda rastro visible template_not_ready");
        assert.match(ev!.message, /NOT_APPROVED|PENDING/);
        assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === tel).length, 0, "ni un mensaje en cola");
      } finally {
        db.setSetting("wa_tpl_verified:out_for_delivery_cod", antes); // el doctor la ve APPROVED de nuevo
      }
      await withEnv({ WHATSAPP_PROVIDER: "cloud_api", TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        assert.equal(trackingNotif.notifyTrackingEvent(db.getOrderById(o.id)!, "OUT_FOR_DELIVERY"), true, "reaprobada: el MISMO aviso sale");
      });
      const item = db.getPendingOutbox(999).filter((x) => x.phone === tel).pop()!;
      assert.equal(item.template_name, "reparto_hoy", "el nombre REAL de la WABA");
      const payload = JSON.parse(item.payload_json!) as { bodyParams: string[] };
      assert.equal(payload.bodyParams.length, 4, "4 variables: nombre, nº pedido, transportista, importe");
      assert.equal(payload.bodyParams[1], "#94205", "el nº de pedido va en 2.ª posición, con #");
      assert.equal(payload.bodyParams[2], "GLS");
    });

    await test("inventario WABA 01-09: tracking_available → pedido_confirmado_casamable con 5 variables en el orden real", async () => {
      const tel = "34600994206";
      const o = mkTrack("v3tr-6", "94206", tel, { carrier: "Correos Express", tracking_number: "PQ123", tracking_url: "https://t.example/PQ123" });
      await withEnv({ WHATSAPP_PROVIDER: "cloud_api", TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        assert.equal(trackingNotif.notifyTrackingEvent(o, "TRACKING_AVAILABLE"), true);
      });
      const item = db.getPendingOutbox(999).filter((x) => x.phone === tel).pop()!;
      assert.equal(item.template_name, "pedido_confirmado_casamable", "pese al nombre, es la de ENVÍO con tracking");
      const payload = JSON.parse(item.payload_json!) as { bodyParams: string[] };
      assert.deepEqual(payload.bodyParams, ["Cliente", "#94206", "Correos Express", "PQ123", "https://t.example/PQ123"]);
    });

    await test("P0-B: dos 'workers' con la misma transición → EXACTAMENTE un envío (el claim decide tras el gate)", async () => {
      const tel = "34600994204";
      const o = mkTrack("v3tr-4", "94204", tel, { carrier: "GLS", tracking_number: "TRK-B4", tracking_url: "https://t.example/B4" });
      await withEnv({ TEST_MODE: "1", TEST_PHONE_ALLOWLIST: tel, APP_MODE: "production", WHATSAPP_SEND_ENABLED: "1", EMERGENCY_STOP: "0" }, () => {
        const r1 = trackingNotif.notifyTrackingEvent(o, "TRACKING_AVAILABLE");
        // El "segundo worker" llega con la MISMA foto vieja del pedido (sello aún null en su copia).
        const r2 = trackingNotif.notifyTrackingEvent(o, "TRACKING_AVAILABLE");
        assert.equal([r1, r2].filter(Boolean).length, 1, "uno gana el claim, el otro no duplica");
      });
      assert.equal(db.getPendingOutbox(999).filter((x) => x.phone === tel).length, 1, "un solo mensaje en cola");
      void trackingSvc;
    });
  }

  // ============ V3 FASE C · Shopify lifecycle: la cadena de exclusión completa ============
  console.log("\n— V3 · Shopify: cancelado no dispara NADA, en ningún canal —");

  await test("§13: pedido CANCELADO en Shopify → jamás WhatsApp inicial, jamás llamada, jamás liberación a Beeping", async () => {
    const beepingRelease = await import("../src/lib/beeping/release");
    const callsSched = await import("../src/lib/calls/scheduler");
    const elig = await import("../src/lib/orders/eligibility");
    const tel = "34600994301";
    const o = mkOrder("v3sh-1", "94301", tel);
    // Cancelación vía el eje de cierre (lo que escribe el webhook orders/cancelled).
    assert.equal(db.setOrderClosure(o.id, "cancelled", "shopify", Math.floor(Date.now() / 1000)), true);
    const cancelado = db.getOrderById(o.id)!;

    // 1) WhatsApp: no elegible para confirmación (ni inicial ni recordatorio ni needs_call).
    const e = elig.isConfirmationEligible(cancelado);
    assert.equal(e.eligible, false);
    assert.match(e.detail, /cancelad/i);

    // 2) Llamadas: enqueueDueOrders jamás lo encola aunque el resto de llaves estén abiertas.
    db.setSetting("calls_allowlist", tel);
    db.setSetting("calls_shadow_mode", "0");
    db.setSetting("ai_calls_enabled", "1");
    db.systemDbHandle().prepare("UPDATE orders SET status = 'needs_call', needs_call_at = unixepoch() - 3600 WHERE id = ?").run(o.id);
    callsSched.enqueueDueOrders({ now: new Date(), isHoliday: () => false });
    assert.equal(db.getActiveCallAttemptForOrder(o.id), null, "un cancelado NUNCA entra en la cola de llamadas");
    db.setSetting("ai_calls_enabled", "0");
    db.setSetting("calls_shadow_mode", "1");

    // 3) Beeping: el gate de liberación lo bloquea con el motivo exacto.
    db.systemDbHandle().prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(o.id);
    const gate = beepingRelease.evaluateLocalReleaseGate(db.getOrderById(o.id)!);
    assert.equal(gate.ok, false);
    assert.ok(gate.reasons.some((r) => /cancelado en Shopify/.test(r)));
  });

  // ============ V3 FASE D · Retell: el incidente "[password 1]" no puede repetirse ============
  console.log("\n— V3 · Retell: variables seguras, versión fijada, prompt bajo contrato —");
  {
    const payloadMod = await import("../src/lib/calls/payload");
    const promptVal = await import("../src/lib/calls/prompt-validator");
    const { retellProvider } = await import("../src/lib/calls/retell");
    const { CALL_RESULTS } = await import("../src/lib/calls/results");
    const fsD = await import("node:fs");

    const pedidoBase = (over: Partial<Record<string, unknown>> = {}) =>
      ({
        customer_name: "Marta García",
        phone: "34600111333",
        product_summary: "1x Limpiador Ultrasónico",
        total_price: "29.99",
        currency: "EUR",
        address_line1: "Calle Almería 12",
        city: "Almería",
        postal_code: "04007",
        shopify_order_number: "1137",
        created_at: Math.floor(Date.now() / 1000) - 86400,
        raw_payload: null,
        ...over,
      }) as unknown as import("../src/lib/db").OrderRow;

    await test("retell-never-speaks-template-garbage: nombre '[password 1]' → CALL BLOCKED con unsafe_dynamic_variable", () => {
      const r = payloadMod.buildCallPayload(pedidoBase({ customer_name: "[password 1]" }), new Date());
      assert.equal(r.ok, false, "JAMÁS se llama con un placeholder como nombre");
      assert.ok(r.missing.some((m) => m.startsWith("unsafe_dynamic_variable:nombre_cliente")), r.missing.join(","));
      assert.equal(r.variables, null, "ni una variable sale del preflight");
      // Y las demás formas del mismo veneno:
      for (const veneno of ["{{nombre_cliente}}", "nombre_cliente", "undefined", "null", "No disponible", "password 1", "<cliente>"]) {
        const rx = payloadMod.buildCallPayload(pedidoBase({ customer_name: veneno }), new Date());
        assert.equal(rx.ok, false, `"${veneno}" debe bloquear la llamada`);
      }
    });

    await test("retell preflight: el pedido NORMAL pasa — saludo con Marta, sin corchetes ni llaves en NINGUNA variable", () => {
      const r = payloadMod.buildCallPayload(pedidoBase(), new Date());
      assert.equal(r.ok, true);
      assert.equal(r.variables!.nombre_cliente, "Marta García");
      for (const [k, v] of Object.entries(r.variables!)) {
        assert.ok(!/[\[\]{}]/.test(v), `${k} lleva símbolos de plantilla: "${v}"`);
        assert.ok(!/password/i.test(v), `${k} lleva "password"`);
      }
    });

    await test("retell versión fijada: override_agent_version viaja en el payload y la respuesta se captura", async () => {
      const originalFetch = globalThis.fetch;
      let bodyEnviado: Record<string, unknown> | null = null;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodyEnviado = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ call_id: "call_test_v16", agent_id: "agent_abc", agent_version: 7 }), { status: 201 });
      }) as typeof fetch;
      try {
        await withEnv({ RETELL_API_KEY: "key-test", RETELL_FROM_NUMBER: "+34950835615", RETELL_AGENT_ID: "agent_abc", RETELL_AGENT_VERSION: "7" }, async () => {
          const accepted = await retellProvider.createOutboundCall({
            toNumber: "+34600111333",
            fromNumber: "+34950835615",
            dynamicVariables: JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/retell/create-phone-call.expected.json"), "utf8")).retell_llm_dynamic_variables,
            metadata: {},
          });
          assert.equal(bodyEnviado!.override_agent_version, 7, "la versión va como NÚMERO en el payload (contrato oficial)");
          assert.equal(bodyEnviado!.override_agent_id, "agent_abc");
          assert.equal(accepted.agentVersion, "7", "la versión usada se captura para auditoría");
          assert.equal(accepted.agentId, "agent_abc");
        });
        // Hardening 03-09: "latest_published" ya NO vale como pin (se mueve
        // cuando alguien publica). Solo número: si no, no hay llamada.
        await withEnv({ RETELL_API_KEY: "key-test", RETELL_FROM_NUMBER: "+34950835615", RETELL_AGENT_ID: "agent_abc", RETELL_AGENT_VERSION: "latest_published" }, async () => {
          bodyEnviado = null;
          await assert.rejects(
            retellProvider.createOutboundCall({ toNumber: "+34600111333", fromNumber: "+34950835615", dynamicVariables: JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/retell/create-phone-call.expected.json"), "utf8")).retell_llm_dynamic_variables, metadata: {} }),
            /agent_version_not_pinned/
          );
          assert.equal(bodyEnviado, null, "sin pin numérico no se toca la red");
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await test("retell migración v16: agent_id/agent_version en call_attempts, idempotente", () => {
      db.migrateCallAgentVersion(db.systemDbHandle());
      db.migrateCallAgentVersion(db.systemDbHandle());
      const cols = (db.systemDbHandle().prepare("PRAGMA table_info(call_attempts)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("agent_id") && cols.includes("agent_version"));
    });

    await test("retell prompt versionado: válido, con las 11 variables, los 12 resultados del enum y la cancelación HONESTA", () => {
      const prompt = fsD.readFileSync("config/retell/casamable-agent-prompt.md", "utf8");
      const v = promptVal.validatePromptPlaceholders(prompt);
      assert.equal(v.ok, true, v.issues.map((i) => i.detail).join(" · "));
      assert.equal(v.used.length, 11, "usa las 11 variables del contrato");
      for (const resultado of CALL_RESULTS) {
        assert.ok(prompt.includes(resultado), `el prompt no menciona el resultado "${resultado}" del enum`);
      }
      assert.match(prompt, /dejo solicitada la cancelación/, "la cancelación se describe como SOLICITUD (lo que el backend hace de verdad)");
      assert.ok(!/lo cancelo ahora mismo/.test(prompt), "jamás promete una mutación que no existe");
      assert.match(prompt, /extraer_datos_llamada/, "referencia la tool real de extracción");
      assert.match(prompt, /finalizarllamada/, "referencia la tool real de colgar");
    });

    await test("retell validador: caza el residuo 'password', el {{}} vacío y la variable obligatoria ausente", () => {
      const conPassword = promptVal.validatePromptPlaceholders("Hola, ¿hablo con [password 1]? Dime {{nombre_cliente}} {{producto}} {{importe_total}} {{direccion}} {{localidad}} {{codigo_postal}}");
      assert.ok(conPassword.issues.some((i) => i.kind === "password_residue"), "password_residue detectado");
      const vacio = promptVal.validatePromptPlaceholders("Hola {{}} — {{nombre_cliente}} {{producto}} {{importe_total}} {{direccion}} {{localidad}} {{codigo_postal}}");
      assert.ok(vacio.issues.some((i) => i.kind === "empty_placeholder"));
      const sinNombre = promptVal.validatePromptPlaceholders("Confirmo {{producto}} {{importe_total}} {{direccion}} {{localidad}} {{codigo_postal}}");
      assert.ok(sinNombre.issues.some((i) => i.kind === "missing_required_variable" && /nombre_cliente/.test(i.detail)));
      const promesaFalsa = promptVal.validatePromptPlaceholders("Si quiere cancelar dile: lo cancelo ahora mismo. {{nombre_cliente}} {{producto}} {{importe_total}} {{direccion}} {{localidad}} {{codigo_postal}}");
      assert.ok(promesaFalsa.issues.some((i) => i.kind === "false_promise"));
    });

    await test("retell salud: el preflight es visible — prompt validado y versión fijada o sin fijar, con la última versión usada", async () => {
      const { getCallsHealth } = await import("../src/lib/system/health-integrations");
      const h1 = getCallsHealth();
      assert.equal(h1.promptValidated, true, "el prompt del repo valida");
      await withEnv({ RETELL_AGENT_VERSION: "7" }, () => {
        const h = getCallsHealth();
        assert.equal(h.agentVersionPinned, true);
        assert.equal(h.configuredAgentVersion, "7");
      });
      await withEnv({ RETELL_AGENT_VERSION: undefined }, () => {
        assert.equal(getCallsHealth().agentVersionPinned, false, "sin fijar se DICE, no se esconde");
      });
    });
  }

  // ============ V3 FASE E · UI: criterios de aceptación del shell (§53, §58) ============
  console.log("\n— V3 · UI: rail con nombres, marca Casamable, header provider-aware —");
  {
    const leer = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    /** El CÓDIGO sin comentarios: un comentario explicando qué NO hacer no
     *  puede hacer fallar la aceptación de que no se hace. */
    const codigo = (rel: string) => leer(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    await test("UI · el nav desktop lleva LABELS visibles (rail, no dock de iconos) y las 6 áreas v4", () => {
      const nav = fs.readFileSync(path.join(process.cwd(), "src/components/NavRail.tsx"), "utf8");
      for (const label of ["Inicio", "Pedidos", "Seguimiento", "Cazador", "Growth", "Ajustes"]) assert.ok(nav.includes(`"${label}"`), `falta la sección ${label}`);
      assert.ok(/collapsed/.test(nav) && /localStorage/.test(nav), "colapsable con preferencia recordada");
      assert.ok(/w-\[24[08]px\]/.test(nav), "sidebar con presencia real (232–248 px), no un dock diminuto");
      assert.ok(/bg-brand-text text-white/.test(nav), "selección activa en carbón, no una cápsula tintada");
    });
    await test("UI · móvil: CUATRO áreas + 'Más' con icono + label, y sheet — no 9 iconos minúsculos", () => {
      const nav = fs.readFileSync(path.join(process.cwd(), "src/components/NavRail.tsx"), "utf8");
      const m = /MOBILE_PRIMARY: NavKey\[\] = \[([^\]]+)\]/.exec(nav);
      assert.ok(m, "MOBILE_PRIMARY definido");
      assert.equal(m![1].split(",").length, 4, "cuatro áreas principales en móvil");
      assert.ok(nav.includes("grid-cols-5"), "4 + Más = 5 huecos");
      assert.ok(nav.includes("<span>Más</span>") && nav.includes("anim-slide-up"), "sheet de Más");
      assert.ok(/h-14/.test(nav), "targets táctiles ≥44px");
    });
    await test("UI · marca: 'Tu Agente' ha muerto — Casamable + Control Center, con slot para el logo real", () => {
      const logo = leer("src/components/Logo.tsx");
      assert.ok(!logo.includes("Tu Agente"), "ni rastro del kit genérico");
      assert.match(logo, /Casamable/);
      assert.match(logo, /Control Center/);
      assert.match(logo, /casamable\.svg/, "slot documentado para el asset oficial");
    });

    await test("UI §47 · provider-aware: con cloud_api no hay QR, ni 'Desconectar' en el header, ni semántica Baileys", () => {
      const status = leer("src/app/api/connection/status/route.ts");
      assert.match(status, /cloud_api/, "la ruta declara el proveedor");
      assert.match(status, /provider/, "el payload lleva provider");
      const gate = leer("src/components/ConnectionGate.tsx");
      assert.match(gate, /provider === "cloud_api"/, "el gate entra directo con la API oficial");
      const header = codigo("src/components/DashboardHeader.tsx");
      assert.ok(!/Desconectar/.test(header), "desconectar ya no vive en el header (es de Ajustes, y solo Baileys)");
      assert.match(header, /API oficial de Meta/, "el canal se nombra por lo que ES");
      assert.ok(!/QR/.test(header), "cero semántica de QR en la cabecera");
    });

    await test("UI · command palette: ⌘K existe, busca pedidos y navega — y el fondo 'demo de IA' está muerto", () => {
      const dash = leer("src/components/Dashboard.tsx");
      assert.match(dash, /metaKey|ctrlKey/, "atajo de teclado global");
      assert.match(dash, /CommandPalette/);
      const ambient = codigo("src/components/AmbientBackground.tsx");
      assert.ok(!/brand-sway|brand-ember|palmera|palm/i.test(ambient), "sin palmeras ni brasas animadas (§53)");
    });

    await test("UI §9 · la rampa de rollout es un setting editable (pilot default) y la ruta de settings la acepta", () => {
      const settings = leer("src/app/api/settings/route.ts");
      assert.match(settings, /whatsapp_rollout_percent/);
      assert.match(settings, /"pilot"/, "default fail-closed");
    });
  }

  // ============ V3.1 · ATRIBUCIÓN DE MARKETING (el dato que no vuelve) ============
  console.log("\n— V3.1 · Atribución: UTM capturadas, latch, campañas —");
  {
    const attr = await import("../src/lib/orders/attribution");
    const match = await import("../src/lib/meta-ads/attribution-match");

    await test("attribution parser: UTM completo, decodificado, con fbclid — y NUNCA inventa nada", () => {
      const a = attr.parseAttribution({
        landing_site:
          "/products/limpiador?utm_source=facebook&utm_medium=paid&utm_campaign=Ultras%20Septiembre&utm_content=video1&utm_term=cod&fbclid=IwAR123abc",
        referring_site: "https://l.facebook.com/",
        source_name: "web",
      });
      assert.equal(a.source, "facebook");
      assert.equal(a.medium, "paid");
      assert.equal(a.campaign, "Ultras Septiembre", "URL-decoded");
      assert.equal(a.content, "video1");
      assert.equal(a.term, "cod");
      assert.equal(a.fbclid, "IwAR123abc");
      assert.equal(a.referringSite, "https://l.facebook.com/");
      assert.equal(a.sourceName, "web");
      // Parcial: SOLO lo presente; el resto NULL — jamás se inventa campaña.
      const parcial = attr.parseAttribution({ landing_site: "/x?utm_source=ig" });
      assert.equal(parcial.source, "ig");
      assert.equal(parcial.campaign, null);
      assert.equal(parcial.medium, null);
      // Sin nada de nada:
      const vacio = attr.parseAttribution({});
      assert.equal(attr.hasAnyAttribution(vacio), false);
      assert.equal(vacio.campaign, null);
    });

    await test("attribution parser: URL relativa, mal formada, params duplicados (gana el PRIMERO) y landing_site_ref como fallback", () => {
      // Relativa sin romper:
      assert.equal(attr.parseAttribution({ landing_site: "/?utm_campaign=a" }).campaign, "a");
      // Mal formada: no lanza, devuelve lo que pueda.
      const rota = attr.parseAttribution({ landing_site: "ht!tp:/// ???utm_campaign=%%%mal" });
      assert.ok(rota.campaign === null || typeof rota.campaign === "string", "jamás una excepción");
      // Duplicados: el PRIMER valor gana (precedencia definida).
      assert.equal(attr.parseAttribution({ landing_site: "/x?utm_source=fb&utm_source=google" }).source, "fb");
      // Sin '?': sin params, sin drama.
      assert.equal(attr.parseAttribution({ landing_site: "/products/limpiador" }).campaign, null);
      // landing_site_ref solo si referring_site falta:
      assert.equal(attr.parseAttribution({ landing_site_ref: "fb.com" }).referringSite, "fb.com");
      assert.equal(attr.parseAttribution({ referring_site: "google.com", landing_site_ref: "fb.com" }).referringSite, "google.com");
    });

    await test("attribution: el webhook orders/create la PERSISTE (v17) y el crudo sigue en raw_payload", () => {
      const raw = JSON.stringify(codPayload({
        id: 995101,
        order_number: 95101,
        landing_site: "/?utm_source=facebook&utm_medium=paid&utm_campaign=120210000000000001&fbclid=IwTest1",
        referring_site: "https://l.facebook.com/",
        source_name: "web",
        shipping_address: {
          name: "Atribución Uno", address1: "Calle UTM 1", address2: null, city: "Madrid",
          province: "Madrid", zip: "28001", country: "Spain", country_code: "ES", phone: "+34 698 951 001",
        },
      }));
      assert.equal(processOrdersCreateWebhook(raw, shopifyHeaders(raw)).status, 200);
      const o = db.getOrderByShopifyId("995101")!;
      assert.equal(o.marketing_source, "facebook");
      assert.equal(o.marketing_campaign, "120210000000000001");
      assert.equal(o.marketing_fbclid, "IwTest1");
      assert.equal(o.shopify_source_name, "web");
      assert.ok((o.raw_payload ?? "").includes("utm_campaign"), "el crudo se conserva para reinterpretar");
    });

    await test("attribution LATCH: un orders/updated SIN utm no destruye lo capturado; uno CON utm solo rellena huecos", () => {
      const antes = db.getOrderByShopifyId("995101")!;
      // updated sin atribución (Shopify a veces no la repite):
      const sinUtm = JSON.stringify({ id: 995101, updated_at: "2026-09-02T10:00:00Z", tags: "" });
      const r1 = processOrdersEventWebhook(sinUtm, shopifyHeaders(sinUtm, { topic: "orders/updated", webhookId: "wh-attr-1" }));
      assert.equal(r1.status, 200);
      const tras1 = db.getOrderByShopifyId("995101")!;
      assert.equal(tras1.marketing_campaign, antes.marketing_campaign, "el PRIMER valor fiable se conserva");
      assert.equal(tras1.marketing_source, "facebook");
      // updated que trae un hueco nuevo (utm_term no existía):
      const conTerm = JSON.stringify({ id: 995101, updated_at: "2026-09-02T10:05:00Z", landing_site: "/?utm_term=nuevo&utm_campaign=OTRA" });
      processOrdersEventWebhook(conTerm, shopifyHeaders(conTerm, { topic: "orders/updated", webhookId: "wh-attr-2" }));
      const tras2 = db.getOrderByShopifyId("995101")!;
      assert.equal(tras2.marketing_term, "nuevo", "el hueco se rellena");
      assert.equal(tras2.marketing_campaign, "120210000000000001", "pero la campaña original NO se pisa (latch)");
    });

    await test("attribution v17: migración idempotente", () => {
      db.migrateOrderAttribution(db.systemDbHandle());
      db.migrateOrderAttribution(db.systemDbHandle());
      const cols = (db.systemDbHandle().prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of ["marketing_source", "marketing_campaign", "marketing_fbclid", "landing_site", "referring_site", "shopify_source_name"]) {
        assert.ok(cols.includes(c), c);
      }
    });

    await test("campañas: DIRECTA solo con id existente en snapshots; INFERIDA por nombre; lo demás es NONE — sin equivalencias mágicas", () => {
      const campanas = [
        { id: "120210000000000001", name: "Ultras Septiembre" },
        { id: "120210000000000002", name: "Gafas Agosto" },
      ];
      const directa = match.resolveCampaignRef("120210000000000001", campanas);
      assert.equal(directa.kind, "direct_id");
      assert.equal(directa.campaignName, "Ultras Septiembre");
      const inferida = match.resolveCampaignRef("  ultras   septiembre ", campanas);
      assert.equal(inferida.kind, "name_match", "nombre normalizado (case/espacios)");
      assert.equal(inferida.campaignId, "120210000000000001");
      // Un número largo que NO está en los snapshots NO es una campaña.
      assert.equal(match.resolveCampaignRef("999999999999", campanas).kind, "none");
      assert.equal(match.resolveCampaignRef("verano_generico", campanas).kind, "none");
      assert.equal(match.resolveCampaignRef(null, campanas).kind, "none");
    });

    await test("campañas: la economía declara COBERTURA y el cubo 'Sin atribución' jamás se reparte", async () => {
      const { upsertMetaAdsDaily } = await import("../src/lib/meta-ads/repo");
      // Día de NEGOCIO (Europe/Madrid), como lo mapea getCampaignEconomics.
      // Con la fecha UTC este test fallaba entre las 00:00 y las 02:00 CEST
      // (flake real, cazado el 03-09 a la 01:00).
      const dia = (await import("../src/lib/time")).businessDay();
      upsertMetaAdsDaily({
        day: dia, level: "campaign", entityId: "120210000000000001", entityName: "Ultras Septiembre",
        spend: 50, impressions: 1000, reach: 900, clicks: 40, ctr: 4, cpc: 1.25, cpm: 50, actionsJson: null, currency: "EUR",
      });
      // Un pedido más SIN atribución en la misma ventana:
      const raw = JSON.stringify(codPayload({
        id: 995102, order_number: 95102,
        shipping_address: {
          name: "Sin Utm", address1: "Calle Nada 2", address2: null, city: "Sevilla",
          province: "Sevilla", zip: "41001", country: "Spain", country_code: "ES", phone: "+34 698 951 002",
        },
      }));
      processOrdersCreateWebhook(raw, shopifyHeaders(raw));
      const now = Math.floor(Date.now() / 1000);
      const eco = match.getCampaignEconomics(now - 3600, now + 1);
      assert.ok(eco.totalOrders >= 2);
      const fila = eco.campaigns.find((c) => c.campaignId === "120210000000000001");
      assert.ok(fila, "la campaña con pedido atribuido aparece");
      assert.equal(fila!.attribution, "direct_id");
      assert.equal(fila!.orders, 1);
      assert.equal(fila!.spend, 50);
      assert.equal(fila!.cpaOrder, 50, "gasto / SUS pedidos, no los del total");
      assert.ok(eco.unattributed.orders >= 1, "lo no resuelto vive en su cubo");
      assert.ok(eco.campaignCoveragePct < 100, "cobertura declarada, nunca fingida");
      assert.ok(eco.attributionCoveragePct >= eco.campaignCoveragePct);
    });
  }

  // ============ V3.1 · Fixtures de incidentes reales (5.3, 5.5) ============
  console.log("\n— V3.1 · Incidentes reales: direcciones y cancelación honesta —");
  {
    const payloadMod = await import("../src/lib/calls/payload");

    await test("incidente 5.3: bloque/piso/puerta, CP con cero inicial y localidad multi-palabra llegan INTACTOS al payload de llamada", () => {
      const casos: Array<[string, string, string]> = [
        ["Calle Real 5", "04007", "Almería"],
        ["Av. de la Constitución 12, Bloque 3, 2ºB", "08820", "El Prat de Llobregat"],
        ["C/ Mayor 1, Esc. A, Piso 4, Puerta 2", "03690", "San Vicente del Raspeig"],
      ];
      for (const [direccion, cp, localidad] of casos) {
        const r = payloadMod.buildCallPayload(
          {
            customer_name: "Cliente Prueba", phone: "34600111444", product_summary: "1x Limpiador",
            total_price: "29.99", currency: "EUR", address_line1: direccion, city: localidad,
            postal_code: cp, shopify_order_number: "1200", created_at: Math.floor(Date.now() / 1000) - 3600, raw_payload: null,
          } as unknown as import("../src/lib/db").OrderRow,
          new Date()
        );
        assert.equal(r.ok, true, `dirección "${direccion}" no debe bloquearse`);
        assert.equal(r.variables!.direccion, direccion, "ni un carácter corrompido");
        assert.equal(r.variables!.codigo_postal, cp, "el CERO inicial del CP sobrevive (es string, no número)");
        assert.equal(r.variables!.localidad, localidad);
      }
    });

    await test("incidente 5.5: 'quiero cancelar' registra la SOLICITUD y el bot no miente diciendo que ya está cancelado", async () => {
      const { handleOrderReply } = await import("../src/lib/orders/confirmation");
      const tel = "34600995503";
      const o = mkOrder("995103", "95103", tel);
      db.systemDbHandle().prepare("UPDATE orders SET status='awaiting_reply', whatsapp_sent_at=unixepoch() WHERE id=?").run(o.id);
      // Paso 1: la frase ambigua JAMÁS cancela — el bot pide confirmación.
      const paso1 = handleOrderReply(tel, "quiero cancelar");
      assert.equal(paso1.handled, true);
      assert.equal(db.getOrderById(o.id)!.cancellation_requested_at, null, "una frase suelta no marca nada todavía");
      assert.ok(!/ya está cancelado|queda cancelado/i.test(paso1.reply ?? ""), "y desde luego no afirma que canceló");
      // Paso 2: el formato explícito registra la SOLICITUD (decisión humana después).
      const paso2 = handleOrderReply(tel, "CANCELAR 95103");
      assert.equal(paso2.handled, true);
      const tras = db.getOrderById(o.id)!;
      assert.ok(tras.cancellation_requested_at !== null, "cancellation_requested: la decisión final sigue siendo humana");
      const respuesta = paso2.reply ?? "";
      assert.ok(!/ya está cancelado|cancelado ✅|queda cancelado/i.test(respuesta), "JAMÁS afirmar una cancelación que no ocurrió");
      assert.match(respuesta, /marcado para cancelar|te contactamos/i, "dice la verdad: anotado y pendiente de confirmar");
    });
  }

  // ============ V4 · Rediseño: navegación, seguimiento, home, PII, sin cifras inventadas ============
  console.log("\n— V4 · Control Center rediseñado —");
  {
    const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

    await test("V4 navegación: todas las áreas con nombre visible en escritorio; móvil = 4 áreas de operación + 'Más'", () => {
      const nav = src("src/components/NavRail.tsx");
      for (const label of ["Inicio", "Pedidos", "Seguimiento", "Cazador", "Growth", "Ajustes", "Landing Studio"]) assert.ok(nav.includes(`"${label}"`), label);
      // v4.2: el móvil prioriza operación real; Cazador y Landing Studio viven en "Más".
      assert.match(nav, /MOBILE_PRIMARY: NavKey\[\] = \["home", "orders", "followup", "growth"\]/, "4 áreas de operación en móvil");
      assert.ok(nav.includes("<span>Más</span>"), "entrada Más");
      assert.ok(nav.includes("safe-area-inset-bottom"), "respeta el safe area");
      assert.ok(!nav.includes("Tu Agente"), "sin branding provisional");
      // Los alias heredados siguen resolviéndose en el shell (enlaces antiguos no se rompen).
      const dash = src("src/components/Dashboard.tsx");
      for (const h of ["#acciones", "#chats", "#envios", "#agente", "#anuncios", "#finanzas"]) assert.ok(dash.includes(`"${h}"`), h);
    });

    await test("V4 tokens: tema claro con stack de sistema, sin Google Fonts ni degradados llamativos", () => {
      const css = src("src/app/globals.css");
      assert.match(css, /--color-brand-bg: #f5f5f7/);
      assert.match(css, /--color-brand-surface: #ffffff/);
      assert.match(css, /-apple-system, BlinkMacSystemFont, "SF Pro Display"/);
      assert.ok(!/next\/font\/google/.test(src("src/app/layout.tsx")), "sin fuentes remotas");
      assert.ok(!/linear-gradient/.test(css), "sin degradados en el sistema de diseño");
      assert.match(css, /prefers-reduced-motion/);
    });

    await test("V4.1 dirección de arte: paleta restringida, selección carbón, dorado solo de marca, radios contenidos", () => {
      const css = src("src/app/globals.css");
      assert.match(css, /--color-brand-gold: #1d1d1f/, "la acción principal es carbón, no un color saturado");
      assert.match(css, /--color-brand-accent: #d5aa14/, "un único color de marca (dorado)");
      assert.match(css, /--color-brand-tertiary: #92929b/, "tres niveles de texto");
      assert.match(css, /--radius-2xl: 12px/, "contenedores a 12 px");
      assert.match(css, /--radius-lg: 8px/, "controles a 8–10 px");
      for (const sem of ["--color-emerald-600: #248a3d", "--color-amber-600: #b66a00", "--color-red-600: #d92d20", "--color-sky-600: #1769e0"]) assert.ok(css.includes(sem), `semántico unificado: ${sem}`);
      const ui = src("src/components/ui.tsx");
      const chip = ui.slice(ui.indexOf("export function Chip"), ui.indexOf("export function Toolbar"));
      assert.ok(!/rounded-full/.test(chip), "los filtros NO son píldoras");
      assert.ok(/bg-brand-text text-white/.test(chip), "filtro activo: fondo oscuro y texto blanco");
      assert.ok(/export function TabBar/.test(ui) && /export function Badge/.test(ui) && /export function Drawer/.test(ui), "pestañas, badge y drawer como primitivas únicas");
      const tabs = ui.slice(ui.indexOf("export function TabBar"), ui.indexOf("export function Chip"));
      assert.ok(/h-\[2px\]/.test(tabs) && !/rounded-full border/.test(tabs), "pestañas con indicador inferior, distintas de los filtros");
    });

    await test("V4.1 barra de entorno: compacta, sin morado, con el detalle técnico en un popover", () => {
      const bar = src("src/components/SafetyBanner.tsx");
      assert.ok(!/violet|purple|TEST MODE/.test(bar), "el banner morado ha desaparecido");
      assert.match(bar, /Entorno de prueba/);
      assert.match(bar, /Ver estado/);
      assert.match(bar, /h-9 /, "≈36 px de alto");
      assert.match(bar, /Parada de emergencia/, "los interruptores viven en el popover, no en badges permanentes");
      const header = src("src/components/DashboardHeader.tsx");
      assert.ok(!/Casamable<\/div>/.test(header), "sin breadcrumb 'Casamable' repetido en la cabecera");
    });

    await test("V4.1 seguimiento: pestañas operativas, lista con columnas, antigüedad como frase y sheet de filtros en móvil", () => {
      const view = src("src/components/FollowUpView.tsx");
      for (const t of ["Vista general", "Acciones", "Conversaciones", "Envíos", "Automatización"]) assert.ok(view.includes(`"${t}"`), `pestaña ${t}`);
      assert.match(view, /TabBar/);
      const panel = src("src/components/FollowUpPanel.tsx");
      assert.match(panel, /Sin resolver · \$\{/, "la antigüedad se comunica como 'Sin resolver · N días', no con un punto rojo");
      assert.match(panel, /grid-cols-\[minmax/, "lista con columnas reales en escritorio");
      assert.match(panel, /Pedido \/ cliente/);
      assert.match(panel, /ModalShell/, "filtros de móvil en un bottom sheet");
      assert.match(panel, /urgency/, "ordenada por urgencia");
      assert.ok(!/rounded-full/.test(panel.replace(/h-1\.5 w-1\.5 rounded-full/g, "")), "sin píldoras salvo la marca de atención");
    });

    await test("V4.1 galería /design-system: existe solo en desarrollo", () => {
      const page = src("src/app/design-system/page.tsx");
      assert.match(page, /NODE_ENV === "production"\) notFound\(\)/, "404 en producción");
      assert.match(src("src/components/DesignSystemGallery.tsx"), /Solo desarrollo/);
    });

    // ── V4.2 · REGLA DE SUPERFICIE ──
    // Una función no gana espacio principal porque exista en el código.
    // Estos tests fijan la jerarquía acordada el 02-09: la operación diaria
    // manda; Cazador (sin fuente) y Landing Studio (beta) son herramientas.

    await test("V4.2 nav móvil: exactamente 5 entradas — 4 áreas de operación + Más, todas con label", () => {
      const nav = src("src/components/NavRail.tsx");
      const m = /MOBILE_PRIMARY: NavKey\[\] = \[([^\]]+)\]/.exec(nav);
      assert.ok(m, "MOBILE_PRIMARY definido");
      const primary = m![1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
      assert.deepEqual(primary, ["home", "orders", "followup", "growth"], "las 4 principales son operación + growth");
      assert.ok(nav.includes("grid-cols-5"), "4 + Más = 5 huecos");
      assert.ok(nav.includes("<span>Más</span>"), "la quinta entrada es Más");
      // Ningún icono sin nombre: cada entrada primaria pinta su label.
      assert.match(nav, /\{NAV_ICONS\[id\]\}\s*<span>\{it\.label\}<\/span>/, "icono + label visible");
    });

    await test("V4.2 Cazador y Landing Studio NO son navegación principal en móvil", () => {
      const nav = src("src/components/NavRail.tsx");
      const m = /MOBILE_PRIMARY: NavKey\[\] = \[([^\]]+)\]/.exec(nav)![1];
      assert.ok(!m.includes("hunter"), "Cazador fuera de la barra principal mientras no tenga fuente real");
      assert.ok(!m.includes("landing"), "Landing Studio fuera de la barra principal (beta)");
    });

    await test("V4.2 'Más' agrupa Herramientas (Cazador + Landing Studio) y Sistema (Ajustes)", () => {
      const nav = src("src/components/NavRail.tsx");
      const m = /MORE_GROUPS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(nav);
      assert.ok(m, "MORE_GROUPS definido");
      const body = m![1];
      assert.match(body, /label: "Herramientas"[\s\S]*?"hunter"[\s\S]*?"landing"/, "Herramientas: Cazador + Landing Studio");
      assert.match(body, /label: "Sistema"[\s\S]*?"settings"/, "Sistema: Ajustes");
    });

    await test("V4.2 sidebar de escritorio agrupada: Operación · Crecimiento · Herramientas · Sistema", () => {
      const nav = src("src/components/NavRail.tsx");
      for (const g of ["Operación", "Crecimiento", "Herramientas", "Sistema"]) assert.ok(nav.includes(`label: "${g}"`), `grupo ${g}`);
      const items = /NAV_ITEMS[\s\S]*?\n\];/.exec(nav)![0];
      assert.match(items, /id: "home"[^\n]*group: "operation"/);
      assert.match(items, /id: "orders"[^\n]*group: "operation"/);
      assert.match(items, /id: "followup"[^\n]*group: "operation"/);
      assert.match(items, /id: "growth"[^\n]*group: "growth"/);
      assert.match(items, /id: "hunter"[^\n]*group: "tools"/, "Cazador es herramienta, no operación");
      assert.match(items, /id: "landing"[^\n]*group: "tools"/, "Landing Studio es herramienta");
      assert.match(items, /id: "settings"[^\n]*group: "system"/);
    });

    await test("V4.2 Product Hunter con source=off: NOT_CONFIGURED, sin prometer búsqueda ni '0 resultados'", async () => {
      const previo = process.env.PRODUCT_HUNTER_SOURCE;
      process.env.PRODUCT_HUNTER_SOURCE = "off";
      const mod = await import("../src/lib/product-hunter/adapter");
      const av = mod.productHunterAvailability();
      assert.equal(av.available, false, "sin fuente no está disponible");
      assert.equal(av.source, "off");
      process.env.PRODUCT_HUNTER_SOURCE = previo;

      const view = src("src/components/hunter/ProductHunterView.tsx");
      assert.match(view, /No hay una fuente de descubrimiento conectada/, "dice NO CONFIGURADO, no 'sin resultados'");
      assert.ok(!/0 productos encontrados|0 resultados/.test(view), "nunca implica que se buscó y no hubo nada");
      assert.match(view, /todavía no hay una fuente real de productos conectada/, "subtexto honesto");
      assert.match(view, /readiness="not_configured"/, "badge de madurez");
      // Sin fuente NO se ofrecen Buscar/Guardados/Comparar: serían CTA engañosas.
      assert.match(view, /availability\.available\s*\?\s*\[[\s\S]*?id: "search", label: "Buscar"[\s\S]*?\]\s*:\s*\[/, "las pestañas de búsqueda solo existen con fuente conectada");
    });

    await test("V4.2 Landing Studio: Beta + aviso de que se guarda en este navegador", () => {
      const ls = src("src/components/landing-studio/LandingStudio.tsx");
      assert.match(ls, /readiness="beta"/, "declara que es beta");
      assert.match(ls, /Guardado localmente en este navegador/, "transparencia sobre localStorage");
      assert.ok(!/window\.alert|role="alertdialog"/.test(ls), "sin modal ni warning agresivo: solo transparencia");
      const nav = src("src/components/NavRail.tsx");
      assert.match(nav, /"Beta"/, "la navegación también lo marca");
    });

    await test("V4.2 la persistencia server-side de Landing Studio NO está integrada (schema sigue en 17)", () => {
      const db = src("src/lib/db.ts");
      assert.match(db, /export const SCHEMA_VERSION = 18;/, "el workspace de atención usa el schema 18");
      for (const tabla of ["landing_projects", "landing_versions", "landing_exports"]) {
        assert.ok(!db.includes(tabla), `sin tabla ${tabla}: el experimento se descartó`);
      }
      assert.ok(!fs.existsSync(path.join(process.cwd(), "src/app/api/landing-studio")), "sin rutas server de Landing Studio");
      assert.ok(!fs.existsSync(path.join(process.cwd(), "src/lib/landing-studio/repository.ts")), "sin repository SQLite");
      // Lo que SÍ debe seguir existiendo: Landing Studio v1 intacto.
      for (const f of ["types.ts", "viability.ts", "validation.ts", "shopify-export.ts"]) {
        assert.ok(fs.existsSync(path.join(process.cwd(), "src/lib/landing-studio", f)), `v1 intacto: ${f}`);
      }
    });

    // ── CONTRATO DEL PREFLIGHT ──
    // `--check-only` es el ÚNICO comando autorizado contra el volumen de
    // producción antes de desplegar. El camino CON escritura llama
    // setSetting → ctx() → build(), y build() MIGRA el esquema: un preflight
    // que abriese la DB subiría 15→17 con el contenedor viejo en marcha.
    // El ensayo del 02-09 demostró que la rama SIN credenciales lo hacía.
    // Estos tests fijan el contrato en las cuatro rutas posibles.
    const doctorProbe = (
      titulo: string,
      opts: { env: Record<string, string>; checkOnly: boolean; esperaFalloDeSalida: boolean }
    ) =>
      test(titulo, () => {
        const os = require("node:os") as typeof import("node:os");
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        const Database = require("better-sqlite3") as typeof import("better-sqlite3");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-preflight-"));
        const dataDir = path.join(dir, "data");
        fs.mkdirSync(dataDir);
        const dbFile = path.join(dataDir, "messages.db");

        // Fixture: DB "de producción" en esquema 15 con un centinela.
        const fixture = new Database(dbFile);
        fixture.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
        fixture.prepare("INSERT INTO settings (key,value) VALUES ('centinela','intacto')").run();
        fixture.pragma("user_version = 15");
        fixture.close();

        let salioConFallo = false;
        try {
          execSync(
            `npx tsx ${path.join(process.cwd(), "scripts/whatsapp-templates-doctor.ts")}${opts.checkOnly ? " -- --check-only" : ""}`,
            { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATA_DIR: dataDir, ...opts.env } }
          );
        } catch {
          salioConFallo = true;
        }

        const after = new Database(dbFile, { readonly: true });
        try {
          if (opts.esperaFalloDeSalida) assert.ok(salioConFallo, "sin verificación posible, el doctor sale con error");
          assert.equal(after.pragma("user_version", { simple: true }), 15, "el esquema NO se migra");
          assert.equal(
            (after.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get() as { c: number }).c,
            1,
            "build() NO corre: la DB sigue con su única tabla"
          );
          assert.equal(
            (after.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'wa_tpl_verified:%'").get() as { c: number }).c,
            0,
            "no se cachea nada"
          );
          assert.equal(
            (after.prepare("SELECT value FROM settings WHERE key='centinela'").get() as { value: string }).value,
            "intacto"
          );
          // La prueba más dura: el fichero ni se abrió (SQLite deja -wal/-shm al abrir en WAL).
          assert.equal(
            fs.readdirSync(dataDir).filter((f) => f.endsWith("-wal") || f.endsWith("-shm")).length,
            0,
            "la base de datos ni siquiera se abre"
          );
        } finally {
          after.close();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

    /** Stub de red: ninguna llamada real a Meta. `modo` decide qué contesta. */
    const metaStub = (dir: string, modo: "approved" | "error"): string => {
      const f = path.join(dir, `meta-stub-${modo}.mjs`);
      const cuerpo =
        modo === "approved"
          ? [
              'const T = { data: [{ name: "confirmacion_pedido_cod", status: "APPROVED", language: "es",',
              '  components: [ { type: "BODY", text: "Hola {{1}} {{2}} {{3}} {{4}}" },',
              '    { type: "BUTTONS", buttons: [{type:"QUICK_REPLY"},{type:"QUICK_REPLY"},{type:"QUICK_REPLY"}] } ] }] };',
              'globalThis.fetch = async (u) => {',
              '  if (!String(u).includes("graph.facebook.com")) throw new Error("red no permitida en el test");',
              '  return new Response(JSON.stringify(T), { status: 200, headers: { "content-type": "application/json" } });',
              "};",
            ]
          : [
              'globalThis.fetch = async (u) => {',
              '  if (!String(u).includes("graph.facebook.com")) throw new Error("red no permitida en el test");',
              '  return new Response(JSON.stringify({ error: { message: "fallo simulado de Meta" } }), { status: 500, headers: { "content-type": "application/json" } });',
              "};",
            ];
      fs.writeFileSync(f, cuerpo.join("\n"));
      return f;
    };
    const stubDir = fs.mkdtempSync(path.join((require("node:os") as typeof import("node:os")).tmpdir(), "doctor-stubs-"));
    const CREDS = {
      META_WHATSAPP_BUSINESS_ACCOUNT_ID: "WABA_FALSA_DE_TEST",
      META_WHATSAPP_ACCESS_TOKEN: "token-de-prueba-jamas-real",
    };
    const SIN_CREDS = {
      META_WHATSAPP_BUSINESS_ACCOUNT_ID: "",
      META_WHATSAPP_ACCESS_TOKEN: "",
      META_ADS_ACCESS_TOKEN: "",
    };

    // A · con credenciales y Meta respondiendo: consulta Meta, no toca la DB.
    await doctorProbe("PREFLIGHT · whatsapp:templates:doctor --check-only NO toca la DB (ni migra ni cachea)", {
      env: { ...CREDS, NODE_OPTIONS: `--import ${metaStub(stubDir, "approved")}` },
      checkOnly: true,
      esperaFalloDeSalida: false,
    });

    // B · sin credenciales: el caso que rompía el contrato (ensayo 02-09).
    await doctorProbe("PREFLIGHT · --check-only SIN credenciales NO toca la DB (no consulta la caché)", {
      env: SIN_CREDS,
      checkOnly: true,
      esperaFalloDeSalida: true,
    });

    // C · con credenciales pero Meta caída: el error tampoco puede abrir la DB.
    await doctorProbe("PREFLIGHT · --check-only con Meta devolviendo error NO toca la DB", {
      env: { ...CREDS, NODE_OPTIONS: `--import ${metaStub(stubDir, "error")}` },
      checkOnly: true,
      esperaFalloDeSalida: true,
    });

    // D · doctor NORMAL sin credenciales: sin nada que verificar, tampoco hay
    // motivo para abrir la DB. Sale gratis al retirar getTemplateReadiness.
    await doctorProbe("PREFLIGHT · doctor NORMAL sin credenciales tampoco toca la DB", {
      env: SIN_CREDS,
      checkOnly: false,
      esperaFalloDeSalida: true,
    });

    await test("PREFLIGHT · el doctor no importa getTemplateReadiness (leerla abriría la DB)", () => {
      const doc = src("scripts/whatsapp-templates-doctor.ts");
      const imp = /const \{([^}]*)\} = await import\(\s*"\.\.\/src\/lib\/whatsapp\/templates"/.exec(doc);
      assert.ok(imp, "el import dinámico del catálogo sigue ahí");
      assert.ok(!imp![1].includes("getTemplateReadiness"), "getTemplateReadiness fuera: solo la usaba la rama sin credenciales");
      // Llamadas reales, no menciones en comentarios (los comentarios del
      // script explican precisamente por qué NO se llama a getSetting).
      const sinComentarios = doc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      assert.ok(!/getSetting\s*\(|systemDbHandle\s*\(/.test(sinComentarios), "el script no lee settings ni el handle crudo");
      // storeVerifiedTemplate SÍ debe seguir, pero solo tras el gate de --check-only.
      const escritura = doc.indexOf("storeVerifiedTemplate(");
      const gate = doc.indexOf('if (!hasFlag("check-only"))');
      assert.ok(gate > 0 && escritura > gate, "la única escritura vive detrás del gate de --check-only");
    });

    await test("WHATSAPP DOCTOR · order_delay_restock resuelve el contrato de botones de retraso_pedido", async () => {
      // Falso negativo real (doctor contra la WABA, 03-09): el catálogo guarda
      // specs con DOS nombres —clave lógica y nombre real de la WABA—. No
      // existe spec "order_delay_restock", pero sí "retraso_pedido" con sus 2
      // botones. Buscando solo por la clave lógica el doctor decía "la WABA
      // tiene 2 y el flujo local espera 0" y tumbaba el preflight, cuando el
      // flujo de retraso SÍ atiende esos botones.
      const tpl = await import("../src/lib/whatsapp/templates");
      const mapping = tpl.loadProviderMappings().find((m) => m.logicalKey === "order_delay_restock")!;
      assert.ok(mapping, "el mapping existe");
      assert.equal(mapping.providerTemplate, "retraso_pedido");
      assert.equal(tpl.getTemplateSpec("order_delay_restock"), null, "no hay spec con la clave lógica: ese era el origen del falso negativo");
      const spec = tpl.resolveMappingSpec(mapping);
      assert.ok(spec, "la spec se resuelve por el nombre real de la WABA");
      assert.equal(spec!.name, "retraso_pedido");
      assert.equal(spec!.buttons.length, 2, "el contrato local son 2 botones, los mismos que la WABA");
    });

    await test("WHATSAPP · el aviso de retraso genera delay_ok/delay_cancel y AMBOS tienen handler seguro", async () => {
      // Los 2 botones de retraso_pedido no son decorativos: existen payloads y
      // existe handler. Por eso el doctor no debe bloquear por ellos.
      const notify = src("src/lib/orders/notify-delay.ts");
      assert.match(notify, /buildTemplateMessage\("retraso_pedido"/);
      assert.match(notify, /delay_ok:\$\{order\.id\}/);
      assert.match(notify, /delay_cancel:\$\{order\.id\}/);

      const conf = await import("../src/lib/orders/confirmation");
      const tel = "34600118801";
      const o = mkOrder("wa-delay-1", "88801", tel);
      db.systemDbHandle().prepare("UPDATE orders SET status='confirmed', confirmed_at=unixepoch() WHERE id=?").run(o.id);

      const ok = await conf.handleOrderButtonReply(tel, `delay_ok:${o.id}`);
      assert.equal(ok.handled, true, "delay_ok está atendido");
      const trasOk = db.getOrderById(o.id)!;
      assert.ok(!/cancel/.test(trasOk.status), "aceptar esperar NO cancela nada");

      const o2 = mkOrder("wa-delay-2", "88802", "34600118802");
      db.systemDbHandle().prepare("UPDATE orders SET status='confirmed', confirmed_at=unixepoch() WHERE id=?").run(o2.id);
      const cancel = await conf.handleOrderButtonReply("34600118802", `delay_cancel:${o2.id}`);
      assert.equal(cancel.handled, true, "delay_cancel está atendido");
      const trasCancel = db.getOrderById(o2.id)!;
      assert.equal(trasCancel.closure_status, "unknown", "NO cancela el pedido: solo REGISTRA la solicitud para gestión humana");
      assert.ok(
        sysRepo.listIntegrationEvents({ limit: 2000 }).some((e) => e.event_type === "delay_cancellation_requested"),
        "queda constancia de la solicitud"
      );
    });

    await test("WHATSAPP · mapping DESHABILITADO es fail-closed: ni con caché previa se considera listo", async () => {
      // order_cancelled_ack → pedido_cancelado: la WABA tiene un botón
      // "Necesito ayuda" sin handler, y NO existe sender productivo (búsqueda
      // 03-09: cero usos en src/ y scripts/). Apagado a propósito.
      const tpl = await import("../src/lib/whatsapp/templates");
      const mapping = tpl.loadProviderMappings().find((m) => m.logicalKey === "order_cancelled_ack")!;
      assert.equal(mapping.enabled, false, "declarado explícitamente en el catálogo");

      // Se le planta una caché de verificación PERFECTA a propósito.
      tpl.storeVerifiedTemplate("order_cancelled_ack", {
        provider: "pedido_cancelado",
        language: "en",
        status: "APPROVED",
        paramCount: 2,
        buttonCount: 1,
        buttonTypes: ["QUICK_REPLY"],
        category: "UTILITY",
        verifiedAt: Math.floor(Date.now() / 1000),
      });
      const r = tpl.getTemplateReadiness("order_cancelled_ack");
      assert.equal(r.ready, false, "sigue sin estar listo pese a la caché APPROVED");
      assert.equal(r.blocker, "TEMPLATE_MAPPING_DISABLED");
      // Y el envío no se puede construir.
      assert.throws(
        () => tpl.buildApprovedTemplateMessage("order_cancelled_ack", { nombre: "x", numero_pedido: "#1" }),
        /no lista|DESHABILITADO/i,
        "no hay forma de enviarlo por accidente"
      );
      // Cero senders en el código: si algún día aparece uno, este test lo caza.
      const usos = ["src", "scripts"].flatMap((d) =>
        execSyncSafe(`grep -rl "order_cancelled_ack" ${d} 2>/dev/null || true`).split("\n").filter(Boolean)
      );
      assert.deepEqual(usos, [], "ningún fichero de src/ o scripts/ referencia este mapping");
    });

    await test("V4.2 Growth: jerarquía sin perder sub-áreas (4 pestañas + Más análisis)", () => {
      const g = src("src/components/GrowthView.tsx");
      const primary = /const TABS: Array<\{ id: GrowthTab; label: string \}> = \[([\s\S]*?)\n\];/.exec(g)![1];
      assert.equal((primary.match(/id: "/g) ?? []).length, 4, "cuatro pestañas principales");
      const secondary = /const SECONDARY_TABS[\s\S]*?\n\];/.exec(g)![0];
      for (const t of ["calculator", "audit", "repurchase", "competition"]) {
        assert.ok(secondary.includes(`id: "${t}"`), `${t} sigue accesible en Más análisis`);
      }
      assert.match(g, /aria-label="Más análisis"/, "navegación secundaria real");
    });

    await test("V4.2 Home sigue centrada en operación: ni Cazador ni Landing Studio como tarea prioritaria", () => {
      const home = src("src/components/HomePanel.tsx");
      assert.ok(!/hunter|landing|Cazador|Landing Studio/i.test(home), "Home no promociona herramientas secundarias");
      const room = src("src/lib/system/control-room.ts");
      assert.ok(!/hunter|landing/i.test(room), "el backend de la Home tampoco genera atención de herramientas");
    });

    await test("V4 seguimiento: buckets por lo que toca hacer, teléfono ENMASCARADO y antigüedad desde el último contacto", async () => {
      const fu = await import("../src/lib/system/followup");
      const tel = "34600997101";
      const o = mkOrder("v4fu-1", "97101", tel);
      db.systemDbHandle().prepare("UPDATE orders SET status='awaiting_reply', whatsapp_sent_at = unixepoch() - 7200 WHERE id = ?").run(o.id);
      const ov = fu.getFollowUpOverview();
      const item = ov.items.find((i) => i.id === o.id)!;
      assert.ok(item, "aparece en seguimiento");
      assert.equal(item.bucket, "awaiting_reply");
      assert.equal(item.phoneMasked, "···7101", "solo los 4 últimos dígitos en el listado");
      assert.ok(!JSON.stringify(ov).includes(tel), "el teléfono completo NO viaja en la vista");
      assert.ok(item.ageSeconds !== null && item.ageSeconds >= 7100, "antigüedad desde el último contacto (nuestro envío)");
      db.systemDbHandle().prepare("UPDATE orders SET status='needs_call', needs_call_at = unixepoch() WHERE id = ?").run(o.id);
      assert.equal(fu.getFollowUpOverview().items.find((i) => i.id === o.id)!.bucket, "needs_call");
    });

    await test("V4 seguimiento: la línea temporal solo contiene hechos con fecha, en orden cronológico", async () => {
      const fu = await import("../src/lib/system/followup");
      const o = mkOrder("v4fu-2", "97102", "34600997102");
      db.systemDbHandle()
        .prepare("UPDATE orders SET created_at = unixepoch() - 7200, ordered_at = unixepoch() - 7200, whatsapp_sent_at = unixepoch() - 3600, customer_replied_at = unixepoch() - 1800, confirmed_at = unixepoch() - 1700, status='confirmed' WHERE id = ?")
        .run(o.id);
      const t = fu.getOrderTimeline(o.id);
      const kinds = t.events.map((e) => e.kind);
      assert.deepEqual(kinds.slice(0, 4), ["order_received", "message_sent", "reply_received", "confirmed"]);
      for (let i = 1; i < t.events.length; i++) assert.ok(t.events[i].at >= t.events[i - 1].at, "orden cronológico");
      assert.ok(!kinds.includes("reminder_sent"), "sin recordatorio no hay evento de recordatorio: nada inventado");
      assert.equal(fu.getOrderTimeline(999999).order, null);
    });

    await test("V4 home: dinero en riesgo = pedidos vivos sin confirmar o con problema; ayer solo si hubo datos", async () => {
      const extras = await import("../src/lib/system/control-room-extras");
      const o = mkOrder("v4hm-1", "97201", "34600997201");
      db.systemDbHandle().prepare("UPDATE orders SET status='awaiting_reply', total_price='40.00' WHERE id = ?").run(o.id);
      const antes = extras.getHomeExtras();
      db.systemDbHandle().prepare("UPDATE orders SET status='confirmed', confirmed_at = unixepoch() WHERE id = ?").run(o.id);
      const despues = extras.getHomeExtras();
      assert.ok(antes.today.revenueAtRisk >= despues.today.revenueAtRisk + 40 - 0.01, "confirmar saca 40 € del riesgo");
      assert.ok(antes.today.revenueAtRiskOrders === despues.today.revenueAtRiskOrders + 1);
      assert.ok(despues.yesterday === null || despues.yesterday.orders > 0, "comparación con ayer solo con datos reales");
      assert.ok(Array.isArray(despues.recentActivity) && despues.recentActivity.length <= 8, "actividad compacta");
      for (const e of despues.recentActivity) assert.ok(!/\+?34\d{9}/.test(e.message), "sin teléfonos completos en la actividad");
    });

    await test("V4 seguridad: los flags de producción no cambian por el rediseño (fail-closed intacto)", async () => {
      const safety2 = await import("../src/lib/safety");
      await withEnv({ WHATSAPP_SEND_ENABLED: "0", APP_MODE: "production", EMERGENCY_STOP: "0", TEST_MODE: "1", TEST_PHONE_ALLOWLIST: "34600000001" }, () => {
        assert.equal(safety2.canSendRealWhatsApp("34600000001"), false, "WHATSAPP_SEND_ENABLED=0 → jamás un envío real");
      });
      const dropea = await import("../src/lib/suppliers/dropea/create-gate");
      await withEnv({ DROPEA_CREATE_MODE: "external_app" }, () => {
        assert.equal(dropea.dropeaCreateMode(), "external_app", "la app oficial crea los pedidos; our_api sigue apagado");
      });
      const env = src(".env.example");
      assert.match(env, /^WHATSAPP_SEND_ENABLED=0/m);
      assert.match(env, /^DROPEA_CREATE_MODE=external_app/m);
    });

    await test("V4 growth: el embudo declara qué pasos NO tienen integración (sin porcentajes inventados)", () => {
      const g = src("src/components/GrowthView.tsx");
      const source = src("src/lib/system/growth-funnel.ts");
      assert.match(g, /Shopify Web Pixels/);
      assert.match(source, /available: false/);
      assert.match(g, /fetch\("\/api\/growth\/funnel"/);
      assert.ok(!/\d+%/.test(source), "ningún porcentaje hardcodeado en el embudo");
      assert.match(g, /Dato real|Hipótesis|Escenario|Recomendación IA/);
    });

    await test("V4 growth: pedido, WhatsApp, confirmado, enviado, entregado y devuelto salen de la DB real", async () => {
      const funnel = await import("../src/lib/system/growth-funnel");
      const before = funnel.getGrowthFunnel();
      const value = (id: string, snapshot = before) => snapshot.steps.find((step) => step.id === id)!.value ?? 0;
      const o = mkOrder("v4-growth-1", "97301", "34600997301");
      db.systemDbHandle().prepare("UPDATE orders SET whatsapp_sent_at=unixepoch(), confirmed_at=unixepoch(), closure_status='delivered' WHERE id=?").run(o.id);
      const after = funnel.getGrowthFunnel();
      for (const id of ["cod_order", "whatsapp", "confirmed", "shipped", "delivered"]) assert.equal(value(id, after), value(id) + 1, id);
      assert.equal(value("refused", after), value("refused"), "entregado no cuenta como devuelto");
      for (const id of ["visit", "product_view", "cart", "checkout"]) assert.equal(after.steps.find((step) => step.id === id)!.value, null, id);
    });

    await test("V4 responsive: sin anchos fijos en píxeles fuera de contenedores con scroll propio", () => {
      const comps = fs.readdirSync(path.join(process.cwd(), "src/components")).filter((f) => f.endsWith(".tsx"));
      for (const f of comps) {
        const code = src(`src/components/${f}`);
        // min-w-[NNNpx] solo dentro de tablas/áreas con overflow-x-auto: se comprueba
        // que cada fichero que lo usa también declara overflow-x-auto.
        if (/min-w-\[[4-9]\d{2,}px\]/.test(code)) assert.ok(/overflow-x-auto/.test(code), `${f}: min-w fijo ≥400px sin contenedor con scroll horizontal`);
      }
    });
  }

  // ============ V4 · Cazador de productos: tests de CONTRATO (backend de Pedro) ============
  console.log("\n— V4 · Cazador de productos (contratos, adaptadores, sin métricas inventadas) —");
  {
    const contract = await import("../src/lib/product-hunter/__contract_tests__");
    const casos = contract.runProductHunterContractTests(assert);
    assert.ok(Array.isArray(casos) && casos.length >= 5, "el módulo del Cazador expone sus tests de contrato");
    for (const c of casos) {
      await test(`Cazador · ${c.name}`, async () => {
        await c.fn();
      });
    }
  }

  // ============ V4 · Landing Studio: blueprint, viabilidad, claims y Shopify ==========
  console.log("\n— V4 · Landing Studio (blueprint, validación, versiones y exportación) —");
  {
    const studio = await import("../src/lib/landing-studio/types");
    const viability = await import("../src/lib/landing-studio/viability");
    const validation = await import("../src/lib/landing-studio/validation");
    const shopify = await import("../src/lib/landing-studio/shopify-export");
    const candidate = {
      id: "candidate-test-1", productName: "Producto prueba", advertiser: "Anunciante de prueba", countries: ["ES"], format: "image" as const,
      cta: "Comprar", startedAt: "2026-08-01", activeDays: 32, variations: 3, landingUrl: "https://example.test/producto",
      detectedPrice: { amount: 29.99, currency: "EUR" }, previewUrl: "https://example.test/product.jpg", adCopy: "Una propuesta pendiente de demostrar",
      dataStatus: "partial" as const, winnerScore: null, status: "saved" as const,
      economics: { costEstimate: 6.5, salePriceEstimate: 29.99, shippingCost: 5.5, returnCost: 4.5 }, notes: [], decisions: [], savedAt: "2026-09-02T10:00:00.000Z", risks: [], saturation: null,
    };

    await test("Landing · el candidato genera un LandingBlueprint estructurado y conserva el anuncio de origen", () => {
      const bp = studio.createLandingBlueprint(candidate, "2026-09-02T12:00:00.000Z");
      assert.equal(bp.schemaVersion, 1);
      assert.equal(bp.candidateId, candidate.id);
      assert.equal(bp.sourceAd.id, candidate.id);
      assert.equal(bp.product.name, candidate.productName);
      assert.ok(bp.sections.length >= 4 && bp.sections.every((section) => typeof section.id === "string" && typeof section.visible === "boolean"));
      assert.ok(Array.isArray(bp.assets) && Array.isArray(bp.claims) && Array.isArray(bp.experiments));
      assert.ok(!("html" in bp), "el HTML no es la fuente de verdad");
    });

    await test("Landing · la viabilidad incompleta devuelve campos ausentes, nunca cero plausible", () => {
      const bp = studio.createLandingBlueprint(candidate);
      const result = viability.calculateLandingViability(bp.economics);
      assert.equal(result.complete, false);
      assert.equal(result.expectedContribution, null);
      assert.ok(result.missing.includes("IVA aplicable") && result.missing.includes("CAC"));
    });

    await test("Landing · la viabilidad usa la fórmula determinista completa y distingue escenario no viable", () => {
      const bp = studio.createLandingBlueprint(candidate);
      for (const [key, value] of Object.entries({ salePrice: 29.99, deliveryRate: 0.7, productCost: 6.5, vat: 2, shipping: 5.5, codFee: 0.7, handling: 1, returnCost: 4.5, cac: 5 })) {
        const field = bp.economics[key as keyof typeof bp.economics]; field.value = value; field.kind = "scenario";
      }
      const result = viability.calculateLandingViability(bp.economics);
      assert.equal(result.complete, true);
      assert.ok(Math.abs((result.expectedNetRevenue ?? 0) - 20.993) < 0.001);
      assert.ok(Math.abs((result.expectedReturnCost ?? 0) - 1.35) < 0.001);
      assert.ok(Math.abs((result.expectedContribution ?? 0) - (-0.847)) < 0.001);
      assert.equal(result.viable, false);
    });

    await test("Landing · claims pendientes, bloqueados y promesas prohibidas bloquean la exportación", () => {
      const bp = studio.createLandingBlueprint(candidate);
      bp.claims = [{ id: "c1", text: "4.9/5 estrellas y científicamente probado", status: "hypothesis", evidence: null }];
      const issues = validation.validateLandingBlueprint(bp);
      assert.ok(issues.some((issue) => issue.code === "CLAIM_PENDING"));
      assert.ok(issues.some((issue) => issue.code === "FAKE_REVIEW"));
      assert.ok(issues.some((issue) => issue.code === "FAKE_STUDY"));
      assert.equal(validation.canExportLanding(bp), false);
    });

    await test("Landing · un precio anterior sin evidencia no produce descuento", () => {
      const bp = studio.createLandingBlueprint(candidate);
      bp.price.compareAt = 49.99;
      bp.price.compareAtEvidence = null;
      assert.ok(validation.validateLandingBlueprint(bp).some((issue) => issue.code === "COMPARE_PRICE_UNPROVEN"));
    });

    await test("Landing · assets ausentes bloquean y no se reemplazan por imágenes ficticias", () => {
      const bp = studio.createLandingBlueprint({ ...candidate, previewUrl: null });
      assert.ok(validation.validateLandingBlueprint(bp).some((issue) => issue.code === "ASSET_MISSING"));
      assert.equal(bp.assets[0].url, null);
    });

    await test("Landing · exportación bloqueada no genera un bundle parcial", () => {
      const bp = studio.createLandingBlueprint(candidate);
      assert.throws(() => shopify.buildShopifyThemeBundle(bp), /Exportación bloqueada/);
    });

    await test("Landing · Liquid, schema, template, assets, locales, manifest y ZIP son válidos y no publican", () => {
      const bp = studio.createLandingBlueprint(candidate, "2026-09-02T12:00:00.000Z");
      bp.claims[0].status = "verified"; bp.claims[0].evidence = "Documento interno TEST-EVIDENCE-1";
      bp.brief.audience = "Adultos que valoran una compra sencilla"; bp.brief.promise = "Explicar el producto sin exageraciones";
      const bundle = shopify.buildShopifyThemeBundle(bp, "2026-09-02T12:30:00.000Z");
      assert.deepEqual(shopify.validateShopifyThemeBundle(bundle), []);
      assert.equal(bundle.manifest.published, false);
      assert.ok(bundle.files.some((file) => file.path.startsWith("sections/") && file.path.endsWith(".liquid")));
      assert.ok(bundle.files.some((file) => file.path.startsWith("templates/") && file.path.endsWith(".json")));
      const liquid = bundle.files.find((file) => file.path.endsWith(".liquid"))!.content;
      for (const native of ["image_picker", "video", "product", "font_picker", "color_scheme"]) assert.ok(liquid.includes(native), native);
      assert.match(liquid, /#cm-\{\{ section\.id \}\}/, "scoping por section.id");
      assert.ok(!bundle.files.some((file) => /!important/i.test(file.content)));
      const zip = shopify.bundleToZip(bundle);
      assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04], "cabecera ZIP estándar");
      assert.ok(zip.length > 1000);
    });

    await test("Landing · la UI incluye editor de tres paneles, preview responsive, versiones, restauración y A/B", () => {
      const code = fs.readFileSync(path.join(process.cwd(), "src/components/landing-studio/LandingStudio.tsx"), "utf8");
      assert.match(code, /xl:grid-cols-\[240px_minmax\(0,1fr\)_300px\]/, "estructura · canvas · inspector");
      for (const viewport of ["desktop", "tablet", "mobile"]) assert.ok(code.includes(`\"${viewport}\"`), viewport);
      for (const action of ["Añadir sección", "Duplicar", "Eliminar", "Restaurar"]) assert.ok(code.includes(action), action);
      assert.match(code, /Experimento A\/B/);
      assert.match(code, /No se ha escrito ni publicado nada en Shopify/);
      assert.ok(!/overflow-x-scroll/.test(code), "sin scroll horizontal forzado en móvil");
    });
  }

  // ============ WORKSPACE DE ATENCIÓN · roles, privacidad y auditoría ============
  console.log("\n— Workspace de atención —");
  await test("schema 18 crea users, sessions, audit_log y límites de reenvío de forma idempotente", () => {
    const raw = db.systemDbHandle();
    db.migrateWorkspaceAuth(raw);
    db.migrateWorkspaceAuth(raw);
    for (const table of ["users", "sessions", "audit_log", "work_items", "confirmation_resends"]) {
      assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    }
    assert.equal(raw.pragma("user_version", { simple: true }), 18);
  });

  await test("la ficha del agente se construye por lista blanca y no filtra PII/proveedor/marketing", async () => {
    const { safeOrder } = await import("../src/lib/workspace");
    const order = db.listOrders(undefined, 1)[0];
    if (!order) return;
    const json = JSON.stringify(safeOrder(order));
    for (const forbidden of ["email", "raw_payload", "supplier_", "beeping_", "marketing_", "landing_site", "referring_site"]) {
      assert.ok(!json.includes(forbidden), `sin ${forbidden}`);
    }
  });

  await test("contraseñas scrypt: verifican la correcta y rechazan otra", async () => {
    const passwords = await import("../src/lib/auth/password");
    const hash = await passwords.hashPassword("contraseña-segura-123");
    assert.match(hash, /^scrypt\$/);
    assert.equal(await passwords.verifyPassword("contraseña-segura-123", hash), true);
    assert.equal(await passwords.verifyPassword("otra-contraseña-123", hash), false);
  });

  await test("PUBLIC_PREFIXES conserva webhooks y health sin cambios", () => {
    const proxy = fs.readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");
    assert.match(proxy, /const PUBLIC_PREFIXES = \["\/api\/webhooks\/", "\/api\/health"\]/);
  });

  // BUG 04-09: el proxy mandaba a requireOwner todo lo que no fuese /trabajo
  // ni /api/workspace, así que /api/mode/* y /api/messages/* devolvían 403 a
  // un agente AUNQUE sus handlers tuviesen requireStaff. El agente no podía
  // responder a un cliente. Esto ejerce el proxy REAL con sesiones REALES.
  await test("PROXY · clasifica staff/propietario y deja que el handler decida la acción", async () => {
    const { proxy } = await import("../src/proxy");
    const { NextRequest } = await import("next/server");
    const { createSession } = await import("../src/lib/auth/session");
    const raw = db.systemDbHandle();
    db.migrateWorkspaceAuth(raw);
    raw.prepare("INSERT OR IGNORE INTO users(email,name,role,password_hash) VALUES('proxy-agente@test','Agente Proxy','agent','x')").run();
    raw.prepare("INSERT OR IGNORE INTO users(email,name,role,password_hash) VALUES('proxy-duena@test','Dueña Proxy','owner','x')").run();
    const idDe = (correo: string) =>
      (raw.prepare("SELECT id FROM users WHERE email=?").get(correo) as { id: number }).id;
    const cookieAgente = `casamable_session=${createSession(idDe("proxy-agente@test"))}`;
    const cookieDuena = `casamable_session=${createSession(idDe("proxy-duena@test"))}`;

    const estado = (ruta: string, cookie?: string) => {
      const req = new NextRequest(`http://localhost${ruta}`, { headers: cookie ? { cookie } : {} });
      return proxy(req).status;
    };

    // Lo que un agente NECESITA para atender: el proxy debe dejarlo pasar.
    for (const ruta of ["/trabajo", "/api/workspace", "/api/workspace/action", "/api/mode/1", "/api/messages/1", "/api/orders/1/action"]) {
      assert.equal(estado(ruta, cookieAgente), 200, `el agente debe LLEGAR al handler de ${ruta}`);
    }
    // Lo que no le corresponde: cortado antes del handler.
    for (const ruta of ["/", "/sistema", "/ajustes", "/api/system", "/api/settings", "/api/calls", "/api/system/audit", "/api/orders", "/api/conversations", "/api/connection/status"]) {
      assert.equal(estado(ruta, cookieAgente), 403, `el agente NO debe llegar a ${ruta}`);
    }
    // El prefijo cómodo que NO se concedió: .../image no tiene guard propio,
    // así que sigue siendo del propietario. Si alguien lo abre, esto avisa.
    assert.equal(estado("/api/messages/1/image", cookieAgente), 403, "/api/messages/*/image no tiene guard propio: no se abre a staff");
    // La dueña llega a todo.
    for (const ruta of ["/", "/sistema", "/api/system", "/api/workspace", "/api/mode/1", "/api/orders/1/action"]) {
      assert.equal(estado(ruta, cookieDuena), 200, `la dueña debe llegar a ${ruta}`);
    }
    // Sin sesión: 401 en API y redirección a /login en páginas. Fail-closed.
    assert.equal(estado("/api/workspace"), 401);
    assert.equal(estado("/api/system"), 401);
    assert.equal(estado("/trabajo"), 307);
    // Públicos intactos.
    assert.equal(estado("/api/health/live"), 200);
    assert.equal(estado("/api/webhooks/shopify/orders-events"), 200);
    assert.equal(estado("/login"), 200);
  });

  await test("PROXY · la respuesta a un agente no lleva PII aunque la acción esté permitida", async () => {
    // Abrir /api/orders/*/action a staff dejaba que el agente recibiera la
    // FILA ENTERA del pedido (email, raw_payload, marketing_*). El permiso de
    // la acción y la forma de la respuesta son dos cosas distintas.
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/orders/[orderId]/action/route.ts"), "utf8");
    assert.match(src, /safeOrder/, "debe proyectar con safeOrder para el agente");
    assert.ok(!/order: getOrderById\(id\)/.test(src), "ninguna respuesta puede devolver la fila cruda sin proyectar");
  });

  await test("endpoints de sistema, ajustes, llamadas y acciones comprueban rol explícitamente", () => {
    for (const file of ["src/app/api/system/route.ts", "src/app/api/settings/route.ts", "src/app/api/calls/route.ts"]) {
      assert.match(fs.readFileSync(path.join(process.cwd(), file), "utf8"), /requireOwner\(req\)/, file);
    }
    assert.match(fs.readFileSync(path.join(process.cwd(), "src/app/api/orders/[orderId]/action/route.ts"), "utf8"), /auth\.user\.role === "agent"/);
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
