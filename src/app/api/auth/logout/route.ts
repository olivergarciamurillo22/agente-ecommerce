import { NextResponse, type NextRequest } from "next/server";
import { deleteSession, readCookie, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const token = readCookie(req.headers.get("cookie"));
  if (token) deleteSession(token);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 0, path: "/" });
  return response;
}
