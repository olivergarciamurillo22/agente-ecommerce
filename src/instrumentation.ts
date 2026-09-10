// ============================================================
// Arranque del servidor de Next (10-09-2026)
//
// `register()` se ejecuta UNA vez por instancia del servidor y termina antes
// de que se atienda la primera petición (documentado en
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
//
// Lo único que hacemos aquí es volcar a `process.env` las claves que el
// cliente haya guardado desde el panel, para que los ~60 puntos que ya leen
// `process.env.X` las vean sin tocarlos. Si no hay llave maestra, o la tabla
// todavía no existe, no pasa nada: se sigue con el `.env` de siempre.
// ============================================================

export async function register(): Promise<void> {
  // better-sqlite3 es solo de Node: en el runtime edge esto no debe correr.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { hydrateSecretsIntoEnv } = await import("./lib/config/secrets");
    const { applied } = hydrateSecretsIntoEnv();
    if (applied > 0) console.log(`[secrets] ${applied} clave(s) del panel cargadas`);
  } catch {
    // Arranque en frío sin base todavía: el .env manda y el panel lo dirá.
  }
}
