// ============================================================
// Diagnóstico Dropi — SOLO LECTURA. No modifica Shopify ni la DB.
//
//   npm run dropi:diagnose                 # productos (vendor/SKU) + pedidos recientes sin SKU
//
// Existe porque la causa real del parón de sincronización del 23-08 fue el
// campo vendor del producto en Shopify — y nada lo enseñaba.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const diag = await import("../src/lib/suppliers/dropi/diagnostics");
  const { shopifyAdminConfigured, getAdminAccessToken } = await import("../src/lib/shopify/admin");
  const db = await import("../src/lib/db");

  console.log("\n════════ DIAGNÓSTICO DROPI (solo lectura) ════════\n");
  console.log(`Vendor esperado por la app de Dropi: "${diag.dropiExpectedVendor()}"`);
  console.log("(configurable con DROPI_EXPECTED_VENDOR)\n");

  // --- 1. Vendor de productos, contra la Admin API (GET) ---
  console.log("── PRODUCTOS EN SHOPIFY ──");
  if (!shopifyAdminConfigured()) {
    console.log("  ✗ Admin API no configurada: esta parte se salta.\n");
  } else {
    try {
      const token = await getAdminAccessToken();
      const version = process.env.SHOPIFY_API_VERSION || "2026-07";
      const dominio = (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const res = await fetch(
        `https://${dominio}/admin/api/${version}/products.json?limit=50&fields=id,title,vendor,variants`,
        { headers: { "X-Shopify-Access-Token": token! }, signal: AbortSignal.timeout(20_000) }
      );
      if (!res.ok) throw new Error(`products.json HTTP ${res.status}`);
      const { products } = (await res.json()) as { products: Array<Parameters<typeof diag.diagnoseProductVendor>[0]> };
      let mal = 0;
      for (const p of products) {
        const d = diag.diagnoseProductVendor(p);
        const marca = d.vendorOk ? "✓" : "✗";
        if (!d.vendorOk || d.variantsSinSku > 0) {
          mal++;
          console.log(`  ${marca} ${d.title}`);
          if (!d.vendorOk) console.log(`      vendor: "${d.vendorActual}" (esperado "${d.vendorEsperado}") — la app de Dropi NO lo reconocerá`);
          if (d.variantsSinSku > 0) console.log(`      ${d.variantsSinSku}/${d.variantsTotal} variante(s) SIN SKU`);
        }
      }
      if (mal === 0) console.log(`  ✓ Los ${products.length} productos tienen vendor correcto y SKU en todas las variantes.`);
      console.log("\n  ⚠️ Esto es DIAGNÓSTICO: si algo está mal, se corrige desde el panel de");
      console.log("     Dropi (Importar productos) o la ficha del producto — nunca desde aquí.\n");
    } catch (err) {
      console.log(`  ✗ No se pudo consultar: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // --- 2. Pedidos recientes con líneas sin SKU, contra la DB local ---
  console.log("── PEDIDOS RECIENTES CON LÍNEAS SIN SKU (DB local) ──");
  const recientes = db.listOrders(undefined, 30);
  let conProblema = 0;
  for (const o of recientes) {
    const lineas = diag.diagnoseSkuNull(o).filter((l) => l.cause !== "service_line_expected" && l.cause !== "sku_present_parser_dropped");
    if (lineas.length === 0) continue;
    conProblema++;
    console.log(`  Pedido #${o.shopify_order_number}:`);
    for (const l of lineas) console.log(`    · ${l.title}: [${l.cause}] ${l.detail}`);
  }
  if (conProblema === 0) console.log("  ✓ Ninguno de los últimos 30 pedidos tiene líneas de producto sin SKU.");
  console.log("");
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
