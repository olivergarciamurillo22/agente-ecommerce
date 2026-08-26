// ============================================================
// Crea .env.local desde la plantilla. NUNCA sobrescribe uno existente.
//
//   npm run env:init
//
// Sin secretos falsos: las variables sensibles quedan VACÍAS a propósito
// (un "fake-token-123" acaba pegado donde no debe).
// ============================================================

import fs from "node:fs";
import path from "node:path";

const destino = path.join(process.cwd(), ".env.local");
const plantilla = path.join(process.cwd(), ".env.example");

if (fs.existsSync(destino)) {
  console.log("\n✓ .env.local ya existe — NO se toca (bórralo tú si quieres regenerarlo).");
  console.log("  Siguiente paso: npm run env:doctor\n");
  process.exit(0);
}
if (!fs.existsSync(plantilla)) {
  console.error("\n✗ No existe .env.example en el repo.\n");
  process.exit(1);
}

fs.copyFileSync(plantilla, destino);
console.log("\n✓ Creado .env.local desde .env.example.");
console.log("  - Este archivo está en .gitignore: NO se sube a Git.");
console.log("  - Abre .env.local y pega tus valores donde falten.");
console.log("  - Los secretos van vacíos a propósito: rellénalos tú.");
console.log("\n  Siguiente paso: npm run env:doctor\n");
