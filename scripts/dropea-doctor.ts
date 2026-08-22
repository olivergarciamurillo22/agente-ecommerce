// ============================================================
// Diagnóstico de Dropea — SOLO LECTURA.
//
//   npm run dropea:doctor
//   npm run dropea:doctor -- --order-id=1234
//
// Comprueba configuración, conectividad y autenticación, y hace unas pocas
// consultas GET. NUNCA crea, confirma ni cancela nada, y jamás imprime la
// API key, el secreto del webhook ni datos personales de clientes.
// ============================================================

import "./env-loader";

function arg(nombre: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

/** Enmascara cualquier credencial: solo longitud y prefijo corto. */
function huella(valor: string | undefined): string {
  if (!valor) return "no configurada";
  return `configurada (${valor.length} caracteres, empieza por "${valor.slice(0, 4)}…")`;
}

async function main(): Promise<void> {
  const client = await import("../src/lib/suppliers/dropea/client");
  const provider = await import("../src/lib/suppliers/dropea");
  const { normalizeDropeaStatus } = await import("../src/lib/suppliers/dropea/status-map");

  console.log("\n════════ DIAGNÓSTICO DROPEA (solo lectura) ════════\n");

  // --- 1. Configuración ---
  const config = client.dropeaConfig();
  console.log("1. CONFIGURACIÓN");
  console.log(`   API key        : ${huella(process.env.DROPEA_API_KEY)}`);
  console.log(`   Webhook secret : ${huella(process.env.DROPEA_WEBHOOK_SECRET)}`);
  console.log(`   Mercado        : ${process.env.DROPEA_MARKET || "es (por defecto)"}`);
  console.log(`   URL base       : ${config?.baseUrl ?? "—"}`);
  console.log(`   Lectura API    : ${client.dropeaReadEnabled() ? "HABILITADA" : "deshabilitada (DROPEA_API_ENABLED=0)"}`);
  console.log(`   Escritura      : ${provider.dropeaWriteEnabled() ? "⚠️ HABILITADA" : "BLOQUEADA"}`);

  if (!config) {
    console.log("\n✗ Falta DROPEA_API_KEY: no se puede continuar.");
    console.log("  Créala en https://v2.app.dropea.com/es/dropshipper/api-keys y pégala en el .env\n");
    process.exit(1);
  }
  if (!client.dropeaReadEnabled()) {
    console.log("\n⚠️  La lectura está deshabilitada. Para diagnosticar pon DROPEA_API_ENABLED=1");
    console.log("   (sigue sin poder escribir: eso exige además DROPEA_WRITE_ENABLED=1)\n");
    process.exit(1);
  }

  // --- 2. Conectividad y autenticación ---
  console.log("\n2. CONEXIÓN Y AUTENTICACIÓN");
  try {
    const me = (await provider.getDropeaMe()) as Record<string, unknown>;
    console.log("   Conexión       : OK");
    console.log("   Autenticación  : OK");
    // Solo campos no sensibles.
    const id = me?.id ?? me?.user_id ?? "—";
    console.log(`   Cuenta         : id=${id}`);
  } catch (err) {
    const e = err as { httpStatus?: number; message?: string };
    console.log(`   ✗ ${e.message ?? err}`);
    if (e.httpStatus === 401) console.log("     → la API key es inválida o ha caducado");
    if (e.httpStatus === 403) console.log("     → la key no tiene el permiso dp:users:read");
    if (e.httpStatus === 0) console.log("     → no se pudo contactar con el host");
    process.exit(1);
  }

  // --- 3. Tiendas: de aquí sale el store_id necesario para crear pedidos ---
  console.log("\n3. TIENDAS (store_id para crear pedidos)");
  try {
    const shops = (await provider.listDropeaShops()) as { items?: Array<Record<string, unknown>> };
    const items = shops?.items ?? [];
    if (!items.length) console.log("   (ninguna tienda)");
    for (const s of items.slice(0, 10)) {
      console.log(`   · store_id=${s.id ?? s.store_id} · ${s.name ?? "—"} · ${s.type ?? ""} ${s.status ?? ""}`);
    }
  } catch (err) {
    console.log(`   ✗ ${(err as Error).message}`);
  }

  // --- 4. Catálogo: de aquí salen los variant_id ---
  console.log("\n4. CATÁLOGO (variant_id para las líneas de pedido)");
  try {
    const prods = await provider.listDropeaProducts(1, 10);
    const items = prods?.items ?? [];
    console.log(`   ${items.length} producto(s) en la primera página`);
    for (const p of items.slice(0, 5)) {
      const vs = p.variants ?? [];
      console.log(`   · producto ${p.id} — ${p.name ?? "—"} (${vs.length} variante/s)`);
      for (const v of vs.slice(0, 3)) {
        console.log(`       variant_id=${v.variant_id} · SKU ${v.sku} · coste ${v.price} · stock ${v.stock ?? "?"}`);
      }
    }
  } catch (err) {
    console.log(`   ✗ ${(err as Error).message}`);
  }

  // --- 5. Webhooks registrados ---
  console.log("\n5. WEBHOOKS REGISTRADOS");
  try {
    const hooks = (await provider.listDropeaWebhooks()) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const items = Array.isArray(hooks) ? hooks : (hooks?.items ?? []);
    if (!items.length) console.log("   (ninguno suscrito todavía)");
    for (const h of items) {
      console.log(`   · ${h.topic} → ${h.url} ${h.active ? "[activo]" : "[inactivo]"}`);
    }
  } catch (err) {
    console.log(`   ✗ ${(err as Error).message}`);
  }

  // --- 6. Pedido concreto (opcional) ---
  const orderId = arg("order-id");
  if (orderId) {
    console.log(`\n6. PEDIDO ${orderId}`);
    try {
      const o = await provider.getDropeaOrder(orderId);
      const normalizado = normalizeDropeaStatus(o.status, o.sub_status ?? null);
      console.log(`   estado         : ${o.status}${o.sub_status ? "." + o.sub_status : ""} → ${normalizado}`);
      console.log(`   tracking       : ${o.tracking_number ?? "—"} · ${o.carrier ?? "—"}`);
      console.log(`   referencia     : ${o.external_order_id ?? "—"}`);
      console.log(`   total          : ${o.total_amount ?? "—"} ${o.currency ?? ""}`);
      // A propósito NO se imprime la dirección ni el cliente.
    } catch (err) {
      console.log(`   ✗ ${(err as Error).message}`);
    }
  }

  console.log("\n════════ RESUMEN ════════");
  console.log(`  Auth            : OK`);
  console.log(`  Conexión        : OK`);
  console.log(`  Escrituras      : ${provider.dropeaWriteEnabled() ? "⚠️ HABILITADAS" : "DESHABILITADAS"}`);
  console.log(`  Webhook secret  : ${process.env.DROPEA_WEBHOOK_SECRET ? "configurado" : "NO configurado"}`);
  console.log("  Este comando no ha modificado nada.\n");
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
