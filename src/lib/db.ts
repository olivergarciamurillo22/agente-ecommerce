import Database from "better-sqlite3";
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
  /** Referencia estable que enviamos al proveedor (nuestro shopify_order_id). */
  supplier_reference: string | null;
  supplier_sync_attempts: number;
  supplier_last_error: string | null;
  supplier_synced_at: number | null;
  supplier_last_checked_at: number | null;
  /** Estado del envío según el proveedor (texto suyo, sin normalizar todavía). */
  supplier_status: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;

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
      tracking_number TEXT,
      tracking_url TEXT,
      carrier TEXT,
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
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
// (ver errores-sesion.md #15)
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
  `);

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
  const stmtMarkOutboxSent = db.prepare("UPDATE outbox SET sent = 1 WHERE id = ?");

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

export function markOutboxSent(id: number): void {
  ctx().stmtMarkOutboxSent.run(id);
}

/**
 * Devuelve un item del outbox a "pendiente" (sent=0). Se usa cuando el envío
 * por Baileys falla DESPUÉS de haberlo reclamado (patrón claim→send→revert):
 * así un fallo blando se reintenta sin que un crash pueda duplicar el envío.
 */
export function revertOutboxSent(id: number): void {
  ctx().db.prepare("UPDATE outbox SET sent = 0 WHERE id = ?").run(id);
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
        status, customer_note, last_error, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.raw_payload ?? null
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

export function getOrderByShopifyId(shopifyOrderId: string): OrderRow | null {
  return (
    (ctx().db.prepare("SELECT * FROM orders WHERE shopify_order_id = ?").get(shopifyOrderId) as
      | OrderRow
      | undefined) ?? null
  );
}

/** Lista pedidos, opcionalmente filtrados por estado, más recientes primero. */
export function listOrders(status?: OrderStatus, limit = 200): OrderRow[] {
  const db = ctx().db;
  if (status) {
    return db
      .prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(status, limit) as OrderRow[];
  }
  return db.prepare("SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as OrderRow[];
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

/** Decide qué dirección se usará con el proveedor ('original' | 'proposed'). */
export function setOrderFinalAddressSource(id: number, source: "original" | "proposed"): boolean {
  const info = ctx()
    .db.prepare(`UPDATE orders SET final_address_source = ?, ${TOUCH} WHERE id = ?`)
    .run(source, id);
  return info.changes > 0;
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
