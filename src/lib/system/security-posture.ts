// ============================================================
// POSTURA DE SEGURIDAD — lo que el Control Center debe decirle a Pedro.
//
// No comprueba nada del NAS (no tenemos acceso). Comprueba lo que el propio
// proceso PUEDE saber sobre cómo está configurado, que es justo lo que se
// olvida: una variable que nadie puso hace un mes y de la que ya nadie se
// acuerda.
// ============================================================

import { checkTimezone } from "../time";

export type PostureLevel = "ok" | "warning" | "critical";

export interface PostureItem {
  key: string;
  /** Texto para Pedro: qué pasa y qué hacer. Sin jerga. */
  label: string;
  level: PostureLevel;
  detail: string;
}

export function getSecurityPosture(): PostureItem[] {
  const items: PostureItem[] = [];

  // 1. ¿El panel tiene contraseña propia?
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  items.push(
    password
      ? {
          key: "dashboard_password",
          label: "El panel pide contraseña",
          level: "ok",
          detail: "además de la protección de Cloudflare Access.",
        }
      : {
          key: "dashboard_password",
          label: "El panel NO pide contraseña propia",
          level: "warning",
          detail:
            "toda la protección depende de Cloudflare Access. Si alguien llega al NAS por la IP de la red local, ve los pedidos y las conversaciones con clientes. Se arregla poniendo DASHBOARD_PASSWORD en el .env.",
        }
  );

  // 2. Secretos de webhook: sin ellos, el endpoint rechaza TODO (fail-closed),
  //    así que no es un agujero — pero sí una integración parada.
  for (const [env, quien] of [
    ["SHOPIFY_WEBHOOK_SECRET", "Shopify"],
    ["DROPEA_WEBHOOK_SECRET", "Dropea"],
  ] as const) {
    const puesto = Boolean(process.env[env]?.trim());
    items.push({
      key: env.toLowerCase(),
      label: puesto ? `Avisos de ${quien}: firma verificándose` : `Avisos de ${quien}: SIN secreto`,
      level: puesto ? "ok" : "warning",
      detail: puesto
        ? "cada aviso se comprueba con la firma del emisor."
        : `sin ${env} se rechazan TODOS los avisos de ${quien}. No es un agujero de seguridad: es la integración parada.`,
    });
  }

  // 3. Huso horario: no es seguridad, pero sí corrección silenciosa.
  const tz = checkTimezone();
  items.push({
    key: "timezone",
    label: tz.ok ? "Hora del servidor correcta" : "Hora del servidor a revisar",
    level: tz.ok ? "ok" : "warning",
    detail: tz.message,
  });

  // 4. TEST_MODE: crítico saber que está puesto, porque significa que los
  //    clientes reales NO están recibiendo mensajes.
  const testMode = process.env.TEST_MODE === "1";
  if (testMode) {
    items.push({
      key: "test_mode",
      label: "MODO PRUEBA activado",
      level: "warning",
      detail:
        "solo se escribe a los teléfonos de la lista de permitidos. Los pedidos de clientes reales se ignoran, así que las colas y la tasa de respuesta no miden nada real.",
    });
  }

  // 5. Guardado del payload íntegro.
  if (process.env.STORE_RAW_PAYLOAD !== "0") {
    items.push({
      key: "raw_payload",
      label: "Se guarda el pedido completo de Shopify",
      level: "ok",
      detail:
        "incluye datos personales del cliente. Se reducen automáticamente al ejecutar `npm run retention` (ver docs/DATA-RETENTION.md).",
    });
  }

  return items;
}

export function worstPostureLevel(items: PostureItem[]): PostureLevel {
  if (items.some((i) => i.level === "critical")) return "critical";
  if (items.some((i) => i.level === "warning")) return "warning";
  return "ok";
}
