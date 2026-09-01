// ============================================================
// Planificador de la sincronización con Beeping — SOLO LECTURA.
//
//   npm run beeping:sync
//
// Enseña QUÉ HARÍA la reconciliación (desglose por transición, pedido a
// pedido) SIN escribir nada: ni en Beeping (nunca), ni en la base local.
// La sincronización real corre dentro de la app (scheduler y panel), donde
// la supresión de avisos y los safety gates están garantizados.
//
// Como T4: aquí no hay --apply ni maquinaria para leerlo. Un script de
// datos no importa nada de WhatsApp, ni transitivamente (salvaguarda T6).
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const client = await import("../src/lib/beeping/client");
  const { beepingEnabled, cachedBeepingShopId } = await import("../src/lib/beeping/config");
  const { mapBeepingOrder, beepingRawStatusLabel } = await import("../src/lib/beeping/mapper");
  const { parseBeepingDate, toBeepingDate } = await import("../src/lib/beeping/mapper");
  const db = await import("../src/lib/db");

  console.log("\n════════ BEEPING · plan de sincronización (dry-run, solo lectura) ════════\n");

  if (!beepingEnabled()) {
    console.log("○ Beeping deshabilitado (falta credencial o BEEPING_ENABLED != 1).\n");
    process.exit(1);
  }

  const desde = Math.floor(Date.now() / 1000) - 30 * 86400;
  let remotos;
  try {
    remotos = await client.listOrders({ fromDate: toBeepingDate(desde), shopId: cachedBeepingShopId() ?? undefined, perPage: 100 });
  } catch (err) {
    console.log(`○ No se pudo listar Beeping: ${err instanceof Error ? err.message : "error"}\n`);
    process.exit(1);
  }

  const transiciones = new Map<string, number>();
  const sinCambios = new Map<string, number>();
  const marca = (mapa: Map<string, number>, clave: string) => mapa.set(clave, (mapa.get(clave) ?? 0) + 1);

  for (const remote of remotos) {
    const local = db.getOrderByShopifyId(remote.external_id) ?? db.getOrderByShopifyOrderNumber(remote.external_id);
    if (!local) {
      marca(sinCambios, "sin pedido local emparejable");
      continue;
    }
    if (local.supplier_platform === "dropea" || local.supplier_platform === "dropi") {
      marca(sinCambios, `enrutado a ${local.supplier_platform} (no se toca)`);
      continue;
    }
    const mapping = mapBeepingOrder(remote.status, remote.tracking_stage);
    const raw = beepingRawStatusLabel(remote.status, remote.tracking_stage);

    // Eje logístico.
    if (remote.status === 6 && mapping.tracking === "unknown") {
      marca(sinCambios, "to_be_confirmed (sin envío todavía)");
    } else if (mapping.tracking === local.supplier_status_normalized) {
      marca(sinCambios, `ya en ${mapping.tracking}`);
    } else {
      marca(transiciones, `tracking ${local.supplier_status_normalized} → ${mapping.tracking} (${raw})`);
    }

    // Eje de cierre.
    if (mapping.closure && mapping.closure !== local.closure_status) {
      const fecha = parseBeepingDate(remote.date_tracking_update) ?? parseBeepingDate(remote.date);
      if (db.canTransitionClosure(local.closure_status, mapping.closure)) {
        marca(transiciones, fecha !== null ? `cierre ${local.closure_status} → ${mapping.closure}` : `cierre ${local.closure_status} → ${mapping.closure} (⚠️ SIN fecha legible: no se estamparía)`);
      } else {
        marca(sinCambios, `cierre terminal ${local.closure_status} protegido (Beeping dice ${mapping.closure})`);
      }
    }
    if (mapping.needsReview) marca(transiciones, `marcar revisión humana (${raw})`);
  }

  console.log(`Pedidos remotos examinados (30 días): ${remotos.length}\n`);
  console.log("HARÍA:");
  if (transiciones.size === 0) console.log("  (nada)");
  for (const [t, n] of [...transiciones].sort((a, b) => b[1] - a[1])) console.log(`  · ${t}: ${n}`);
  console.log("\nSIN CAMBIOS:");
  for (const [t, n] of [...sinCambios].sort((a, b) => b[1] - a[1])) console.log(`  · ${t}: ${n}`);
  console.log("\nEste script NO escribe. La sync real corre dentro de la app (panel/scheduler).\n");
}

main().catch((err) => {
  console.error(`\n✗ Error: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
