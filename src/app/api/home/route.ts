// La Home del Control Center v2 (§19): HOY + atención + flujo.
import { NextResponse } from "next/server";
import { getControlRoom } from "../../../lib/system/control-room";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...getControlRoom() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error interno" },
      { status: 500 }
    );
  }
}
