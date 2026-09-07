// ============================================================
// CANAL DE DESPACHO POR PRODUCTO — la tabla que rellena Pedro.
//
//   npm run dispatch:channels -- --list
//   npm run dispatch:channels -- --set --sku ORG-01 --channel beeping            # dry-run
//   npm run dispatch:channels -- --set --sku ORG-01 --channel beeping --apply
//   npm run dispatch:channels -- --set --variant 4567 --channel dropea --apply
//   npm run dispatch:channels -- --unset --sku ORG-01 --apply
//
// Cada producto se despacha por Beeping O por Dropea, nunca por los dos. La
// tabla nace vacía: hasta que Pedro dé el canal de un producto, sus pedidos
// NO se auto-despachan (quedan "pendiente de configurar canal").
// docs/AUTO-DESPACHO-COOLDOWN.md § Router de canal.
// ============================================================

import "./env-loader";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}
function hasFlag(nombre: string): boolean {
  return process.argv.slice(2).includes(`--${nombre}`);
}

async function main(): Promise<void> {
  const { listDispatchChannels, upsertDispatchChannel, deleteDispatchChannel } = await import("../src/lib/orders/dispatch-channel");
  const apply = hasFlag("apply");

  console.log("\n════════ CANAL DE DESPACHO POR PRODUCTO (Beeping O Dropea) ════════\n");

  if (hasFlag("list") || (!hasFlag("set") && !hasFlag("unset"))) {
    const rows = listDispatchChannels();
    if (rows.length === 0) {
      console.log("  (vacía) Ningún producto tiene canal configurado: el auto-despacho no se ejecuta para ninguno.\n");
    } else {
      for (const r of rows) {
        console.log(`  · ${r.shopify_sku ? `SKU ${r.shopify_sku}` : r.shopify_variant_id ? `variante ${r.shopify_variant_id}` : `producto ${r.shopify_product_id}`} → ${r.channel}${r.note ? `  (${r.note})` : ""}`);
      }
      console.log();
    }
    return;
  }

  const key = { sku: arg("sku") ?? null, variantId: arg("variant") ?? null, productId: arg("product") ?? null };
  const label = key.sku ? `SKU ${key.sku}` : key.variantId ? `variante ${key.variantId}` : key.productId ? `producto ${key.productId}` : "(sin clave)";

  if (hasFlag("unset")) {
    console.log(`  ${apply ? "Eliminando" : "Se eliminaría"} el canal de ${label}`);
    if (!apply) { console.log("  Dry-run: repite con --apply.\n"); return; }
    console.log(deleteDispatchChannel(key) ? "  ✓ eliminado\n" : "  (no existía)\n");
    return;
  }

  const channel = arg("channel");
  if (channel !== "beeping" && channel !== "dropea") {
    console.error("  ✗ --channel debe ser beeping | dropea\n");
    process.exit(1);
  }
  console.log(`  ${apply ? "Configurando" : "Se configuraría"}: ${label} → ${channel}`);
  if (!apply) { console.log("  Dry-run: repite con --apply.\n"); return; }
  const row = upsertDispatchChannel({ ...key, channel, note: arg("note") ?? null });
  console.log(`  ✓ guardado (id ${row.id}). Los pedidos de este producto se despacharán por ${row.channel} al vencer el cooldown.\n`);
}

main().catch((err) => {
  console.error("\n✗", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
