import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth/guard";
import { inboundMediaDirectory } from "@/lib/whatsapp/meta-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ fileName: string }> }

export async function GET(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = requireStaff(req);
  if (!auth.ok) return auth.response;
  const fileName = (await params).fileName;
  if (!/^inbound-[0-9a-f-]+\.(?:jpe?g|png|webp)$/i.test(fileName)) {
    return NextResponse.json({ error: "archivo inválido" }, { status: 400 });
  }
  const filePath = path.join(inboundMediaDirectory(), fileName);
  if (!fs.existsSync(filePath)) return NextResponse.json({ error: "imagen no encontrada" }, { status: 404 });
  const ext = path.extname(fileName).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return new NextResponse(fs.readFileSync(filePath), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
