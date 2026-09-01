// ============================================================
// Diagnóstico de Meta Ads — SOLO LECTURA.
//
//   npm run meta-ads:doctor
//
// Comprueba token, permiso ads_read, cuenta, divisa/huso y el endpoint de
// insights. NUNCA imprime el token y no escribe nada en Meta.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const { metaAdsConfig, metaAdsApiVersion, metaAdsVersionLagging, META_ADS_DEFAULT_API_VERSION } = await import(
    "../src/lib/meta-ads/config"
  );
  const client = await import("../src/lib/meta-ads/client");

  console.log("\n════════ META ADS · diagnóstico (solo lectura) ════════\n");

  const config = metaAdsConfig();
  console.log("1. CONFIGURACIÓN");
  console.log(`   Token          : ${process.env.META_ADS_ACCESS_TOKEN ? "configurado (no se muestra)" : "FALTA (META_ADS_ACCESS_TOKEN)"}`);
  console.log(`   Cuenta         : ${process.env.META_ADS_ACCOUNT_ID ? `act_${config?.accountId ?? "?"}` : "FALTA (META_ADS_ACCOUNT_ID)"}`);
  console.log(`   Versión API    : ${metaAdsApiVersion()}${process.env.META_ADS_API_VERSION ? "" : " (default)"}`);
  if (metaAdsVersionLagging()) {
    console.log(`   ◐ AVISO: versión por detrás de la vigente conocida (${META_ADS_DEFAULT_API_VERSION}) — revisar calendario de sunset de Meta`);
  }
  if (!config) {
    console.log("\n○ Faltan credenciales: no se puede continuar.");
    console.log("  El token debe ser INDEPENDIENTE del de WhatsApp y llevar el permiso ads_read.\n");
    process.exit(1);
  }

  console.log("\n2. TOKEN Y PERMISOS");
  try {
    const permisos = await client.getTokenPermissions();
    const adsRead = permisos.find((p) => p.permission === "ads_read");
    if (adsRead?.status === "granted") {
      console.log("   ● ads_read concedido");
    } else {
      console.log(`   ◐ ads_read: ${adsRead?.status ?? "NO aparece entre los permisos del token"}`);
      console.log("     → Genera el token con ads_read (Business Manager → usuarios del sistema).");
    }
  } catch (err) {
    console.log(`   ○ No se pudieron leer los permisos: ${err instanceof Error ? err.message : "error"}`);
  }

  console.log("\n3. CUENTA PUBLICITARIA");
  try {
    const cuenta = await client.getAccountInfo();
    console.log(`   ● Accesible: ${cuenta.name ?? cuenta.id}`);
    console.log(`   Divisa         : ${cuenta.currency ?? "?"}${cuenta.currency && cuenta.currency !== "EUR" ? " — ⚠️ Finanzas asume EUR" : ""}`);
    console.log(`   Huso horario   : ${cuenta.timezone ?? "?"}${cuenta.timezone && cuenta.timezone !== "Europe/Madrid" ? " — ⚠️ distinto de Europe/Madrid: los días de Meta no coincidirán exactos con los de negocio" : ""}`);
  } catch (err) {
    console.log(`   ○ No accesible: ${err instanceof Error ? err.message : "error"}\n`);
    process.exit(1);
  }

  console.log("\n4. INSIGHTS (últimos 3 días, nivel cuenta)");
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const hace3 = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
    const filas = await client.getDailyInsights({ level: "account", since: hace3, until: hoy });
    console.log(`   ● Endpoint OK — ${filas.length} día(s) con datos`);
    for (const f of filas) {
      console.log(`     · ${f.day}: gasto ${f.spend ?? "—"} ${f.currency ?? ""} · ${f.impressions ?? "—"} impresiones · ${f.clicks ?? "—"} clics`);
    }
    if (filas.length === 0) console.log("     (sin gasto en el rango; no es un error)");
  } catch (err) {
    console.log(`   ○ Insights falló: ${err instanceof Error ? err.message : "error"}\n`);
    process.exit(1);
  }

  console.log("\n● META ADS: conectado y listo. Siguiente paso: npm run meta-ads:sync\n");
}

main().catch((err) => {
  console.error(`\n✗ Error inesperado: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
