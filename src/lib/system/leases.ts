// ============================================================
// LEASES DE SCHEDULER — que dos procesos no dupliquen efectos externos.
//
// El problema: las guardas `if (timer) return` + `ticking` de cada scheduler
// son EN MEMORIA. Protegen dentro de un proceso y no protegen nada si
// arrancan dos (dos contenedores, un reinicio solapado, alguien corriendo
// `npm run start:bot` a mano mientras el contenedor está vivo). Y lo que
// duplicarían no son lecturas: son WhatsApps y llamadas telefónicas.
//
// La solución es un lease en SQLite, que ya es el punto de sincronización de
// todo el sistema. Sin Redis, sin infraestructura nueva.
//
// ── CÓMO FUNCIONA ──────────────────────────────────────────────
// Cada scheduler pide un lease antes de ejecutar. El lease tiene dueño
// (`owner_id`, único por proceso) y caducidad (`lease_until`). Mientras no
// caduque, solo su dueño puede renovarlo; cuando caduca, cualquiera puede
// robarlo. Eso es lo que hace que un proceso muerto NO bloquee el sistema
// para siempre: el lease se recupera solo, sin intervención.
//
// La adquisición es UNA sentencia SQL con `WHERE` sobre el estado anterior,
// así que es atómica: si dos procesos la ejecutan a la vez, exactamente uno
// ve `changes > 0`. Mismo patrón que el claim del outbox y el de las
// notificaciones de tracking.
//
// ── ELECCIÓN DEL TTL ───────────────────────────────────────────
// El TTL debe ser MAYOR que lo que tarda un tick, o el dueño perdería su
// propio lease a mitad de trabajo y otro proceso entraría en paralelo — justo
// lo que se quiere evitar. Por eso cada scheduler declara el suyo y renueva
// al empezar cada tick.
// ============================================================

import { systemDbHandle } from "../db";

/** Identidad de ESTE proceso. Se calcula una vez y no cambia en su vida. */
let ownerId: string | null = null;

export function processOwnerId(): string {
  if (ownerId) return ownerId;
  // pid + arranque + un sufijo aleatorio: dos procesos del mismo contenedor
  // pueden compartir pid tras un reinicio, el sufijo los separa.
  const rnd = Math.floor(Math.random() * 1e9).toString(36);
  ownerId = `${process.pid}-${Date.now().toString(36)}-${rnd}`;
  return ownerId;
}

/** Solo para tests: permite simular otro proceso. */
export function __setOwnerIdForTests(id: string | null): void {
  ownerId = id;
}

export interface LeaseRow {
  name: string;
  owner_id: string;
  lease_until: number;
  last_acquired_at: number | null;
  last_released_at: number | null;
  heartbeat_at: number | null;
  acquire_count: number;
}

/**
 * Intenta adquirir (o renovar) el lease. Devuelve `true` SOLO si este dueño
 * tiene derecho a ejecutar.
 *
 * Gana si:
 *   · no existe el lease todavía, o
 *   · está caducado (`lease_until <= now`), o
 *   · ya era suyo (renovación).
 *
 * Es una sola sentencia: dos procesos simultáneos → exactamente uno gana.
 */
export function acquireLease(
  name: string,
  ttlSeconds: number,
  opts: { owner?: string; nowSec?: number } = {}
): boolean {
  const owner = opts.owner ?? processOwnerId();
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const until = now + Math.max(1, Math.floor(ttlSeconds));
  const info = systemDbHandle()
    .prepare(
      `INSERT INTO scheduler_leases (name, owner_id, lease_until, last_acquired_at, heartbeat_at, acquire_count)
       VALUES (@name, @owner, @until, @now, @now, 1)
       ON CONFLICT(name) DO UPDATE SET
         owner_id = @owner,
         lease_until = @until,
         heartbeat_at = @now,
         last_acquired_at = CASE WHEN scheduler_leases.owner_id = @owner
                                 THEN scheduler_leases.last_acquired_at ELSE @now END,
         acquire_count = scheduler_leases.acquire_count
                         + CASE WHEN scheduler_leases.owner_id = @owner THEN 0 ELSE 1 END
       WHERE scheduler_leases.lease_until <= @now OR scheduler_leases.owner_id = @owner`
    )
    .run({ name, owner, until, now });
  return info.changes > 0;
}

/** Latido sin extender el derecho: solo deja constancia de que sigue vivo. */
export function heartbeatLease(name: string, opts: { owner?: string; nowSec?: number } = {}): void {
  const owner = opts.owner ?? processOwnerId();
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  systemDbHandle()
    .prepare("UPDATE scheduler_leases SET heartbeat_at = ? WHERE name = ? AND owner_id = ?")
    .run(now, name, owner);
}

/**
 * Suelta el lease para que otro pueda cogerlo YA, sin esperar a que caduque.
 * Se llama al apagar limpiamente. Solo el dueño puede soltarlo.
 */
export function releaseLease(name: string, opts: { owner?: string; nowSec?: number } = {}): boolean {
  const owner = opts.owner ?? processOwnerId();
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const info = systemDbHandle()
    .prepare(
      "UPDATE scheduler_leases SET lease_until = 0, last_released_at = ? WHERE name = ? AND owner_id = ?"
    )
    .run(now, name, owner);
  return info.changes > 0;
}

/** ¿Tiene ESTE proceso el lease ahora mismo? Lectura, no adquiere nada. */
export function holdsLease(name: string, opts: { owner?: string; nowSec?: number } = {}): boolean {
  const owner = opts.owner ?? processOwnerId();
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const row = systemDbHandle()
    .prepare("SELECT owner_id, lease_until FROM scheduler_leases WHERE name = ?")
    .get(name) as { owner_id: string; lease_until: number } | undefined;
  return Boolean(row && row.owner_id === owner && row.lease_until > now);
}

export function getLease(name: string): LeaseRow | null {
  return (
    (systemDbHandle().prepare("SELECT * FROM scheduler_leases WHERE name = ?").get(name) as
      | LeaseRow
      | undefined) ?? null
  );
}

export function listLeases(): LeaseRow[] {
  return systemDbHandle()
    .prepare("SELECT * FROM scheduler_leases ORDER BY name")
    .all() as LeaseRow[];
}

/**
 * Envoltura para el tick de un scheduler: si no se tiene el lease, NO se
 * ejecuta nada. Devuelve `null` cuando no se pudo adquirir, para que quien
 * llama pueda distinguir "no me tocaba" de "corrí y no hice nada".
 */
export async function withLease<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T> | T,
  opts: { owner?: string; nowSec?: number } = {}
): Promise<T | null> {
  if (!acquireLease(name, ttlSeconds, opts)) return null;
  return await fn();
}

/** Nombres canónicos. En un solo sitio para que no se escriban a mano. */
export const LEASE_ORDERS = "orders";
export const LEASE_TRACKING = "tracking";
export const LEASE_RECONCILE = "reconcile";
export const LEASE_CALLS = "calls";
export const LEASE_OUTBOX = "outbox";
export const LEASE_WATCHDOG = "watchdog";
