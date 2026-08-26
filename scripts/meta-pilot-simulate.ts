// ============================================================
// SIMULADOR DEL PILOTO DE META — el flujo completo, SIN RED.
//
//   npm run meta:pilot:simulate
//
// Reproduce en una base de datos TEMPORAL exactamente lo que pasará el día
// del piloto: pedido nuevo → fuera de ventana → PLANTILLA → el cliente
// responde → la ventana se abre → interactivo con botones → botón Confirmar
// → webhook de estados delivered/read. Con credenciales FALSAS y un fetch
// falso: ni una llamada a Meta, ni un WhatsApp real, ni tocar tu data/.
//
// Si esto sale verde, lo único que el piloto real puede descubrir son
// diferencias del CONTRATO de Meta — no bugs de nuestro flujo.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// DB temporal ANTES de importar nada que toque SQLite.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meta-pilot-"));
process.env.DATA_DIR = tmp;

// Entorno del piloto, con credenciales FALSAS (el fetch es falso: no salen).
Object.assign(process.env, {
  APP_MODE: "production",
  WHATSAPP_SEND_ENABLED: "1",
  EMERGENCY_STOP: "0",
  TEST_MODE: "1",
  TEST_PHONE_ALLOWLIST: "34600000901",
  WHATSAPP_PROVIDER: "cloud_api",
  META_WHATSAPP_API_ENABLED: "1",
  META_WHATSAPP_PHONE_NUMBER_ID: "111000111",
  META_WHATSAPP_ACCESS_TOKEN: "token-simulado-jamas-real",
  META_WHATSAPP_APP_SECRET: "app-secret-simulado",
  META_WHATSAPP_VERIFY_TOKEN: "verify-simulado",
  WHATSAPP_WINDOW_ENABLED: "0",
  MAX_ORDER_AGE_MINUTES: "9999999",
  ORDER_POLL_SECONDS: "1",
  FIRST_REMINDER_MINUTES: "9999",
  NEEDS_CALL_MINUTES: "99999",
  LOG_LEVEL: "silent",
});

const TEL = "34600000901";
let paso = 0;
let fallos = 0;
function check(nombre: string, ok: boolean, detalle?: string): void {
  paso++;
  console.log(`  ${ok ? "✓" : "✗"} ${paso}. ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  if (!ok) fallos++;
}

async function main(): Promise<void> {
  const db = await import("../src/lib/db");
  const { runSchedulerTick } = await import("../src/lib/orders/scheduler");
  const { runCloudOutboxTick } = await import("../src/lib/whatsapp/cloud-outbox");
  const { processMetaWebhook } = await import("../src/lib/whatsapp/meta-webhook");
  const { isWithinSessionWindow } = await import("../src/lib/whatsapp/meta-cloud");
  const tipo = (m: unknown) => (m as { kind: string }).kind;

  // Proveedor Meta FALSO: acepta todo y devuelve ids tipo wamid.
  const enviados: Array<{ kind: string; toTemplate: string | null }> = [];
  let seq = 0;
  const fakeProvider = {
    name: "cloud_api" as const,
    isConfigured: () => true,
    getHealth: () => ({ provider: "cloud_api" as const, configured: true, available: true, detail: "" }),
    markAsRead: async () => {},
    send: async (_to: string, m: unknown) => {
      enviados.push({ kind: tipo(m), toTemplate: (m as { templateName?: string }).templateName ?? null });
      return { ok: true, providerMessageId: `wamid.SIM.${++seq}` };
    },
  };
  const firma = (raw: string) =>
    "sha256=" + crypto.createHmac("sha256", "app-secret-simulado").update(raw, "utf8").digest("hex");
  const inbound = (msg: Record<string, unknown>) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: TEL, profile: { name: "Piloto" } }], messages: [msg] } }] }],
    });
  const statusBody = (st: Record<string, unknown>) =>
    JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [st] } }] }] });
  const drenar = async () => {
    for (let i = 0; i < 20 && db.getPendingOutbox(50).length > 0; i++) await runCloudOutboxTick(fakeProvider);
  };
  const mkPedido = (id: string, num: string) =>
    db.insertOrderIfNew({
      shopify_order_id: id, shopify_order_number: num, customer_name: "Cliente Piloto", phone: TEL,
      email: null, product_summary: "Limpiador Ultrasónico Multiusos", total_price: "29.99", currency: "EUR",
      address_line1: "Calle Ejemplo 1", address_line2: null, city: "Vigo", province: "Pontevedra",
      postal_code: "36201", country: "España", status: "pending_send",
    }).order;

  console.log("\n════════ SIMULACIÓN DEL PILOTO DE META (sin red) ════════\n");
  console.log(`  DB temporal: ${tmp}\n`);

  // ── FASE 1: primer mensaje, fuera de ventana → PLANTILLA ──
  console.log("── FASE 1 · Pedido nuevo (el cliente JAMÁS escribió) ──");
  const p1 = mkPedido("990901", "9901");
  check("fuera de la ventana de 24 h", !isWithinSessionWindow(TEL));
  await runSchedulerTick(Math.floor(Date.now() / 1000));
  const item1 = db.getPendingOutbox(50).find((x) => x.phone === TEL);
  check("el scheduler encoló el primer mensaje", Boolean(item1));
  check("y es PLANTILLA, no interactivo", item1?.message_type === "template", item1?.template_name ?? "");
  await drenar();
  check("salió por el proveedor como template", enviados[0]?.kind === "template", `→ ${enviados[0]?.toTemplate}`);
  check("provider_message_id persistido", Boolean(db.getOutboxByProviderMessageId("wamid.SIM.1")));

  // ── FASE 2: el cliente responde → la ventana SE ABRE ──
  console.log("\n── FASE 2 · El cliente responde al template ──");
  const r1 = inbound({ from: TEL, id: "wamid.in.1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hola, sí" } });
  const res1 = processMetaWebhook(r1, firma(r1));
  check("webhook aceptado (firma válida)", res1.status === 200);
  check("la ventana de 24 h está ABIERTA", isWithinSessionWindow(TEL));
  await drenar(); // la respuesta del flujo (aclaración) sale como texto

  // ── FASE 3: segundo pedido, dentro de ventana → BOTONES ──
  console.log("\n── FASE 3 · Segundo pedido (dentro de ventana) ──");
  db.markOrderConfirmed(p1.id, true); // cerrar el 1º para aislar la fase
  const p2 = mkPedido("990902", "9902");
  await runSchedulerTick(Math.floor(Date.now() / 1000));
  const item2 = db.getPendingOutbox(50).find((x) => x.phone === TEL);
  check("el segundo mensaje es INTERACTIVO con botones", item2?.message_type === "interactive_buttons");
  await drenar();
  check("salió como interactive_buttons", enviados.some((e) => e.kind === "interactive_buttons"));

  // ── FASE 4: botón Confirmar ──
  console.log("\n── FASE 4 · El cliente pulsa ✅ Confirmar ──");
  const r2 = inbound({
    from: TEL, id: "wamid.in.2", timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "confirm_order", title: "✅ Confirmar pedido" } },
  });
  processMetaWebhook(r2, firma(r2));
  check("el pedido queda CONFIRMADO por el payload del botón", db.getOrderById(p2.id)!.status === "confirmed");
  await drenar();

  // ── FASE 5: estados delivered / read ──
  console.log("\n── FASE 5 · Webhooks de estado ──");
  const wamidPlantilla = "wamid.SIM.1";
  const t = Math.floor(Date.now() / 1000);
  const sDel = statusBody({ id: wamidPlantilla, status: "delivered", timestamp: String(t), recipient_id: TEL });
  processMetaWebhook(sDel, firma(sDel));
  const sRead = statusBody({ id: wamidPlantilla, status: "read", timestamp: String(t + 5), recipient_id: TEL });
  processMetaWebhook(sRead, firma(sRead));
  const fila = db.getOutboxByProviderMessageId(wamidPlantilla)!;
  check("delivered_at estampado", fila.delivered_at === t);
  check("read_at estampado (y no pisa delivered)", fila.read_at === t + 5 && fila.delivered_at === t);

  // ── Resumen ──
  console.log("\n════════ RESULTADO ════════");
  if (fallos === 0) {
    console.log(`✓ ${paso}/${paso} pasos correctos — EL FLUJO DEL PILOTO FUNCIONA EN LOCAL.`);
    console.log("  Lo único que el piloto real puede descubrir son diferencias del contrato de Meta.\n");
  } else {
    console.log(`✗ ${fallos} de ${paso} pasos fallaron — NO ir al piloto hasta arreglarlo.\n`);
    process.exitCode = 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
