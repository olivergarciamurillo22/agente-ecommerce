import "./env-loader";
import { MetaAdLibraryProvider } from "../src/lib/product-intelligence/providers/meta-ad-library-provider";

async function main() {
  if (!process.argv.includes("--confirmar-red-real")) throw new Error("Este smoke hace llamadas reales. Añade --confirmar-red-real explícitamente.");
  const query = process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? "juanetes";
  const provider = new MetaAdLibraryProvider({ maxPages: 1, maxCalls: 20, maxRetries: 0 });
  const fields = await provider.auditFields(query);
  console.log(JSON.stringify({ query, fields, telemetry: provider.telemetry() }, null, 2));
  if (!fields.some((field) => field.status === "AVAILABLE")) process.exitCode = 2;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
