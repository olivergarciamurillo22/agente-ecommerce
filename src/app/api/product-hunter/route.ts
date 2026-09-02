// ============================================================
// API del Cazador de productos — proxy fino sobre el adaptador.
//
// GET  ?op=availability
// GET  ?op=search&country=ES&keywords=...&platform=&creativeFormat=&activeOnly=1
//        &startedAfter=YYYY-MM-DD&minActiveDays=30&sort=&page=&pageSize=&category=
//        &advanced=<JSON>
// GET  ?op=candidates&status=a,b&country=&minScore=&saturation=
// GET  ?op=candidate&id=
// GET  ?op=compare&ids=a,b,c
// POST { op: "save",      result, note? }
// POST { op: "move",      id, status, note? }
// POST { op: "note",      id, text }
// POST { op: "economics", id, economics }
//
// Siempre { ok, ... }. Cuando la fuente no está configurada responde
// HTTP 200 con { ok:false, code:"NOT_CONFIGURED" } para que la UI pinte el
// estado vacío honesto en lugar de un error. El token del backend vive en el
// adaptador (servidor) y jamás viaja en ninguna respuesta.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import {
  createProductHunterDataSource,
  NotConfiguredError,
  productHunterAvailability,
  ProductHunterUpstreamError,
} from "@/lib/product-hunter/adapter";
import {
  isProductResearchStatus,
  normalizeAdLibraryResult,
  normalizeEconomics,
  ProductHunterInputError,
} from "@/lib/product-hunter/scoring";
import {
  type AdLibrarySearchParams,
  type AdLibrarySort,
  type AdPlatformFilter,
  type CreativeFormatFilter,
  type ProductHunterFilters,
  type ProductResearchStatus,
  type SaturationLevel,
} from "@/lib/product-hunter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS: readonly AdPlatformFilter[] = ["facebook", "instagram", "all"];
const FORMATS: readonly CreativeFormatFilter[] = ["video", "image", "carousel", "all"];
const SORTS: readonly AdLibrarySort[] = ["relevance", "newest", "longest_active", "most_variations"];
const SATURATIONS: readonly SaturationLevel[] = ["low", "medium", "high"];

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | undefined {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function intIn(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function text(raw: string | null, max: number): string | undefined {
  const t = (raw ?? "").trim();
  return t ? t.slice(0, max) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSearch(sp: URLSearchParams): AdLibrarySearchParams {
  const country = (text(sp.get("country"), 2) ?? "ES").toUpperCase();
  const startedAfterRaw = text(sp.get("startedAfter"), 10);
  const startedAfter = startedAfterRaw && /^\d{4}-\d{2}-\d{2}$/.test(startedAfterRaw) ? startedAfterRaw : undefined;
  let advanced: Record<string, unknown> | undefined;
  const advRaw = sp.get("advanced");
  if (advRaw) {
    try {
      const parsed: unknown = JSON.parse(advRaw);
      if (isRecord(parsed)) advanced = parsed;
    } catch {
      advanced = undefined;
    }
  }
  const activeOnlyRaw = sp.get("activeOnly");
  return {
    country: /^[A-Z]{2}$/.test(country) ? country : "ES",
    keywords: text(sp.get("keywords"), 200) ?? "",
    category: text(sp.get("category"), 80),
    platform: oneOf(sp.get("platform"), PLATFORMS),
    creativeFormat: oneOf(sp.get("creativeFormat"), FORMATS),
    activeOnly: activeOnlyRaw === null ? undefined : activeOnlyRaw === "1" || activeOnlyRaw === "true",
    startedAfter,
    minActiveDays: intIn(sp.get("minActiveDays"), 0, 3650),
    sort: oneOf(sp.get("sort"), SORTS),
    page: intIn(sp.get("page"), 1, 500),
    pageSize: intIn(sp.get("pageSize"), 1, 48),
    advanced,
  };
}

function parseFilters(sp: URLSearchParams): ProductHunterFilters {
  const statusRaw = sp.get("status");
  const status = statusRaw
    ? statusRaw.split(",").map((s) => s.trim()).filter((s): s is ProductResearchStatus => isProductResearchStatus(s))
    : undefined;
  const countryRaw = text(sp.get("country"), 2)?.toUpperCase();
  return {
    status: status && status.length > 0 ? status : undefined,
    country: countryRaw && /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : undefined,
    minScore: intIn(sp.get("minScore"), 0, 100),
    saturation: oneOf(sp.get("saturation"), SATURATIONS),
  };
}

function fail(err: unknown): NextResponse {
  if (err instanceof NotConfiguredError) {
    // 200 a propósito: "no configurado" es un estado, no un fallo del panel.
    return NextResponse.json({ ok: false, error: err.message, code: "NOT_CONFIGURED", availability: productHunterAvailability() });
  }
  if (err instanceof ProductHunterInputError) {
    return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.code === "NOT_FOUND" ? 404 : 400 });
  }
  if (err instanceof ProductHunterUpstreamError) {
    return NextResponse.json({ ok: false, error: `Backend del Cazador: ${err.message}`, code: "UPSTREAM" }, { status: 502 });
  }
  return NextResponse.json({ ok: false, error: "error interno", code: "INTERNAL" }, { status: 500 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const op = sp.get("op") ?? "availability";
  try {
    if (op === "availability") {
      return NextResponse.json({ ok: true, availability: productHunterAvailability() });
    }
    const ds = createProductHunterDataSource();
    if (op === "search") {
      const page = await ds.search(parseSearch(sp));
      return NextResponse.json({ ok: true, ...page });
    }
    if (op === "candidates") {
      const candidates = await ds.listSaved(parseFilters(sp));
      return NextResponse.json({ ok: true, candidates });
    }
    if (op === "candidate") {
      const id = text(sp.get("id"), 200);
      if (!id) throw new ProductHunterInputError("falta el id");
      const candidate = await ds.getCandidate(id);
      if (!candidate) throw new ProductHunterInputError("no existe ese candidato", "NOT_FOUND");
      return NextResponse.json({ ok: true, candidate });
    }
    if (op === "compare") {
      const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const comparison = await ds.compare(ids);
      return NextResponse.json({ ok: true, ...comparison });
    }
    throw new ProductHunterInputError(`operación desconocida: ${op}`);
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!isRecord(body) || typeof body.op !== "string") {
    return NextResponse.json({ ok: false, error: "cuerpo inválido", code: "BAD_INPUT" }, { status: 400 });
  }
  try {
    const ds = createProductHunterDataSource();
    const op = body.op;
    if (op === "save") {
      const result = normalizeAdLibraryResult(body.result);
      if (!result) throw new ProductHunterInputError("falta el resultado a guardar (o no tiene id)");
      const note = typeof body.note === "string" ? body.note : null;
      const candidate = await ds.saveCandidate({ result, note });
      return NextResponse.json({ ok: true, candidate });
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) throw new ProductHunterInputError("falta el id");
    if (op === "move") {
      if (!isProductResearchStatus(body.status)) throw new ProductHunterInputError("estado de pipeline desconocido");
      const note = typeof body.note === "string" ? body.note : null;
      const candidate = await ds.moveCandidate(id, body.status, note);
      return NextResponse.json({ ok: true, candidate });
    }
    if (op === "note") {
      const t = typeof body.text === "string" ? body.text : "";
      const candidate = await ds.addNote(id, t);
      return NextResponse.json({ ok: true, candidate });
    }
    if (op === "economics") {
      const economics = normalizeEconomics(body.economics);
      if (!economics) throw new ProductHunterInputError("faltan los datos económicos");
      const candidate = await ds.setEconomics(id, economics);
      return NextResponse.json({ ok: true, candidate });
    }
    throw new ProductHunterInputError(`operación desconocida: ${op}`);
  } catch (err) {
    return fail(err);
  }
}
