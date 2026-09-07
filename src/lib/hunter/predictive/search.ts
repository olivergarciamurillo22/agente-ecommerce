import type { EvidenceKind, PredictiveSearchProvider, PredictiveSearchRequest, SearchEvidence } from "./types";

const TIMEOUT_MS = 20_000;
const ALLOWED_WHOLESALE = new Set(["alibaba.com", "aliexpress.com", "1688.com", "cjdropshipping.com"]);

function domainAllowed(hostname: string, kind: EvidenceKind): boolean {
  if (kind === "retail") return true;
  return [...ALLOWED_WHOLESALE].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function parseEvidence(raw: unknown, kind: EvidenceKind, observedAt: number): SearchEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  try {
    const url = new URL(String(item.url ?? ""));
    const price = Number(item.priceEur);
    const quantity = item.quantity === null || item.quantity === undefined ? null : Number(item.quantity);
    const weight = item.weightGrams === null || item.weightGrams === undefined ? null : Number(item.weightGrams);
    if (url.protocol !== "https:" || !domainAllowed(url.hostname.toLowerCase(), kind) || !Number.isFinite(price) || price <= 0) return null;
    return {
      kind,
      sourceUrl: url.toString().slice(0, 2048),
      sourceDomain: url.hostname.toLowerCase(),
      title: String(item.title ?? "").trim().slice(0, 200),
      priceEur: price,
      quantity: quantity !== null && Number.isFinite(quantity) && quantity > 0 ? quantity : null,
      weightGrams: weight !== null && Number.isFinite(weight) && weight > 0 ? weight : null,
      observedAt,
    };
  } catch { return null; }
}

/** Contrato HTTP: POST JSON y respuesta { results:[{url,title,priceEur,quantity,weightGrams}] }. */
export class HttpPredictiveSearchProvider implements PredictiveSearchProvider {
  readonly available: boolean;
  readonly mechanism: string | null;
  private readonly endpoint: string | null;
  constructor(private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = (process.env.HUNTER_PREDICTIVE_SEARCH_API_URL ?? "").trim() || null;
    this.available = this.endpoint !== null;
    this.mechanism = this.available ? "api_busqueda_http_configurada" : null;
  }

  async search(request: PredictiveSearchRequest): Promise<SearchEvidence[]> {
    if (!this.endpoint) return [];
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(process.env.HUNTER_PREDICTIVE_SEARCH_API_TOKEN ? { authorization: `Bearer ${process.env.HUNTER_PREDICTIVE_SEARCH_API_TOKEN}` } : {}),
      },
      body: JSON.stringify({ query: request.query, competitorUrl: request.competitorUrl ?? null, kind: request.kind }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`busqueda predictiva HTTP ${response.status}`);
    const payload = await response.json() as { results?: unknown[] };
    const now = Math.floor(Date.now() / 1000);
    return (Array.isArray(payload.results) ? payload.results : []).map((x) => parseEvidence(x, request.kind, now)).filter((x): x is SearchEvidence => x !== null);
  }
}
