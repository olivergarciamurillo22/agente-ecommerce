// ============================================================
// Simulador de envío a proveedor. NO hace red, NO toca proveedores reales,
// NO modifica la base de datos.
//
//   npm run supplier:simulate            → todos los pedidos confirmados
//   npm run supplier:simulate -- 1065    → solo ese número de pedido
//
// Muestra qué proveedor se elegiría, el DTO que se enviaría y qué bloquea
// el envío. Nunca imprime credenciales.
// ============================================================

import "./env-loader";
import { listOrders, getOrderById, type OrderRow } from "../src/lib/db";
import { simulateSupplierSync, supplierSyncEnabled, supplierTestMode } from "../src/lib/suppliers/service";

const ETIQUETA: Record<string, string> = {
  not_ready: "SIN CONFIRMAR",
  blocked_address: "BLOQUEADO DIRECCIÓN",
  manual_review: "REVISIÓN MANUAL",
  ready: "LISTO",
  simulated: "SIMULADO",
  syncing: "SINCRONIZANDO",
  synced: "SINCRONIZADO",
  failed: "ERROR",
  cancelled: "CANCELADO",
};

function simular(order: OrderRow): void {
  const { evaluation, gate, simulated } = simulateSupplierSync(order);

  console.log(`\n── Pedido #${order.shopify_order_number} ─────────────────────`);
  console.log(`  estado del pedido : ${order.status}`);
  console.log(`  proveedor         : ${evaluation.platform}`);
  console.log(`  resultado         : ${ETIQUETA[evaluation.status] ?? evaluation.status}`);
  console.log(`  motivo            : ${evaluation.reason}`);
  console.log(`  ¿envío real?      : NO — ${gate.reason ?? "permitido (pero esto es una simulación)"}`);

  if (evaluation.input) {
    const i = evaluation.input;
    console.log("  payload interno que se enviaría:");
    console.log(`      referencia   : ${i.shopifyOrderId} (idempotency key)`);
    console.log(`      cliente      : ${i.customerName ?? "—"} · +${i.phone}`);
    console.log(`      dirección    : ${[i.finalAddress.line1, i.finalAddress.line2].filter(Boolean).join(", ")}`);
    console.log(`                     ${i.finalAddress.postalCode} ${i.finalAddress.city}${i.finalAddress.province ? ` (${i.finalAddress.province})` : ""}`);
    console.log(`      origen dir.  : ${i.addressSource}`);
    console.log(`      productos    : ${i.items.map((it) => `${it.quantity}x ${it.title}`).join(" | ") || "—"}`);
    console.log(`      contra reemb.: ${i.codAmount} ${i.currency}`);
    console.log(`      nota reparto : ${i.deliveryNote ?? "—"}`);
  }
  if (simulated) {
    console.log(`  id simulado       : ${simulated.externalOrderId} (ficticio, no existe en el proveedor)`);
  }
}

function main(): void {
  const arg = process.argv[2];

  console.log("\n════════ SIMULACIÓN DE ENVÍO A PROVEEDOR ════════");
  console.log(`  SUPPLIER_SYNC_ENABLED : ${supplierSyncEnabled() ? "1 ⚠️" : "0 (bloqueado)"}`);
  console.log(`  SUPPLIER_TEST_MODE    : ${supplierTestMode() ? "1 (solo simulación)" : "0 ⚠️"}`);
  console.log("  Esta herramienta NUNCA hace llamadas de red ni modifica nada.");

  let pedidos: OrderRow[];
  if (arg) {
    const porNumero = listOrders().filter((o) => o.shopify_order_number === arg);
    const porId = /^\d+$/.test(arg) ? getOrderById(Number(arg)) : null;
    pedidos = porNumero.length ? porNumero : porId ? [porId] : [];
    if (!pedidos.length) {
      console.log(`\n✗ No encuentro ningún pedido "${arg}".`);
      process.exit(1);
    }
  } else {
    pedidos = listOrders().filter((o) => o.status === "confirmed");
    if (!pedidos.length) {
      console.log("\nNo hay pedidos confirmados que simular.");
      return;
    }
  }

  for (const o of pedidos) simular(o);
  console.log(`\n${pedidos.length} pedido(s) simulados. Nada se ha enviado.\n`);
}

main();
