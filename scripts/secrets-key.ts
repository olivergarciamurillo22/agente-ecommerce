// ============================================================
// secrets:key — genera la llave maestra que cifra las claves del panel
//
//   npm run secrets:key
//
// Se ejecuta UNA vez por instalación, al montarla. El valor se pega en el
// `.env` del servidor como SECRETS_MASTER_KEY y no se vuelve a tocar.
//
// Ojo, y esto hay que decírselo al cliente por escrito: si se pierde esta
// llave, las claves guardadas en la base quedan ilegibles y hay que volver a
// pegarlas una a una desde el panel. No se puede recuperar de ningún sitio:
// esa es justamente la razón de que un backup robado no sirva de nada.
// ============================================================

import { generateMasterKey, parseMasterKey } from "../src/lib/config/secrets";

const actual = (process.env.SECRETS_MASTER_KEY ?? "").trim();
if (actual && parseMasterKey(actual)) {
  console.log("\n⚠  Esta instalación YA tiene SECRETS_MASTER_KEY en el entorno.");
  console.log("   Si la cambias, las claves ya guardadas dejarán de poder leerse");
  console.log("   y habrá que volver a ponerlas desde el panel.");
  console.log("   Si aun así quieres una nueva, ejecuta: npm run secrets:key -- --forzar\n");
  if (!process.argv.includes("--forzar")) process.exit(0);
}

console.log("\nPega esta línea en el .env del servidor y reinicia:\n");
console.log(`SECRETS_MASTER_KEY=${generateMasterKey()}\n`);
console.log("Guárdala también fuera del servidor (gestor de contraseñas).");
console.log("Sin ella no se pueden leer las claves que el cliente guarde en el panel.\n");
