// IMPORTANTE: env-loader debe ser el PRIMER import.
// Los ES module imports se hoistean al inicio del archivo, así que cualquier
// import que lea process.env en su top-level necesita que el .env.local
// se haya cargado YA. env-loader.ts es side-effect only y puebla process.env
// antes de que se evalúen el resto de imports.
import "./env-loader";

import pino from "pino";
import { start, watchRestartFlag } from "../src/lib/baileys/client";
import { startOrderScheduler } from "../src/lib/orders/scheduler";
import { startTrackingScheduler } from "../src/lib/tracking/scheduler";
import { startReconcileScheduler } from "../src/lib/shopify/reconcile";
import { whatsappProviderName } from "../src/lib/whatsapp/provider";
import { startCloudOutboxLoop } from "../src/lib/whatsapp/cloud-outbox";
import {
  releaseLease,
  LEASE_ORDERS,
  LEASE_TRACKING,
  LEASE_RECONCILE,
  LEASE_CALLS,
  LEASE_OUTBOX,
  LEASE_WATCHDOG,
} from "../src/lib/system/leases";
import { startCallOrchestrator } from "../src/lib/calls/scheduler";
import { startBeepingScheduler } from "../src/lib/beeping/scheduler";
import { startMetaAdsScheduler } from "../src/lib/meta-ads/scheduler";
import { printSafetyStatus } from "../src/lib/safety";
import { getPendingOutbox } from "../src/lib/db";

const logger = pino({
  level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info",
});

// Red de seguridad: un error async no capturado (p.ej. en el intervalo del
// outbox o al recibir un mensaje) NO debe tumbar el bot entero y dejar a todos
// los leads sin respuesta. Se registra y el proceso sigue vivo.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "[bot] promesa rechazada sin capturar (el proceso sigue vivo)");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "[bot] excepción no capturada (el proceso sigue vivo)");
});

async function main(): Promise<void> {
  // En producción (NAS/servidor) el panel muestra datos de clientes reales:
  // arrancar sin contraseña sería exponerlos. Fallamos rápido y con un
  // mensaje claro en vez de levantar algo inseguro.
  if (process.env.NODE_ENV === "production" && !process.env.DASHBOARD_PASSWORD?.trim()) {
    logger.error(
      "[SEGURIDAD] DASHBOARD_PASSWORD está vacío y NODE_ENV=production. " +
        "El panel quedaría accesible sin contraseña. Rellena DASHBOARD_PASSWORD en el .env y vuelve a arrancar."
    );
    process.exit(1);
  }

  // Estado de seguridad SIEMPRE visible al arrancar: imposible no saber en
  // qué modo estamos antes de que ocurra nada.
  printSafetyStatus();

  // Mensajes pendientes en el outbox (restos de sesiones anteriores): se
  // avisa y NO se envían solos — el loop del outbox los retiene por edad y
  // por gates. Revisar con npm run outbox:inspect / outbox:clear-safe.
  try {
    const pendientes = getPendingOutbox(500);
    if (pendientes.length > 0) {
      logger.warn(
        `[SAFETY] Hay ${pendientes.length} mensaje(s) pendientes en outbox. ` +
          `Los antiguos quedan retenidos; revisa con "npm run outbox:inspect" y limpia con "npm run outbox:clear-safe".`
      );
    }
  } catch {
    // la comprobación informativa nunca debe impedir el arranque
  }

  logger.info("[bot] arrancando bot de WhatsApp...");

  // La IA es OPCIONAL en este proyecto: el flujo de confirmación de pedidos
  // COD es determinista y funciona con coste de IA = 0 €.
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === "") {
    logger.info(
      "[bot] OPENROUTER_API_KEY vacía — agente IA desactivado. Las confirmaciones de pedidos funcionan igual."
    );
  }
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) {
    logger.warn(
      "[bot] SHOPIFY_WEBHOOK_SECRET vacío — el webhook de Shopify rechazará pedidos hasta configurarlo en .env.local"
    );
  }

  try {
    if (whatsappProviderName() === "cloud_api") {
      // Proveedor oficial: NO se arranca Baileys (ni QR ni sesión de
      // WhatsApp Web). La entrada llega por el webhook de Meta (proceso
      // web) y la salida la drena el loop de Cloud API. El lease del outbox
      // garantiza que jamás entregan dos loops a la vez.
      logger.info("[bot] WHATSAPP_PROVIDER=cloud_api — Baileys NO se arranca; entrega por API oficial de Meta");
      startCloudOutboxLoop();
    } else {
      await start();
      watchRestartFlag();
    }
    // Scheduler de confirmaciones COD: corre aunque WhatsApp aún no esté
    // vinculado (los envíos esperan a que haya conexión; el estado es SQLite).
    startOrderScheduler();
    // Polling de estado de envíos. Con SUPPLIER_SYNC_ENABLED=0 (por defecto)
    // no consulta nada: es la red de seguridad de los webhooks de proveedor.
    startTrackingScheduler();
    startReconcileScheduler();
    startCallOrchestrator();
    // Beeping y Meta Ads: sin credenciales/flags, ambos quedan inactivos.
    startBeepingScheduler();
    startMetaAdsScheduler();
    if (whatsappProviderName() !== "cloud_api") {
      logger.info("[bot] esperando QR scan en el dashboard (localhost:3000)...");
    }
  } catch (err) {
    logger.error({ err }, "[bot] error fatal al arrancar");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, "[bot] error no capturado");
  process.exit(1);
});

// Graceful shutdown
//
// Soltar los leases al salir NO es imprescindible (caducan solos), pero
// ahorra al siguiente proceso esperar el TTL entero antes de poder trabajar.
// En un redespliegue eso es la diferencia entre reanudar en segundos o
// quedarse minutos sin mandar confirmaciones.
function soltarLeases(): void {
  for (const n of [LEASE_ORDERS, LEASE_TRACKING, LEASE_RECONCILE, LEASE_CALLS, LEASE_OUTBOX, LEASE_WATCHDOG]) {
    try {
      releaseLease(n);
    } catch {
      // Mejor esfuerzo: si la DB ya está cerrada, el lease caduca solo.
    }
  }
}

process.on("SIGINT", () => {
  logger.info("[bot] SIGINT recibido, cerrando...");
  soltarLeases();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("[bot] SIGTERM recibido, cerrando...");
  soltarLeases();
  process.exit(0);
});
