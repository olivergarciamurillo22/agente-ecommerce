// ============================================================
// Emparejado de nuestros productos con el catálogo de Dropea.
//
//   npm run dropea:mapping:inspect            → solo mira y compara
//   npm run dropea:mapping:inspect -- --apply → guarda los INEQUÍVOCOS
//
// Solo se importan automáticamente las coincidencias EXACTAS por SKU. Lo
// ambiguo (varias variantes con el mismo SKU, o coincidencia solo por
// nombre) se marca para revisión y NO se guarda: un emparejado equivocado
// mandaría al cliente un producto distinto del que compró.
// ============================================================

import "./env-loader";

type Estado = "exacto" | "ambiguo" | "no_encontrado" | "ya_mapeado";

interface Fila {
  titulo: string;
  sku: string | null;
  estado: Estado;
  variantId?: number;
  detalle: string;
}

function normaliza(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function main(): Promise<void> {
  const aplicar = process.argv.includes("--apply");
  const db = await import("../src/lib/db");
  const provider = await import("../src/lib/suppliers/dropea");
  const { dropeaReadEnabled } = await import("../src/lib/suppliers/dropea/client");

  console.log("\n════════ EMPAREJADO DE PRODUCTOS CON DROPEA ════════\n");

  if (!dropeaReadEnabled()) {
    console.log("✗ La lectura de la API está deshabilitada.");
    console.log("  Necesitas DROPEA_API_KEY y DROPEA_API_ENABLED=1 en el .env\n");
    process.exit(1);
  }

  // 1. Catálogo de Dropea — ENTERO, hasta que una página venga incompleta.
  //
  // Antes se paraba en la página 10 (500 productos) sobre un catálogo de
  // 4.142: el Cortaúñas estaba en la página 46, así que el emparejado
  // "no lo encontraba" y parecía que el producto no existía en Dropea.
  // Un tope silencioso en una herramienta de diagnóstico es una respuesta
  // falsa; si ahora se alcanza el tope de seguridad, se DICE.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 200; // 20.000 productos: red de seguridad, no un límite real
  const variantes: Array<{ variantId: number; sku: string; nombre: string; precio: number; producto: number }> = [];
  let paginas = 0;
  let topeAlcanzado = false;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await provider.listDropeaProducts(page, PAGE_SIZE);
      const items = res?.items ?? [];
      paginas = page;
      for (const p of items) {
        for (const v of p.variants ?? []) {
          variantes.push({
            variantId: v.variant_id,
            sku: (v.sku ?? "").trim(),
            nombre: v.name ?? "",
            precio: v.price ?? 0,
            producto: p.id,
          });
        }
      }
      if (items.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) topeAlcanzado = true;
    }
  } catch (err) {
    console.log(`✗ No se pudo leer el catálogo: ${(err as Error).message}\n`);
    process.exit(1);
  }
  console.log(`Catálogo de Dropea: ${variantes.length} variante(s) en ${paginas} página(s)`);
  if (topeAlcanzado) {
    console.log(`⚠️  Se alcanzó el tope de ${MAX_PAGES} páginas: el catálogo puede estar INCOMPLETO.`);
    console.log("    Lo que no aparezca aquí puede existir igualmente en Dropea.");
  }
  console.log("");

  // 2. Nuestros productos: los que han aparecido en pedidos reales.
  const titulos = new Map<string, string | null>();
  for (const o of db.listOrders(undefined, 500)) {
    for (const linea of (o.product_summary ?? "").split("\n")) {
      const limpio = linea.replace(/^\d+x\s+/i, "").trim();
      if (limpio) titulos.set(limpio, null); // el SKU no lo guardamos hoy
    }
  }

  const yaMapeados = new Map(
    db.listSupplierProductMappings("dropea").map((m) => [m.shopify_title ?? "", m])
  );

  // 3. Comparar.
  const filas: Fila[] = [];
  for (const [titulo, sku] of titulos) {
    if (yaMapeados.has(titulo)) {
      const m = yaMapeados.get(titulo)!;
      filas.push({
        titulo,
        sku,
        estado: "ya_mapeado",
        variantId: Number(m.supplier_variant_id),
        detalle: `variant_id=${m.supplier_variant_id}`,
      });
      continue;
    }

    // Coincidencia por SKU (la única que se importa sola).
    const porSku = sku ? variantes.filter((v) => v.sku && v.sku === sku) : [];
    if (porSku.length === 1) {
      filas.push({
        titulo,
        sku,
        estado: "exacto",
        variantId: porSku[0].variantId,
        detalle: `SKU ${porSku[0].sku} → variant_id=${porSku[0].variantId} (${porSku[0].precio} €)`,
      });
      continue;
    }
    if (porSku.length > 1) {
      filas.push({
        titulo,
        sku,
        estado: "ambiguo",
        detalle: `${porSku.length} variantes comparten el SKU ${sku}`,
      });
      continue;
    }

    // Por nombre: NUNCA se importa solo, solo se sugiere.
    const n = normaliza(titulo);
    const porNombre = variantes.filter((v) => {
      const vn = normaliza(v.nombre);
      return vn && (vn.includes(n) || n.includes(vn));
    });
    if (porNombre.length === 1) {
      filas.push({
        titulo,
        sku,
        estado: "ambiguo",
        detalle: `posible: "${porNombre[0].nombre}" (variant_id=${porNombre[0].variantId}) — CONFIRMAR a mano`,
      });
    } else if (porNombre.length > 1) {
      filas.push({
        titulo,
        sku,
        estado: "ambiguo",
        detalle: `${porNombre.length} candidatos por nombre — CONFIRMAR a mano`,
      });
    } else {
      filas.push({ titulo, sku, estado: "no_encontrado", detalle: "sin candidatos en el catálogo" });
    }
  }

  // 4. Informe.
  const icono: Record<Estado, string> = {
    exacto: "✓",
    ambiguo: "⚠️",
    no_encontrado: "✗",
    ya_mapeado: "·",
  };
  for (const f of filas) {
    console.log(`${icono[f.estado]} ${f.titulo}`);
    console.log(`    ${f.estado.toUpperCase()}: ${f.detalle}`);
  }

  const exactos = filas.filter((f) => f.estado === "exacto");
  const ambiguos = filas.filter((f) => f.estado === "ambiguo");
  console.log(
    `\nResumen: ${exactos.length} exacto(s), ${ambiguos.length} a revisar, ` +
      `${filas.filter((f) => f.estado === "no_encontrado").length} sin encontrar, ` +
      `${filas.filter((f) => f.estado === "ya_mapeado").length} ya guardado(s)`
  );

  // 5. Guardar SOLO los inequívocos, y solo si se pide.
  if (!aplicar) {
    console.log("\n(Solo lectura. Añade --apply para guardar los emparejados EXACTOS.)\n");
    return;
  }
  if (exactos.length === 0) {
    console.log("\nNo hay emparejados exactos que guardar.\n");
    return;
  }
  for (const f of exactos) {
    const v = variantes.find((x) => x.variantId === f.variantId)!;
    db.upsertSupplierProductMapping({
      supplier_platform: "dropea",
      shopify_sku: f.sku,
      shopify_title: f.titulo,
      supplier_product_id: String(v.producto),
      supplier_variant_id: String(v.variantId),
      supplier_unit_price: v.precio,
    });
    console.log(`  guardado: ${f.titulo} → variant_id=${f.variantId}`);
  }
  console.log(
    `\n${exactos.length} emparejado(s) guardado(s). Los ambiguos NO se han tocado: ` +
      `hay que confirmarlos a mano.\n`
  );
}

main().catch((err) => {
  console.error("\n✗", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
