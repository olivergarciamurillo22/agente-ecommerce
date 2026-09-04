import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "../../../lib/db";
import { requireOwner } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Valores por defecto (de las variables de entorno del servidor).
const DEFAULTS: Record<string, string> = {
  model: process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5",
  temperature: "0.4",
  paused: "0",
  buffer_seconds: process.env.BUFFER_SECONDS || "10",
  audio_enabled: "1",
  transcription_model: process.env.TRANSCRIPTION_MODEL || "google/gemini-2.5-flash",
  // Rampa de WhatsApp automático (V3 §9): pilot | 25 | 50 | 100.
  // pilot = SOLO la allowlist de pruebas (fail-closed, el default).
  whatsapp_rollout_percent: "pilot",
};

const ALLOWED = new Set(Object.keys(DEFAULTS));

function effective(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ALLOWED) out[k] = getSetting(k) ?? DEFAULTS[k];
  return out;
}

export async function GET(req: NextRequest) {
  const auth = requireOwner(req); if (!auth.ok) return auth.response;
  return NextResponse.json({ settings: effective(), defaults: DEFAULTS });
}

export async function POST(req: NextRequest) {
  const auth = requireOwner(req); if (!auth.ok) return auth.response;
  let body: { key?: string; value?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const { key, value } = body;
  if (!key || !ALLOWED.has(key) || typeof value !== "string") {
    return NextResponse.json({ ok: false, error: "Ajuste no permitido" }, { status: 400 });
  }

  // Validaciones por tipo
  let v = value.trim();
  if (key === "paused" || key === "audio_enabled") {
    v = v === "1" ? "1" : "0";
  } else if (key === "buffer_seconds") {
    const n = Math.min(Math.max(parseInt(v, 10) || 10, 0), 120);
    v = String(n);
  } else if (key === "temperature") {
    const n = parseFloat(v);
    v = String(Number.isFinite(n) ? Math.min(Math.max(n, 0), 1.5) : 0.4);
  } else if ((key === "model" || key === "transcription_model") && v.length === 0) {
    return NextResponse.json({ ok: false, error: "El modelo no puede estar vacío" }, { status: 400 });
  }

  setSetting(key, v);
  return NextResponse.json({ ok: true, settings: effective() });
}
