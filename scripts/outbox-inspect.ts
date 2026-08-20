// Inspección del outbox: lista los mensajes PENDIENTES de envío para poder
// revisarlos antes de habilitar cualquier envío real.
//   npm run outbox:inspect
// No modifica nada.
import "./env-loader";
import { getPendingOutbox } from "../src/lib/db";

const pending = getPendingOutbox(500);

if (pending.length === 0) {
  console.log("Outbox limpio: no hay mensajes pendientes de envío.");
  process.exit(0);
}

console.log(`Hay ${pending.length} mensaje(s) PENDIENTES en el outbox:\n`);
const now = Math.floor(Date.now() / 1000);
for (const item of pending) {
  const ageMin = Math.round((now - item.created_at) / 60);
  console.log(
    [
      `#${item.id}`,
      `→ +${item.phone}`,
      `tipo=${item.type}`,
      `hace ${ageMin} min`,
      `"${item.content.replace(/\s+/g, " ").slice(0, 70)}"`,
    ].join("  ")
  );
}
console.log(
  "\nEstos mensajes NO se enviarán solos si son antiguos o los safety gates están cerrados." +
    "\nPara descartarlos de forma segura: npm run outbox:clear-safe"
);
