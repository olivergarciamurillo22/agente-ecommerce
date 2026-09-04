import { randomBytes } from "node:crypto";
import { systemDbHandle } from "@/lib/db";

export const SESSION_COOKIE = "casamable_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export type UserRole = "owner" | "agent";

export interface AuthUser { id: number; email: string; name: string; role: UserRole }

export function createSession(userId: number, now = Math.floor(Date.now() / 1000)): string {
  const token = randomBytes(32).toString("hex");
  systemDbHandle().prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, now + SESSION_TTL_SECONDS, now);
  return token;
}

export function getSessionUser(token: string, now = Math.floor(Date.now() / 1000)): AuthUser | null {
  const row = systemDbHandle().prepare(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
  ).get(token, now) as (AuthUser & { role: string }) | undefined;
  if (!row || (row.role !== "owner" && row.role !== "agent")) return null;
  return row as AuthUser;
}

export function deleteSession(token: string): void {
  systemDbHandle().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function readCookie(header: string | null, name = SESSION_COOKIE): string | null {
  const pair = (header ?? "").split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}
