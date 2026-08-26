// ============================================================
// SEED LOCAL — puebla la DB del Mac con datos DEMO para ver el panel vivo.
//
//   npm run local:seed            # dice qué crearía
//   npm run local:seed -- --yes   # crea de verdad (solo DB LOCAL)
//
// Cero PII real: nombres inventados y teléfonos del rango 6000009xx.
// SE NIEGA con APP_MODE=production o DATA_DIR con pinta de NAS.
// ============================================================

import "./env-loader";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");
// APP_MODE=production con TEST_MODE=1 es la postura normal del Mac (los
// gates de envío quedan detrás de la allowlist): eso NO bloquea el seed.
// Lo que bloquea es producción DE VERDAD (TEST_MODE=0) o una ruta de NAS.
if ((process.env.APP_MODE === "production" && process.env.TEST_MODE === "0") || /\/volume1\/|\/app\/data|nas-data/.test(dataDir)) {
  console.error("\n✗ Entorno con pinta de producción/NAS: local:seed se NIEGA.\n");
  process.exit(1);
}

interface Demo {
  num: string; nombre: string; producto: string; precio: string; status: string;
  extra?: (db: typeof import("../src/lib/db"), id: number) => void;
}

const DEMOS: Demo[] = [
  { num: "8801", nombre: "Ana Demo", producto: "Limpiador Ultrasónico Multiusos", precio: "29.99", status: "awaiting_reply" },
  { num: "8802", nombre: "Luis Demo", producto: "Cortaúñas Eléctrico 3 en 1", precio: "24.99", status: "confirmed",
    extra: (db, id) => { db.setOrderSupplierPlatformAndExternalId(id, "dropea", "9900001"); db.setOrderClosure(id, "delivered", "dropea", Math.floor(Date.now() / 1000) - 86400); } },
  { num: "8803", nombre: "Marta Demo", producto: "Espejo Retrovisor Panorámico", precio: "39.99", status: "confirmed",
    extra: (db, id) => { db.setOrderSupplierPlatformAndExternalId(id, "dropea", "9900002"); db.setOrderClosure(id, "refused", "dropea", Math.floor(Date.now() / 1000) - 43200); } },
  { num: "8804", nombre: "Pepe Demo", producto: "Limpiador Ultrasónico Multiusos", precio: "29.99", status: "needs_call" },
  // Duplicado probable: mismo producto/importe/teléfono que 8805b.
  { num: "8805", nombre: "Lola Demo", producto: "Plancha de Pelo Iónica", precio: "34.99", status: "awaiting_reply" },
  { num: "8806", nombre: "Lola Demo", producto: "Plancha de Pelo Iónica", precio: "34.99", status: "awaiting_reply",
    extra: (db, id) => { db.markOrderPossibleDuplicate(id); } },
  { num: "8807", nombre: "Nico Demo", producto: "Cortaúñas Eléctrico 3 en 1", precio: "24.99", status: "needs_call",
    extra: (db, id) => { db.requestOrderCancellation(id); } },
];

async function main(): Promise<void> {
  if (!process.argv.includes("--yes")) {
    console.log(`\nCrearía ${DEMOS.length} pedidos DEMO (sin PII real) en ${dataDir}:`);
    for (const d of DEMOS) console.log(`  · #${d.num} ${d.producto} → ${d.status}`);
    console.log("\nRepite con -- --yes para crearlos. (Solo DB local; bórralos con npm run local:reset)\n");
    return;
  }
  const db = await import("../src/lib/db");
  const sys = await import("../src/lib/system/repo");
  let creados = 0;
  for (const [i, d] of DEMOS.entries()) {
    const tel = `346000009${String(i + 10).padStart(2, "0")}`;
    // Duplicado: mismo teléfono para el par 8805/8806.
    const telefono = d.num === "8806" ? "34600000914" : d.num === "8805" ? "34600000914" : tel;
    const { order, created } = db.insertOrderIfNew({
      shopify_order_id: `88${d.num}`, shopify_order_number: d.num, customer_name: d.nombre,
      phone: telefono, email: null, product_summary: d.producto, total_price: d.precio, currency: "EUR",
      address_line1: "Calle Demo 1", address_line2: null, city: "Vigo", province: "Pontevedra",
      postal_code: "36201", country: "España", status: d.status as never,
    });
    if (created) {
      creados++;
      d.extra?.(db, order.id);
    }
  }
  // Un par de eventos para que el feed no esté vacío.
  sys.logIntegrationEvent("whatsapp", "demo_seed", "info", "datos de demostración creados por local:seed");
  sys.logIntegrationEvent("shopify", "webhook_bad_signature", "warning", "EJEMPLO de firma inválida (demo)");
  sys.logIntegrationEvent("dropea", "closure_needs_review", "warning", "EJEMPLO: paquete devuelto por daño, no por rehúse (demo)");
  console.log(`\n✓ ${creados} pedidos demo creados. Arranca el panel: npm run dev:all → localhost:3000`);
  console.log("  Verás: pendientes, confirmados, entregado, rehusado, needs_call, POSIBLE DUPLICADO y PIDE CANCELAR.");
  console.log("  Limpieza: npm run local:reset -- --yes\n");
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
