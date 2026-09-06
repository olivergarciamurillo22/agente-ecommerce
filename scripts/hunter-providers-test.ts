// ============================================================
// npm run hunter:providers:test — prueba REAL y mínima de cada fuente.
//
// SOLO LECTURA. Hace la consulta más barata posible de cada proveedor
// configurado (1 resultado) para confirmar tres cosas que el doctor no puede:
//   · que la clave autentica de verdad,
//   · qué FORMA tiene la respuesta,
//   · y si nuestro mapeo defensivo saca algo o se queda todo a null.
//
// Ese último punto es el que convierte las capacidades UNVERIFIED en
// AVAILABLE: hasta que no se ve un anuncio con nombre y anunciante, no se
// puede prometer que la integración funciona.
//
// No escribe productos ni oportunidades. No dispara ninguna escritura externa.
// Salidas: 0 = todo lo configurado responde · 1 = alguno falla · 2 = error.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  console.log("\n════════ RADAR · PRUEBA DE FUENTES (solo lectura) ════════\n");

  const { searchProviders } = await import("../src/lib/hunter/providers/registry");
  const { CallBudget } = await import("../src/lib/hunter/http");

  // Presupuesto minúsculo a propósito: esto es una comprobación, no una
  // búsqueda. Si algo intenta paginar, el tope lo corta.
  const budget = new CallBudget(6);
  const proveedores = searchProviders({ budget });

  if (proveedores.length === 0) {
    console.log("  ○ Ninguna fuente configurada. Nada que probar.");
    console.log("    Empieza por WINNINGHUNTER_API_KEY (docs/product-hunter/PEDRO-API-KEYS.md).\n");
    process.exit(1);
  }

  let fallos = 0;
  for (const p of proveedores) {
    console.log(`── ${p.id} ──`);
    const salud = await p.health();
    console.log(`   salud: ${salud.status} · ${salud.detail}`);
    if (salud.creditsRemaining !== null) console.log(`   créditos: ${salud.creditsRemaining}`);

    if (!p.searchAds) {
      console.log("   (no implementa búsqueda de anuncios)\n");
      continue;
    }
    const t0 = Date.now();
    const res = await p.searchAds({ keywords: "hogar", country: "ES", limit: 1, activeOnly: true });
    const ms = Date.now() - t0;

    if (!res.ok) {
      fallos += 1;
      console.log(`   ✗ búsqueda: ${res.error} (HTTP ${res.status ?? "—"}) · ${ms} ms\n`);
      continue;
    }
    const ads = res.data?.ads ?? [];
    console.log(`   ✓ búsqueda: ${ads.length} anuncio(s) · ${ms} ms · llamadas=${res.calls} · caché=${res.fromCache}`);
    if (ads.length > 0) {
      const a = ads[0];
      // Se enseña QUÉ CAMPOS han llegado, no su contenido: así se ve de un
      // vistazo si el mapeo defensivo está acertando con los nombres reales.
      const presentes = Object.entries({
        anunciante: a.advertiserName, producto: a.productNameRaw, copy: a.adCopy,
        landing: a.landingUrl, inicio: a.startedAt, activo: a.active,
        diasActivo: a.activeDays, precio: a.priceObserved, imagen: a.imageUrl,
      })
        .map(([k, v]) => `${k}=${v === null || v === undefined ? "—" : "sí"}`)
        .join(" ");
      console.log(`   campos mapeados: ${presentes}`);
      const vacios = [a.advertiserName, a.productNameRaw, a.adCopy].filter((x) => x === null).length;
      if (vacios >= 3) {
        console.log("   ⚠️  TODO a null: los nombres de campo reales no coinciden con los candidatos.");
        console.log("       Ajusta el mapeo en src/lib/hunter/providers/ antes de fiarte de una búsqueda.");
      }
    }
    console.log();
  }

  console.log(`════════ ${fallos === 0 ? "TODAS LAS FUENTES CONFIGURADAS RESPONDEN" : `${fallos} FUENTE(S) CON PROBLEMAS`} ════════`);
  console.log(`  llamadas gastadas en esta prueba: ${budget.spent}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
