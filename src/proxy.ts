import { NextResponse, type NextRequest } from "next/server";
import { requireOwner, requireStaff } from "@/lib/auth/guard";

// Basic Auth is compared with timingSafeEqual inside the central guard.

// Contrato público: no modificar estos prefijos.
const PUBLIC_PREFIXES = ["/api/webhooks/", "/api/health"];
const LOGIN_PREFIXES = ["/login", "/api/auth/"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  if (LOGIN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  const result = pathname.startsWith("/trabajo") || pathname.startsWith("/api/workspace")
    ? requireStaff(req)
    : requireOwner(req);
  if (result.ok) return NextResponse.next();
  if (!pathname.startsWith("/api/") && result.response.status === 401) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return result.response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
