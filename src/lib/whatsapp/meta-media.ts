import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_INBOUND_IMAGE_BYTES = 12 * 1024 * 1024;

export function metaInboundMediaEnabled(): boolean {
  return process.env.META_WHATSAPP_MEDIA_DOWNLOAD_ENABLED !== "0";
}

function apiVersion(): string {
  return (process.env.META_WHATSAPP_API_VERSION ?? "").trim() || "v23.0";
}

function accessToken(): string {
  return (process.env.META_WHATSAPP_ACCESS_TOKEN ?? "").trim();
}

function extensionFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpg";
  throw new Error("formato de imagen entrante no permitido");
}

export function inboundMediaDirectory(): string {
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), "data");
  return path.join(dataDir, "media", "inbound");
}

export function inboundImageMarker(fileName: string): string {
  return `[[media:image:${fileName}]]`;
}

/** Descarga autenticada de una imagen que Meta ya entregó por webhook. */
export async function cacheMetaInboundImage(
  mediaId: string,
  mimeHint: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const token = accessToken();
  if (!token || !mediaId.trim()) throw new Error("credenciales o media id ausentes");
  const headers = { Authorization: `Bearer ${token}` };
  const meta = await fetchImpl(`https://graph.facebook.com/${apiVersion()}/${encodeURIComponent(mediaId)}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!meta.ok) throw new Error(`metadata de imagen: HTTP ${meta.status}`);
  const detail = (await meta.json()) as { url?: string; mime_type?: string };
  if (!detail.url || !detail.url.startsWith("https://")) throw new Error("Meta no devolvió una URL https de media");

  const file = await fetchImpl(detail.url, { method: "GET", headers, signal: AbortSignal.timeout(20_000) });
  if (!file.ok) throw new Error(`descarga de imagen: HTTP ${file.status}`);
  const length = Number(file.headers.get("content-length") ?? 0);
  if (length > MAX_INBOUND_IMAGE_BYTES) throw new Error("imagen entrante demasiado grande");
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_INBOUND_IMAGE_BYTES) throw new Error("tamaño de imagen entrante inválido");
  const mime = (detail.mime_type ?? mimeHint ?? file.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new Error("formato de imagen entrante no permitido");
  }

  const fileName = `inbound-${crypto.randomUUID()}.${extensionFor(mime)}`;
  const dir = inboundMediaDirectory();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buffer, { flag: "wx" });
  return fileName;
}
