import Database from "better-sqlite3";
import { normalizePhone } from "./orders/normalize";
import path from "node:path";
import fs from "node:fs";

// DATA_DIR se puede sobreescribir por entorno (los tests usan un directorio
// temporal para no tocar la base de datos real).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "messages.db");

// ============================================================
// Tipos
// ============================================================

export type ConversationMode = "AI" | "HUMAN";
export type MessageRole = "user" | "assistant" | "human";
export type ConnectionStatus = "disconnected" | "qr" | "connecting" | "connected";

export interface Conversation {
  id: number;
  phone: string;
  name: string | null;
  jid: string | null;
  mode: ConversationMode;
  last_message_at: number | null;
  created_at: number;
}

export interface ConversationListItem extends Conversation {
  last_message_preview: string | null;
}

export interface UnansweredConvo {
  id: number;
  phone: string;
  name: string | null;
  last_role: string;
  last_at: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
  created_at: number;
}

export interface ConnectionState {
  id: number;
  status: ConnectionStatus;
  qr_string: string | null;
  phone: string | null;
  updated_at: number;
}

export interface OutboxItem {
  id: number;
  conversation_id: number;
  phone: string;
  content: string;
  type: string; // 'text' | 'image'
  media_path: string | null;
  sent: number;
  /** 1 = envío de un pedido autorizado a mano para el piloto (ver orders.pilot_authorized). */
  authorized: number;
  created_at: number;
  provider: string | null;
  provider_message_id: string | null;
  message_type: string;
  template_name: string | null;
  payload_json: string | null;
  delivered_at: number | null;
  read_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
}

// --- Pedidos COD (confirmación por WhatsApp) ---
//
// Máquina de estados de un pedido:
//   pending_send   → recibido de Shopify, en cola para enviar el WhatsApp inicial
//   awaiting_reply → mensaje inicial enviado, esperando respuesta del cliente
//   reminder_sent  → recordatorio enviado, sigue sin respuesta
//   awaiting_delivery_note → respondió "3": esperando el texto de la nota para
//                    el repartidor (al guardarla vuelve a awaiting_reply)
//   confirmed      → el cliente confirmó (o Pedro lo marcó a mano). Terminal.
//   needs_correction → el cliente quiere corregir la dirección (proposed_address)
//   needs_call     → sin respuesta tras el plazo, o marcado a mano. Pedro llama.
//   cancelled      → descartado manualmente
//   ignored_old    → llegó/estaba demasiado antiguo (MAX_ORDER_AGE_MINUTES):
//                    jamás se actúa sobre él (anti-replay/backfill). Terminal.
//   error          → no se pudo procesar (p.ej. pedido sin teléfono)
export type OrderStatus =
  | "pending_send"
  | "awaiting_reply"
  | "reminder_sent"
  | "awaiting_delivery_note"
  | "confirmed"
  | "needs_correction"
  | "needs_call"
  | "cancelled"
  | "ignored_old"
  | "error";

export const ORDER_STATUSES: OrderStatus[] = [
  "pending_send",
  "awaiting_reply",
  "reminder_sent",
  "awaiting_delivery_note",
  "confirmed",
  "needs_correction",
  "needs_call",
  "cancelled",
  "ignored_old",
  "error",
];

/** Estados en los que el pedido sigue "vivo" esperando algo del cliente. */
export const ORDER_ACTIVE_STATUSES: OrderStatus[] = [
  "awaiting_reply",
  "reminder_sent",
  "awaiting_delivery_note",
  "needs_correction",
];

// --- Eje de CIERRE (E1: espejo de Shopify) ---
//
// Independiente de `status` (la máquina de confirmación por WhatsApp: pending
// → sent → confirmed → needs_call → ...). `status` no se toca aquí: mezclar
// los dos ejes en una sola columna rompería el scheduler, que ya razona sobre
// `status` en todas partes.
//
// Este eje refleja qué ha pasado con el pedido en el mundo real (Shopify o el
// proveedor de fulfillment), para poder sacarlo de las colas operativas y de
// las métricas (E1 solo define el modelo; quién lo lee y actúa es E2+).
//
//   unknown     → no se sabe todavía. Valor de arranque: todo pedido nuevo, y
//                 todo pedido existente al migrar, empieza aquí. NUNCA se
//                 infiere desde datos locales — eso lo hará E3 leyendo Shopify.
//   in_progress → sigue vivo: ni entregado, ni rechazado, ni cancelado.
//   delivered   → entregado. TERMINAL.
//   refused     → rechazado por el cliente o devuelto. TERMINAL.
//   cancelled   → cancelado (en Shopify o a mano). TERMINAL.
export type ClosureStatus = "unknown" | "in_progress" | "delivered" | "refused" | "cancelled";

export const CLOSURE_STATUSES: ClosureStatus[] = [
  "unknown",
  "in_progress",
  "delivered",
  "refused",
  "cancelled",
];

/** Una vez aquí, un pedido no se mueve a un cierre distinto (ver canTransitionClosure). */
export const CLOSURE_TERMINAL_STATUSES: ClosureStatus[] = ["delivered", "refused", "cancelled"];

/** Quién dijo la última palabra sobre el cierre de este pedido.
 *  Precedencia: canTransitionClosure impide que CUALQUIER fuente (incluida
 *  llamada_ia) abandone un terminal ya fijado — Shopify/Dropea escriben
 *  primero y la llamada nunca los pisa. */
export type ClosureSource = "shopify" | "dropea" | "beeping" | "manual" | "llamada_ia";

export const CLOSURE_SOURCES: ClosureSource[] = ["shopify", "dropea", "beeping", "manual", "llamada_ia"];

/**
 * ¿Se puede pasar de `from` a `to` en el eje de cierre?
 *
 * Repetir el mismo valor siempre está permitido (un reintento o un webhook
 * duplicado no debe fallar). Fuera de eso, un estado TERMINAL no se abandona:
 * ningún evento tardío o duplicado puede "reabrir" un pedido ya entregado,
 * rechazado o cancelado. Desde `unknown` o `in_progress` se puede ir a
 * cualquier sitio.
 */
export function canTransitionClosure(from: ClosureStatus, to: ClosureStatus): boolean {
  if (from === to) return true;
  return !CLOSURE_TERMINAL_STATUSES.includes(from);
}

/**
 * Migración E1 (SCHEMA_VERSION 4): añade el eje de cierre a `orders` si no
 * existe todavía. Mismo patrón que las columnas de proveedor: comprobar si
 * la columna existe antes de añadirla (para que correr esto dos veces sea un
 * no-op), envuelto además en try/catch como red de seguridad extra — la DB
 * de producción tiene datos reales y esto tiene que poder ejecutarse
 * repetidas veces sin romper nada, la haya aplicado ya o no.
 *
 * Exportada y parametrizada por la conexión (en vez de vivir inline dentro
 * de `build()`) para poder probarla directamente contra cualquier DB —vacía
 * o con filas de un esquema anterior a E1— sin pasar por el singleton
 * perezoso del módulo.
 */
export function migrateClosureAxis(db: Database.Database): void {
  const closureCols: Array<[string, string]> = [
    ["closure_status", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["closure_source", "TEXT"],
    ["closure_at", "INTEGER"],
  ];
  const currentCols = new Set(
    (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, decl] of closureCols) {
    if (!currentCols.has(name)) {
      try {
        db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${decl}`);
      } catch (err) {
        // No debe pasar (ya comprobamos que no existía), pero si otro proceso
        // la añadió justo entre medias, no es un fallo real: seguimos.
        const mensaje = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(mensaje)) throw err;
      }
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_closure ON orders(closure_status)");
    // Índice compuesto para la métrica de negocio, que es la consulta caliente
    // del panel: "cierres de esta ventana, agrupados por estado". Con solo
    // closure_status, SQLite tenía que recorrer todas las filas de cada
    // estado para filtrar por fecha. Se justifica porque se ejecuta 3 veces
    // (hoy/7d/30d) en cada carga del Control Center.
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_closure_at ON orders(closure_status, closure_at)");
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(mensaje)) throw err;
  }
}

/**
 * Migración (SCHEMA_VERSION 11): resoluciones del Action Center.
 *
 * Cuando Pedro arregla algo a mano (llamó al cliente, gestionó una
 * cancelación, decidió qué duplicado va), tiene que poder marcarlo RESUELTO
 * sin borrar nada: la fila registra quién-qué-cuándo y una nota corta, y el
 * elemento desaparece de la bandeja pero el histórico queda. Una resolución
 * es por (pedido, tipo de acción): resolver el duplicado no resuelve la
 * cancelación del mismo pedido.
 */
export function migrateActionResolutions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_resolutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      note TEXT,
      resolved_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(order_id, action_type)
    );
  `);
}

/**
 * Migración (SCHEMA_VERSION 9): el outbox aprende de PROVEEDOR y de ESTADOS.
 *
 * Con Baileys, "enviado" era todo lo que se podía saber. La Cloud API de
 * Meta devuelve un id de mensaje y luego cuenta por webhook si se entregó,
 * se leyó o falló — cuatro cosas que no son lo mismo y que hasta ahora se
 * confundían en un único `sent`:
 *
 *   encolado  → fila en outbox, sent=0
 *   enviado   → sent=1 (+ provider_message_id si lo hubo)
 *   entregado → delivered_at (webhook `delivered`)
 *   leído     → read_at (webhook `read`)
 *   fallado   → failed_at + failure_reason (webhook `failed` o error de envío)
 *
 * `message_type` y `payload_json` permiten encolar mensajes INTERACTIVOS
 * (botones, listas) manteniendo `content` como texto de fallback: es lo que
 * enseña el panel y lo que sale si el proveedor activo no soporta botones.
 * Aditiva e idempotente, como todas.
 */
export function migrateOutboxProvider(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, decl] of [
    ["provider", "TEXT"],
    ["provider_message_id", "TEXT"],
    ["message_type", "TEXT NOT NULL DEFAULT 'text'"],
    ["template_name", "TEXT"],
    ["payload_json", "TEXT"],
    ["delivered_at", "INTEGER"],
    ["read_at", "INTEGER"],
    ["failed_at", "INTEGER"],
    ["failure_reason", "TEXT"],
  ] as const) {
    if (!cols.has(name)) {
      try {
        db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${decl}`);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(mensaje)) throw err;
      }
    }
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_outbox_pmid ON outbox(provider_message_id) WHERE provider_message_id IS NOT NULL"
    );
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(mensaje)) throw err;
  }
}

/**
 * Migración (SCHEMA_VERSION 8): contexto de conversación multi-pedido.
 *
 * Nace de un bug REAL de producción (25-08-2026): un cliente con dos pedidos
 * escribió "1097" para elegir uno y el bot contestó "Responde 1, 2 o 3";
 * después escribió "Todo correcto" y el bot volvió a enseñar el selector.
 * El flujo no tenía MEMORIA: cada mensaje re-resolvía la ambigüedad desde
 * cero contra getActiveOrdersByPhone(), así que elegir un pedido no servía
 * de nada en el mensaje siguiente.
 *
 * La tabla guarda, POR TELÉFONO: qué pedido está seleccionado (con su fecha,
 * para caducarlo), qué tipo de mensaje mandamos por última vez y cuántas
 * veces seguidas (anti-bucle: el mismo selector no se repite eternamente), y
 * si hay una cancelación pendiente de confirmar.
 *
 * En `orders`, dos columnas de señal para Pedro:
 *   - possible_duplicate: pedidos que parecen el mismo (mismo teléfono,
 *     producto, importe y dirección en una ventana corta). NUNCA se cancela
 *     nada automáticamente: solo se marca para que lo vea un humano.
 *   - cancellation_requested_at: el cliente pidió cancelar. Tampoco se toca
 *     Shopify: el pedido pasa a needs_call y lo decide Pedro.
 *
 * Aditiva e idempotente, como todas.
 */
export function migrateConversationOrderContext(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_order_context (
      phone TEXT PRIMARY KEY,
      selected_order_id INTEGER,
      selected_at INTEGER,
      last_prompt_type TEXT,
      same_prompt_count INTEGER NOT NULL DEFAULT 0,
      pending_cancel_order_id INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  const cols = new Set(
    (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, decl] of [
    ["possible_duplicate", "INTEGER NOT NULL DEFAULT 0"],
    ["cancellation_requested_at", "INTEGER"],
  ] as const) {
    if (!cols.has(name)) {
      try {
        db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${decl}`);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(mensaje)) throw err;
      }
    }
  }
}

/**
 * Migración (SCHEMA_VERSION 7): LEASES de schedulers.
 *
 * Los cinco schedulers (confirmaciones, tracking, reconciliación, llamadas,
 * outbox) se protegían con `if (timer) return` + un flag `ticking`. Eso es
 * una guarda EN MEMORIA: sirve dentro de un proceso y no sirve para nada si
 * arrancan dos. Hoy solo el bot los arranca y hay un contenedor, así que no
 * duplican — pero eso es una propiedad del despliegue, no del código: un
 * segundo contenedor, o un reinicio solapado con el anterior aún drenando,
 * duplicaría efectos externos (WhatsApp, llamadas).
 *
 * El lease vive en SQLite porque SQLite ya es el punto de sincronización de
 * todo el sistema: no hace falta Redis ni infraestructura nueva.
 *
 * Aditiva e idempotente. La tabla nace vacía: sin lease, nadie ejecuta hasta
 * que alguien lo adquiera, que es el comportamiento correcto.
 */
export function migrateSchedulerLeases(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_leases (
      name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      -- Epoch segundos hasta cuando este dueño tiene derecho a ejecutar.
      -- Pasado ese instante, cualquiera puede robarlo: es lo que hace que un
      -- proceso muerto no bloquee el sistema para siempre.
      lease_until INTEGER NOT NULL,
      last_acquired_at INTEGER,
      last_released_at INTEGER,
      heartbeat_at INTEGER,
      acquire_count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Migración (SCHEMA_VERSION 6): `status_axis` en `order_status_history`.
 *
 * La tabla mezclaba transiciones de ejes distintos en las mismas columnas
 * (`previous_status` / `new_status`), así que un `delivered` del eje
 * LOGÍSTICO y un `delivered` del eje de CIERRE eran indistinguibles al
 * leerla. Con cuatro máquinas de estado declaradas (ver
 * docs/MODELO-ESTADOS.md) eso es una ambigüedad que sí importa.
 *
 * Aditiva e idempotente, y con BACKFILL NEUTRO: las filas existentes reciben
 * `'tracking'` porque hasta hoy el ÚNICO escritor de esta tabla era
 * `processSupplierUpdate` (el eje logístico) — no es inferencia, es el hecho
 * comprobable de que no había otro. El DEFAULT también es `'tracking'` para
 * que cualquier inserción antigua que no pase el campo siga siendo correcta.
 *
 * Parametrizada por conexión, igual que las anteriores.
 */
export function migrateStatusAxis(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(order_status_history)").all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );
  if (!cols.has("status_axis")) {
    try {
      db.exec(
        "ALTER TABLE order_status_history ADD COLUMN status_axis TEXT NOT NULL DEFAULT 'tracking'"
      );
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(mensaje)) throw err;
    }
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_osh_axis ON order_status_history(status_axis, occurred_at)"
    );
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(mensaje)) throw err;
  }
}

/**
 * Migración E7 (SCHEMA_VERSION 5): orquestador de llamadas de confirmación.
 * Aditiva e idempotente (CREATE TABLE IF NOT EXISTS + ADD COLUMN comprobado).
 * Parametrizada por conexión, igual que migrateClosureAxis.
 */
export function migrateCallOrchestrator(db: Database.Database): void {
  db.exec(`
    -- Un intento de llamada = una fila. NUNCA en JSON dentro de orders.
    -- state:
    --   planned   → en cola, con su scheduled_at
    --   reserved  → un worker lo reclamó (transitorio, dentro de un tick)
    --   dialing   → vamos a llamar YA: se persiste ANTES de tocar al
    --               proveedor. Si el proceso muere aquí, la fila queda en
    --               dialing y JAMÁS se re-marca sola (→ manual_review).
    --   in_flight → el proveedor aceptó (tenemos provider_call_id)
    --   completed → terminó, con result
    --   cancelled → descartado antes de marcar (inelegible, DNC, etc.)
    --   manual_review → necesita un humano (reason dice por qué)
    CREATE TABLE IF NOT EXISTS call_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      contact_number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'planned'
        CHECK(state IN ('planned','reserved','dialing','in_flight','completed','cancelled','manual_review')),
      scheduled_at INTEGER NOT NULL,
      shadow_logged_at INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      provider_call_id TEXT,
      provider_status TEXT,
      result TEXT,
      retry_consumed INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Idempotencia dura: (a) un provider_call_id solo puede existir una vez;
    -- (b) un pedido solo puede tener UN intento vivo a la vez.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_provider_id
      ON call_attempts(provider_call_id) WHERE provider_call_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_call_one_active
      ON call_attempts(order_id) WHERE state IN ('planned','reserved','dialing','in_flight');
    CREATE INDEX IF NOT EXISTS idx_call_due ON call_attempts(state, scheduled_at);

    -- "No volver a llamar": por TELÉFONO normalizado, global, no por pedido.
    CREATE TABLE IF NOT EXISTS call_dnc (
      phone TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      reason TEXT,
      order_id INTEGER,
      provider_call_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- INBOX de eventos del proveedor de voz: el webhook solo guarda y
    -- responde 200; el worker procesa después. Dedupe por dedupe_key.
    CREATE TABLE IF NOT EXISTS call_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      provider_call_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_at INTEGER,
      received_at INTEGER NOT NULL DEFAULT (unixepoch()),
      payload_json TEXT,
      processed_at INTEGER,
      processing_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_call_events_pending
      ON call_events(processed_at, received_at);

    -- Auditoría de correcciones de datos dictadas por una llamada.
    CREATE TABLE IF NOT EXISTS order_data_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      source TEXT NOT NULL,
      provider_call_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_audit_order ON order_data_audit(order_id);
  `);
}

/**
 * Migración T1 (SCHEMA_VERSION 10): separa `ordered_at` (fecha REAL de compra
 * en Shopify) de `created_at` (que en realidad es `imported_at` — el instante
 * en que la fila se insertó, ya sea por el webhook o por un backfill). Antes
 * de esto no había forma de distinguir "el cliente compró hoy" de "hoy se
 * importó un pedido de hace tres semanas", y eso rompía tanto el orden del
 * panel como el criterio de antigüedad.
 *
 * Aditiva y opcional a propósito: NULL para todas las filas existentes hasta
 * que algo la rellene (el webhook y el backfill de Shopify la rellenan desde
 * ya; las filas históricas las rellena `scripts/backfill-ordered-at.ts`,
 * aparte). Mismo patrón que migrateClosureAxis: comprobar con
 * PRAGMA table_info antes de añadir, envuelto en try/catch por si otro
 * proceso la añadió justo entre medias.
 */
export function migrateOrderedAt(db: Database.Database): void {
  const currentCols = new Set(
    (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!currentCols.has("ordered_at")) {
    try {
      db.exec("ALTER TABLE orders ADD COLUMN ordered_at INTEGER");
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(mensaje)) throw err;
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON orders(ordered_at DESC)");
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(mensaje)) throw err;
  }
}

/**
 * Migración (SCHEMA_VERSION 11): idempotencia de los envíos masivos de aviso
 * (el batch de retraso de reposición "Ultras"/"gafa"). Un pedido, una fila:
 * relanzar el script no reenvía a quien ya recibió. `order_id UNIQUE` es la
 * clave de idempotencia; un intento bloqueado por los safety gates también
 * deja fila (`status != 'sent'`) para que el informe lo explique, y SÍ se
 * reintenta en el siguiente lanzamiento (UPSERT en recordNotifyDelaySend).
 */
export function migrateNotifyDelaySends(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_delay_sends (
      order_id INTEGER PRIMARY KEY,
      batch_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

/**
 * Migración (SCHEMA_VERSION 12): eje Beeping en `orders` + nota de expedición.
 *
 * Beeping NO es otro Dropea: los pedidos los crea su app de Shopify (no
 * nosotros) y quedan retenidos en "To be confirmed" hasta que Casamable los
 * LIBERA con mark-to-send. Ese acto de liberar es un estado propio, distinto
 * de la confirmación del cliente (orders.status='confirmed') y distinto del
 * eje logístico (supplier_*). De ahí columnas propias:
 *
 *   beeping_sync_status  → not_released | releasing | released |
 *                          release_failed | release_unknown
 *                          (release_unknown = timeout ambiguo: NUNCA se
 *                          reintenta a ciegas, primero se consulta Beeping)
 *   beeping_order_status → el `status` crudo de Beeping (0-6), sin traducir.
 *   beeping_external_id  → external_id con el que Beeping conoce el pedido.
 *   beeping_released_at  → cuándo se llamó mark-to-send con éxito.
 *   beeping_last_sync_at → última vez que la reconciliación vio este pedido.
 *   beeping_last_error   → último error de release/sync, legible.
 *   dispatch_note        → nota INTERNA de expedición de Pedro. La API
 *                          pública de Beeping NO documenta campo de notas:
 *                          hasta tener contrato, esto no viaja a ningún lado.
 *
 * Sin CHECK SQL (como el resto de columnas añadidas por ALTER): la
 * validación vive en TypeScript (src/lib/beeping/).
 */
export function migrateBeepingAxis(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, decl] of [
    ["beeping_sync_status", "TEXT NOT NULL DEFAULT 'not_released'"],
    ["beeping_order_status", "INTEGER"],
    ["beeping_external_id", "TEXT"],
    ["beeping_released_at", "INTEGER"],
    ["beeping_last_sync_at", "INTEGER"],
    ["beeping_last_error", "TEXT"],
    ["dispatch_note", "TEXT"],
  ] as const) {
    if (!cols.has(name)) {
      try {
        db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${decl}`);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(mensaje)) throw err;
      }
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_beeping_sync ON orders(beeping_sync_status)");
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(mensaje)) throw err;
  }
}

/**
 * Migración (SCHEMA_VERSION 13): snapshots diarios de Meta Ads (READ-ONLY).
 *
 * Insights de la Marketing API persistidos por (día, nivel, entidad) para
 * que Finanzas y Anuncios no dependan de que Meta responda en cada carga
 * del panel — y para conservar historia aunque Meta recorte la ventana.
 * `actions_json` guarda el array `actions` crudo: las métricas de compra
 * se derivarán cuando se verifique su fiabilidad con la cuenta real,
 * sin necesidad de re-pedir datos.
 */
export function migrateMetaAdsDaily(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_ads_daily (
      day TEXT NOT NULL,
      level TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      spend REAL,
      impressions INTEGER,
      reach INTEGER,
      clicks INTEGER,
      ctr REAL,
      cpc REAL,
      cpm REAL,
      actions_json TEXT,
      currency TEXT,
      synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (day, level, entity_id)
    );
  `);
}

/**
 * Migración (SCHEMA_VERSION 14): histórico de costes por producto.
 *
 * `product_costs` es la foto VIGENTE (la consumen las pantallas y la
 * economía de ventanas cortas). Para P&L por periodos hace falta saber qué
 * coste regía CUANDO se envió cada pedido: cada cambio de coste cierra la
 * fila vigente (effective_to) y abre una nueva. NUNCA se sobrescribe una
 * fila histórica.
 *
 * Backfill neutro: la fila vigente de product_costs se copia UNA vez con
 * effective_from = su updated_at real (dato de la fuente, no inventado).
 * También se añade handling_cost a product_costs (coste de manipulación
 * del fulfillment, p.ej. 1,70 € de Beeping), NULL para las filas viejas.
 */
export function migrateProductCostHistory(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(product_costs)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!cols.has("handling_cost")) {
    try {
      db.exec("ALTER TABLE product_costs ADD COLUMN handling_cost REAL");
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(mensaje)) throw err;
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_cost_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      title TEXT,
      product_cost REAL,
      shipping_cost REAL,
      cod_fee REAL,
      handling_cost REAL,
      effective_from INTEGER NOT NULL,
      effective_to INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_pch_sku ON product_cost_history(sku, effective_from);
  `);
  // Copia inicial de lo vigente, solo para SKUs sin historia todavía.
  db.exec(`
    INSERT INTO product_cost_history (sku, title, product_cost, shipping_cost, cod_fee, handling_cost, effective_from, effective_to)
    SELECT pc.sku, pc.title, pc.product_cost, pc.shipping_cost, pc.cod_fee, pc.handling_cost, pc.updated_at, NULL
    FROM product_costs pc
    WHERE NOT EXISTS (SELECT 1 FROM product_cost_history h WHERE h.sku = pc.sku)
  `);
}

/**
 * Migración (SCHEMA_VERSION 15): escenarios guardados de la Calculadora COD.
 * Un escenario = un juego de supuestos con nombre ("PELUCHE CPA 6€",
 * "Escala septiembre"). Guardar un escenario NUNCA toca datos reales
 * (product_costs, settings, Shopify, Meta): es solo simulación.
 */
export function migrateCodScenarios(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cod_scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      product_sku TEXT,
      model_type TEXT NOT NULL DEFAULT 'real',
      assumptions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

/**
 * Migración (SCHEMA_VERSION 16): qué agente y VERSIÓN de Retell atendió
 * cada llamada. El incidente "[password 1]" (02-09) salió de una edición
 * del dashboard que cambió las llamadas reales sin que nadie lo pidiera:
 * desde ahora la versión se fija por env (RETELL_AGENT_VERSION) y cada
 * intento persiste la que Retell usó de verdad — auditable en salud.
 */
export function migrateCallAgentVersion(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(call_attempts)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, decl] of [
    ["agent_id", "TEXT"],
    ["agent_version", "TEXT"],
  ] as const) {
    if (!cols.has(name)) {
      try {
        db.exec(`ALTER TABLE call_attempts ADD COLUMN ${name} ${decl}`);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(mensaje)) throw err;
      }
    }
  }
}

/**
 * Migración (SCHEMA_VERSION 17): atribución de marketing del pedido.
 *
 * Lo que Shopify sabe del ORIGEN (landing_site con sus UTM, referrer,
 * canal) capturado al CREAR el pedido — el dato que no se captura hoy no
 * se recupera mañana. Columnas de INTERPRETACIÓN: el crudo completo ya
 * vive en orders.raw_payload (política existente), así que esto siempre
 * se puede reinterpretar. NULL = el payload no lo traía; jamás se inventa.
 */
export function migrateOrderAttribution(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const name of [
    "marketing_source",
    "marketing_medium",
    "marketing_campaign",
    "marketing_content",
    "marketing_term",
    "marketing_fbclid",
    "landing_site",
    "referring_site",
    "shopify_source_name",
  ] as const) {
    if (!cols.has(name)) {
      try {
        db.exec(`ALTER TABLE orders ADD COLUMN ${name} TEXT`);
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(mensaje)) throw err;
      }
    }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_mkt_campaign ON orders(marketing_campaign) WHERE marketing_campaign IS NOT NULL");
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(mensaje)) throw err;
  }
}

export interface OrderRow {
  id: number;
  shopify_order_id: string;
  shopify_order_number: string;
  customer_name: string | null;
  phone: string; // dígitos internacionales normalizados ('' si el pedido no traía teléfono)
  email: string | null;
  product_summary: string;
  total_price: string;
  currency: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  status: OrderStatus;
  proposed_address: string | null;
  delivery_note: string | null;
  /** Nota/campos del formulario del pedido (p.ej. "¿A qué hora estarás en casa?"). */
  customer_note: string | null;
  /**
   * Autorización manual de piloto (TEST_MODE): 1 = este pedido CONCRETO puede
   * recibir mensajes y tag aunque su teléfono no esté en TEST_PHONE_ALLOWLIST.
   * Es por pedido, nunca por teléfono ni por cliente.
   */
  pilot_authorized: number;
  /**
   * Si el pedido llegó fuera de la ventana horaria, momento estimado de la
   * próxima apertura. Además de documentar la espera, es la base desde la que
   * se mide la antigüedad: esperar a propósito NUNCA lo convierte en ignored_old.
   */
  deferred_until: number | null;

  // --- Proveedor (Dropi / Dropea) — fase 2, hoy solo simulación ---
  /** Dirección elegida para el proveedor: 'original' | 'proposed' | null (sin decidir). */
  final_address_source: string | null;
  /** Plataforma resuelta por el router: 'dropi' | 'dropea' | 'manual' | 'unknown' | null. */
  supplier_platform: string | null;
  /** Estado de sincronización. Ver SUPPLIER_SYNC_STATUSES en suppliers/types.ts. */
  supplier_sync_status: string;
  /** Id del pedido en el proveedor. Su presencia BLOQUEA recrearlo (idempotencia). */
  supplier_external_order_id: string | null;
  possible_duplicate: number;
  cancellation_requested_at: number | null;
  /** Referencia estable que enviamos al proveedor (nuestro shopify_order_id). */
  supplier_reference: string | null;
  supplier_sync_attempts: number;
  supplier_last_error: string | null;
  supplier_synced_at: number | null;
  supplier_last_checked_at: number | null;
  /** Estado del envío según el proveedor (texto suyo, sin normalizar todavía). */
  supplier_status: string | null;
  /** Estado tal cual lo devuelve el proveedor, sin interpretar. */
  supplier_status_raw: string | null;
  /** Ese estado normalizado a nuestra máquina (ver TrackingStatus). */
  supplier_status_normalized: string;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  tracking_first_seen_at: number | null;
  tracking_last_checked_at: number | null;
  /** Sellos de aviso enviado: su presencia impide repetir el WhatsApp. */
  tracking_notification_sent_at: number | null;
  out_for_delivery_notification_sent_at: number | null;
  delivered_notification_sent_at: number | null;
  delivery_attempt_notification_sent_at: number | null;
  pickup_point_notification_sent_at: number | null;
  /** Nombre/dirección/enlace del punto de recogida que reporta el proveedor. */
  pickup_point_info: string | null;
  /** Autorización manual, pedido a pedido, para el piloto de proveedores. */
  supplier_pilot_approved: number;
  /** Fase de creación: none | creating | created | confirming | confirmed | failed. */
  supplier_create_phase: string;
  /** Claves de idempotencia ya usadas (nunca se regeneran en un reintento). */
  supplier_idempotency_key: string | null;
  supplier_confirm_idempotency_key: string | null;
  /** not_present | unsupported | manually_handled | sent */
  supplier_delivery_note_status: string;

  last_error: string | null;
  clarify_count: number;
  shopify_tagged: number;
  whatsapp_sent_at: number | null;
  reminder_sent_at: number | null;
  customer_replied_at: number | null;
  confirmed_at: number | null;
  needs_call_at: number | null;
  raw_payload: string | null;
  created_at: number;
  updated_at: number;
  /** Fecha REAL de compra en Shopify (epoch, segundos). `null` = sin resolver
   *  todavía (fila anterior a T1 aún no pasada por el backfill de la columna,
   *  o el payload nunca trajo `created_at`). NUNCA confundir con `created_at`
   *  de arriba, que es cuándo se insertó la FILA (import), no la compra. */
  ordered_at: number | null;

  // --- Eje de cierre (E1) — ver ClosureStatus más arriba ---
  closure_status: ClosureStatus;
  closure_source: ClosureSource | null;
  closure_at: number | null;

  // --- Eje Beeping (v12) — ver migrateBeepingAxis y src/lib/beeping/ ---
  /** not_released | releasing | released | release_failed | release_unknown */
  beeping_sync_status: string;
  /** `status` crudo de Beeping (0-6). null = la sync nunca lo ha visto. */
  beeping_order_status: number | null;
  /** external_id con el que Beeping conoce el pedido (= id de Shopify). */
  beeping_external_id: string | null;
  beeping_released_at: number | null;
  beeping_last_sync_at: number | null;
  beeping_last_error: string | null;
  /** Nota INTERNA de expedición. NO viaja a Beeping (sin contrato de notas). */
  dispatch_note: string | null;

  // --- Atribución de marketing (v17) — NULL = el payload no lo traía ---
  marketing_source: string | null;
  marketing_medium: string | null;
  marketing_campaign: string | null;
  marketing_content: string | null;
  marketing_term: string | null;
  marketing_fbclid: string | null;
  landing_site: string | null;
  referring_site: string | null;
  shopify_source_name: string | null;
}

export interface NewOrderInput {
  shopify_order_id: string;
  shopify_order_number: string;
  customer_name: string | null;
  phone: string;
  email: string | null;
  product_summary: string;
  total_price: string;
  currency: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  status: OrderStatus;
  customer_note?: string | null;
  last_error?: string | null;
  raw_payload?: string | null;
  /** Fecha real de compra en Shopify (epoch, segundos). `null`/ausente si el
   *  payload no la traía — nunca se inventa. */
  ordered_at?: number | null;
  /** Atribución de marketing (v17). Ausente = todo NULL. */
  attribution?: Partial<{
    source: string | null;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
    fbclid: string | null;
    landingSite: string | null;
    referringSite: string | null;
    sourceName: string | null;
  }> | null;
}

// Columnas de `orders` — ÚNICA fuente de verdad del esquema: la usan el CREATE
// inicial y la migración de reconstrucción (ver build()). Si añades una columna
// o un estado, tócalo SOLO aquí y actualiza la lista de la migración.
const ORDERS_TABLE_BODY = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id TEXT UNIQUE NOT NULL,
      shopify_order_number TEXT NOT NULL,
      customer_name TEXT,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT,
      product_summary TEXT NOT NULL DEFAULT '',
      total_price TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'EUR',
      address_line1 TEXT,
      address_line2 TEXT,
      city TEXT,
      province TEXT,
      postal_code TEXT,
      country TEXT,
      status TEXT NOT NULL DEFAULT 'pending_send' CHECK(status IN (
        'pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note',
        'confirmed','needs_correction','needs_call','cancelled','ignored_old','error'
      )),
      proposed_address TEXT,
      delivery_note TEXT,
      customer_note TEXT,
      pilot_authorized INTEGER NOT NULL DEFAULT 0,
      deferred_until INTEGER,
      -- Qué dirección se usará con el proveedor: 'original' | 'proposed'.
      -- NULL = sin decidir (si hay proposed_address, queda a revisión humana).
      final_address_source TEXT,
      -- Sincronización con el proveedor (Dropi/Dropea). Ver SupplierSyncStatus.
      supplier_platform TEXT,
      supplier_sync_status TEXT NOT NULL DEFAULT 'not_ready',
      supplier_external_order_id TEXT,
      supplier_reference TEXT,
      supplier_sync_attempts INTEGER NOT NULL DEFAULT 0,
      supplier_last_error TEXT,
      supplier_synced_at INTEGER,
      supplier_last_checked_at INTEGER,
      supplier_status TEXT,
      supplier_status_raw TEXT,
      supplier_status_normalized TEXT NOT NULL DEFAULT 'unknown',
      tracking_number TEXT,
      tracking_url TEXT,
      carrier TEXT,
      tracking_first_seen_at INTEGER,
      tracking_last_checked_at INTEGER,
      tracking_notification_sent_at INTEGER,
      out_for_delivery_notification_sent_at INTEGER,
      delivered_notification_sent_at INTEGER,
      delivery_attempt_notification_sent_at INTEGER,
      pickup_point_notification_sent_at INTEGER,
      pickup_point_info TEXT,
      supplier_pilot_approved INTEGER NOT NULL DEFAULT 0,
      supplier_create_phase TEXT NOT NULL DEFAULT 'none',
      supplier_idempotency_key TEXT,
      supplier_confirm_idempotency_key TEXT,
      supplier_delivery_note_status TEXT NOT NULL DEFAULT 'not_present',
      last_error TEXT,
      clarify_count INTEGER NOT NULL DEFAULT 0,
      shopify_tagged INTEGER NOT NULL DEFAULT 0,
      whatsapp_sent_at INTEGER,
      reminder_sent_at INTEGER,
      customer_replied_at INTEGER,
      confirmed_at INTEGER,
      needs_call_at INTEGER,
      raw_payload TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      -- Fecha REAL de compra en Shopify (T1). NULL = sin resolver. Distinta
      -- de created_at de arriba, que es cuándo se insertó la fila (import).
      ordered_at INTEGER,
      -- Eje de cierre (E1): independiente de status. Ver ClosureStatus.
      -- Arranca en 'unknown' siempre -- nunca se infiere, ni al crear ni al migrar.
      closure_status TEXT NOT NULL DEFAULT 'unknown',
      closure_source TEXT,
      closure_at INTEGER
`;

// ============================================================
// Inicialización PEREZOSA (lazy) de la base de datos.
//
// La conexión, el esquema y los statements NO se crean al importar este módulo,
// sino la primera vez que se usa de verdad (primera llamada a una función).
//
// Esto es CLAVE: `next build` importa las rutas API (que importan este módulo)
// en ~10 workers en paralelo. Si abriéramos y escribiéramos la DB al importar,
// esos workers chocarían inicializando el WAL del mismo archivo a la vez y el
// build fallaría con "database is locked" (SQLITE_BUSY) — un fallo no determinista
// que el `busy_timeout` no cubre del todo. Con init perezoso, importar el módulo
// NO toca la DB: solo la tocan el bot y el servidor cuando atienden de verdad.
// (ver docs/archive/kit/errores-sesion.md #15)
// ============================================================

function build() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // PRAGMA WAL: permite que bot y dashboard lean/escriban el mismo archivo a la vez.
  db.pragma("journal_mode = WAL");
  // busy_timeout: red de seguridad en runtime. Si bot y dashboard coinciden
  // escribiendo, esperar hasta 5s a que se libere el lock en vez de fallar al
  // instante con SQLITE_BUSY. (El problema del build se resuelve con el init perezoso.)
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      jid TEXT,
      mode TEXT CHECK(mode IN ('AI','HUMAN')) NOT NULL DEFAULT 'AI',
      last_message_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT CHECK(role IN ('user','assistant','human')) NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, created_at);
    -- Retención: el barrido es "todos los mensajes anteriores a X", sin
    -- conversación. Sin este índice recorría la tabla entera, que es
    -- precisamente la que más crece.
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS connection_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT CHECK(status IN ('disconnected','qr','connecting','connected'))
        NOT NULL DEFAULT 'disconnected',
      qr_string TEXT,
      phone TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT OR IGNORE INTO connection_state (id, status) VALUES (1, 'disconnected');

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      content TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON outbox(sent, created_at);

    -- Métricas: consumo de tokens/coste por llamada al LLM
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      model TEXT,
      in_tokens INTEGER NOT NULL DEFAULT 0,
      out_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);

    -- Métricas: eventos de tools (para leads y embudo)
    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      tool TEXT NOT NULL,
      has_email INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_toolev_time ON tool_events(created_at);

    -- Métricas: caché de análisis con IA (dudas frecuentes) por periodo
    CREATE TABLE IF NOT EXISTS insights (
      period_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Ajustes editables en caliente desde el dashboard (modelo, pausa, buffer...)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Pedidos COD de Shopify pendientes de confirmar por WhatsApp.
    -- Fuente de verdad del MVP (Casamable). Idempotencia por shopify_order_id.
    CREATE TABLE IF NOT EXISTS orders (${ORDERS_TABLE_BODY});
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone, created_at DESC);

    -- Correspondencia explícita producto nuestro ↔ producto del proveedor.
    -- Sustituye al emparejado por texto: el routing de producción no puede
    -- depender de que un título contenga cierta palabra.
    CREATE TABLE IF NOT EXISTS supplier_product_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_platform TEXT NOT NULL,
      shopify_product_id TEXT,
      shopify_variant_id TEXT,
      shopify_sku TEXT,
      shopify_title TEXT,
      supplier_product_id TEXT,
      -- Para Dropea es el dato CRÍTICO: variant_id de su catálogo.
      supplier_variant_id TEXT NOT NULL,
      supplier_unit_price REAL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_mapping_sku
      ON supplier_product_mapping(supplier_platform, shopify_sku);
    CREATE INDEX IF NOT EXISTS idx_mapping_title
      ON supplier_product_mapping(supplier_platform, shopify_title);

    -- Eventos de webhook ya procesados: deduplicación por event_id, que es
    -- lo que exige el contrato de Dropea ("store it for idempotent processing").
    CREATE TABLE IF NOT EXISTS supplier_webhook_events (
      event_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      topic TEXT,
      resource_id TEXT,
      received_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_time
      ON supplier_webhook_events(received_at);

    -- ====== Observabilidad (Control Center) ======
    -- Una fila por servicio vigilado (whatsapp, shopify, dropea…), upsert.
    -- Sin secretos ni PII: metadata_json pasa por el sanitizador antes de entrar.
    CREATE TABLE IF NOT EXISTS service_health (
      service TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('healthy','warning','critical','disabled','unknown')),
      last_success_at INTEGER,
      last_error_at INTEGER,
      last_error_message TEXT,
      last_checked_at INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata_json TEXT
    );

    -- Ejecuciones de schedulers. Los ticks sin trabajo NO se guardan (el
    -- outbox corre cada 2s y llenaría la tabla); su latido va a service_health.
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduler_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('ok','error')),
      processed_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_runs
      ON scheduler_runs(scheduler_name, started_at);

    -- Feed técnico de eventos. message SIEMPRE sanitizado (sin teléfonos,
    -- direcciones, tokens ni payloads); la referencia al pedido es el número.
    CREATE TABLE IF NOT EXISTS integration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
      order_ref TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_integration_events
      ON integration_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_integration_events_sev
      ON integration_events(severity, created_at);

    -- ====== Fase A · Histórico de estados de envío ======
    -- Una fila por TRANSICIÓN REAL del estado normalizado de un envío.
    -- Es la fuente de la tasa de entrega: nunca se estima, se cuenta aquí.
    -- Dedupe: por event_id cuando el proveedor lo manda (índice único parcial)
    -- y, sin event_id, por (pedido, de, a, raw) dentro de la misma ventana.
    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      shopify_order_id TEXT NOT NULL,
      supplier_platform TEXT,
      carrier TEXT,
      previous_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      raw_status TEXT,
      raw_sub_status TEXT,
      source TEXT NOT NULL CHECK(source IN ('webhook','polling','manual','reconciliation')),
      -- Qué EJE cambió. Sin esto, un 'delivered' logístico y un 'delivered'
      -- de cierre son indistinguibles al leer la tabla. Ver StatusAxis.
      status_axis TEXT NOT NULL DEFAULT 'tracking'
        CHECK(status_axis IN ('confirmation','supplier_sync','tracking','closure')),
      event_id TEXT,
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_osh_event_id
      ON order_status_history(event_id) WHERE event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_osh_status ON order_status_history(new_status, occurred_at);

    -- ====== Fase A · Unit economics (entrada manual, sin inventar) ======
    -- Coste por SKU. Si un SKU no está aquí, la economía sale "incompleta".
    CREATE TABLE IF NOT EXISTS product_costs (
      sku TEXT PRIMARY KEY,
      title TEXT,
      product_cost REAL,
      shipping_cost REAL,
      cod_fee REAL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Gasto en publicidad por día (YYYY-MM-DD). Manual hasta que exista fuente.
    CREATE TABLE IF NOT EXISTS daily_ad_spend (
      day TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Versión de esquema: hasta ahora no se estampaba (user_version=0). Las
  // migraciones siguen siendo idempotentes por sí mismas; esto solo da un
  // número legible en el Control Center. Subir en 1 con cada cambio de schema.
  if ((db.pragma("user_version", { simple: true }) as number) < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // Migración: columna `jid` en conversations. Guarda la dirección completa del contacto
  // (p.ej. <numero>@s.whatsapp.net o <lid>@lid) para poder responderle por el dominio correcto.
  // En DBs creadas con versiones anteriores la tabla ya existe sin esta columna; la añadimos si falta.
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "jid")) {
    db.exec("ALTER TABLE conversations ADD COLUMN jid TEXT");
  }

  const obCols = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!obCols.some((c) => c.name === "type")) {
    db.exec("ALTER TABLE outbox ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
  }
  if (!obCols.some((c) => c.name === "media_path")) {
    db.exec("ALTER TABLE outbox ADD COLUMN media_path TEXT");
  }

  // Migración fase 2 (Casamable): la tabla orders de la fase 1 no tenía la
  // columna delivery_note ni el estado awaiting_delivery_note (su CHECK viejo
  // lo rechazaría). SQLite no permite alterar un CHECK, así que reconstruimos
  // la tabla CONSERVANDO todas las filas (no destructivo) y reindexamos.
  const ordersDef = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'")
    .get() as { sql: string } | undefined;
  if (
    ordersDef &&
    (!ordersDef.sql.includes("awaiting_delivery_note") || !ordersDef.sql.includes("ignored_old"))
  ) {
    const COLS =
      "id, shopify_order_id, shopify_order_number, customer_name, phone, email, " +
      "product_summary, total_price, currency, address_line1, address_line2, city, " +
      "province, postal_code, country, status, proposed_address, last_error, " +
      "clarify_count, shopify_tagged, whatsapp_sent_at, reminder_sent_at, " +
      "customer_replied_at, confirmed_at, needs_call_at, raw_payload, created_at, updated_at";
    db.exec(`
      BEGIN;
      ALTER TABLE orders RENAME TO orders_old;
      CREATE TABLE orders (${ORDERS_TABLE_BODY});
      INSERT INTO orders (${COLS}) SELECT ${COLS} FROM orders_old;
      DROP TABLE orders_old;
      COMMIT;
    `);
    // Los índices viejos se fueron con orders_old: recrearlos sobre la nueva.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone, created_at DESC);
    `);
  }

  // Migración pre-piloto: columnas nuevas de `orders` y `outbox`. No tocan
  // ningún CHECK, así que bastan ALTER TABLE (no destructivo).
  const orderCols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
  if (!orderCols.some((c) => c.name === "pilot_authorized")) {
    db.exec("ALTER TABLE orders ADD COLUMN pilot_authorized INTEGER NOT NULL DEFAULT 0");
  }
  if (!orderCols.some((c) => c.name === "deferred_until")) {
    db.exec("ALTER TABLE orders ADD COLUMN deferred_until INTEGER");
  }
  if (!obCols.some((c) => c.name === "authorized")) {
    // Marca del envío: 1 = pertenece a un pedido autorizado a mano para el
    // piloto. El loop del outbox la usa al revalidar los safety gates.
    db.exec("ALTER TABLE outbox ADD COLUMN authorized INTEGER NOT NULL DEFAULT 0");
  }
  if (!obCols.some((c) => c.name === "sent_at")) {
    // Cuándo se envió de verdad (created_at solo dice cuándo se encoló).
    // Lo usa el Control Center para "último envío" y "enviados recientes".
    db.exec("ALTER TABLE outbox ADD COLUMN sent_at INTEGER");
  }

  // Migración fase 2 (proveedores Dropi/Dropea). Columnas nuevas sin CHECK,
  // así que basta ALTER TABLE: no destructivo y sin reconstruir la tabla.
  // Los valores se validan en TypeScript (SUPPLIER_SYNC_STATUSES).
  const supplierCols: Array<[string, string]> = [
    ["final_address_source", "TEXT"],
    ["supplier_platform", "TEXT"],
    ["supplier_sync_status", "TEXT NOT NULL DEFAULT 'not_ready'"],
    ["supplier_external_order_id", "TEXT"],
    ["supplier_reference", "TEXT"],
    ["supplier_sync_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["supplier_last_error", "TEXT"],
    ["supplier_synced_at", "INTEGER"],
    ["supplier_last_checked_at", "INTEGER"],
    ["supplier_status", "TEXT"],
    ["tracking_number", "TEXT"],
    ["tracking_url", "TEXT"],
    ["carrier", "TEXT"],
    // --- Fase 3: tracking y avisos de postventa ---
    // Estado tal cual lo manda el proveedor (sin tocar) y su equivalente
    // normalizado a nuestra máquina de estados (TrackingStatus).
    ["supplier_status_raw", "TEXT"],
    ["supplier_status_normalized", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["tracking_first_seen_at", "INTEGER"],
    ["tracking_last_checked_at", "INTEGER"],
    // Sellos de "ya avisado": su presencia impide repetir el WhatsApp.
    ["tracking_notification_sent_at", "INTEGER"],
    ["out_for_delivery_notification_sent_at", "INTEGER"],
    ["delivered_notification_sent_at", "INTEGER"],
    // Fase A: avisos nuevos (intento fallido, punto de recogida) y el dato
    // del punto de recogida tal cual lo cuenta el proveedor (sin PII nuestra).
    ["delivery_attempt_notification_sent_at", "INTEGER"],
    ["pickup_point_notification_sent_at", "INTEGER"],
    ["pickup_point_info", "TEXT"],
    // Autorización POR PEDIDO para el piloto de proveedores (distinta de la
    // allowlist de teléfonos de WhatsApp: aquí decide Pedro pedido a pedido).
    ["supplier_pilot_approved", "INTEGER NOT NULL DEFAULT 0"],
    // Fase de creación en el proveedor: crear y confirmar son dos pasos
    // distintos y hay que sobrevivir a un reinicio entre ambos.
    ["supplier_create_phase", "TEXT NOT NULL DEFAULT 'none'"],
    // Clave de idempotencia YA USADA: se persiste para no regenerarla nunca
    // en un reintento (regenerarla crearía un pedido duplicado).
    ["supplier_idempotency_key", "TEXT"],
    ["supplier_confirm_idempotency_key", "TEXT"],
    // Qué ha pasado con la nota del repartidor en este proveedor.
    ["supplier_delivery_note_status", "TEXT NOT NULL DEFAULT 'not_present'"],
  ];
  const currentCols = new Set(
    (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  for (const [name, decl] of supplierCols) {
    if (!currentCols.has(name)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${decl}`);
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders(supplier_sync_status, status)"
  );

  migrateClosureAxis(db);
  migrateCallOrchestrator(db);
  migrateStatusAxis(db);
  migrateSchedulerLeases(db);
  migrateConversationOrderContext(db);
  migrateOutboxProvider(db);
  migrateActionResolutions(db);
  migrateOrderedAt(db);
  migrateNotifyDelaySends(db);
  migrateBeepingAxis(db);
  migrateMetaAdsDaily(db);
  migrateProductCostHistory(db);
  migrateCodScenarios(db);
  migrateCallAgentVersion(db);
  migrateOrderAttribution(db);

  // --- Conversations ---
  const stmtGetConvByPhone = db.prepare<[string], Conversation>(
    "SELECT * FROM conversations WHERE phone = ?"
  );
  const stmtInsertConv = db.prepare(
    "INSERT INTO conversations (phone, name, jid) VALUES (?, ?, ?)"
  );
  const stmtUpdateConvName = db.prepare(
    "UPDATE conversations SET name = ? WHERE id = ? AND (name IS NULL OR name = '')"
  );
  const stmtUpdateConvJid = db.prepare(
    "UPDATE conversations SET jid = ? WHERE id = ?"
  );
  const stmtGetConvById = db.prepare<[number], Conversation>(
    "SELECT * FROM conversations WHERE id = ?"
  );
  const stmtListConvs = db.prepare<[], ConversationListItem>(`
    SELECT
      c.*,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_preview
    FROM conversations c
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
  `);
  const stmtSetMode = db.prepare("UPDATE conversations SET mode = ? WHERE id = ?");
  // Watchdog: conversaciones en modo AI cuyo ÚLTIMO mensaje es del lead (no
  // contestado) con una antigüedad entre [newer, older] segundos. Señal directa
  // de "el bot no está respondiendo".
  const stmtUnanswered = db.prepare<[number, number], UnansweredConvo>(`
    SELECT id, phone, name, last_role, last_at FROM (
      SELECT c.id AS id, c.phone AS phone, c.name AS name,
        (SELECT m.role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_at
      FROM conversations c
      WHERE c.mode = 'AI'
    )
    WHERE last_role = 'user' AND last_at < ? AND last_at >= ?
  `);

  // --- Messages ---
  const stmtInsertMessage = db.prepare(
    "INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)"
  );
  const stmtUpdateLastMessageAt = db.prepare(
    "UPDATE conversations SET last_message_at = unixepoch() WHERE id = ?"
  );
  const stmtGetMessages = db.prepare<[number, number], Message>(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const insertMessageTx = db.transaction(
    (conversationId: number, role: MessageRole, content: string): number => {
      const info = stmtInsertMessage.run(conversationId, role, content);
      stmtUpdateLastMessageAt.run(conversationId);
      return info.lastInsertRowid as number;
    }
  );

  // --- Connection state ---
  const stmtGetConnState = db.prepare<[], ConnectionState>(
    "SELECT * FROM connection_state WHERE id = 1"
  );
  const stmtUpdateConnAll = db.prepare(`
    UPDATE connection_state
    SET status = ?, qr_string = ?, phone = ?, updated_at = unixepoch()
    WHERE id = 1
  `);

  // --- Outbox ---
  const stmtEnqueueOutbox = db.prepare(
    "INSERT INTO outbox (conversation_id, phone, content, authorized) VALUES (?, ?, ?, ?)"
  );
  const stmtEnqueueOutboxMedia = db.prepare(
    "INSERT INTO outbox (conversation_id, phone, content, type, media_path) VALUES (?, ?, ?, ?, ?)"
  );
  const stmtGetPendingOutbox = db.prepare<[number], OutboxItem>(
    "SELECT * FROM outbox WHERE sent = 0 ORDER BY created_at ASC LIMIT ?"
  );
  // `AND sent = 0` NO es decorativo: convierte esto en un CLAIM atómico.
  // Sin esa condición, dos procesos que hubieran leído la misma fila
  // pendiente la "reclamarían" los dos con éxito y el cliente recibiría el
  // mismo WhatsApp DOS veces. Con ella, solo uno ve changes=1 y envía.
  // Mismo patrón que claimTrackingNotification y claimSupplierCreate.
  const stmtMarkOutboxSent = db.prepare(
    "UPDATE outbox SET sent = 1, sent_at = unixepoch() WHERE id = ? AND sent = 0"
  );

  // --- Borrado de conversaciones (atómico) ---
  const stmtDeleteMessages = db.prepare(
    "DELETE FROM messages WHERE conversation_id = ?"
  );
  const stmtDeletePendingOutbox = db.prepare(
    "DELETE FROM outbox WHERE conversation_id = ? AND sent = 0"
  );
  const stmtDeleteConv = db.prepare("DELETE FROM conversations WHERE id = ?");
  const deleteConversationTx = db.transaction((conversationId: number): void => {
    stmtDeleteMessages.run(conversationId);
    stmtDeletePendingOutbox.run(conversationId);
    stmtDeleteConv.run(conversationId);
  });

  // --- Reconciliación @lid → número real (WhatsApp 2025+) ---
  // Cuando una persona que estaba guardada por su LID ahora llega resuelta a su
  // número real, unificamos su conversación para que no aparezca duplicada.
  const stmtSetConvPhoneJid = db.prepare(
    "UPDATE conversations SET phone = ?, jid = ? WHERE id = ?"
  );
  const stmtMoveMessages = db.prepare(
    "UPDATE messages SET conversation_id = ? WHERE conversation_id = ?"
  );
  const stmtMoveOutbox = db.prepare(
    "UPDATE outbox SET conversation_id = ? WHERE conversation_id = ?"
  );
  const reconcileLidToPnTx = db.transaction(
    (lidPhone: string, realPhone: string, jid: string): void => {
      const lidConvo = stmtGetConvByPhone.get(lidPhone);
      if (!lidConvo) return; // no había conversación vieja con el LID
      const realConvo = stmtGetConvByPhone.get(realPhone);
      if (!realConvo) {
        // Re-indexar la conversación del LID al número real (conserva historial).
        stmtSetConvPhoneJid.run(realPhone, jid, lidConvo.id);
      } else if (realConvo.id !== lidConvo.id) {
        // Ya existían las dos (split previo al arreglo): fusionar mensajes y
        // outbox en la del número real y borrar la del LID.
        stmtMoveMessages.run(realConvo.id, lidConvo.id);
        stmtMoveOutbox.run(realConvo.id, lidConvo.id);
        stmtUpdateConvJid.run(jid, realConvo.id);
        stmtUpdateLastMessageAt.run(realConvo.id);
        stmtDeleteConv.run(lidConvo.id);
      }
    }
  );

  return {
    db,
    stmtGetConvByPhone,
    stmtInsertConv,
    stmtUpdateConvName,
    stmtUpdateConvJid,
    stmtGetConvById,
    stmtListConvs,
    stmtSetMode,
    stmtUnanswered,
    stmtGetMessages,
    insertMessageTx,
    stmtGetConnState,
    stmtUpdateConnAll,
    stmtEnqueueOutbox,
    stmtEnqueueOutboxMedia,
    stmtGetPendingOutbox,
    stmtMarkOutboxSent,
    deleteConversationTx,
    reconcileLidToPnTx,
  };
}

let _ctx: ReturnType<typeof build> | null = null;

/** Devuelve el contexto de la DB, inicializándolo de forma perezosa la primera vez. */
function ctx(): ReturnType<typeof build> {
  if (!_ctx) {
    _ctx = build();
  }
  return _ctx;
}

/** Versión de esquema estampada en PRAGMA user_version. Subir con cada cambio. */
export const SCHEMA_VERSION = 17;

/**
 * Handle crudo de SQLite para el módulo de observabilidad (`src/lib/system/`),
 * que mantiene sus consultas en su propio repository en vez de engordar este
 * archivo. SOLO para ese módulo: el resto del código usa las funciones de aquí.
 */
export function systemDbHandle(): Database.Database {
  return ctx().db;
}

/** Ruta del fichero .db (para medir tamaños; nunca para servirlo por HTTP). */
export function dbFilePath(): string {
  return DB_PATH;
}

// ============================================================
// Conversations
// ============================================================

export function getOrCreateConversation(
  phone: string,
  name?: string,
  jid?: string
): Conversation {
  const c = ctx();
  const existing = c.stmtGetConvByPhone.get(phone);
  if (existing) {
    if (name && (!existing.name || existing.name === "")) {
      c.stmtUpdateConvName.run(name, existing.id);
      existing.name = name;
    }
    // Mantener el jid al día (backfill de filas antiguas y cambios de dirección).
    if (jid && existing.jid !== jid) {
      c.stmtUpdateConvJid.run(jid, existing.id);
      existing.jid = jid;
    }
    return existing;
  }
  const info = c.stmtInsertConv.run(phone, name ?? null, jid ?? null);
  return {
    id: info.lastInsertRowid as number,
    phone,
    name: name ?? null,
    jid: jid ?? null,
    mode: "AI",
    last_message_at: null,
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Reconciliación @lid → número real: si una persona estaba guardada por su LID
 * (antes del arreglo del @lid) y ahora llega resuelta a su número real, unifica
 * su conversación —re-indexa la vieja o fusiona las dos si ya se habían partido—
 * para que no aparezca duplicada en el panel ni pierda su historial.
 * Best-effort: nunca rompe la recepción de mensajes.
 */
export function reconcileLidToPn(lidPhone: string, realPhone: string, jid: string): void {
  if (!lidPhone || !realPhone || lidPhone === realPhone) return;
  try {
    ctx().reconcileLidToPnTx(lidPhone, realPhone, jid);
  } catch {
    // la reconciliación nunca debe romper el flujo de mensajes
  }
}

export function getConversationById(id: number): Conversation | null {
  return ctx().stmtGetConvById.get(id) ?? null;
}

export function listConversations(): ConversationListItem[] {
  return ctx().stmtListConvs.all();
}

/**
 * Watchdog: conversaciones en modo AI cuyo último mensaje es del lead y lleva
 * sin respuesta entre `minSinRespuestaSec` y `maxAntiguedadSec` segundos. Señal
 * directa de que el bot no está contestando (bug mudo, saldo, error…).
 */
export function getUnansweredConversations(
  minSinRespuestaSec = 180,
  maxAntiguedadSec = 7200
): UnansweredConvo[] {
  const now = Math.floor(Date.now() / 1000);
  return ctx().stmtUnanswered.all(now - minSinRespuestaSec, now - maxAntiguedadSec);
}

export function setMode(conversationId: number, mode: ConversationMode): void {
  ctx().stmtSetMode.run(mode, conversationId);
}

// ============================================================
// Messages
// ============================================================

export function insertMessage(
  conversationId: number,
  role: MessageRole,
  content: string
): number {
  return ctx().insertMessageTx(conversationId, role, content);
}

export function getMessages(conversationId: number, limit = 50): Message[] {
  return ctx().stmtGetMessages.all(conversationId, limit).reverse();
}

export function getRecentHistory(conversationId: number, limit = 20): Message[] {
  // Consulta DESC + reverse en JS, mucho más eficiente que ORDER BY ASC sobre toda la tabla
  return ctx().stmtGetMessages.all(conversationId, limit).reverse();
}

// ============================================================
// Connection state
// ============================================================

export function getConnectionState(): ConnectionState {
  return ctx().stmtGetConnState.get() as ConnectionState;
}

interface SetConnectionInput {
  status?: ConnectionStatus;
  qr_string?: string | null;
  phone?: string | null;
}

/**
 * Actualiza el estado de conexión.
 * IMPORTANTE: Preserva los campos no provistos.
 * Solo pasar null EXPLÍCITO borra un campo.
 * Si pasas {status: 'connecting'}, qr_string y phone NO se tocan.
 */
export function setConnectionState(input: SetConnectionInput): void {
  const current = getConnectionState();
  const next = {
    status: input.status ?? current.status,
    qr_string: "qr_string" in input ? input.qr_string : current.qr_string,
    phone: "phone" in input ? input.phone : current.phone,
  };
  ctx().stmtUpdateConnAll.run(next.status, next.qr_string, next.phone);
}

// ============================================================
// Outbox (mensajes humanos que el bot debe enviar)
// ============================================================

export function enqueueOutbox(
  conversationId: number,
  phone: string,
  content: string,
  authorized = false
): number {
  const info = ctx().stmtEnqueueOutbox.run(conversationId, phone, content, authorized ? 1 : 0);
  return info.lastInsertRowid as number;
}

/** Encola una IMAGEN para que el bot la envíe (content = pie de foto, opcional). */
export function enqueueOutboxImage(
  conversationId: number,
  phone: string,
  mediaPath: string,
  caption = ""
): number {
  const info = ctx().stmtEnqueueOutboxMedia.run(conversationId, phone, caption, "image", mediaPath);
  return info.lastInsertRowid as number;
}

export function getPendingOutbox(limit = 20): OutboxItem[] {
  return ctx().stmtGetPendingOutbox.all(limit);
}

/**
 * RECLAMA el derecho a enviar este item, de forma atómica.
 *
 * Devuelve `true` solo si esta llamada ganó el claim (el item estaba
 * pendiente). `false` significa que otro proceso ya lo reclamó: quien lo
 * reciba NO debe enviar nada. Es la barrera que hace que el patrón
 * claim→send→revert siga siendo at-most-once aunque corriera más de un
 * proceso de bot a la vez (dos contenedores, o un reinicio solapado).
 */
export function markOutboxSent(id: number): boolean {
  return ctx().stmtMarkOutboxSent.run(id).changes > 0;
}

/**
 * Devuelve un item del outbox a "pendiente" (sent=0). Se usa cuando el envío
 * por Baileys falla DESPUÉS de haberlo reclamado (patrón claim→send→revert):
 * así un fallo blando se reintenta sin que un crash pueda duplicar el envío.
 */
export function revertOutboxSent(id: number): void {
  ctx().db.prepare("UPDATE outbox SET sent = 0, sent_at = NULL WHERE id = ?").run(id);
}

// ============================================================
// Borrado de conversaciones (atómico)
// ============================================================

export function deleteConversation(conversationId: number): void {
  ctx().deleteConversationTx(conversationId);
}

// ============================================================
// Métricas (analytics)
// ============================================================

export function insertUsage(
  conversationId: number | null,
  model: string,
  inTokens: number,
  outTokens: number,
  costUsd: number
): void {
  ctx()
    .db.prepare(
      "INSERT INTO usage (conversation_id, model, in_tokens, out_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)"
    )
    .run(conversationId, model, inTokens, outTokens, costUsd);
}

export function insertToolEvent(
  conversationId: number | null,
  tool: string,
  hasEmail: boolean
): void {
  ctx()
    .db.prepare(
      "INSERT INTO tool_events (conversation_id, tool, has_email) VALUES (?, ?, ?)"
    )
    .run(conversationId, tool, hasEmail ? 1 : 0);
}

export function getInsight(periodKey: string): { data_json: string; created_at: number } | null {
  return (
    (ctx()
      .db.prepare("SELECT data_json, created_at FROM insights WHERE period_key = ?")
      .get(periodKey) as { data_json: string; created_at: number } | undefined) ?? null
  );
}

export function setInsight(periodKey: string, dataJson: string): void {
  ctx()
    .db.prepare(
      "INSERT INTO insights (period_key, data_json, created_at) VALUES (?, ?, unixepoch()) " +
        "ON CONFLICT(period_key) DO UPDATE SET data_json = excluded.data_json, created_at = unixepoch()"
    )
    .run(periodKey, dataJson);
}

export interface DayBucket {
  day: string; // YYYY-MM-DD (hora local)
  convos: number;
  userMsgs: number;
  botMsgs: number;
  leads: number;
  costUsd: number;
}

export interface AnalyticsData {
  days: DayBucket[];
  totals: {
    convos: number;
    userMsgs: number;
    botMsgs: number;
    leads: number;
    leadsConEmail: number;
    costUsd: number;
    inTokens: number;
    outTokens: number;
    avgRespSec: number | null;
  };
  funnel: { escribieron: number; email: number; enlace: number };
}

const DAY = "date(created_at, 'unixepoch', 'localtime')";

/** Agrega todas las métricas locales desde `sinceTs` (epoch s). */
export function getAnalytics(sinceTs: number): AnalyticsData {
  const db = ctx().db;
  const buckets = new Map<string, DayBucket>();
  const day = (d: string): DayBucket => {
    let b = buckets.get(d);
    if (!b) {
      b = { day: d, convos: 0, userMsgs: 0, botMsgs: 0, leads: 0, costUsd: 0 };
      buckets.set(d, b);
    }
    return b;
  };

  // Mensajes por día y rol
  for (const r of db
    .prepare(
      `SELECT ${DAY} AS d, role, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY d, role`
    )
    .all(sinceTs) as Array<{ d: string; role: string; n: number }>) {
    if (r.role === "user") day(r.d).userMsgs += r.n;
    else day(r.d).botMsgs += r.n;
  }

  // Conversaciones nuevas por día
  for (const r of db
    .prepare(`SELECT ${DAY} AS d, COUNT(*) AS n FROM conversations WHERE created_at >= ? GROUP BY d`)
    .all(sinceTs) as Array<{ d: string; n: number }>) {
    day(r.d).convos += r.n;
  }

  // Leads guardados por día
  for (const r of db
    .prepare(
      `SELECT ${DAY} AS d, COUNT(*) AS n FROM tool_events WHERE tool = 'guardarLead' AND created_at >= ? GROUP BY d`
    )
    .all(sinceTs) as Array<{ d: string; n: number }>) {
    day(r.d).leads += r.n;
  }

  // Coste por día
  for (const r of db
    .prepare(`SELECT ${DAY} AS d, SUM(cost_usd) AS c FROM usage WHERE created_at >= ? GROUP BY d`)
    .all(sinceTs) as Array<{ d: string; c: number }>) {
    day(r.d).costUsd += r.c ?? 0;
  }

  const days = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));

  const usageTot = db
    .prepare(
      "SELECT COALESCE(SUM(in_tokens),0) AS i, COALESCE(SUM(out_tokens),0) AS o, COALESCE(SUM(cost_usd),0) AS c FROM usage WHERE created_at >= ?"
    )
    .get(sinceTs) as { i: number; o: number; c: number };

  const leadsTot = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(has_email),0) AS e FROM tool_events WHERE tool='guardarLead' AND created_at >= ?"
    )
    .get(sinceTs) as { n: number; e: number };

  // Tiempo medio de respuesta: para cada mensaje del bot, segundos desde el
  // último mensaje del lead anterior en la misma conversación.
  const resp = db
    .prepare(
      `SELECT AVG(diff) AS avg FROM (
         SELECT m.created_at - (
           SELECT MAX(u.created_at) FROM messages u
           WHERE u.conversation_id = m.conversation_id AND u.role='user' AND u.created_at <= m.created_at
         ) AS diff
         FROM messages m
         WHERE m.role IN ('assistant','human') AND m.created_at >= ?
       ) WHERE diff IS NOT NULL AND diff >= 0 AND diff < 3600`
    )
    .get(sinceTs) as { avg: number | null };

  // Embudo
  const escribieron = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT conversation_id) AS n FROM messages WHERE role='user' AND created_at >= ?"
      )
      .get(sinceTs) as { n: number }
  ).n;
  const email = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT conversation_id) AS n FROM tool_events WHERE has_email=1 AND created_at >= ?"
      )
      .get(sinceTs) as { n: number }
  ).n;
  // Cuántas conversaciones recibieron el enlace de compra. Pon tu enlace en
  // CHECKOUT_URL; si no, cuenta cualquier enlace enviado por el agente.
  const linkMatch = process.env.CHECKOUT_URL ? `%${process.env.CHECKOUT_URL}%` : "%http%";
  const enlace = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT conversation_id) AS n FROM messages WHERE role IN ('assistant','human') AND created_at >= ? AND content LIKE ?"
      )
      .get(sinceTs, linkMatch) as { n: number }
  ).n;

  const totals = {
    convos: days.reduce((s, d) => s + d.convos, 0),
    userMsgs: days.reduce((s, d) => s + d.userMsgs, 0),
    botMsgs: days.reduce((s, d) => s + d.botMsgs, 0),
    leads: leadsTot.n,
    leadsConEmail: leadsTot.e,
    costUsd: usageTot.c,
    inTokens: usageTot.i,
    outTokens: usageTot.o,
    avgRespSec: resp.avg,
  };

  return { days, totals, funnel: { escribieron, email, enlace } };
}

// ============================================================
// Ajustes editables en caliente (modelo, pausa, buffer, audios...)
// ============================================================

export function getSetting(key: string): string | null {
  const r = ctx().db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  ctx()
    .db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = ctx().db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ============================================================
// Pedidos COD (confirmación por WhatsApp) — fuente de verdad del MVP
// ============================================================

/** Marca updated_at; se usa en todas las transiciones. */
const TOUCH = "updated_at = unixepoch()";

/**
 * Inserta el pedido si no existía (idempotencia por shopify_order_id).
 * Devuelve si se creó y la fila resultante (la nueva o la ya existente).
 *
 * ATÓMICO frente a webhooks concurrentes: INSERT OR IGNORE apoyado en el
 * UNIQUE de shopify_order_id — dos entregas simultáneas del mismo pedido
 * jamás crean dos filas ni revientan con SQLITE_CONSTRAINT (que provocaría
 * un 500 y más reintentos de Shopify).
 */
export function insertOrderIfNew(input: NewOrderInput): { created: boolean; order: OrderRow } {
  const db = ctx().db;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO orders (
        shopify_order_id, shopify_order_number, customer_name, phone, email,
        product_summary, total_price, currency,
        address_line1, address_line2, city, province, postal_code, country,
        status, customer_note, last_error, raw_payload, ordered_at,
        marketing_source, marketing_medium, marketing_campaign, marketing_content,
        marketing_term, marketing_fbclid, landing_site, referring_site, shopify_source_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.shopify_order_id,
      input.shopify_order_number,
      input.customer_name,
      input.phone,
      input.email,
      input.product_summary,
      input.total_price,
      input.currency,
      input.address_line1,
      input.address_line2,
      input.city,
      input.province,
      input.postal_code,
      input.country,
      input.status,
      input.customer_note ?? null,
      input.last_error ?? null,
      input.raw_payload ?? null,
      input.ordered_at ?? null,
      input.attribution?.source ?? null,
      input.attribution?.medium ?? null,
      input.attribution?.campaign ?? null,
      input.attribution?.content ?? null,
      input.attribution?.term ?? null,
      input.attribution?.fbclid ?? null,
      input.attribution?.landingSite ?? null,
      input.attribution?.referringSite ?? null,
      input.attribution?.sourceName ?? null
    );
  const order = getOrderByShopifyId(input.shopify_order_id);
  if (!order) {
    // Solo posible si el INSERT se ignoró por algo distinto al UNIQUE (p.ej.
    // un CHECK). Mejor reventar con contexto que devolver un estado falso.
    throw new Error(`insertOrderIfNew: el pedido ${input.shopify_order_id} no se pudo guardar`);
  }
  return { created: info.changes > 0, order };
}

export function getOrderById(id: number): OrderRow | null {
  return (ctx().db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined) ?? null;
}

/**
 * Nota interna de expedición (Pedro). Editable hasta que el pedido se libera
 * a Beeping; después queda congelada como registro de lo que se decidió.
 * NUNCA viaja a Beeping: su API pública no documenta campo de notas.
 */
export function setOrderDispatchNote(id: number, note: string | null): boolean {
  const limpia = (note ?? "").trim().slice(0, 500) || null;
  const res = ctx()
    .db.prepare(
      `UPDATE orders SET dispatch_note = ?, updated_at = unixepoch()
       WHERE id = ? AND beeping_sync_status IN ('not_released', 'release_failed')`
    )
    .run(limpia, id);
  return res.changes > 0;
}

/**
 * LATCH de atribución (v17): rellena SOLO los huecos (COALESCE con el valor
 * existente). Precedencia explícita: el PRIMER valor fiable se conserva —
 * un orders/updated posterior sin UTM no destruye lo capturado en el
 * create, y uno con UTM solo puede completar lo que faltaba.
 */
export function latchOrderAttribution(
  id: number,
  attr: Partial<{
    source: string | null;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
    fbclid: string | null;
    landingSite: string | null;
    referringSite: string | null;
    sourceName: string | null;
  }>
): boolean {
  const res = ctx()
    .db.prepare(
      `UPDATE orders SET
         marketing_source = COALESCE(marketing_source, ?),
         marketing_medium = COALESCE(marketing_medium, ?),
         marketing_campaign = COALESCE(marketing_campaign, ?),
         marketing_content = COALESCE(marketing_content, ?),
         marketing_term = COALESCE(marketing_term, ?),
         marketing_fbclid = COALESCE(marketing_fbclid, ?),
         landing_site = COALESCE(landing_site, ?),
         referring_site = COALESCE(referring_site, ?),
         shopify_source_name = COALESCE(shopify_source_name, ?)
       WHERE id = ?`
    )
    .run(
      attr.source ?? null,
      attr.medium ?? null,
      attr.campaign ?? null,
      attr.content ?? null,
      attr.term ?? null,
      attr.fbclid ?? null,
      attr.landingSite ?? null,
      attr.referringSite ?? null,
      attr.sourceName ?? null,
      id
    );
  return res.changes > 0;
}

export function getOrderByShopifyId(shopifyOrderId: string): OrderRow | null {
  return (
    (ctx().db.prepare("SELECT * FROM orders WHERE shopify_order_id = ?").get(shopifyOrderId) as
      | OrderRow
      | undefined) ?? null
  );
}

/**
 * Busca por el NÚMERO de pedido (el corto, "1063", no el id largo de
 * Shopify). Usado por el reconciliador de Dropea (E8): su `external_order_id`
 * puede corresponder a cualquiera de los dos, y no se asume cuál sin mirar
 * datos reales.
 */
export function getOrderByShopifyOrderNumber(orderNumber: string): OrderRow | null {
  return (
    (ctx().db.prepare("SELECT * FROM orders WHERE shopify_order_number = ?").get(orderNumber) as
      | OrderRow
      | undefined) ?? null
  );
}

/** Lista pedidos, opcionalmente filtrados por estado, más recientes primero. */
/**
 * Orden "por fecha de llegada del pedido", de más nuevo a más viejo.
 *
 * NO se usa `created_at`: esa columna es `unixepoch()` del momento en que la
 * fila se INSERTÓ aquí, no de cuándo compró el cliente. Los 93 pedidos que
 * importó el backfill del 24-08 se insertaron todos en el mismo instante, así
 * que ordenar por `created_at` los apila en un montón sin orden real — que es
 * exactamente lo que se sufría en el panel.
 *
 * `shopify_order_number` sí es la llegada real: Shopify lo incrementa pedido a
 * pedido dentro de la misma tienda. Se castea porque la columna es TEXT (para
 * no perder ceros ni prefijos raros); un valor no numérico castea a 0 y se va
 * al final, que es mejor sitio que en medio. `created_at` queda de desempate.
 *
 * Se prefirió esto a añadir una columna `shopify_created_at`: daría el mismo
 * resultado y costaría una migración de esquema, un backfill y un despliegue.
 */
const ORDERS_ARRIVAL_ORDER =
  // T3 (26-08): con `ordered_at` disponible (la fecha REAL de compra), esa
  // manda. COALESCE a created_at para las filas históricas aún sin backfill
  // de la columna, y el número de pedido como desempate estable — que era el
  // criterio anterior y sigue siendo correcto entre pedidos del mismo
  // instante.
  "COALESCE(ordered_at, created_at) DESC, CAST(shopify_order_number AS INTEGER) DESC, id DESC";

export function listOrders(status?: OrderStatus, limit = 200): OrderRow[] {
  const db = ctx().db;
  if (status) {
    return db
      .prepare(`SELECT * FROM orders WHERE status = ? ORDER BY ${ORDERS_ARRIVAL_ORDER} LIMIT ?`)
      .all(status, limit) as OrderRow[];
  }
  return db
    .prepare(`SELECT * FROM orders ORDER BY ${ORDERS_ARRIVAL_ORDER} LIMIT ?`)
    .all(limit) as OrderRow[];
}

/**
 * Candidatos amplios para un aviso masivo tipo "retraso de reposición":
 * confirmados, con teléfono, sin cierre cancelado, sin pedidos de prueba
 * (`shopify_order_id LIKE 'TEST-%'`). El filtro de PRODUCTO (qué pedidos
 * son de verdad elegibles) NO vive aquí — vive en
 * isDelayNotificationEligible (orders/notify-delay.ts), la misma función
 * que usa el botón manual del panel, para que las dos vías compartan un
 * único criterio de elegibilidad.
 */
export function listOrdersForDelayNotification(opts: { excludeOrderIds?: number[] } = {}): OrderRow[] {
  const db = ctx().db;
  const excluded = opts.excludeOrderIds ?? [];
  const placeholders = excluded.length > 0 ? excluded.map(() => "?").join(",") : null;
  return db
    .prepare(
      `SELECT * FROM orders
       WHERE status = 'confirmed'
         AND phone != ''
         AND closure_status != 'cancelled'
         AND shopify_order_id NOT LIKE 'TEST-%'
         ${placeholders ? `AND id NOT IN (${placeholders})` : ""}
       ORDER BY id`
    )
    .all(...excluded) as OrderRow[];
}

/** Ids de pedido con un aviso YA entregado (status='sent') — idempotencia del batch (lectura en bloque, para el informe). */
export function getNotifyDelaySentOrderIds(): Set<number> {
  const rows = ctx()
    .db.prepare("SELECT order_id FROM notify_delay_sends WHERE status = 'sent'")
    .all() as Array<{ order_id: number }>;
  return new Set(rows.map((r) => r.order_id));
}

/** Mismo dato que getNotifyDelaySentOrderIds pero para UN pedido — la guarda antes de enviar de verdad. */
export function wasDelayNotificationSent(orderId: number): boolean {
  const row = ctx()
    .db.prepare("SELECT 1 FROM notify_delay_sends WHERE order_id = ? AND status = 'sent'")
    .get(orderId);
  return row !== undefined;
}

/**
 * Deja constancia del resultado de un intento (UPSERT: una fila por pedido).
 * Un intento bloqueado por los safety gates NO cuenta como "sent" — se
 * reintenta en el siguiente lanzamiento si las condiciones cambian.
 */
export function recordNotifyDelaySend(orderId: number, batchId: string, status: string): void {
  ctx()
    .db.prepare(
      `INSERT INTO notify_delay_sends (order_id, batch_id, sent_at, status)
       VALUES (?, ?, unixepoch(), ?)
       ON CONFLICT(order_id) DO UPDATE SET batch_id = excluded.batch_id, sent_at = excluded.sent_at, status = excluded.status`
    )
    .run(orderId, batchId, status);
}

export interface OrderCounts {
  today: number; // pedidos entrados hoy (hora local)
  confirmedToday: number; // confirmados hoy
  awaiting: number; // pending_send + awaiting_reply + reminder_sent
  correction: number; // needs_correction pendientes de revisar
  needsCall: number; // needs_call — el filtro crítico de Pedro
  error: number;
}

export function getOrderCounts(): OrderCounts {
  const db = ctx().db;
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    today: one(
      "SELECT COUNT(*) AS n FROM orders WHERE date(created_at,'unixepoch','localtime') = date('now','localtime')"
    ),
    confirmedToday: one(
      "SELECT COUNT(*) AS n FROM orders WHERE status='confirmed' AND date(COALESCE(confirmed_at, updated_at),'unixepoch','localtime') = date('now','localtime')"
    ),
    awaiting: one(
      "SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note')"
    ),
    correction: one("SELECT COUNT(*) AS n FROM orders WHERE status='needs_correction'"),
    needsCall: one("SELECT COUNT(*) AS n FROM orders WHERE status='needs_call'"),
    error: one("SELECT COUNT(*) AS n FROM orders WHERE status='error'"),
  };
}

/** Pedidos "vivos" (esperando algo del cliente) de un teléfono, el más reciente primero. */
export function getActiveOrdersByPhone(phone: string): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE phone = ? AND status IN ('awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction')
       ORDER BY created_at DESC, id DESC`
    )
    .all(phone) as OrderRow[];
}

/**
 * Pedidos de este teléfono que YA están en manos humanas (needs_call).
 * Para una sola cosa: si el cliente escribe "cancelar" cuando el bot ya se
 * apartó, la petición debe quedar ESTAMPADA para Pedro (urgencia 1 en
 * Acciones), no perderse en el silencio.
 */
export function getNeedsCallOrdersByPhone(phone: string): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders WHERE phone = ? AND status = 'needs_call'
       ORDER BY created_at DESC, id DESC`
    )
    .all(phone) as OrderRow[];
}

/**
 * Candidatos a duplicado del mismo teléfono para la detección A LA ENTRADA.
 *
 * Distinto de getActiveOrdersByPhone a propósito: aquí SÍ cuentan
 * 'pending_send' (el recién insertado siempre está ahí — sin esto la
 * detección a la entrada no saltaba jamás) y 'needs_call' (el original pudo
 * agotar el flujo de WhatsApp y seguir siendo el mismo pedido repetido).
 * Fuera quedan confirmed/cancelled/ignored_old/error: un pedido ya decidido
 * no es "posible duplicado", es historia.
 */
export function getDuplicateCandidatesByPhone(phone: string): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE phone = ? AND status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction','needs_call')
       ORDER BY created_at DESC, id DESC`
    )
    .all(phone) as OrderRow[];
}



// --- Outbox: proveedor, id de mensaje y estados (Cloud API de Meta) ---

/** Encola un mensaje RICO (interactivo o plantilla). `content` es SIEMPRE el
 *  texto de fallback: lo que enseña el panel y lo que saldría por un
 *  proveedor sin soporte de botones. */
export function enqueueOutboxRich(
  conversationId: number,
  phone: string,
  input: {
    content: string;
    messageType: "text" | "interactive_buttons" | "interactive_list" | "template";
    payloadJson?: string | null;
    templateName?: string | null;
    authorized?: boolean;
  }
): number {
  const info = ctx()
    .db.prepare(
      `INSERT INTO outbox (conversation_id, phone, content, authorized, message_type, template_name, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      conversationId,
      phone,
      input.content,
      input.authorized ? 1 : 0,
      input.messageType,
      input.templateName ?? null,
      input.payloadJson ?? null
    );
  return info.lastInsertRowid as number;
}

/** Tras un envío aceptado por el proveedor: quién lo llevó y con qué id. */
export function setOutboxProviderResult(id: number, provider: string, providerMessageId: string | null): void {
  ctx()
    .db.prepare("UPDATE outbox SET provider = ?, provider_message_id = ? WHERE id = ?")
    .run(provider, providerMessageId, id);
}

/**
 * Fallo TERMINAL de envío: no se reintenta (reintentarlo daría lo mismo).
 * El item queda marcado como enviado para salir de la cola, pero con
 * failed_at y el motivo — el panel lo distingue de un envío bueno.
 */
export function markOutboxFailedTerminal(id: number, provider: string, reason: string): void {
  ctx()
    .db.prepare(
      `UPDATE outbox SET sent = 1, sent_at = unixepoch(), provider = ?,
        failed_at = unixepoch(), failure_reason = ? WHERE id = ?`
    )
    .run(provider, reason.slice(0, 300), id);
}

/**
 * Actualiza el estado de un mensaje a partir del webhook de Meta.
 * Los estados solo AVANZAN (un `read` no se borra si llega un `delivered`
 * atrasado) y son idempotentes: el mismo webhook dos veces no cambia nada.
 */
export function updateOutboxStatusByProviderMessageId(
  providerMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  atSec: number,
  failureReason?: string | null
): boolean {
  const db = ctx().db;
  let info;
  if (status === "delivered") {
    info = db
      .prepare("UPDATE outbox SET delivered_at = COALESCE(delivered_at, ?) WHERE provider_message_id = ?")
      .run(atSec, providerMessageId);
  } else if (status === "read") {
    // Un read implica entregado aunque el webhook `delivered` se perdiera.
    info = db
      .prepare(
        `UPDATE outbox SET read_at = COALESCE(read_at, ?), delivered_at = COALESCE(delivered_at, ?)
         WHERE provider_message_id = ?`
      )
      .run(atSec, atSec, providerMessageId);
  } else if (status === "failed") {
    // MONOTONICIDAD: un mensaje ya entregado (o leído) NO puede pasar a
    // fallado por un webhook atrasado o duplicado. failed es un terminal
    // ALTERNATIVO a delivered, no un estado posterior.
    info = db
      .prepare(
        `UPDATE outbox SET failed_at = COALESCE(failed_at, ?), failure_reason = COALESCE(failure_reason, ?)
         WHERE provider_message_id = ? AND delivered_at IS NULL AND read_at IS NULL`
      )
      .run(atSec, (failureReason ?? "fallo reportado por Meta").slice(0, 300), providerMessageId);
  } else {
    return true; // `sent`: ya lo estampó el propio envío; nada que hacer.
  }
  return info.changes > 0;
}

export function getOutboxByProviderMessageId(providerMessageId: string): OutboxItem | null {
  return (
    (ctx().db.prepare("SELECT * FROM outbox WHERE provider_message_id = ?").get(providerMessageId) as
      | OutboxItem
      | undefined) ?? null
  );
}

/** Conversación por teléfono, SOLO LECTURA (no crea nada). Para chequeos
 *  como la ventana de 24 h, que no deben tener efectos secundarios. */
export function getConversationIdByPhone(phone: string): number | null {
  const row = ctx().db.prepare("SELECT id FROM conversations WHERE phone = ?").get(phone) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/**
 * ¿Cuándo fue el último mensaje ENTRANTE de esta conversación?
 * Es la base de la ventana de 24 h de Meta: fuera de ella, un mensaje libre
 * está prohibido y hace falta plantilla.
 */
export function getLastInboundAt(conversationId: number): number | null {
  const row = ctx()
    .db.prepare(
      "SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'"
    )
    .get(conversationId) as { t: number | null };
  return row.t ?? null;
}


// --- Action Center: resoluciones manuales de Pedro ---

export function resolveActionItem(orderId: number, actionType: string, note?: string | null): void {
  ctx()
    .db.prepare(
      `INSERT INTO action_resolutions (order_id, action_type, note) VALUES (?, ?, ?)
       ON CONFLICT(order_id, action_type) DO UPDATE SET note = excluded.note, resolved_at = unixepoch()`
    )
    .run(orderId, actionType, note?.slice(0, 300) ?? null);
}

export function isActionResolved(orderId: number, actionType: string): boolean {
  return Boolean(
    ctx().db.prepare("SELECT 1 FROM action_resolutions WHERE order_id = ? AND action_type = ?").get(orderId, actionType)
  );
}

export function listActionResolutions(): Array<{ order_id: number; action_type: string; note: string | null; resolved_at: number }> {
  return ctx()
    .db.prepare("SELECT order_id, action_type, note, resolved_at FROM action_resolutions")
    .all() as Array<{ order_id: number; action_type: string; note: string | null; resolved_at: number }>;
}

// --- Contexto de conversación multi-pedido (bug real del 25-08-2026) ---

export interface ConversationOrderContext {
  phone: string;
  selected_order_id: number | null;
  selected_at: number | null;
  last_prompt_type: string | null;
  same_prompt_count: number;
  pending_cancel_order_id: number | null;
  updated_at: number;
}

export function getConversationOrderContext(phone: string): ConversationOrderContext | null {
  return (
    (ctx().db.prepare("SELECT * FROM conversation_order_context WHERE phone = ?").get(phone) as
      | ConversationOrderContext
      | undefined) ?? null
  );
}

/** Guarda qué pedido eligió el cliente. Sobrescribe la selección anterior. */
export function setSelectedOrderContext(phone: string, orderId: number, nowSec?: number): void {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  ctx()
    .db.prepare(
      `INSERT INTO conversation_order_context (phone, selected_order_id, selected_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         selected_order_id = excluded.selected_order_id,
         selected_at = excluded.selected_at,
         updated_at = excluded.updated_at`
    )
    .run(phone, orderId, now, now);
}

/** Borra la selección (el pedido se resolvió, caducó, o llegó uno nuevo). */
export function clearSelectedOrderContext(phone: string): void {
  ctx()
    .db.prepare(
      `UPDATE conversation_order_context
       SET selected_order_id = NULL, selected_at = NULL, pending_cancel_order_id = NULL,
           updated_at = unixepoch()
       WHERE phone = ?`
    )
    .run(phone);
}

/**
 * Registra el TIPO de mensaje que estamos a punto de mandar y devuelve
 * cuántas veces SEGUIDAS hemos mandado ese mismo tipo (contando esta).
 *
 * Es el anti-bucle: si el selector de pedidos va a salir por tercera vez
 * idéntico, quien llama puede cambiar de estrategia en vez de repetirlo.
 * Mandar un tipo distinto resetea la cuenta.
 */
export function recordConversationPrompt(phone: string, promptType: string): number {
  const db = ctx().db;
  db.prepare(
    `INSERT INTO conversation_order_context (phone, last_prompt_type, same_prompt_count, updated_at)
     VALUES (?, ?, 1, unixepoch())
     ON CONFLICT(phone) DO UPDATE SET
       same_prompt_count = CASE WHEN conversation_order_context.last_prompt_type = excluded.last_prompt_type
                                THEN conversation_order_context.same_prompt_count + 1 ELSE 1 END,
       last_prompt_type = excluded.last_prompt_type,
       updated_at = unixepoch()`
  ).run(phone, promptType);
  const row = db
    .prepare("SELECT same_prompt_count FROM conversation_order_context WHERE phone = ?")
    .get(phone) as { same_prompt_count: number };
  return row.same_prompt_count;
}

/** La conversación avanzó: el próximo selector volvería a contar desde 1. */
export function resetConversationPrompt(phone: string): void {
  ctx()
    .db.prepare(
      `UPDATE conversation_order_context
       SET last_prompt_type = NULL, same_prompt_count = 0, updated_at = unixepoch()
       WHERE phone = ?`
    )
    .run(phone);
}

/** Deja armada una cancelación pendiente de confirmación explícita. */
export function setPendingCancelContext(phone: string, orderId: number | null): void {
  ctx()
    .db.prepare(
      `INSERT INTO conversation_order_context (phone, pending_cancel_order_id, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(phone) DO UPDATE SET
         pending_cancel_order_id = excluded.pending_cancel_order_id,
         updated_at = unixepoch()`
    )
    .run(phone, orderId);
}

/** Marca un pedido como posible duplicado (señal para Pedro; nunca cancela). */
export function markOrderPossibleDuplicate(id: number): void {
  ctx().db.prepare(`UPDATE orders SET possible_duplicate = 1, ${TOUCH} WHERE id = ?`).run(id);
}

/**
 * El cliente pidió cancelar y lo CONFIRMÓ. No se toca Shopify ni el
 * proveedor: se estampa la petición y el pedido pasa a needs_call para que
 * Pedro decida. La cancelación real es una acción humana.
 */
export function requestOrderCancellation(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET cancellation_requested_at = COALESCE(cancellation_requested_at, unixepoch()), ${TOUCH}
       WHERE id = ? AND status NOT IN ('confirmed','cancelled','ignored_old')`
    )
    .run(id);
  if (info.changes === 0) return false;
  markOrderNeedsCall(id);
  return true;
}

/**
 * Cancelación solicitada DESPUÉS de confirmar el pedido.
 * Solo la deja para gestión humana: NO toca Shopify ni proveedor.
 */
export function requestConfirmedOrderCancellation(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders
       SET cancellation_requested_at = COALESCE(cancellation_requested_at, unixepoch()),
           status = 'needs_call',
           needs_call_at = COALESCE(needs_call_at, unixepoch()),
           ${TOUCH}
       WHERE id = ?
         AND status = 'confirmed'
         AND COALESCE(closure_status, 'unknown')
             NOT IN ('cancelled','delivered','refused')`
    )
    .run(id);
  return info.changes > 0;
}

// --- Colas del scheduler (todo se deriva de la DB: sobrevive reinicios) ---

export function getOrdersDueInitialSend(limit = 20): OrderRow[] {
  return ctx()
    .db.prepare(
      "SELECT * FROM orders WHERE status = 'pending_send' AND phone != '' ORDER BY created_at ASC LIMIT ?"
    )
    .all(limit) as OrderRow[];
}

/** Enviado hace más de X, sin NINGUNA respuesta del cliente → toca recordatorio. */
export function getOrdersDueReminder(sentBeforeTs: number, limit = 20): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE status = 'awaiting_reply' AND customer_replied_at IS NULL
         AND whatsapp_sent_at IS NOT NULL AND whatsapp_sent_at <= ?
       ORDER BY whatsapp_sent_at ASC LIMIT ?`
    )
    .all(sentBeforeTs, limit) as OrderRow[];
}

/**
 * Enviado hace más de X y sigue sin resolverse (haya contestado algo ilegible,
 * pedido "3" sin mandar la nota, o nada) → Pedro tiene que llamar.
 * needs_correction NO escala: ya está en su bandeja de revisión (CORRECCIÓN).
 */
export function getOrdersDueNeedsCall(sentBeforeTs: number, limit = 50): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE status IN ('awaiting_reply','reminder_sent','awaiting_delivery_note')
         AND whatsapp_sent_at IS NOT NULL AND whatsapp_sent_at <= ?
       ORDER BY whatsapp_sent_at ASC LIMIT ?`
    )
    .all(sentBeforeTs, limit) as OrderRow[];
}

// --- Transiciones de estado ---

/**
 * "Reclama" el envío inicial de forma atómica (idempotencia por acción):
 * solo transiciona si el pedido sigue en pending_send. Devuelve true si esta
 * llamada ganó el claim — SOLO entonces se debe encolar el mensaje. Así un
 * mismo pedido no puede generar dos mensajes iniciales.
 */
export function claimOrderInitialSend(id: number, ts?: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='awaiting_reply', whatsapp_sent_at = COALESCE(?, unixepoch()), ${TOUCH}
       WHERE id = ? AND status = 'pending_send' AND whatsapp_sent_at IS NULL`
    )
    .run(ts ?? null, id);
  return info.changes > 0;
}

/** Claim atómico del recordatorio: un pedido jamás recibe dos reminders. */
export function claimOrderReminder(id: number, ts?: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='reminder_sent', reminder_sent_at = COALESCE(?, unixepoch()), ${TOUCH}
       WHERE id = ? AND status = 'awaiting_reply' AND reminder_sent_at IS NULL`
    )
    .run(ts ?? null, id);
  return info.changes > 0;
}

// --- MÁQUINA DE ESTADOS CENTRALIZADA ---
// Cada transición lleva su guarda WHERE: una transición inválida (p.ej.
// confirmed → needs_call, cancelled → confirmed, ignored_old → cualquier
// cosa) simplemente NO se aplica y la función devuelve false para que el
// llamante lo loguee. Los estados terminales (confirmed, cancelled,
// ignored_old) no se reactivan jamás por automatización.

/** Pedido demasiado antiguo para actuar: SOLO desde la cola de envío. Terminal. */
export function markOrderIgnoredOld(id: number, reason?: string): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='ignored_old', last_error = COALESCE(?, last_error), ${TOUCH}
       WHERE id = ? AND status = 'pending_send'`
    )
    .run(reason ?? null, id);
  return info.changes > 0;
}

/**
 * Claim de confirmación: solo desde estados vivos. Devuelve false si ya
 * estaba confirmado/cancelado/ignorado — el llamante NO debe disparar el tag
 * (así una doble confirmación jamás produce dos mutaciones).
 */
export function markOrderConfirmed(id: number, viaReply: boolean): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='confirmed', confirmed_at = unixepoch(),
        customer_replied_at = CASE WHEN ? THEN COALESCE(customer_replied_at, unixepoch()) ELSE customer_replied_at END,
        ${TOUCH}
       WHERE id = ? AND status NOT IN ('confirmed','cancelled','ignored_old')`
    )
    .run(viaReply ? 1 : 0, id);
  return info.changes > 0;
}

/** El cliente respondió "3": queda a la espera del texto de la nota. */
export function markOrderAwaitingDeliveryNote(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='awaiting_delivery_note',
        customer_replied_at = COALESCE(customer_replied_at, unixepoch()), ${TOUCH}
       WHERE id = ? AND status IN ('awaiting_reply','reminder_sent','needs_correction','awaiting_delivery_note')`
    )
    .run(id);
  return info.changes > 0;
}

/**
 * Guarda (añade) la nota para el repartidor y devuelve el pedido a
 * awaiting_reply: la nota NO confirma — sigue pendiente del 1/2.
 * Solo válida mientras el pedido espera la nota. Capada a 500 chars.
 */
export function saveOrderDeliveryNote(id: number, text: string): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET
        delivery_note = substr(COALESCE(delivery_note || char(10), '') || ?, 1, 500),
        status = 'awaiting_reply',
        customer_replied_at = COALESCE(customer_replied_at, unixepoch()),
        ${TOUCH}
       WHERE id = ? AND status = 'awaiting_delivery_note'`
    )
    .run(text.trim().slice(0, 400), id);
  return info.changes > 0;
}

export function markOrderNeedsCorrection(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='needs_correction', customer_replied_at = COALESCE(customer_replied_at, unixepoch()), ${TOUCH}
       WHERE id = ? AND status IN ('awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction')`
    )
    .run(id);
  return info.changes > 0;
}

/** A la lista de llamadas: desde cualquier estado vivo o con error, jamás desde terminales. */
export function markOrderNeedsCall(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='needs_call', needs_call_at = unixepoch(), ${TOUCH}
       WHERE id = ? AND status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction','error')`
    )
    .run(id);
  return info.changes > 0;
}

/** Descartar del flujo. Un pedido confirmado no se cancela por aquí. */
export function markOrderCancelled(id: number): boolean {
  const info = ctx()
    .db.prepare(`UPDATE orders SET status='cancelled', ${TOUCH} WHERE id = ? AND status != 'confirmed'`)
    .run(id);
  return info.changes > 0;
}

export function setOrderError(id: number, message: string): void {
  ctx()
    .db.prepare(`UPDATE orders SET status='error', last_error = ?, ${TOUCH} WHERE id = ?`)
    .run(message.slice(0, 300), id);
}

/** Registra que el cliente contestó (sea legible o no) sin cambiar el estado. */
export function setOrderCustomerReplied(id: number): void {
  ctx()
    .db.prepare(
      `UPDATE orders SET customer_replied_at = COALESCE(customer_replied_at, unixepoch()), ${TOUCH} WHERE id = ?`
    )
    .run(id);
}

/** Añade texto a la dirección propuesta (solo mientras está en corrección). */
export function appendOrderProposedAddress(id: number, text: string): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET
        proposed_address = substr(COALESCE(proposed_address || char(10), '') || ?, 1, 1000),
        customer_replied_at = COALESCE(customer_replied_at, unixepoch()),
        ${TOUCH}
       WHERE id = ? AND status = 'needs_correction'`
    )
    .run(text.trim().slice(0, 600), id);
  return info.changes > 0;
}

export function incrementOrderClarify(id: number): number {
  ctx().db.prepare(`UPDATE orders SET clarify_count = clarify_count + 1, ${TOUCH} WHERE id = ?`).run(id);
  return getOrderById(id)?.clarify_count ?? 0;
}

/**
 * Autoriza a mano ESTE pedido para el piloto (TEST_MODE): a partir de ahora
 * puede recibir mensaje inicial, recordatorios, respuestas y el tag
 * WA_CONFIRMED aunque su teléfono no esté en TEST_PHONE_ALLOWLIST.
 *
 * Es estrictamente por pedido: autorizar uno NO autoriza otros pedidos del
 * mismo teléfono ni de nadie más. No se puede autorizar un pedido en estado
 * terminal (cancelado/ignorado): no tendría efecto y confundiría.
 */
export function authorizeOrderForPilot(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET pilot_authorized = 1, ${TOUCH}
       WHERE id = ? AND status NOT IN ('cancelled','ignored_old')`
    )
    .run(id);
  return info.changes > 0;
}

/** Retira la autorización de piloto de un pedido (vuelve a quedar bloqueado). */
export function revokeOrderPilotAuthorization(id: number): boolean {
  const info = ctx()
    .db.prepare(`UPDATE orders SET pilot_authorized = 0, ${TOUCH} WHERE id = ?`)
    .run(id);
  return info.changes > 0;
}

/**
 * Marca que el pedido espera a la próxima apertura de la ventana horaria.
 * `until` pasa a ser la base desde la que se mide su antigüedad, para que
 * esperar a propósito jamás lo convierta en ignored_old.
 */
export function deferOrderUntil(id: number, until: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET deferred_until = ?, ${TOUCH}
       WHERE id = ? AND status = 'pending_send' AND (deferred_until IS NULL OR deferred_until < ?)`
    )
    .run(until, id, until);
  return info.changes > 0;
}

export function setOrderShopifyTagged(id: number): void {
  ctx().db.prepare(`UPDATE orders SET shopify_tagged = 1, ${TOUCH} WHERE id = ?`).run(id);
}

// --- Proveedores (Dropi/Dropea) — fase 2, hoy solo simulación ---

/** Pedidos confirmados cuya evaluación de proveedor conviene refrescar. */
export function getOrdersForSupplierEvaluation(limit = 50): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE status = 'confirmed' AND supplier_external_order_id IS NULL
         AND supplier_sync_status NOT IN ('synced','cancelled','syncing')
       ORDER BY confirmed_at ASC LIMIT ?`
    )
    .all(limit) as OrderRow[];
}

/**
 * Guarda el resultado de evaluar un pedido (plataforma + estado + motivo).
 * No dispara nada externo: es solo el "qué haríamos" persistido.
 */
export function setOrderSupplierEvaluation(
  id: number,
  platform: string | null,
  syncStatus: string,
  reason: string | null
): void {
  ctx()
    .db.prepare(
      `UPDATE orders SET supplier_platform = ?, supplier_sync_status = ?,
        supplier_last_error = ?, supplier_reference = COALESCE(supplier_reference, shopify_order_id),
        supplier_last_checked_at = unixepoch(), ${TOUCH}
       WHERE id = ? AND supplier_external_order_id IS NULL`
    )
    .run(platform, syncStatus, reason?.slice(0, 300) ?? null, id);
}

/** Tipos de aviso de postventa (cada uno con su sello anti-duplicado). */
export type TrackingNotificationKind =
  | "tracking"
  | "out_for_delivery"
  | "delivered"
  | "delivery_attempt"
  | "pickup_point";

const COLUMNA_SELLO: Record<TrackingNotificationKind, string> = {
  tracking: "tracking_notification_sent_at",
  out_for_delivery: "out_for_delivery_notification_sent_at",
  delivered: "delivered_notification_sent_at",
  delivery_attempt: "delivery_attempt_notification_sent_at",
  pickup_point: "pickup_point_notification_sent_at",
};

/**
 * RECLAMA el derecho a enviar un aviso, de forma atómica. Devuelve true solo
 * la primera vez: el UPDATE condicionado a `IS NULL` garantiza que, aunque
 * dos procesos vean la misma transición a la vez, únicamente uno gane.
 */
export function claimTrackingNotification(id: number, kind: TrackingNotificationKind): boolean {
  const col = COLUMNA_SELLO[kind];
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET ${col} = unixepoch(), ${TOUCH} WHERE id = ? AND ${col} IS NULL`
    )
    .run(id);
  return info.changes > 0;
}

/** Devuelve el sello (solo para tests o si el envío se descarta después). */
export function releaseTrackingNotification(id: number, kind: TrackingNotificationKind): void {
  ctx().db.prepare(`UPDATE orders SET ${COLUMNA_SELLO[kind]} = NULL WHERE id = ?`).run(id);
}

/** Guarda lo que el proveedor nos contó del envío (estado y tracking). */
export function updateOrderTracking(
  id: number,
  data: {
    rawStatus: string | null;
    normalizedStatus: string;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    carrier?: string | null;
    pickupPointInfo?: string | null;
    firstTracking: boolean;
  }
): void {
  ctx()
    .db.prepare(
      `UPDATE orders SET
        supplier_status_raw = COALESCE(?, supplier_status_raw),
        supplier_status_normalized = ?,
        tracking_number = COALESCE(?, tracking_number),
        tracking_url = COALESCE(?, tracking_url),
        carrier = COALESCE(?, carrier),
        pickup_point_info = COALESCE(?, pickup_point_info),
        tracking_first_seen_at = CASE WHEN ? THEN COALESCE(tracking_first_seen_at, unixepoch()) ELSE tracking_first_seen_at END,
        tracking_last_checked_at = unixepoch(),
        ${TOUCH}
       WHERE id = ?`
    )
    .run(
      data.rawStatus,
      data.normalizedStatus,
      data.trackingNumber ?? null,
      data.trackingUrl ?? null,
      data.carrier ?? null,
      data.pickupPointInfo ?? null,
      data.firstTracking ? 1 : 0,
      id
    );
}

/**
 * Liga un pedido a un proveedor y a su id externo. Se usa cuando el propio
 * proveedor nos avisa de un pedido que ya existe en su sistema: adoptamos su
 * id en vez de crear otro. Solo actúa si aún NO teníamos id externo, para no
 * pisar jamás una referencia existente.
 */
export function setOrderSupplierPlatformAndExternalId(
  id: number,
  platform: string,
  externalOrderId: string
): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET supplier_platform = ?, supplier_external_order_id = ?,
        supplier_sync_status = 'synced', supplier_synced_at = COALESCE(supplier_synced_at, unixepoch()),
        supplier_reference = COALESCE(supplier_reference, shopify_order_id), ${TOUCH}
       WHERE id = ? AND supplier_external_order_id IS NULL`
    )
    .run(platform, externalOrderId, id);
  return info.changes > 0;
}


// --- Fase A · Histórico de estados de envío ---

export type StatusHistorySource = "webhook" | "polling" | "manual" | "reconciliation";

/**
 * Cuál de las CUATRO máquinas de estado cambió. Ver docs/MODELO-ESTADOS.md.
 * No se mezclan: cada eje tiene su vocabulario, su fuente de verdad y sus
 * reglas de terminalidad.
 */
export type StatusAxis = "confirmation" | "supplier_sync" | "tracking" | "closure" | "beeping_release";

export const STATUS_AXES: StatusAxis[] = ["confirmation", "supplier_sync", "tracking", "closure", "beeping_release"];

export interface OrderStatusHistoryRow {
  id: number;
  order_id: number;
  shopify_order_id: string;
  supplier_platform: string | null;
  carrier: string | null;
  previous_status: string;
  new_status: string;
  raw_status: string | null;
  raw_sub_status: string | null;
  source: StatusHistorySource;
  status_axis: StatusAxis;
  event_id: string | null;
  occurred_at: number;
  recorded_at: number;
}

export interface StatusHistoryInput {
  orderId: number;
  shopifyOrderId: string;
  supplierPlatform: string | null;
  carrier: string | null;
  previousStatus: string;
  newStatus: string;
  rawStatus: string | null;
  rawSubStatus?: string | null;
  source: StatusHistorySource;
  /** Qué eje cambió. Por defecto 'tracking': es el único escritor histórico
   *  de esta tabla, así que omitirlo sigue siendo correcto para ese camino. */
  statusAxis?: StatusAxis;
  eventId?: string | null;
  /** Epoch segundos. Si no se conoce, ahora. */
  occurredAt?: number | null;
}

/**
 * Persiste UNA transición. Devuelve el id de la fila nueva o null si era un
 * duplicado. Reglas de dedupe:
 *   1. Con event_id: el índice único manda (un webhook reintentado no repite).
 *   2. Sin event_id: misma (pedido, de, a, raw) en los últimos 10 minutos
 *      se considera el mismo hecho (dos pollings seguidos, un reintento).
 */
export function insertOrderStatusHistory(h: StatusHistoryInput): number | null {
  const db = ctx().db;
  const occurredAt = h.occurredAt ?? Math.floor(Date.now() / 1000);
  const eventId = (h.eventId ?? "").trim() || null;
  if (eventId) {
    const dup = db.prepare("SELECT 1 FROM order_status_history WHERE event_id = ?").get(eventId);
    if (dup) return null;
  } else {
    const dup = db
      .prepare(
        `SELECT 1 FROM order_status_history
         WHERE order_id = ? AND previous_status = ? AND new_status = ?
           AND IFNULL(raw_status,'') = IFNULL(?, '')
           AND occurred_at >= ?`
      )
      .get(h.orderId, h.previousStatus, h.newStatus, h.rawStatus ?? null, occurredAt - 600);
    if (dup) return null;
  }
  const info = db
    .prepare(
      `INSERT INTO order_status_history
        (order_id, shopify_order_id, supplier_platform, carrier, previous_status, new_status,
         raw_status, raw_sub_status, source, status_axis, event_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      h.orderId,
      h.shopifyOrderId,
      h.supplierPlatform ?? null,
      h.carrier ?? null,
      h.previousStatus,
      h.newStatus,
      h.rawStatus ?? null,
      h.rawSubStatus ?? null,
      h.source,
      h.statusAxis ?? "tracking",
      eventId,
      occurredAt
    );
  return Number(info.lastInsertRowid);
}

export function listOrderStatusHistory(orderId: number): OrderStatusHistoryRow[] {
  return ctx()
    .db.prepare("SELECT * FROM order_status_history WHERE order_id = ? ORDER BY occurred_at, id")
    .all(orderId) as OrderStatusHistoryRow[];
}

// --- Fase A · Costes (unit economics, entrada manual) ---

export interface ProductCostRow {
  sku: string;
  title: string | null;
  product_cost: number | null;
  shipping_cost: number | null;
  cod_fee: number | null;
  /** Coste de manipulación del fulfillment (p.ej. Beeping). */
  handling_cost: number | null;
  updated_at: number;
}

export interface ProductCostHistoryRow {
  id: number;
  sku: string;
  title: string | null;
  product_cost: number | null;
  shipping_cost: number | null;
  cod_fee: number | null;
  handling_cost: number | null;
  effective_from: number;
  /** null = vigente hoy. */
  effective_to: number | null;
  created_at: number;
}

export function listProductCosts(): ProductCostRow[] {
  return ctx().db.prepare("SELECT * FROM product_costs ORDER BY sku").all() as ProductCostRow[];
}

export function listProductCostHistory(sku?: string): ProductCostHistoryRow[] {
  const db = ctx().db;
  if (sku) {
    return db
      .prepare("SELECT * FROM product_cost_history WHERE sku = ? ORDER BY effective_from")
      .all(sku.trim()) as ProductCostHistoryRow[];
  }
  return db.prepare("SELECT * FROM product_cost_history ORDER BY sku, effective_from").all() as ProductCostHistoryRow[];
}

export function upsertProductCost(c: {
  sku: string;
  title?: string | null;
  product_cost?: number | null;
  shipping_cost?: number | null;
  cod_fee?: number | null;
  handling_cost?: number | null;
}): void {
  const sku = c.sku.trim();
  if (!sku) throw new Error("sku vacío");
  const db = ctx().db;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO product_costs (sku, title, product_cost, shipping_cost, cod_fee, handling_cost, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(sku) DO UPDATE SET
         title = COALESCE(excluded.title, product_costs.title),
         product_cost = COALESCE(excluded.product_cost, product_costs.product_cost),
         shipping_cost = COALESCE(excluded.shipping_cost, product_costs.shipping_cost),
         cod_fee = COALESCE(excluded.cod_fee, product_costs.cod_fee),
         handling_cost = COALESCE(excluded.handling_cost, product_costs.handling_cost),
         updated_at = unixepoch()`
    ).run(sku, c.title ?? null, c.product_cost ?? null, c.shipping_cost ?? null, c.cod_fee ?? null, c.handling_cost ?? null);

    // Historia versionada: si el resultado VIGENTE cambió, se cierra la fila
    // abierta y se abre una nueva. Nunca se toca una fila histórica cerrada.
    const vigente = db
      .prepare("SELECT * FROM product_costs WHERE sku = ?")
      .get(sku) as ProductCostRow;
    const abierta = db
      .prepare("SELECT * FROM product_cost_history WHERE sku = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1")
      .get(sku) as ProductCostHistoryRow | undefined;
    const cambia =
      !abierta ||
      abierta.product_cost !== vigente.product_cost ||
      abierta.shipping_cost !== vigente.shipping_cost ||
      abierta.cod_fee !== vigente.cod_fee ||
      abierta.handling_cost !== vigente.handling_cost;
    if (cambia) {
      const ahora = Math.floor(Date.now() / 1000);
      if (abierta) {
        db.prepare("UPDATE product_cost_history SET effective_to = ? WHERE id = ?").run(ahora, abierta.id);
      }
      db.prepare(
        `INSERT INTO product_cost_history (sku, title, product_cost, shipping_cost, cod_fee, handling_cost, effective_from, effective_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(sku, vigente.title, vigente.product_cost, vigente.shipping_cost, vigente.cod_fee, vigente.handling_cost, ahora);
    }
  });
  tx();
}

export function deleteProductCost(sku: string): void {
  ctx().db.prepare("DELETE FROM product_costs WHERE sku = ?").run(sku);
}

export interface DailyAdSpendRow {
  day: string;
  amount: number;
  source: string;
  updated_at: number;
}

export function listDailyAdSpend(fromDay?: string, toDay?: string): DailyAdSpendRow[] {
  const db = ctx().db;
  if (fromDay && toDay) {
    return db
      .prepare("SELECT * FROM daily_ad_spend WHERE day >= ? AND day <= ? ORDER BY day")
      .all(fromDay, toDay) as DailyAdSpendRow[];
  }
  return db.prepare("SELECT * FROM daily_ad_spend ORDER BY day DESC LIMIT 90").all() as DailyAdSpendRow[];
}

export function upsertDailyAdSpend(day: string, amount: number, source = "manual"): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("día inválido (YYYY-MM-DD)");
  if (!Number.isFinite(amount) || amount < 0) throw new Error("importe inválido");
  ctx()
    .db.prepare(
      `INSERT INTO daily_ad_spend (day, amount, source, updated_at) VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(day) DO UPDATE SET amount = excluded.amount, source = excluded.source, updated_at = unixepoch()`
    )
    .run(day, amount, source);
}

// --- Correspondencia de productos con el proveedor ---

export interface SupplierProductMapping {
  id: number;
  supplier_platform: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_sku: string | null;
  shopify_title: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string;
  supplier_unit_price: number | null;
  active: number;
  created_at: number;
  updated_at: number;
}

export function listSupplierProductMappings(platform?: string): SupplierProductMapping[] {
  const db = ctx().db;
  if (platform) {
    return db
      .prepare(
        "SELECT * FROM supplier_product_mapping WHERE supplier_platform = ? ORDER BY shopify_title, id"
      )
      .all(platform) as SupplierProductMapping[];
  }
  return db
    .prepare("SELECT * FROM supplier_product_mapping ORDER BY supplier_platform, shopify_title")
    .all() as SupplierProductMapping[];
}

/**
 * Alta o actualización de una correspondencia. La identidad es
 * (plataforma + SKU) cuando hay SKU, y (plataforma + título) si no.
 */
export function upsertSupplierProductMapping(m: {
  supplier_platform: string;
  shopify_product_id?: string | null;
  shopify_variant_id?: string | null;
  shopify_sku?: string | null;
  shopify_title?: string | null;
  supplier_product_id?: string | null;
  supplier_variant_id: string;
  supplier_unit_price?: number | null;
  active?: boolean;
}): number {
  const db = ctx().db;
  const existente = (
    m.shopify_sku
      ? db
          .prepare(
            "SELECT id FROM supplier_product_mapping WHERE supplier_platform = ? AND shopify_sku = ?"
          )
          .get(m.supplier_platform, m.shopify_sku)
      : db
          .prepare(
            "SELECT id FROM supplier_product_mapping WHERE supplier_platform = ? AND shopify_title = ?"
          )
          .get(m.supplier_platform, m.shopify_title ?? "")
  ) as { id: number } | undefined;

  if (existente) {
    db.prepare(
      `UPDATE supplier_product_mapping SET
        shopify_product_id = COALESCE(?, shopify_product_id),
        shopify_variant_id = COALESCE(?, shopify_variant_id),
        shopify_title = COALESCE(?, shopify_title),
        supplier_product_id = COALESCE(?, supplier_product_id),
        supplier_variant_id = ?,
        supplier_unit_price = COALESCE(?, supplier_unit_price),
        active = ?, updated_at = unixepoch()
       WHERE id = ?`
    ).run(
      m.shopify_product_id ?? null,
      m.shopify_variant_id ?? null,
      m.shopify_title ?? null,
      m.supplier_product_id ?? null,
      m.supplier_variant_id,
      m.supplier_unit_price ?? null,
      m.active === false ? 0 : 1,
      existente.id
    );
    return existente.id;
  }

  const info = db
    .prepare(
      `INSERT INTO supplier_product_mapping
        (supplier_platform, shopify_product_id, shopify_variant_id, shopify_sku, shopify_title,
         supplier_product_id, supplier_variant_id, supplier_unit_price, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.supplier_platform,
      m.shopify_product_id ?? null,
      m.shopify_variant_id ?? null,
      m.shopify_sku ?? null,
      m.shopify_title ?? null,
      m.supplier_product_id ?? null,
      m.supplier_variant_id,
      m.supplier_unit_price ?? null,
      m.active === false ? 0 : 1
    );
  return info.lastInsertRowid as number;
}

/**
 * Activa o desactiva un mapping sin borrarlo.
 *
 * Desactivar en vez de borrar es lo correcto aquí: si un mapping estaba mal,
 * borrarlo pierde la evidencia de qué se estaba usando y por qué un pedido
 * se enrutó como se enrutó. Desactivado deja de decidir routing pero sigue
 * siendo consultable.
 */
export function setSupplierProductMappingActive(id: number, active: boolean): boolean {
  const info = ctx()
    .db.prepare("UPDATE supplier_product_mapping SET active = ?, updated_at = unixepoch() WHERE id = ?")
    .run(active ? 1 : 0, id);
  return info.changes > 0;
}

/** Un mapping concreto, por id. */
export function getSupplierProductMapping(id: number): SupplierProductMapping | null {
  return (
    (ctx().db.prepare("SELECT * FROM supplier_product_mapping WHERE id = ?").get(id) as
      | SupplierProductMapping
      | undefined) ?? null
  );
}

export function deleteSupplierProductMapping(id: number): void {
  ctx().db.prepare("DELETE FROM supplier_product_mapping WHERE id = ?").run(id);
}

// --- Deduplicación de webhooks por event_id ---

/**
 * Registra un evento de webhook. Devuelve true si es NUEVO (hay que
 * procesarlo) y false si ya se había recibido: el INSERT OR IGNORE sobre la
 * clave primaria hace la comprobación atómica.
 */
export function claimWebhookEvent(
  eventId: string,
  platform: string,
  topic?: string | null,
  resourceId?: string | null
): boolean {
  const info = ctx()
    .db.prepare(
      `INSERT OR IGNORE INTO supplier_webhook_events (event_id, platform, topic, resource_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(eventId, platform, topic ?? null, resourceId ?? null);
  return info.changes > 0;
}

/**
 * Ids de pedido (resource_id) distintos vistos en webhooks de PEDIDO (nunca
 * de incidencia) de una plataforma — la población exacta que el
 * reconciliador de Dropea (E8) tiene que emparejar. Orden ascendente y
 * numérico cuando el id lo permite, para que un checkpoint por "último
 * procesado" tenga sentido entre ejecuciones.
 */
export function listOrderWebhookResourceIds(platform: string): string[] {
  const rows = ctx()
    .db.prepare(
      `SELECT DISTINCT resource_id FROM supplier_webhook_events
       WHERE platform = ? AND topic LIKE 'order.%' AND resource_id IS NOT NULL`
    )
    .all(platform) as Array<{ resource_id: string }>;
  return rows
    .map((r) => r.resource_id)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
}

/** Limpia eventos antiguos (por defecto, más de 30 días). */
export function pruneWebhookEvents(olderThanDays = 30): number {
  const info = ctx()
    .db.prepare("DELETE FROM supplier_webhook_events WHERE received_at < unixepoch() - ? * 86400")
    .run(olderThanDays);
  return info.changes;
}

// --- Fase de creación en el proveedor (create → confirm) ---

export type SupplierCreatePhase =
  | "none"
  | "creating"
  | "created"
  | "confirming"
  | "confirmed"
  | "failed";

/**
 * Reclama el paso de CREACIÓN de forma atómica y deja persistida la clave de
 * idempotencia. Devuelve false si otro proceso ya lo reclamó o si el pedido
 * ya pasó de fase: así un reinicio a mitad NUNCA provoca un segundo create.
 */
export function claimSupplierCreate(id: number, idempotencyKey: string): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET supplier_create_phase = 'creating',
        supplier_idempotency_key = COALESCE(supplier_idempotency_key, ?),
        supplier_sync_status = 'syncing', ${TOUCH}
       WHERE id = ? AND supplier_create_phase IN ('none','failed')
         AND supplier_external_order_id IS NULL`
    )
    .run(idempotencyKey, id);
  return info.changes > 0;
}

/** Marca la creación como terminada, guardando el id del proveedor. */
export function markSupplierCreated(id: number, platform: string, externalOrderId: string): void {
  ctx()
    .db.prepare(
      `UPDATE orders SET supplier_create_phase = 'created', supplier_platform = ?,
        supplier_external_order_id = ?, supplier_synced_at = COALESCE(supplier_synced_at, unixepoch()),
        supplier_sync_status = 'synced', ${TOUCH}
       WHERE id = ?`
    )
    .run(platform, externalOrderId, id);
}

/** Reclama el paso de CONFIRMACIÓN (solo tras un create completado). */
export function claimSupplierConfirm(id: number, idempotencyKey: string): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET supplier_create_phase = 'confirming',
        supplier_confirm_idempotency_key = COALESCE(supplier_confirm_idempotency_key, ?), ${TOUCH}
       WHERE id = ? AND supplier_create_phase = 'created' AND supplier_external_order_id IS NOT NULL`
    )
    .run(idempotencyKey, id);
  return info.changes > 0;
}

export function markSupplierConfirmed(id: number): void {
  ctx()
    .db.prepare(`UPDATE orders SET supplier_create_phase = 'confirmed', ${TOUCH} WHERE id = ?`)
    .run(id);
}

/** Registra un fallo de creación sin perder la clave de idempotencia. */
export function markSupplierCreateFailed(id: number, error: string): void {
  ctx()
    .db.prepare(
      `UPDATE orders SET supplier_create_phase = 'failed', supplier_sync_status = 'failed',
        supplier_last_error = ?, supplier_sync_attempts = supplier_sync_attempts + 1, ${TOUCH}
       WHERE id = ?`
    )
    .run(error.slice(0, 300), id);
}

/** Estado de la nota del repartidor frente al proveedor. */
export function setOrderDeliveryNoteStatus(id: number, status: string): void {
  ctx()
    .db.prepare(`UPDATE orders SET supplier_delivery_note_status = ?, ${TOUCH} WHERE id = ?`)
    .run(status, id);
}

/** Busca un pedido por su número de seguimiento (vía de último recurso). */
export function getOrderByTrackingNumber(trackingNumber: string): OrderRow | null {
  return (
    (ctx()
      .db.prepare("SELECT * FROM orders WHERE tracking_number = ?")
      .get(trackingNumber) as OrderRow | undefined) ?? null
  );
}

/** Busca un pedido por su id en el proveedor (para procesar sus webhooks). */
export function getOrderBySupplierExternalId(externalId: string): OrderRow | null {
  return (
    (ctx()
      .db.prepare("SELECT * FROM orders WHERE supplier_external_order_id = ?")
      .get(externalId) as OrderRow | undefined) ?? null
  );
}

/** Autoriza (o retira) este pedido concreto para el piloto de proveedores. */
export function setOrderSupplierPilotApproval(id: number, approved: boolean): boolean {
  const info = ctx()
    .db.prepare(`UPDATE orders SET supplier_pilot_approved = ?, ${TOUCH} WHERE id = ?`)
    .run(approved ? 1 : 0, id);
  return info.changes > 0;
}

/**
 * Pedidos ya sincronizados cuyo envío sigue vivo: candidatos a consultar
 * estado. Excluye los terminales (entregado, devuelto, cancelado) para no
 * preguntar eternamente por algo que ya acabó.
 */
export function getOrdersForTrackingPolling(checkedBefore: number, limit = 25): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE supplier_external_order_id IS NOT NULL
         AND supplier_status_normalized NOT IN ('delivered','returned','cancelled')
         AND (tracking_last_checked_at IS NULL OR tracking_last_checked_at <= ?)
       ORDER BY COALESCE(tracking_last_checked_at, 0) ASC LIMIT ?`
    )
    .all(checkedBefore, limit) as OrderRow[];
}

/**
 * Manda un pedido a revisión de proveedor SIN la guarda de idempotencia:
 * hace falta para pedidos YA sincronizados que sufren una incidencia o una
 * devolución (setOrderSupplierEvaluation no los toca a propósito).
 */
export function setOrderSupplierReview(id: number, reason: string): void {
  ctx()
    .db.prepare(
      `UPDATE orders SET supplier_sync_status = 'manual_review', supplier_last_error = ?,
        supplier_last_checked_at = unixepoch(), ${TOUCH} WHERE id = ?`
    )
    .run(reason.slice(0, 300), id);
}

/** Decide qué dirección se usará con el proveedor ('original' | 'proposed'). */
export function setOrderFinalAddressSource(id: number, source: "original" | "proposed"): boolean {
  const info = ctx()
    .db.prepare(`UPDATE orders SET final_address_source = ?, ${TOUCH} WHERE id = ?`)
    .run(source, id);
  return info.changes > 0;
}

/**
 * Registra el cierre de un pedido (eje independiente de `status`, ver
 * ClosureStatus). Devuelve false SIN TOCAR NADA si la transición no está
 * permitida (el pedido ya está en un cierre terminal distinto) o si el
 * pedido no existe — así un evento tardío o duplicado nunca "reabre" un
 * pedido ya entregado, rechazado o cancelado.
 */
export function setOrderClosure(
  id: number,
  status: ClosureStatus,
  source: ClosureSource,
  at: number = Math.floor(Date.now() / 1000)
): boolean {
  const row = ctx().db.prepare("SELECT closure_status FROM orders WHERE id = ?").get(id) as
    | { closure_status: ClosureStatus }
    | undefined;
  if (!row) return false;
  if (!canTransitionClosure(row.closure_status, status)) return false;

  const info = ctx()
    .db.prepare(`UPDATE orders SET closure_status = ?, closure_source = ?, closure_at = ?, ${TOUCH} WHERE id = ?`)
    .run(status, source, at, id);
  if (info.changes === 0) return false;

  // Rastro en el histórico, marcado como eje de CIERRE. Sin esto, el eje que
  // manda en el dinero era el único sin auditoría: se veía el valor actual
  // pero no quién lo puso ni cuándo cambió. Repetir el mismo valor (permitido:
  // refresca fuente y fecha) no genera fila: no es una transición.
  if (row.closure_status !== status) {
    const meta = ctx().db.prepare("SELECT shopify_order_id, supplier_platform, carrier FROM orders WHERE id = ?").get(id) as
      | { shopify_order_id: string; supplier_platform: string | null; carrier: string | null }
      | undefined;
    if (meta) {
      insertOrderStatusHistory({
        orderId: id,
        shopifyOrderId: meta.shopify_order_id,
        supplierPlatform: meta.supplier_platform,
        carrier: meta.carrier,
        previousStatus: row.closure_status,
        newStatus: status,
        rawStatus: null,
        source: source === "llamada_ia" || source === "manual" ? "manual" : "webhook",
        statusAxis: "closure",
        occurredAt: at,
      });
    }
  }
  return true;
}

/** Marca updated_at sin cambiar nada más (backoff natural de reintentos). */
export function touchOrder(id: number): void {
  ctx().db.prepare(`UPDATE orders SET ${TOUCH} WHERE id = ?`).run(id);
}

/**
 * Pedidos confirmados (últimos 7 días) a los que aún no se pudo poner el tag
 * en Shopify y cuyo último intento (updated_at) es anterior a `notTouchedSince`.
 */
export function getConfirmedUntagged(notTouchedSince: number, limit = 5): OrderRow[] {
  return ctx()
    .db.prepare(
      `SELECT * FROM orders
       WHERE status = 'confirmed' AND shopify_tagged = 0
         AND confirmed_at IS NOT NULL AND confirmed_at >= unixepoch() - 7*86400
         AND updated_at <= ?
       ORDER BY confirmed_at ASC LIMIT ?`
    )
    .all(notTouchedSince, limit) as OrderRow[];
}

/**
 * Acción manual "Reenviar WhatsApp": vuelve a la cola de envío desde cero.
 * Nunca desde confirmed (no tiene sentido volver a pedir confirmación).
 * Nota: si el pedido supera MAX_ORDER_AGE_MINUTES, el scheduler lo marcará
 * ignored_old en vez de enviarlo (protección deliberada).
 */
export function resetOrderForResend(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status='pending_send', whatsapp_sent_at = NULL, reminder_sent_at = NULL,
        customer_replied_at = NULL, needs_call_at = NULL, clarify_count = 0, last_error = NULL, ${TOUCH}
       WHERE id = ? AND status != 'confirmed'`
    )
    .run(id);
  return info.changes > 0;
}

/** Mensajes de leads (role user) desde `sinceTs`, para clasificar dudas con IA. */
export function getUserMessagesSince(sinceTs: number, limit = 300): string[] {
  return (
    ctx()
      .db.prepare(
        "SELECT content FROM messages WHERE role='user' AND created_at >= ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(sinceTs, limit) as Array<{ content: string }>
  ).map((r) => r.content);
}

// ============================================================
// E7 · Orquestador de llamadas — helpers de persistencia
// ============================================================

export type CallAttemptState =
  | "planned"
  | "reserved"
  | "dialing"
  | "in_flight"
  | "completed"
  | "cancelled"
  | "manual_review";

export interface CallAttemptRow {
  id: number;
  order_id: number;
  contact_number: number;
  state: CallAttemptState;
  scheduled_at: number;
  shadow_logged_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  provider_call_id: string | null;
  provider_status: string | null;
  result: string | null;
  retry_consumed: number;
  reason: string | null;
  created_at: number;
  updated_at: number;
  /** Qué agente/versión de Retell atendió (v16, incidente 02-09). */
  agent_id: string | null;
  agent_version: string | null;
}

/** Crea un intento en cola. Devuelve null si el pedido YA tiene un intento
 *  vivo (el índice único parcial lo impide — jamás dos llamadas en vuelo). */
export function insertCallAttempt(orderId: number, contactNumber: number, scheduledAt: number): number | null {
  try {
    const info = ctx()
      .db.prepare(
        "INSERT INTO call_attempts (order_id, contact_number, scheduled_at) VALUES (?, ?, ?)"
      )
      .run(orderId, contactNumber, scheduledAt);
    return Number(info.lastInsertRowid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return null;
    throw err;
  }
}

export function getCallAttempt(id: number): CallAttemptRow | null {
  return (ctx().db.prepare("SELECT * FROM call_attempts WHERE id = ?").get(id) as CallAttemptRow) ?? null;
}

export function getCallAttemptByProviderId(providerCallId: string): CallAttemptRow | null {
  return (
    (ctx().db.prepare("SELECT * FROM call_attempts WHERE provider_call_id = ?").get(providerCallId) as CallAttemptRow) ??
    null
  );
}

export function getActiveCallAttemptForOrder(orderId: number): CallAttemptRow | null {
  return (
    (ctx()
      .db.prepare(
        "SELECT * FROM call_attempts WHERE order_id = ? AND state IN ('planned','reserved','dialing','in_flight')"
      )
      .get(orderId) as CallAttemptRow) ?? null
  );
}

export function listCallAttemptsForOrder(orderId: number): CallAttemptRow[] {
  return ctx()
    .db.prepare("SELECT * FROM call_attempts WHERE order_id = ? ORDER BY id")
    .all(orderId) as CallAttemptRow[];
}

export function listCallAttemptsByState(state: CallAttemptState, limit = 100): CallAttemptRow[] {
  return ctx()
    .db.prepare("SELECT * FROM call_attempts WHERE state = ? ORDER BY scheduled_at LIMIT ?")
    .all(state, limit) as CallAttemptRow[];
}

/** Intentos en cola cuyo momento ya llegó. */
export function listDueCallAttempts(nowS: number, limit = 20): CallAttemptRow[] {
  return ctx()
    .db.prepare(
      "SELECT * FROM call_attempts WHERE state = 'planned' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?"
    )
    .all(nowS, limit) as CallAttemptRow[];
}

/** Reclamo atómico planned → reserved. true solo para UN worker. */
export function claimCallAttempt(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE call_attempts SET state = 'reserved', updated_at = unixepoch() WHERE id = ? AND state = 'planned'`
    )
    .run(id);
  return info.changes > 0;
}

/** Transición de estado con guardia sobre el estado actual (compare-and-set). */
export function transitionCallAttempt(
  id: number,
  fromStates: CallAttemptState[],
  to: CallAttemptState,
  patch: Partial<{
    scheduled_at: number;
    shadow_logged_at: number | null;
    started_at: number;
    ended_at: number;
    provider_call_id: string;
    provider_status: string;
    result: string;
    retry_consumed: number;
    reason: string;
    agent_id: string | null;
    agent_version: string | null;
  }> = {}
): boolean {
  const sets: string[] = ["state = ?", "updated_at = unixepoch()"];
  const vals: unknown[] = [to];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  const ph = fromStates.map(() => "?").join(",");
  const info = ctx()
    .db.prepare(`UPDATE call_attempts SET ${sets.join(", ")} WHERE id = ? AND state IN (${ph})`)
    .run(...vals, id, ...fromStates);
  return info.changes > 0;
}

/** Contactos ya CONSUMIDOS de un pedido (intentos completados que gastaron cupo). */
export function countConsumedContacts(orderId: number): number {
  const r = ctx()
    .db.prepare(
      "SELECT COUNT(*) AS n FROM call_attempts WHERE order_id = ? AND retry_consumed = 1"
    )
    .get(orderId) as { n: number };
  return r.n;
}

/** Fallos técnicos seguidos (para el tope de provider_error_exhausted). */
export function countRecentTechFailures(orderId: number): number {
  const rows = ctx()
    .db.prepare(
      "SELECT result FROM call_attempts WHERE order_id = ? AND state = 'completed' ORDER BY id DESC LIMIT 5"
    )
    .all(orderId) as Array<{ result: string | null }>;
  let n = 0;
  for (const r of rows) {
    if (r.result === "fallo_tecnico") n++;
    else break;
  }
  return n;
}

/** Llamadas REALES arrancadas desde un timestamp (para el tope diario). */
export function countCallsStartedSince(sinceS: number): number {
  const r = ctx()
    .db.prepare(
      "SELECT COUNT(*) AS n FROM call_attempts WHERE started_at IS NOT NULL AND started_at >= ?"
    )
    .get(sinceS) as { n: number };
  return r.n;
}

/** ¿Tiene el pedido algún intento pendiente de revisión humana? */
export function hasManualReviewCallAttempt(orderId: number): boolean {
  return Boolean(
    ctx().db.prepare("SELECT 1 FROM call_attempts WHERE order_id = ? AND state = 'manual_review'").get(orderId)
  );
}

export interface CallQueueSummary {
  planned: number;
  inFlight: number;
  completedToday: number;
  manualReview: number;
  shadowPending: number;
}

export function getCallQueueSummary(startOfDayS: number): CallQueueSummary {
  const db = ctx().db;
  const c = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    planned: c("SELECT COUNT(*) AS n FROM call_attempts WHERE state IN ('planned','reserved','dialing')"),
    inFlight: c("SELECT COUNT(*) AS n FROM call_attempts WHERE state = 'in_flight'"),
    completedToday: c("SELECT COUNT(*) AS n FROM call_attempts WHERE state = 'completed' AND ended_at >= ?", startOfDayS),
    manualReview: c("SELECT COUNT(*) AS n FROM call_attempts WHERE state = 'manual_review'"),
    shadowPending: c("SELECT COUNT(*) AS n FROM call_attempts WHERE state = 'planned' AND shadow_logged_at IS NOT NULL"),
  };
}

// --- DNC (no volver a llamar) ---

/** DNC se compara SIEMPRE en forma canónica: "+34 600 11 22 33", "34600112233"
 *  y "600112233" son el mismo teléfono. Sin esto, un alta manual con
 *  espacios no bloquearía la llamada al mismo número guardado en dígitos. */
function dncCanonical(phone: string): string {
  return normalizePhone(phone ?? "");
}

export function addDncPhone(phone: string, source: string, opts: { reason?: string; orderId?: number; providerCallId?: string } = {}): void {
  const canon = dncCanonical(phone);
  if (!canon) return;
  ctx()
    .db.prepare(
      `INSERT INTO call_dnc (phone, source, reason, order_id, provider_call_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(phone) DO NOTHING`
    )
    .run(canon, source, opts.reason ?? null, opts.orderId ?? null, opts.providerCallId ?? null);
}

export function isDncPhone(phone: string): boolean {
  const canon = dncCanonical(phone);
  if (!canon) return false;
  return Boolean(ctx().db.prepare("SELECT 1 FROM call_dnc WHERE phone = ? OR phone = ?").get(canon, phone));
}

// --- Inbox de eventos del proveedor de voz ---

export interface CallEventRow {
  id: number;
  dedupe_key: string;
  provider_call_id: string;
  event_type: string;
  event_at: number | null;
  received_at: number;
  payload_json: string | null;
  processed_at: number | null;
  processing_error: string | null;
}

/** Guarda un evento entrante. false = duplicado (dedupe_key ya visto). */
export function insertCallEvent(e: {
  dedupeKey: string;
  providerCallId: string;
  eventType: string;
  eventAt: number | null;
  payloadJson: string | null;
}): boolean {
  try {
    ctx()
      .db.prepare(
        `INSERT INTO call_events (dedupe_key, provider_call_id, event_type, event_at, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(e.dedupeKey, e.providerCallId, e.eventType, e.eventAt, e.payloadJson);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return false;
    throw err;
  }
}

export function listUnprocessedCallEvents(limit = 50): CallEventRow[] {
  return ctx()
    .db.prepare(
      "SELECT * FROM call_events WHERE processed_at IS NULL ORDER BY received_at, id LIMIT ?"
    )
    .all(limit) as CallEventRow[];
}

export function markCallEventProcessed(id: number, error: string | null = null): void {
  ctx()
    .db.prepare("UPDATE call_events SET processed_at = unixepoch(), processing_error = ? WHERE id = ?")
    .run(error, id);
}

// --- Auditoría de correcciones dictadas por llamada ---

export function insertOrderDataAudit(a: {
  orderId: number;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  source: string;
  providerCallId?: string | null;
}): void {
  ctx()
    .db.prepare(
      `INSERT INTO order_data_audit (order_id, field, old_value, new_value, source, provider_call_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(a.orderId, a.field, a.oldValue, a.newValue, a.source, a.providerCallId ?? null);
}

export function listOrderDataAudit(orderId: number): Array<{
  id: number;
  order_id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  source: string;
  provider_call_id: string | null;
  created_at: number;
}> {
  return ctx().db.prepare("SELECT * FROM order_data_audit WHERE order_id = ? ORDER BY id").all(orderId) as never;
}

/** Aplica una corrección de dirección/teléfono dictada por una llamada,
 *  con auditoría. Solo escribe si el valor nuevo es no-vacío y distinto. */
export function applyOrderCorrection(
  orderId: number,
  field: "address_line1" | "city" | "postal_code" | "phone",
  newValue: string,
  providerCallId: string | null
): boolean {
  const valor = newValue.trim();
  if (!valor) return false;
  const row = ctx().db.prepare(`SELECT ${field} AS v FROM orders WHERE id = ?`).get(orderId) as
    | { v: string | null }
    | undefined;
  if (!row) return false;
  if ((row.v ?? "").trim() === valor) return false;
  ctx().db.prepare(`UPDATE orders SET ${field} = ?, ${TOUCH} WHERE id = ?`).run(valor, orderId);
  insertOrderDataAudit({
    orderId,
    field,
    oldValue: row.v,
    newValue: valor,
    source: "llamada_ia",
    providerCallId,
  });
  return true;
}

/** Cancela el pedido en el eje OPERATIVO por resultado de llamada, solo
 *  desde estados vivos (nunca pisa confirmed/cancelled previos). */
export function markOrderCancelledByCall(id: number): boolean {
  const info = ctx()
    .db.prepare(
      `UPDATE orders SET status = 'cancelled', ${TOUCH}
       WHERE id = ? AND status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction','needs_call')`
    )
    .run(id);
  return info.changes > 0;
}
