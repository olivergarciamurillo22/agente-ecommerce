// Verifica la integración con el CRM de Airtable (la tabla de leads que hayas
// configurado en AIRTABLE_LEADS_TABLE). Crea un lead de PRUEBA, comprueba que
// la UTM del agente queda enlazada y el campo de notas existe, y BORRA el
// registro de prueba al terminar.
// Uso: npm run test:airtable  (equivale a: npx tsx scripts/test-airtable.mts)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf-8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";

const apiKey = get("AIRTABLE_API_KEY");
const baseId = get("AIRTABLE_BASE_ID");
const table = get("AIRTABLE_LEADS_TABLE") || "tblXXXXXXXXXXXXXX";
const utm = get("AIRTABLE_AGENT_UTM") || "recXXXXXXXXXXXXXX";
const H = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

if (!apiKey || !baseId) { console.error("❌ Falta AIRTABLE_API_KEY o AIRTABLE_BASE_ID en .env.local"); process.exit(1); }

const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
const TEST_PHONE = "000-TEST-BOT";
const fields: Record<string, unknown> = {
  Contacto: TEST_PHONE,
  Lead: "PRUEBA Agente (borrar)",
  Email: "prueba@ejemplo.com",
  "🔗 UTMs": [utm],
  "📝 Notas Agente IA": "Objetivo: Primer cliente · Situación: Desde cero · Temperatura: Caliente",
};

async function upsert(f: Record<string, unknown>) {
  // Crear un registro nuevo (POST). El código real busca-y-actualiza; aquí solo
  // probamos permisos de escritura, enlace de UTM y campo de notas, y limpiamos.
  return fetch(base, { method: "POST", headers: H, body: JSON.stringify({ fields: f, typecast: true }) });
}

let notasOk = true;
let res = await upsert(fields);
if (!res.ok) {
  const detail = await res.text();
  if (res.status === 422 && /unknown field|📝|notas/i.test(detail)) {
    notasOk = false;
    console.log("⚠️  El campo «📝 Notas Agente IA» NO existe todavía en tu tabla de leads.");
    console.log("   Créalo a mano: en tu tabla de leads de Airtable → + → tipo 'Long text' → nombre exacto «📝 Notas Agente IA».");
    delete fields["📝 Notas Agente IA"];
    res = await upsert(fields);
    if (!res.ok) { console.error(`❌ Airtable ${res.status}: ${(await res.text()).slice(0, 400)}`); process.exit(1); }
  } else {
    console.error(`❌ Airtable ${res.status}: ${detail.slice(0, 400)}`); process.exit(1);
  }
}

const created = await res.json();
const rid = created.id;
const f = created.fields;
console.log(`✅ Lead de prueba creado en tu tabla de leads (${rid})`);
console.log(`   Lead: ${f.Lead}`);
console.log(`   Contacto: ${f.Contacto}`);
console.log(`   Email: ${f.Email}`);
console.log(`   UTM enlazada: ${Array.isArray(f["🔗 UTMs"]) ? "sí (" + f["🔗 UTMs"].length + ")" : "NO"}`);
console.log(`   Campaña atribuida (auto): ${JSON.stringify(f["⚡️ Campañas"] ?? "—")}`);
console.log(`   Canal atribuido (auto):   ${JSON.stringify(f["⭐️ Canal"] ?? "—")}`);
console.log(`   Notas Agente IA: ${notasOk ? "✅ guardadas" : "❌ campo pendiente de crear"}`);

// Limpieza: borrar el registro de prueba para no ensuciar el CRM real.
const del = await fetch(`${base}/${rid}`, { method: "DELETE", headers: H });
console.log(del.ok ? "🧹 Registro de prueba BORRADO." : `⚠️ No pude borrar la prueba (${del.status}) — bórrala a mano: ${rid}`);

console.log(notasOk ? "\n✅ Integración lista." : "\n⚠️ Integración casi lista: crea el campo de notas y vuelve a ejecutar.");
