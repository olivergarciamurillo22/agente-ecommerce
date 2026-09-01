import "./env-loader";

import pino from "pino";
import { startCloudOutboxLoop } from "../src/lib/whatsapp/cloud-outbox";
import { printSafetyStatus } from "../src/lib/safety";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

printSafetyStatus();

log.info("[outbox-only] worker de entrega Cloud API - SIN schedulers, SIN bot");
log.info("[outbox-only] no corre: confirmaciones, tracking, reconcile, llamadas");

startCloudOutboxLoop();

process.on("SIGTERM", () => {
  log.info("[outbox-only] SIGTERM recibido, saliendo");
  process.exit(0);
});
