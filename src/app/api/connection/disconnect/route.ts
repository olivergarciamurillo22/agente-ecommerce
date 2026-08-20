import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { setConnectionState } from "@/lib/db";

export const dynamic = "force-dynamic";

const AUTH_DIR = path.resolve(process.cwd(), "auth");
const DATA_DIR = path.resolve(process.cwd(), "data");
const RESTART_FLAG = path.join(DATA_DIR, ".restart");

export async function POST(): Promise<NextResponse> {
  setConnectionState({
    status: "disconnected",
    qr_string: null,
    phone: null,
  });

  // Borrar la sesión de Baileys (cross-platform)
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }

  // Crear flag para que el proceso del bot reinicie
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(RESTART_FLAG, "");

  return NextResponse.json({ ok: true });
}
