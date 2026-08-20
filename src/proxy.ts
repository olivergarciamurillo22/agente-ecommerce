import { NextResponse, type NextRequest } from "next/server";

// ============================================================
// Protección básica del panel (opcional). [Convención "proxy" de Next 16,
// antes llamada middleware.]
//
// Si DASHBOARD_PASSWORD está definida, todo el dashboard y sus APIs piden
// Basic Auth (cualquier usuario + esa contraseña). Quedan SIEMPRE públicos:
//  - /api/webhooks/*  → Shopify tiene que poder entregar pedidos
//  - /api/health      → monitores externos
// Sin DASHBOARD_PASSWORD (uso local normal) no se interpone nada.
// ============================================================

const PUBLIC_PREFIXES = ["/api/webhooks/", "/api/health"];

/** Comparación en tiempo constante (sin node:crypto: esto corre en Edge). */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(pass, password)) return NextResponse.next();
    } catch {
      // header malformado → 401
    }
  }

  return new NextResponse("Autenticación requerida", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Panel de pedidos"' },
  });
}

export const config = {
  // Todo excepto los estáticos de Next (los prefijos públicos se filtran arriba).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
