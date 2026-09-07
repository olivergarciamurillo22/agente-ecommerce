import "./env-loader";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const phone = value("telefono");
  if (!phone) throw new Error("uso: npm run fixture:pedido -- --telefono <número de allowlist>");
  const { createSyntheticOrder } = await import("../src/lib/orders/synthetic-fixture");
  const order = createSyntheticOrder(phone);
  console.log(`Pedido sintético #${order.shopify_order_number} creado`);
  console.log(`Teléfono normalizado: ${order.phone.slice(0, 2)}···${order.phone.slice(-3)} · estado ${order.status}`);
}

main().catch((error) => { console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
