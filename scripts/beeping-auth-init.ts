// ============================================================
// Genera la credencial Basic de Beeping EN LOCAL y la guarda en .env.local.
//
//   npm run beeping:auth:init
//
// Pide email y contraseña de forma INTERACTIVA (la contraseña sin eco),
// codifica "email:contraseña" en Base64 —que es una CODIFICACIÓN, no un
// cifrado: cualquiera que vea el valor recupera la contraseña— y escribe
// BEEPING_BASIC_AUTH en .env.local.
//
// NUNCA imprime email, contraseña, base64 ni cabecera. NUNCA manda nada a
// ninguna web. Si ya hay valor, pide confirmación antes de sobrescribir.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";

const ENV_FILE = path.join(process.cwd(), ".env.local");
const VAR = "BEEPING_BASIC_AUTH";

function preguntar(rl: readline.Interface, texto: string): Promise<string> {
  return new Promise((resolve) => rl.question(texto, resolve));
}

/** Pregunta con eco APAGADO (la contraseña no se pinta ni en el scroll). */
function preguntarOculto(texto: string): Promise<string> {
  return new Promise((resolve) => {
    let silenciar = false;
    const mudo = new Writable({
      write(chunk, _enc, cb) {
        if (!silenciar) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: mudo, terminal: true });
    rl.question(texto, (respuesta) => {
      rl.close();
      process.stdout.write("\n");
      resolve(respuesta);
    });
    silenciar = true;
  });
}

function leerEnv(): string {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
}

function escribirVariable(contenido: string, valor: string): string {
  const linea = `${VAR}=${valor}`;
  const regex = new RegExp(`^${VAR}=.*$`, "m");
  if (regex.test(contenido)) return contenido.replace(regex, linea);
  const sep = contenido.endsWith("\n") || contenido === "" ? "" : "\n";
  return `${contenido}${sep}${linea}\n`;
}

async function main(): Promise<void> {
  console.log("\n══════ BEEPING · credencial Basic (generada en local) ══════\n");
  console.log("  La credencial se construye AQUÍ, en tu máquina. Nada sale a la red.");
  console.log("  Ojo: Base64 NO es cifrado — el valor resultante equivale a tu");
  console.log("  contraseña de Beeping y se trata como un secreto.\n");

  const actual = leerEnv();
  const yaExiste = new RegExp(`^${VAR}=.+$`, "m").test(actual);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (yaExiste) {
    const resp = (await preguntar(rl, `  ${VAR} ya tiene valor en .env.local. ¿Sobrescribir? (escribe "si"): `)).trim().toLowerCase();
    if (resp !== "si" && resp !== "sí") {
      console.log("\n  Sin cambios. El valor existente se conserva.\n");
      rl.close();
      return;
    }
  }

  const email = (await preguntar(rl, "  Email de la cuenta Beeping: ")).trim();
  rl.close();
  if (!email || !email.includes("@")) {
    console.error("\n✗ Eso no parece un email. Sin cambios.\n");
    process.exit(1);
  }
  const password = await preguntarOculto("  Contraseña (no se muestra): ");
  if (!password) {
    console.error("\n✗ Contraseña vacía. Sin cambios.\n");
    process.exit(1);
  }

  const credencial = Buffer.from(`${email}:${password}`, "utf8").toString("base64");
  fs.writeFileSync(ENV_FILE, escribirVariable(actual, credencial), { mode: 0o600 });

  console.log(`\n✓ ${VAR} guardada en .env.local (${credencial.length} caracteres; no se muestra).`);
  console.log("  Siguiente paso: BEEPING_ENABLED=1 en .env.local y npm run beeping:doctor\n");
}

main().catch((err) => {
  // Jamás volcar el error entero: podría arrastrar el valor.
  console.error(`\n✗ Error: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
