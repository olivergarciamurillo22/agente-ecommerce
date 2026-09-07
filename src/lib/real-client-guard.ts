import { normalizePhone } from "./orders/normalize";

export type RealClientOrigin = "manual" | "scheduler" | "script" | "provider";
export interface RealClientVerdict { allowed: boolean; reason: string | null }

/** Frontera anti-cliente-real. No existe variable de bypass. */
export function guardRealClient(phone: string, _origin: RealClientOrigin): RealClientVerdict {
  if (process.env.EMERGENCY_STOP !== "0") return { allowed: false, reason: "EMERGENCY_STOP activo: contacto real bloqueado" };
  if (process.env.TEST_MODE === "0") return { allowed: true, reason: null };
  const normalized = normalizePhone(phone);
  const allowlist = (process.env.TEST_PHONE_ALLOWLIST ?? "").split(",").map(normalizePhone).filter(Boolean);
  if (normalized && allowlist.includes(normalized)) return { allowed: true, reason: null };
  return { allowed: false, reason: "TEST_MODE activo: teléfono fuera de TEST_PHONE_ALLOWLIST" };
}

export function assertRealClientAllowed(phone: string, origin: RealClientOrigin): void {
  const verdict = guardRealClient(phone, origin);
  if (!verdict.allowed) throw new Error(`anti_cliente_real: ${verdict.reason}`);
}
