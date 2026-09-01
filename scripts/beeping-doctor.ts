// ============================================================
// Diagnóstico de Beeping — SOLO LECTURA.
//
//   npm run beeping:doctor
//
// Comprueba credencial, conectividad, tienda, pedidos y emparejado con la
// base local. NUNCA escribe en Beeping (ni mark-to-send, ni cancel, ni
// update) y JAMÁS imprime la credencial — ni siquiera su longitud exacta.
// ============================================================

import "./env-loader";

const ICON: Record<string, string> = { ok: "●", warn: "◐", err: "○" };

async function main(): Promise<void> {
  const { beepingConfig, beepingEnabled, beepingWriteEnabled, beepingAutoReleaseEnabled, cachedBeepingShopId, cachedBeepingShopName, BEEPING_DEFAULT_BASE_URL } =
    await import("../src/lib/beeping/config");
  const client = await import("../src/lib/beeping/client");
  const { BEEPING_ORDER_STATUS } = await import("../src/lib/beeping/types");
  const { beepingCutoff } = await import("../src/lib/beeping/cutoff");
  const db = await import("../src/lib/db");

  console.log("\n════════ BEEPING · diagnóstico (solo lectura) ════════\n");

  // --- 1. Configuración (sin tocar la red) ---
  const config = beepingConfig();
  console.log("1. CONFIGURACIÓN");
  console.log(`   Credencial     : ${config ? "configurada (no se muestra)" : "FALTA — ejecuta npm run beeping:auth:init"}`);
  console.log(`   URL base       : ${config?.baseUrl ?? BEEPING_DEFAULT_BASE_URL}${process.env.BEEPING_BASE_URL ? "" : " (default)"}`);
  console.log(`   Lectura        : ${beepingEnabled() ? "HABILITADA" : "deshabilitada (BEEPING_ENABLED != 1)"}`);
  console.log(`   Escritura      : ${beepingWriteEnabled() ? "⚠️ HABILITADA" : "BLOQUEADA (correcto hasta el piloto)"}`);
  console.log(`   Auto-release   : ${beepingAutoReleaseEnabled() ? "⚠️ ACTIVO" : "apagado (LIBERACIÓN MANUAL — correcto)"}`);

  if (!config) {
    console.log("\n○ Sin credencial: no se puede continuar.\n");
    process.exit(1);
  }
  if (!beepingEnabled()) {
    console.log("\n◐ Lectura deshabilitada. Pon BEEPING_ENABLED=1 en .env.local para diagnosticar.\n");
    process.exit(1);
  }

  // --- 2. Conexión y tiendas ---
  console.log("\n2. CONEXIÓN Y TIENDA");
  const salud = await client.healthCheck();
  if (!salud.ok) {
    console.log(`   ${ICON.err} No conectado: ${salud.error}`);
    if (/401|credencial/i.test(salud.error ?? "")) {
      console.log("     → La credencial no vale: repite npm run beeping:auth:init (¿email o contraseña mal?).");
    } else {
      console.log("     → ¿Hay red? ¿app.gobeeping.com accesible? Reintenta en unos minutos.");
    }
    console.log();
    process.exit(1);
  }
  console.log(`   ${ICON.ok} Conectado — autenticación OK`);
  console.log(`   Tiendas visibles: ${salud.shops.length}`);
  for (const s of salud.shops) console.log(`     · ${s.name} (id ${s.id})`);

  const shopCacheada = cachedBeepingShopId();
  if (shopCacheada !== null) {
    console.log(`   Tienda seleccionada: ${cachedBeepingShopName() ?? "?"} (id ${shopCacheada})`);
  } else if (salud.shops.length === 1) {
    console.log(`   Tienda: se autodetectará "${salud.shops[0].name}" en la primera sync`);
  } else if (salud.shops.length > 1) {
    console.log(`   ${ICON.warn} Varias tiendas: habrá que elegir una en Ajustes → Beeping`);
  }

  // --- 3. Pedidos ---
  console.log("\n3. PEDIDOS EN BEEPING (últimos 30 días)");
  const desde = new Date(Date.now() - 30 * 86400 * 1000);
  const fromDate = `${String(desde.getUTCDate()).padStart(2, "0")}-${String(desde.getUTCMonth() + 1).padStart(2, "0")}-${desde.getUTCFullYear()}`;
  let pedidos;
  try {
    pedidos = await client.listOrders({ fromDate, shopId: shopCacheada ?? salud.shops[0]?.id, perPage: 100 });
  } catch (err) {
    console.log(`   ${ICON.err} No se pudieron listar: ${err instanceof Error ? err.message : "error"}\n`);
    process.exit(1);
  }
  console.log(`   ${ICON.ok} Listado OK — ${pedidos.length} pedido(s) devueltos (máx. 100)`);

  const porEstado = new Map<string, number>();
  let conTracking = 0;
  let emparejados = 0;
  let sinSku = 0;
  for (const p of pedidos) {
    const etiqueta =
      p.status !== null ? (BEEPING_ORDER_STATUS[p.status as keyof typeof BEEPING_ORDER_STATUS] ?? `status_${p.status}`) : "sin_status";
    porEstado.set(etiqueta, (porEstado.get(etiqueta) ?? 0) + 1);
    if (p.tracking_number) conTracking++;
    if (db.getOrderByShopifyId(p.external_id) ?? db.getOrderByShopifyOrderNumber(p.external_id)) emparejados++;
    if (p.lines.some((l) => !l.sku)) sinSku++;
  }
  console.log("   Distribución por estado:");
  for (const [estado, n] of [...porEstado].sort((a, b) => b[1] - a[1])) {
    console.log(`     · ${estado}: ${n}`);
  }
  console.log(`   Con tracking       : ${conTracking}`);
  console.log(`   Emparejables local : ${emparejados} de ${pedidos.length}${pedidos.length > 0 && emparejados === 0 ? " — ⚠️ ningún ID coincide con la base local" : ""}`);
  if (sinSku > 0) console.log(`   ${ICON.warn} ${sinSku} pedido(s) con líneas SIN SKU (el gate de liberación los bloqueará)`);

  // --- 4. Corte ---
  const corte = beepingCutoff();
  console.log("\n4. CORTE DE PREPARACIÓN");
  console.log(`   ${corte.message}`);

  // --- 5. Resumen ---
  console.log("\n════════ RESUMEN ════════");
  console.log(`   BEEPING`);
  console.log(`   ${ICON.ok} Conectado`);
  if (shopCacheada !== null || salud.shops.length === 1) {
    console.log(`   Tienda: ${cachedBeepingShopName() ?? salud.shops[0]?.name ?? "?"}`);
  }
  console.log(`   Pedidos vistos (30d): ${pedidos.length}`);
  console.log(`   Por confirmar: ${porEstado.get("to_be_confirmed") ?? 0}`);
  console.log(`   Preparando: ${(porEstado.get("pending") ?? 0) + (porEstado.get("in_preparation") ?? 0) + (porEstado.get("pending_stock") ?? 0)}`);
  console.log(`   Enviados: ${porEstado.get("shipped") ?? 0}`);
  console.log(`   Devueltos: ${porEstado.get("returned") ?? 0}`);
  console.log(`   Cancelados: ${porEstado.get("cancelled") ?? 0}`);
  console.log();
}

main().catch((err) => {
  console.error(`\n✗ Error inesperado: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
