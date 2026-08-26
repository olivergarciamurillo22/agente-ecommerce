// ============================================================
// CASAMABLE ENV DOCTOR — ¿qué me falta para el perfil X?
//
//   npm run env:doctor                                   # local-safe
//   npm run env:doctor -- --profile whatsapp-cloud-pilot
//   npm run env:doctor -- --profile retell-pilot
//   npm run env:doctor -- --profile shopify-readonly
//
// Solo lectura del entorno. CERO red. Los secretos JAMÁS se imprimen:
// solo "configurado" / "falta".
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const { auditEnvironment, PROFILES } = await import("../src/lib/config/env-schema");
  type Profile = (typeof PROFILES)[number];

  const idx = process.argv.indexOf("--profile");
  const pedido = idx >= 0 ? process.argv[idx + 1] : "local-safe";
  if (!PROFILES.includes(pedido as Profile)) {
    console.log(`\n✗ Perfil desconocido: "${pedido}". Disponibles: ${PROFILES.join(", ")}\n`);
    process.exit(1);
  }
  const profile = pedido as Profile;
  const audit = auditEnvironment(profile);

  console.log("\n════════ CASAMABLE ENV DOCTOR ════════\n");
  console.log(`Perfil: ${profile}`);
  console.log(`Archivo local de entorno: .env.local (créalo con npm run env:init)\n`);

  const porCategoria = new Map<string, typeof audit.items>();
  for (const item of audit.items) {
    const c = item.spec.category;
    if (!porCategoria.has(c)) porCategoria.set(c, []);
    porCategoria.get(c)!.push(item);
  }

  for (const [categoria, items] of porCategoria) {
    // Las categorías sin nada que decir en este perfil se resumen en una línea.
    const relevantes = items.filter((i) => i.state !== "not_needed" && i.state !== "do_not_configure");
    console.log(`── ${categoria.replace("_", " ")} ──`);
    if (relevantes.length === 0) {
      console.log("  ○ nada requerido para este perfil");
      continue;
    }
    for (const i of relevantes) {
      const icono = i.state === "ok" ? "✓" : i.state === "missing" ? "✗" : i.state === "wrong_value" ? "✗" : "⚠";
      const valor = i.spec.secret
        ? i.state === "ok"
          ? "configurado (secreto: no se muestra)"
          : "FALTA"
        : (i.shownValue ?? "");
      console.log(`  ${icono} ${i.spec.name}${valor ? ` — ${valor}` : ""}`);
      if (i.problem) console.log(`      ${i.problem}`);
      if (i.state !== "ok") {
        console.log(`      ${i.spec.description}`);
        if (i.spec.managedBySettings) {
          console.log(`      OJO: settings.${i.spec.managedBySettings} (panel) tiene PRIORIDAD sobre el .env.`);
        }
        if (i.spec.secret) console.log("      Secreto: SÍ → pégalo en .env.local. NUNCA a Git ni a un chat.");
      }
    }
  }

  // Plantilla de confirmación: es fichero de catálogo, no variable.
  if (profile === "whatsapp-cloud-pilot") {
    console.log("── CATÁLOGO DE PLANTILLAS ──");
    try {
      const cat = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config/whatsapp-templates.json"), "utf8")) as {
        templates: Array<{ name: string }>;
      };
      const ok = cat.templates.some((t) => t.name === "order_confirmation_request");
      console.log(ok ? "  ✓ order_confirmation_request está en el catálogo local" : "  ✗ falta order_confirmation_request en config/whatsapp-templates.json");
      console.log("      (La APROBACIÓN real solo se ve en WhatsApp Manager — verifícala allí, categoría UTILITY.)");
    } catch {
      console.log("  ✗ config/whatsapp-templates.json ilegible");
    }
  }

  if (audit.dangers.length) {
    console.log("\n── AVISOS ──");
    for (const d of audit.dangers) console.log(`  ${d}`);
  }

  console.log("\n════════ RESULTADO ════════");
  if (audit.ready) {
    const etiqueta: Record<string, string> = {
      "local-safe": "READY FOR LOCAL DEVELOPMENT",
      "shopify-readonly": "READY FOR SHOPIFY READONLY",
      "whatsapp-baileys": "READY FOR BAILEYS",
      "whatsapp-cloud-pilot": "READY FOR CLOUD PILOT (entorno)",
      "retell-pilot": "READY FOR RETELL PILOT (entorno)",
      "nas-production": "PERFIL DOCUMENTAL — no ejecutar desde el Mac",
    };
    console.log(`✓ ${etiqueta[profile]}\n`);
  } else {
    console.log(`✗ NOT READY — falta(n) ${audit.missingRequired.length}: ${audit.missingRequired.join(", ")}`);
    console.log("  Rellena lo que falte en .env.local y vuelve a ejecutar este comando.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
