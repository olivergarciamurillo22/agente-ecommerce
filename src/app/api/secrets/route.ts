// ============================================================
// Ajustes → Integraciones → Claves de conexión (10-09-2026)
//
//   GET  → metadatos de las claves gestionables. NUNCA el valor: solo los
//          cuatro últimos caracteres, de dónde sale la que se usa, quién la
//          puso y cómo fue la última comprobación.
//   POST → { name, value }        guarda (comprobándola antes contra el proveedor)
//          { name, clear: true }  borra la del panel y devuelve el mando al .env
//          { name, value, force } guarda aunque la comprobación falle (el
//                                 cliente asume el riesgo; queda en auditoría)
//
// Solo rol `owner`. Un `agent` (atención al cliente) recibe 403: las claves
// de la empresa no son cosa suya.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { audit } from "@/lib/workspace";
import { SecretStore, secretsAvailable, isManagedSecret, managedSecret, type SecretMeta } from "@/lib/config/secrets";
import { verifySecret } from "@/lib/config/secrets-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface SecretsResponse {
  ok: boolean;
  /** false = falta SECRETS_MASTER_KEY: el módulo entero está apagado. */
  available: boolean;
  reason: string | null;
  secrets: SecretMeta[];
}

export async function GET(req: NextRequest) {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const disp = secretsAvailable();
  try {
    const meta = new SecretStore().meta();
    return NextResponse.json<SecretsResponse>({ ok: true, available: disp.ok, reason: disp.reason, secrets: meta });
  } catch (e) {
    return NextResponse.json({ ok: false, available: disp.ok, reason: e instanceof Error ? e.message : "no se pudo leer el estado de las claves", secrets: [] }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  const disp = secretsAvailable();
  if (!disp.ok) return NextResponse.json({ ok: false, error: disp.reason }, { status: 409 });

  let body: { name?: unknown; value?: unknown; clear?: unknown; force?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "cuerpo no válido" }, { status: 400 }); }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!isManagedSecret(name)) return NextResponse.json({ ok: false, error: "esa clave no se gestiona desde el panel" }, { status: 400 });
  const ficha = managedSecret(name)!;
  const store = new SecretStore();

  // --- borrar: vuelve a mandar el .env ---
  if (body.clear === true) {
    const borrada = store.clear(name);
    audit(auth.user, "clear_secret", "secret", name, { borrada });
    const meta = store.meta().find((m) => m.name === name)!;
    return NextResponse.json({
      ok: true,
      secret: meta,
      message: borrada
        ? meta.inEnv
          ? `«${ficha.label}» borrada del panel: vuelve a usarse la del servidor`
          : `«${ficha.label}» borrada. Ya no hay ninguna configurada: ${ficha.impact}`
        : "no había ninguna guardada en el panel",
    });
  }

  // --- guardar ---
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value) return NextResponse.json({ ok: false, error: "el valor está vacío" }, { status: 400 });
  if (value.length > 4096) return NextResponse.json({ ok: false, error: "el valor es demasiado largo: revisa que hayas pegado solo la clave" }, { status: 400 });
  if (/\s/.test(value)) return NextResponse.json({ ok: false, error: "el valor lleva espacios o saltos de línea: pega solo la clave, sin comillas ni el nombre de la variable" }, { status: 400 });

  // La prueba se hace con el valor CANDIDATO, sin tocar todavía el entorno.
  const verificacion = await verifySecret(name, value, { ...process.env, [name]: value });

  if (verificacion.status === "fallo" && body.force !== true) {
    return NextResponse.json({
      ok: false,
      verify: verificacion,
      error: `No se ha guardado: ${verificacion.message}.`,
      canForce: true,
      forceWarning: ficha.risk === "critico"
        ? `Si aun así quieres guardarla, ten en cuenta que es una clave crítica: ${ficha.impact}`
        : "Puedes guardarla igualmente si crees que la prueba falla por otro motivo.",
    }, { status: 422 });
  }

  try {
    store.set(name, value, auth.user.email || auth.user.name, { status: verificacion.status, message: verificacion.message });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "no se pudo guardar" }, { status: 500 });
  }

  // En auditoría queda QUÉ se cambió y CÓMO fue la prueba; nunca el valor.
  audit(auth.user, "set_secret", "secret", name, { verify: verificacion.status, forzado: body.force === true, risk: ficha.risk });

  const meta = store.meta().find((m) => m.name === name)!;
  const aviso = ficha.name === "META_WHATSAPP_VERIFY_TOKEN"
    ? " Acuérdate de poner este mismo valor en Meta → WhatsApp → Webhooks y volver a verificar."
    : verificacion.status === "no_verificable"
      ? ` Guardada, pero no se ha podido comprobar sola: ${verificacion.message}.`
      : "";
  return NextResponse.json({
    ok: true,
    secret: meta,
    verify: verificacion,
    message: `«${ficha.label}» guardada y en uso.${aviso}`,
  });
}
