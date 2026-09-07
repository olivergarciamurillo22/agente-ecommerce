// ============================================================
// COBERTURA DEL ROUTER DE CANAL — CLI
//
//   npm run dispatch:coverage                      (base local)
//   npm run dispatch:coverage -- --dias 30 --json informe.json
//
// Lo usa `npm run predeploy:check` en un proceso HIJO con DATA_DIR apuntando
// a la copia YA MIGRADA: así lee los productos y los canales de la copia de
// producción sin abrir jamás la base real y sin que el orquestador tenga que
// cargar src/lib/db (que congela DATA_DIR al importarse).
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
  const { dispatchCoverage, COVERAGE_WINDOW_DAYS } = await import("../src/lib/orders/dispatch-coverage");
  const dias = Number.parseInt(arg("dias") ?? "", 10);
  const report = dispatchCoverage(Number.isFinite(dias) && dias > 0 ? dias : COVERAGE_WINDOW_DAYS);
  const jsonPath = arg("json");
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  console.log("\n──── COBERTURA DEL ROUTER DE CANAL ────\n");
  console.log(`  ventana            : ${report.windowDays} días`);
  console.log(`  pedidos leídos     : ${report.ordersScanned} (${report.ordersWithoutPayload} sin raw_payload legible)`);
  console.log(`  reglas de canal    : ${report.channels.total} (${report.channels.beeping} Beeping · ${report.channels.dropea} Dropea)`);
  console.log(`  productos activos  : ${report.products.length}`);
  console.log(`  sin canal          : ${report.uncovered.length}\n`);
  for (const p of report.products.slice(0, 40)) {
    const canal = p.channel ? `${p.channel} (por ${p.matchedBy})` : "SIN CANAL";
    console.log(`  ${canal.padEnd(24)} ${(p.sku ?? "—").padEnd(22)} ${p.title.slice(0, 42).padEnd(42)} ${p.orders} pedido(s)`);
  }
  if (report.products.length > 40) console.log(`  … y ${report.products.length - 40} más`);
  for (const problema of report.problems) console.log(`\n  ✗ ${problema}`);
  console.log(report.ok ? "\n  ✓ Todos los productos activos tienen canal asignado.\n" : "\n  ✗ Cobertura incompleta: el auto-despacho retendría esos pedidos.\n");
  if (jsonPath) console.log(`  Informe JSON: ${jsonPath}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("\n✗", err instanceof Error ? err.message : err, "\n");
    process.exitCode = 1;
  });
}
