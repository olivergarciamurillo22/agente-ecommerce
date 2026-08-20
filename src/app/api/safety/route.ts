import { NextResponse } from "next/server";
import { safetyStatus } from "@/lib/safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado de seguridad para el banner del dashboard: que nunca haya que
 *  recordar de memoria cómo está el .env. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(safetyStatus());
}
