// ============================================================
// RESUMEN OPERATIVO — CLI. docs/deploy/RESUMEN-OPERATIVO.md
//
//   npm run pending:review                 (texto para leer o pegar)
//   npm run pending:review -- --json informe.json
//
// Solo lectura. Pensado también para un cron: su salida es exactamente lo que
// se enviaría por WhatsApp o correo cuando se decida activar el envío.
// Exit 0 siempre que pueda leer la base (que haya incidencias no es un fallo).
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return inline ? inline.slice(nombre.length + 3) : undefined;
}

async function main(): Promise<void> {
  const { getPendingReview, renderPendingReview } = await import("../src/lib/system/pending-review");
  const review = getPendingReview();
  const jsonPath = arg("json");
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(review, null, 2));
  console.log("");
  console.log(renderPendingReview(review));
  console.log("");
  if (jsonPath) console.log(`  Informe JSON: ${jsonPath}\n`);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("\n✗", err instanceof Error ? err.message : err, "\n");
    process.exitCode = 1;
  });
}
