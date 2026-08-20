import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import path from "node:path";
import fs from "node:fs";
import { setConnectionState, getConnectionState } from "../db";
import { handleIncomingMessages } from "./handler";
import { startOutboxLoop, stopOutboxLoop } from "./outbox";
import { startWatchdog, stopWatchdog } from "../watchdog";

const AUTH_DIR = path.resolve(process.cwd(), "auth");
const DATA_DIR = path.resolve(process.cwd(), "data");
const RESTART_FLAG = path.join(DATA_DIR, ".restart");

let handle: { sock: WASocket; shutdown: () => Promise<void> } | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });
const baileysLogger = pino({ level: "silent" }); // Baileys es ruidoso, lo silenciamos

function scheduleReconnect(code: number | undefined) {
  if (reconnectTimer) return;

  // Code 440 = connectionReplaced. Ocurre justo después del pairing.
  // Si reintentamos muy rápido, entramos en loop. Espera 15s.
  // El resto de errores: 5s es suficiente.
  const delay = code === 440 ? 15000 : 5000;

  logger.info(`[bot] reconectando en ${delay / 1000}s (code=${code ?? "?"})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (handle) {
      // Cleanup explícito del socket viejo antes de reconectar.
      // Sin esto, Baileys puede dejar listeners colgando que se mezclan con la nueva conexión.
      try {
        handle.sock.end(undefined);
      } catch {
        // ignorar
      }
      handle = null;
    }
    void start();
  }, delay);
}

export async function start(): Promise<void> {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // OBLIGATORIO: WhatsApp rechaza versiones desactualizadas con code 405.
  // Baileys hardcodea una versión que queda vieja entre releases.
  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    logger.info(`[bot] usando Baileys version ${version.join(".")}`);
  } catch (err) {
    logger.warn({ err }, "[bot] no se pudo obtener la última versión de Baileys");
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    // OBLIGATORIO: browser fingerprint conocido. Custom dispara code 440 en loop.
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // printQRInTerminal está deprecated en Baileys 6.7+. Manejamos el QR manualmente.
  });

  // Mark current state
  const current = getConnectionState();
  if (current.status === "disconnected") {
    setConnectionState({ status: "connecting" });
  }

  // Eventos
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("[bot] QR generado");
      setConnectionState({ status: "qr", qr_string: qr, phone: null });
      // Fallback: pintar el QR en la terminal en ASCII
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      // Solo degradamos a 'connecting' desde 'disconnected'.
      // NO degradar desde 'qr' (perderíamos el qr_string) ni desde 'connected'.
      const state = getConnectionState();
      if (state.status === "disconnected") {
        setConnectionState({ status: "connecting" });
      }
    }

    if (connection === "open") {
      const userId = sock.user?.id ?? "";
      // Formato típico: "5491155...:N@s.whatsapp.net"
      const phone = userId.split(":")[0].split("@")[0] || null;
      setConnectionState({ status: "connected", qr_string: null, phone });
      logger.info(`[bot] ✓ conectado como ${phone}`);

      // SEGURIDAD: el sistema debe operar con el número DEDICADO de WhatsApp
      // Business de Casamable, nunca con un número personal. Si se escaneó el
      // QR con otro teléfono, avisar bien alto (no bloquea: los safety gates
      // ya impiden envíos accidentales).
      const expected = (process.env.BUSINESS_WHATSAPP_NUMBER ?? "").replace(/\D/g, "");
      if (expected && phone && phone.replace(/\D/g, "") !== expected) {
        logger.warn(
          `[SAFETY] ⚠️ El WhatsApp conectado (${phone}) NO es el número Business configurado ` +
            `(BUSINESS_WHATSAPP_NUMBER=${expected}). ¿Se escaneó el QR con el teléfono equivocado?`
        );
      }

      startOutboxLoop(sock);
      startWatchdog(sock);
    }

    if (connection === "close") {
      // Type-safe extract of status code
      const error = lastDisconnect?.error as unknown;
      const code =
        error && typeof error === "object" && "output" in error
          ? // @ts-expect-error: Boom error structure
            (error.output?.statusCode as number | undefined)
          : undefined;

      stopOutboxLoop();
      stopWatchdog();

      if (code === DisconnectReason.loggedOut) {
        // 401: logout desde el móvil (desvincular el dispositivo, o pasar el
        // número a WhatsApp Business). Las credenciales de auth/ quedan MUERTAS:
        // si las conserváramos, cada arranque intentaría resumir la sesión,
        // recibiría otro 401 y el bot nunca generaría QR (dead-end que obliga a
        // borrar auth/ a mano). Por eso las borramos y reconectamos limpio:
        // start() sin credenciales genera un QR nuevo solo, listo para
        // re-vincular (mismo número o WhatsApp Business), sin tocar nada.
        setConnectionState({
          status: "disconnected",
          qr_string: null,
          phone: null,
        });
        logger.info(
          "[bot] sesión cerrada desde el móvil. Borrando credenciales muertas y regenerando QR..."
        );
        try {
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
        } catch (err) {
          logger.warn({ err }, "[bot] no se pudieron borrar las credenciales muertas");
        }
        scheduleReconnect(undefined);
        return;
      }

      // Cualquier otro código: NO modificar el estado de la DB.
      // Si estamos 'connected', queremos seguir mostrando 'connected' en el dashboard
      // mientras el bot reconecta. Si la reconexión necesita un nuevo QR, el evento 'qr' lo sobreescribirá.
      logger.warn(`[bot] conexión cerrada (code=${code ?? "?"}). Reconectando...`);
      scheduleReconnect(code);
    }
  });

  sock.ev.on("messages.upsert", async (event) => {
    await handleIncomingMessages(sock, event);
  });

  handle = {
    sock,
    shutdown: async () => {
      try {
        sock.end(undefined);
      } catch {
        // ignorar
      }
    },
  };
}

/**
 * Loop opcional para detectar el flag de restart desde el dashboard.
 * Si /api/connection/disconnect crea ./data/.restart, el bot lo detecta,
 * cierra la sesión, borra ./auth/ y arranca limpio (genera QR nuevo).
 */
export function watchRestartFlag(): void {
  setInterval(() => {
    if (fs.existsSync(RESTART_FLAG)) {
      logger.info("[bot] flag de restart detectado");
      try {
        fs.unlinkSync(RESTART_FLAG);
      } catch {
        // ignorar
      }
      void (async () => {
        if (handle) {
          await handle.shutdown();
          handle = null;
        }
        // Defensa: borrar carpeta auth si sigue existiendo (cross-platform)
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        await start();
      })();
    }
  }, 1000);
}
