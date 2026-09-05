import { NextResponse, type NextRequest } from "next/server";
import { requireOwner, requireStaff } from "@/lib/auth/guard";

// ============================================================
// Clasificación de rutas en TRES niveles: PÚBLICA · STAFF · PROPIETARIO.
//
// El proxy decide UNA sola cosa: quién puede LLEGAR al handler. El permiso
// fino por acción vive en el handler, que es quien conoce el negocio — por
// ejemplo `/api/orders/{id}/action` deja entrar a un agente y allí dentro
// solo le permite `resend` (`call_now` y el resto siguen siendo del
// propietario). Doble política contradictoria = el bug del 04-09: el
// handler decía "staff" y el proxy contestaba 403 antes de llegar.
//
// POR QUÉ LA LISTA STAFF ES DE PATRONES EXACTOS Y NO DE PREFIJOS:
// un cómodo `/api/messages/` abriría también `/api/messages/{id}/image`,
// que NO tiene guard propio (sube un fichero a disco y encola un envío de
// WhatsApp). Cada patrón de esta lista se corresponde con un handler que
// tiene `requireStaff`. Antes de añadir uno, comprueba que el handler tenga
// su propio guard: aquí no se concede acceso a rutas sin autoridad detrás.
// ============================================================

// Contrato público: no modificar estos prefijos.
const PUBLIC_PREFIXES = ["/api/webhooks/", "/api/health"];
const LOGIN_PREFIXES = ["/login", "/api/auth/"];

/** Lo que un agente necesita para atender. Todas con `requireStaff`. */
const STAFF_PATTERNS: RegExp[] = [
  /^\/trabajo(?:\/.*)?$/, //           el espacio de atención al cliente
  /^\/api\/workspace$/, //             bandeja + conversación seleccionada
  /^\/api\/workspace\/action$/, //     corregir dirección, nota, resolver, escalar
  /^\/api\/mode\/[^/]+$/, //           IA → HUMANO
  /^\/api\/messages\/[^/]+$/, //       responder (NO .../image: sin guard propio)
  /^\/api\/media\/[^/]+$/, //          ver media entrante (handler con requireStaff)
  /^\/api\/orders\/[^/]+\/action$/, // el handler limita al agente a `resend`
];

const esRutaDeStaff = (pathname: string): boolean => STAFF_PATTERNS.some((re) => re.test(pathname));

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  if (LOGIN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();
  const result = esRutaDeStaff(pathname) ? requireStaff(req) : requireOwner(req);
  if (result.ok) return NextResponse.next();
  if (!pathname.startsWith("/api/") && result.response.status === 401) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return result.response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
