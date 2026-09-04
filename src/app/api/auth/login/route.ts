import { NextResponse, type NextRequest } from "next/server";
import { systemDbHandle } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Datos no válidos" }, { status: 400 }); }
  const email = (body.email ?? "").trim().toLowerCase();
  const row = systemDbHandle().prepare(
    "SELECT id, role, password_hash FROM users WHERE email = ? AND active = 1"
  ).get(email) as { id: number; role: string; password_hash: string } | undefined;
  if (!row || !["owner", "agent"].includes(row.role) || !(await verifyPassword(body.password ?? "", row.password_hash))) {
    return NextResponse.json({ error: "Correo o contraseña incorrectos" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true, destination: row.role === "agent" ? "/trabajo" : "/" });
  response.cookies.set(SESSION_COOKIE, createSession(row.id), { httpOnly: true, secure: true, sameSite: "lax", maxAge: SESSION_TTL_SECONDS, path: "/" });
  return response;
}
