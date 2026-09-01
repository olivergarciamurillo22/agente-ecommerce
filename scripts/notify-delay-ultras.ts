// ============================================================
// Aviso de retraso de reposición — campaña "Ultras"/"gafa".
//
//   npm run notify:delay-ultras -- --date=2026-09-15                      # dry-run
//   npm run notify:delay-ultras -- --date=2026-09-15 --execute             # envía de verdad
//   npm run notify:delay-ultras -- --date=2026-09-15 --execute --only=1234,1240
//
// DRY-RUN POR DEFECTO. Solo envía con --execute explícito.
//
// La construcción del mensaje y el envío son EXACTAMENTE los de la acción
// notify_delay del panel (src/app/api/orders/[orderId]/action/route.ts) —
// ver src/lib/orders/notify-delay.ts, que es el único sitio donde vive esa
// lógica. Este script solo añade lo que el botón manual no necesita:
// selección en lote, idempotencia, ritmo y aborto.
//
// --date es OBLIGATORIO, sin default: es la fecha de REPOSICIÓN de stock en
// almacén (variable {{4}} de la plantilla retraso_pedido), NO la fecha de
// entrega al cliente — no filtra qué pedidos entran, solo se inserta en el
// mensaje. Si falta, el script aborta sin tocar nada.
//
// SELECCIÓN: confirmados, con teléfono, sin cierre cancelado, sin pedidos
// de prueba (shopify_order_id TEST-%), y elegibles según
// isDelayNotificationEligible (producto con "ultras" o "gafa" — el mismo
// criterio que ya aplicaba el botón del panel). --only restringe el lote a
// ids concretos (para reintentar un pedido suelto sin tocar el resto).
//
// IDEMPOTENCIA: notify_delay_sends (order_id UNIQUE) — relanzar el script
// NO reenvía a quien ya recibió. Un intento bloqueado por los safety gates
// SÍ se reintenta en el siguiente lanzamiento.
//
// SAFETY: cada envío pasa por sendWhatsAppInteractive() → canSendRealWhatsApp
// (TEST_MODE, allowlist, pilot_authorized, EMERGENCY_STOP). Este script no
// puentea ni duplica esos gates.
//
// RITMO: 1 mensaje cada 3 segundos (solo en --execute; el dry-run no espera).
// ABORTO: 3 fallos SEGUIDOS (excepciones reales, no bloqueos de gate) paran
// el script — no sigue a ciegas.
// ============================================================

import "./env-loader";

const EXCLUDE_ORDER_IDS = [1131, 1105, 1119];

function hasFlag(nombre: string): boolean {
  return process.argv.slice(2).includes(`--${nombre}`);
}

function arg(nombre: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

function parseIdList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

async function main(): Promise<void> {
  const execute = hasFlag("execute");
  const replenishmentDate = (arg("date") ?? "").trim();
  const only = parseIdList(arg("only"));

  console.log("\n════════ AVISO DE RETRASO — Ultras/gafa ════════\n");
  console.log(`  Modo             : ${execute ? "⚠️  ENVIANDO DE VERDAD (--execute)" : "DRY-RUN (no se envía nada)"}`);

  if (!replenishmentDate) {
    console.log("\n✗ Falta --date=<fecha> (la fecha prevista de reposición). Abortado sin tocar nada.\n");
    process.exit(1);
  }
  console.log(`  Fecha reposición : ${replenishmentDate}`);
  if (only.length > 0) console.log(`  --only           : ${only.join(", ")}`);

  const { planDelayNotificationBatch, runDelayNotificationBatch } = await import(
    "../src/lib/orders/notify-delay"
  );

  // Se calcula la selección una vez aquí (para la cabecera del informe) y
  // runDelayNotificationBatch la recalcula al ejecutar — misma consulta de
  // solo lectura, coste insignificante, y así el orden del log es natural.
  const plan = planDelayNotificationBatch({ excludeOrderIds: EXCLUDE_ORDER_IDS, onlyOrderIds: only });
  console.log(`  Pedidos seleccionados : ${plan.items.length}`);
  if (plan.phoneCollisions.length > 0) {
    console.log("\n  ⚠️  Teléfonos compartidos por más de un pedido de este lote (los dos se procesan igual; revisar a mano):");
    for (const c of plan.phoneCollisions) {
      console.log(`     ${c.phone} → pedidos ${c.orderNumbers.join(", ")}`);
    }
  }

  console.log("\n──────── Por pedido ────────");

  const batchId = `ultras-${replenishmentDate}-${Date.now()}`;
  const report = await runDelayNotificationBatch({
    excludeOrderIds: EXCLUDE_ORDER_IDS,
    onlyOrderIds: only,
    replenishmentDate,
    batchId,
    dryRun: !execute,
    onItem: (r) => {
      const marca = r.outcome === "sent" || r.outcome === "would_send" ? "✓" : r.outcome === "error" ? "✗" : "·";
      const detalle: Record<typeof r.outcome, string> = {
        sent: "enviado",
        would_send: "se enviaría (dry-run)",
        already_sent: "ya recibido antes — omitido",
        blocked: "bloqueado por los safety gates (TEST_MODE/allowlist/EMERGENCY_STOP) — omitido, se reintentará",
        ineligible: `ya no elegible (${r.error ?? "cambió entre el plan y el envío"}) — omitido`,
        error: `error: ${r.error ?? "desconocido"}`,
      };
      console.log(`  ${marca} #${r.orderNumber} (id ${r.orderId}, ${r.phoneMasked}) → ${detalle[r.outcome]}`);
    },
  });

  if (report.aborted) {
    console.log(
      `\n✗ 3 fallos SEGUIDOS — parado para no seguir a ciegas. Revisa el error de arriba antes de relanzar.\n`
    );
  }

  console.log("\n──────── Resumen ────────");
  console.log(`  ${execute ? "Enviados" : "Se enviarían"} : ${report.sent}`);
  console.log(`  Omitidos              : ${report.skipped}`);
  console.log(`  Fallidos              : ${report.failed}`);
  if (!execute) {
    console.log("\n  Esto ha sido un dry-run: NADA se ha enviado ni escrito.");
    console.log("  Repite con --execute cuando el desglose de arriba coincida con lo esperado.\n");
  } else {
    console.log("");
  }

  if (report.aborted) process.exit(1);
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
