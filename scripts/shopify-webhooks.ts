// ============================================================
// Suscripciones de webhooks de Shopify.
//
//   npm run shopify:webhooks              # LISTA lo que hay y lo compara
//   npm run shopify:webhooks -- --ensure  # crea las que FALTAN (sin duplicar)
//
// Nunca borra ni modifica suscripciones existentes: un topic apuntando a
// otra URL se AVISA (decidir a mano), y un topic con MÁS DE UNA suscripción
// activa se lista como DUPLICADO (decidir a mano cuál sobra — nunca se
// borra sola). API version: SHOPIFY_API_VERSION.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const { listShopifyWebhooks, planWebhookEnsure, createShopifyWebhook, desiredSubscriptions, publicBaseUrl } =
    await import("../src/lib/shopify/webhook-subscriptions");
  const { shopifyAdminConfigured } = await import("../src/lib/shopify/admin");

  if (!shopifyAdminConfigured()) {
    console.log("\n✗ Admin API de Shopify no configurada.\n");
    process.exit(1);
  }
  const ensure = process.argv.includes("--ensure");
  console.log(`\n════════ WEBHOOKS SHOPIFY (base ${publicBaseUrl()}) ════════\n`);

  const existentes = await listShopifyWebhooks();
  console.log(`  Suscripciones existentes: ${existentes.length}`);
  for (const e of existentes) console.log(`    · ${e.topic} → ${e.address} (v${e.api_version ?? "?"})`);

  const plan = planWebhookEnsure(existentes);
  console.log(`\n  ✓ Correctas       : ${plan.ok.map((x) => x.topic).join(", ") || "(ninguna)"}`);
  console.log(`  + Faltan          : ${plan.toCreate.map((x) => x.topic).join(", ") || "(ninguna)"}`);
  if (plan.mismatched.length) {
    console.log("  ⚠️  Mismo topic, OTRA URL (revisar a mano, no se toca):");
    for (const m of plan.mismatched) console.log(`    · ${m.topic}: esperada ${m.expected} — real ${m.actual}`);
  }
  if (plan.extra.length) {
    console.log(`  · Otras suscripciones ajenas a este sistema: ${plan.extra.map((x) => x.topic).join(", ")}`);
  }
  if (plan.duplicates.length) {
    console.log(
      "\n  🚨 DUPLICADOS — mismo topic con MÁS DE UNA suscripción activa. Antes esto se veía"
    );
    console.log(
      "     como \"✓ Correctas\" sin más aviso: basta con que UNA copia apunte bien para contar como"
    );
    console.log(
      "     cubierta, pero eso no dice si hay OTRA copia vieja entregando el mismo topic con otro"
    );
    console.log("     secreto (típico: una firmada desde el admin y otra desde la app). NO se borra");
    console.log("     nada aquí — decide a mano cuál sobra mirando id/fecha de creación en Shopify:");
    for (const d of plan.duplicates) {
      console.log(`    · ${d.topic} (${d.subscriptions.length} suscripciones):`);
      for (const s of d.subscriptions) {
        console.log(`        id ${s.id} → ${s.address} (v${s.api_version ?? "?"})`);
      }
    }
  }

  if (!ensure) {
    console.log("\n  (Solo lectura. Ejecuta con --ensure para crear las que faltan.)\n");
    return;
  }
  for (const w of plan.toCreate) {
    const creado = await createShopifyWebhook(w.topic, w.address);
    console.log(`  ✓ creada ${creado.topic} → ${creado.address} (id ${creado.id})`);
  }
  if (plan.toCreate.length === 0) console.log("\n  Nada que crear: todo estaba.\n");
  else console.log(`\n  ${plan.toCreate.length} suscripción(es) creadas. Los ${desiredSubscriptions().length} topics quedan cubiertos.\n`);
}

main().catch((err) => {
  console.error("\n✗", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
