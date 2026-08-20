// Limpieza SEGURA del outbox: marca como "sent" (descartados) todos los
// mensajes pendientes SIN enviarlos. No borra filas: queda rastro auditable.
//   npm run outbox:clear-safe
// Pensado para descartar restos de desarrollo antes de habilitar envíos.
import "./env-loader";
import { getPendingOutbox, markOutboxSent } from "../src/lib/db";

const pending = getPendingOutbox(1000);

if (pending.length === 0) {
  console.log("Outbox ya estaba limpio: nada que descartar.");
  process.exit(0);
}

for (const item of pending) {
  markOutboxSent(item.id);
  console.log(`Descartado #${item.id} → +${item.phone} "${item.content.replace(/\s+/g, " ").slice(0, 50)}"`);
}
console.log(`\n${pending.length} mensaje(s) descartados SIN enviar. El outbox queda limpio.`);
