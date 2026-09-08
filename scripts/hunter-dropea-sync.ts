// ============================================================
// hunter:dropea:sync — copia local del catálogo de Dropea (08-09-2026)
// docs/PRODUCT-HUNTER-BACKEND-USO.md
//
//   npm run hunter:dropea:sync
//
// Recorre GET /dropshipper/products página a página (100 por página) con el
// cliente de Dropea ya existente y guarda cada variante en `dropea_catalog`.
// El panel del Cazador y el cruce (hunter:cruce-dropea) leen de esa copia.
// Exige DROPEA_API_KEY y DROPEA_API_ENABLED=1; sin ellos no llama a nada.
// Solo LECTURA de Dropea: aquí no se crea ni se toca ningún pedido.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const { syncDropeaCatalog, DropeaCatalogRepository, dropeaSyncState } = await import("../src/lib/product-hunter/internal/dropea-catalog");
  const repo = new DropeaCatalogRepository();
  const antes = repo.count();
  const ultima = repo.lastSyncedAt();
  const estado = dropeaSyncState();
  console.log(`\n──── CATÁLOGO DE DROPEA · copia local ────\n`);
  console.log(`  Copia actual: ${antes} variante(s)${ultima ? `, sincronizada el ${new Date(ultima * 1000).toISOString().slice(0, 16).replace("T", " ")}` : " (nunca sincronizada)"}`);
  if (estado && !estado.complete) console.log(`  ⚠ La última pasada NO terminó (${estado.pages} página(s); ${estado.error ?? "sin terminar"}): la copia está mezclada con la pasada anterior. Esta ejecución la completa.`);
  const r = await syncDropeaCatalog({ repo, onPage: (page, items) => console.log(`  página ${String(page).padStart(3)} · ${items} producto(s)`) });
  if (!r.ok) {
    console.error(`\n✗ ${r.reason}\n`);
    process.exit(r.pages > 0 ? 3 : 2); // 3 = parcial: filas nuevas y viejas mezcladas; relanzar
  }
  console.log(`\n  ✓ ${r.pages} página(s) · ${r.products} producto(s) · ${r.variants} variante(s) guardadas · copia de ${new Date(r.syncedAt * 1000).toISOString().slice(0, 10)}`);
  if (r.truncated) console.log(`  ⚠ ${r.reason}`);
  const noVistas = repo.staleCount(r.syncedAt);
  if (noVistas > 0) console.log(`  ⚠ ${noVistas} variante(s) de la copia no aparecieron en esta pasada: pueden haber desaparecido de Dropea (se conservan, con su fecha anterior).`);
  console.log(`  Ahora en la copia: ${repo.count()} variante(s). Peso y medidas NO vienen de Dropea: se completan a mano (hunter:add --coste-eur … o el panel).\n`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
