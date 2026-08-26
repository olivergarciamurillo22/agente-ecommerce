// ============================================================
// SHOPIFY DOCTOR — solo lectura, desde el Mac o el NAS.
//
//   npm run shopify:doctor
//
// Verifica: credenciales, tienda, versión de API, suscripciones de webhook
// y el diagnóstico de productos (vendor de Dropi / SKUs). CERO writes.
// Sin credenciales: lo dice claro y sale, sin errores crípticos.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const { shopifyAdminConfigured, getAdminAccessToken } = await import("../src/lib/shopify/admin");
  const { listShopifyWebhooks, planWebhookEnsure, publicBaseUrl } = await import("../src/lib/shopify/webhook-subscriptions");
  const diag = await import("../src/lib/suppliers/dropi/diagnostics");

  console.log("\n════════ SHOPIFY DOCTOR (solo lectura) ════════\n");

  const dominio = (process.env.SHOPIFY_STORE_DOMAIN ?? "").trim();
  if (!dominio) {
    console.log("○ SHOPIFY_STORE_DOMAIN no configurado.");
    console.log("  Para usar este doctor: rellena en .env.local el dominio y las credenciales");
    console.log("  (token estático O client_id+secret) — ver npm run env:doctor -- --profile shopify-readonly\n");
    return;
  }
  console.log(`Tienda      : ${dominio}`);
  console.log(`API version : ${process.env.SHOPIFY_API_VERSION || "2026-07 (default)"}`);
  console.log(`Writes      : ${process.env.SHOPIFY_WRITE_ENABLED === "1" ? "⚠️ HABILITADOS (en el Mac deben estar en 0)" : "apagados ✓"}\n`);

  if (!shopifyAdminConfigured()) {
    console.log("○ Sin credenciales de la Admin API: solo se pudo comprobar la configuración local.");
    console.log("  Faltan: SHOPIFY_ADMIN_ACCESS_TOKEN o el par SHOPIFY_CLIENT_ID+SECRET.\n");
    return;
  }

  // 1. Auth (una llamada de token / GET).
  console.log("── AUTENTICACIÓN ──");
  try {
    const token = await getAdminAccessToken();
    console.log(token ? "  ✓ token obtenido (no se muestra)" : "  ✗ no se pudo obtener token");
    if (!token) return;
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : err}\n`);
    return;
  }

  // 2. Webhooks.
  console.log("\n── SUSCRIPCIONES DE WEBHOOK ──");
  try {
    const existentes = await listShopifyWebhooks();
    const plan = planWebhookEnsure(existentes);
    console.log(`  base esperada: ${publicBaseUrl() || "(PUBLIC_BASE_URL sin configurar)"}`);
    console.log(`  ✓ correctas: ${plan.ok.map((x) => x.topic).join(", ") || "(ninguna)"}`);
    if (plan.toCreate.length) console.log(`  ✗ faltan: ${plan.toCreate.map((x) => x.topic).join(", ")} (se crean con npm run shopify:webhooks -- --ensure, NO desde aquí)`);
    if (plan.mismatched.length) for (const m of plan.mismatched) console.log(`  ⚠ ${m.topic} apunta a OTRA URL: ${m.actual}`);
    if (plan.extra.length) console.log(`  · ajenas: ${plan.extra.map((x) => x.topic).join(", ")}`);
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : err}`);
  }

  // 3. Productos (vendor de Dropi + SKUs), reutilizando el diagnóstico puro.
  console.log("\n── PRODUCTOS (vendor Dropi / SKU) ──");
  try {
    const token = await getAdminAccessToken();
    const version = process.env.SHOPIFY_API_VERSION || "2026-07";
    const res = await fetch(
      `https://${dominio.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/admin/api/${version}/products.json?limit=50&fields=id,title,vendor,variants`,
      { headers: { "X-Shopify-Access-Token": token! }, signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) throw new Error(`products.json HTTP ${res.status}`);
    const { products } = (await res.json()) as { products: Array<Parameters<typeof diag.diagnoseProductVendor>[0]> };
    let problemas = 0;
    for (const p of products) {
      const d = diag.diagnoseProductVendor(p);
      if (!d.vendorOk || d.variantsSinSku > 0) {
        problemas++;
        console.log(`  ✗ ${d.title}${!d.vendorOk ? ` — vendor "${d.vendorActual}" (esperado "${d.vendorEsperado}")` : ""}${d.variantsSinSku ? ` — ${d.variantsSinSku} variante(s) sin SKU` : ""}`);
      }
    }
    if (problemas === 0) console.log(`  ✓ ${products.length} productos sin problemas de vendor/SKU`);
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : err}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
