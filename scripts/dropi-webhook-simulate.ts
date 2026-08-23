// ============================================================
// Simulador del webhook de Dropi. SIN RED y SIN efectos reales.
//
//   npm run dropi:webhook:simulate                    → fixture de ejemplo
//   npm run dropi:webhook:simulate -- fixture.json    → tu propio payload
//   npm run dropi:webhook:simulate -- --status="EN REPARTO" --status-id=4
//
// Prueba el camino completo: parseo → validación → emparejado → tracking →
// deduplicación, sobre una copia TEMPORAL de la base de datos. La base real
// no se toca en ningún momento.
// ============================================================

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import "./env-loader";

/** Copia la DB real a un directorio temporal: trabajamos sobre la copia. */
function prepararDbTemporal(): string {
  const origen = path.resolve(process.env.DATA_DIR ?? "data", "messages.db");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dropi-sim-"));
  if (fs.existsSync(origen)) {
    fs.copyFileSync(origen, path.join(dir, "messages.db"));
  }
  return dir;
}

interface Args {
  fixture?: string;
  statusName?: string;
  statusId?: number;
  tracking?: string;
  orderNumber?: string;
}

function parseArgs(): Args {
  const out: Args = {};
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--status-id=")) out.statusId = parseInt(a.split("=")[1], 10);
    else if (a.startsWith("--status=")) out.statusName = a.split("=").slice(1).join("=");
    else if (a.startsWith("--tracking=")) out.tracking = a.split("=")[1];
    else if (a.startsWith("--order=")) out.orderNumber = a.split("=")[1];
    else if (!a.startsWith("--")) out.fixture = a;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const tmp = prepararDbTemporal();
  process.env.DATA_DIR = tmp; // TODO lo que siga trabaja sobre la copia
  process.env.DROPIPRO_WEBHOOK_ENABLED = "1"; // habilitado solo en la simulación

  const db = await import("../src/lib/db");
  const { processDropiWebhook } = await import("../src/lib/suppliers/dropi/webhook");
  const { normalizeDropiStatus } = await import("../src/lib/suppliers/dropi/status-map");

  console.log("\n════════ SIMULACIÓN WEBHOOK DROPI ════════");
  console.log(`  Base de datos: COPIA temporal (${tmp})`);
  console.log("  Sin red. Sin efectos sobre la base real ni sobre WhatsApp.\n");

  // 1. Elegir el pedido sobre el que simular.
  const pedidos = db.listOrders().filter((o) => o.status === "confirmed");
  const objetivo = args.orderNumber
    ? pedidos.find((o) => o.shopify_order_number === args.orderNumber)
    : pedidos[0];

  if (!objetivo && !args.fixture) {
    console.log("✗ No hay pedidos confirmados sobre los que simular.");
    console.log("  Usa un fixture propio: npm run dropi:webhook:simulate -- mi-payload.json");
    return;
  }

  // 2. Construir el payload (fixture del usuario o ejemplo con la estructura real).
  let payload: Record<string, unknown>;
  if (args.fixture) {
    payload = JSON.parse(fs.readFileSync(path.resolve(args.fixture), "utf-8"));
    console.log(`  Fixture: ${args.fixture}`);
  } else {
    payload = {
      order_id: 987654,
      event_date: new Date().toISOString(),
      status_id: args.statusId ?? 4,
      status_name: args.statusName ?? "EN REPARTO",
      details: "Actualización simulada",
      tracking_code: args.tracking ?? "TRK-SIM-0001",
      tracking_url: "https://tracking.example/TRK-SIM-0001",
      shopify_order_id: Number(objetivo!.shopify_order_id),
      shipping_company: "Transportista Ejemplo",
      total: objetivo!.total_price,
    };
  }

  const nombre = String(payload.status_name ?? "");
  const id = Number(payload.status_id ?? 0);
  console.log(`  Estado recibido : id=${id} "${nombre}"`);
  console.log(`  Normalizado a   : ${normalizeDropiStatus(id, nombre)}`);
  if (normalizeDropiStatus(id, nombre) === "unknown") {
    console.log("     ⚠️  Estado sin confirmar → no se avisará al cliente (correcto).");
    console.log("        Para confirmarlo: DROPI_STATUS_MAP=" + id + ":out_for_delivery");
  }

  const contar = (phone: string) => db.getPendingOutbox(999).filter((o) => o.phone === phone).length;
  const tel = objetivo?.phone ?? "";
  const antes = tel ? contar(tel) : 0;

  // 3. Primer envío.
  console.log("\n── 1ª entrega del webhook ──");
  const r1 = processDropiWebhook(JSON.stringify(payload));
  console.log(`  HTTP ${r1.status} · ${JSON.stringify(r1.body)}`);
  const tras1 = tel ? contar(tel) : 0;
  console.log(`  WhatsApps encolados: ${tras1 - antes}`);

  // 4. Mismo webhook otra vez: debe ser inocuo.
  console.log("\n── 2ª entrega IDÉNTICA (reintento del proveedor) ──");
  const r2 = processDropiWebhook(JSON.stringify(payload));
  console.log(`  HTTP ${r2.status} · ${JSON.stringify(r2.body)}`);
  const tras2 = tel ? contar(tel) : 0;
  console.log(
    `  WhatsApps encolados: ${tras2 - tras1} ${tras2 === tras1 ? "✓ sin duplicados" : "✗ ¡DUPLICADO!"}`
  );

  // 5. Estado final del pedido.
  if (objetivo) {
    const fresco = db.getOrderById(objetivo.id)!;
    console.log("\n── Estado del pedido tras la simulación ──");
    console.log(`  proveedor      : ${fresco.supplier_platform ?? "—"}`);
    console.log(`  id externo     : ${fresco.supplier_external_order_id ?? "—"}`);
    console.log(`  estado envío   : ${fresco.supplier_status_normalized} (raw: ${fresco.supplier_status_raw ?? "—"})`);
    console.log(`  tracking       : ${fresco.tracking_number ?? "—"} · ${fresco.carrier ?? "—"}`);
    console.log(`  aviso tracking : ${fresco.tracking_notification_sent_at ? "enviado" : "no"}`);
    console.log(`  aviso reparto  : ${fresco.out_for_delivery_notification_sent_at ? "enviado" : "no"}`);
  }

  console.log(`\nLa base de datos real NO se ha tocado. Copia temporal: ${tmp}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
