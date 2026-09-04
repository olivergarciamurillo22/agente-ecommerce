import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser, readCookie, type AuthUser, type UserRole } from "./session";
import { timingSafeEqual } from "node:crypto";

export type AuthPrincipal = AuthUser | { id: null; email: ""; name: string; role: "owner" };
export type GuardResult = { ok: true; user: AuthPrincipal } | { ok: false; response: NextResponse };

function basicOwner(req: NextRequest): AuthPrincipal | null {
  const expected = process.env.DASHBOARD_PASSWORD;
  const header = req.headers.get("authorization") ?? "";
  if (!expected || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const supplied = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
    const wanted = Buffer.from(expected);
    if (supplied.length === wanted.length && timingSafeEqual(supplied, wanted)) {
      return { id: null, email: "", name: "Propietario (Basic Auth)", role: "owner" };
    }
  } catch { /* fail closed */ }
  return null;
}

export function requireRole(req: NextRequest, roles: UserRole[]): GuardResult {
  const token = readCookie(req.headers.get("cookie"));
  const user = (token ? getSessionUser(token) : null) ?? basicOwner(req);
  if (!user) return { ok: false, response: NextResponse.json({ ok: false, error: "Inicia sesión" }, { status: 401 }) };
  if (!roles.includes(user.role)) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "No tienes permiso" }, { status: 403 }) };
  }
  return { ok: true, user };
}

export const requireOwner = (req: NextRequest) => requireRole(req, ["owner"]);
export const requireStaff = (req: NextRequest) => requireRole(req, ["owner", "agent"]);
