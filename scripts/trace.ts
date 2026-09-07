import "./env-loader";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const pedido = value("pedido");
  if (!pedido) throw new Error("uso: npm run trace -- --pedido <numero>");
  const reveal = process.argv.includes("--sin-redactar");
  if (reveal && !process.argv.includes("--confirmo-pii")) {
    throw new Error("--sin-redactar exige --confirmo-pii: la salida puede contener datos personales");
  }
  const { buildOrderTrace } = await import("../src/lib/trace");
  const trace = buildOrderTrace(pedido, reveal);
  if (!trace) throw new Error(`pedido ${pedido} no encontrado`);
  console.log(`\nPedido ${trace.order.number} · ${trace.order.status}`);
  console.log(`Cliente: ${trace.order.customer ?? "—"} · teléfono ${trace.order.phone} · ubicación ${trace.order.location ?? "—"}`);
  console.log(reveal ? "PII SIN REDACTAR: confirmación explícita recibida\n" : "PII redactada (usa --sin-redactar --confirmo-pii solo si es imprescindible)\n");
  for (const event of trace.events) {
    const detail = event.detail ? ` · ${event.detail.replace(/\s+/g, " ")}` : "";
    console.log(`${new Date(event.at * 1000).toISOString()}  ${event.source.padEnd(13)} ${event.label}${detail}`);
  }
}

main().catch((error) => { console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
