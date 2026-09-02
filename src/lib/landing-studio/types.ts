// Landing Studio — fuente de verdad estructurada y versionada.
// El HTML/Liquid se deriva siempre de este blueprint; nunca se guarda como
// documento principal ni se acepta de vuelta desde el editor.

import type { WinningProductCandidate } from "../product-hunter/types";

export const LANDING_BLUEPRINT_VERSION = 1 as const;

export type EvidenceKind = "real" | "estimate" | "scenario" | "missing";
export type ClaimStatus = "verified" | "supplier" | "pedro" | "hypothesis" | "pending" | "blocked";
export type LandingSectionType = "hero" | "benefits" | "proof" | "how_it_works" | "offer" | "faq" | "guarantee";
export type LandingViewport = "desktop" | "tablet" | "mobile";

export interface SourcedNumber {
  value: number | null;
  kind: EvidenceKind;
  source: string | null;
}

export interface LandingEconomics {
  salePrice: SourcedNumber;
  deliveryRate: SourcedNumber;
  productCost: SourcedNumber;
  vat: SourcedNumber;
  shipping: SourcedNumber;
  codFee: SourcedNumber;
  handling: SourcedNumber;
  returnCost: SourcedNumber;
  cac: SourcedNumber;
}

export interface ViabilityResult {
  complete: boolean;
  viable: boolean | null;
  expectedNetRevenue: number | null;
  expectedReturnCost: number | null;
  expectedContribution: number | null;
  missing: string[];
  formula: string;
}

export interface LandingClaim {
  id: string;
  text: string;
  status: ClaimStatus;
  evidence: string | null;
}

export interface LandingAsset {
  id: string;
  kind: "image" | "video";
  url: string | null;
  alt: string;
  source: string | null;
}

export interface LandingSection {
  id: string;
  type: LandingSectionType;
  title: string;
  eyebrow: string;
  body: string;
  items: string[];
  claimIds: string[];
  assetIds: string[];
  visible: boolean;
}

export interface LandingBrief {
  audience: string;
  problem: string;
  promise: string;
  tone: "editorial" | "direct" | "warm";
  primaryCta: string;
  visualDirection: string;
}

export interface LandingPrice {
  current: number | null;
  currency: "EUR";
  compareAt: number | null;
  compareAtEvidence: string | null;
}

export interface LandingValidationIssue {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  sectionId?: string;
}

export interface LandingVersion {
  id: string;
  number: number;
  createdAt: string;
  note: string;
  blueprint: LandingBlueprint;
}

export interface LandingExportRecord {
  id: string;
  createdAt: string;
  format: "shopify_theme_zip";
  fileName: string;
  published: false;
  validationIssueCount: number;
}

export interface LandingExperiment {
  id: string;
  name: string;
  status: "draft";
  primaryMetric: "order_created" | "confirmed_order" | "delivered_order";
  variants: Array<{ id: "A" | "B"; versionId: string | null; label: string }>;
}

export interface LandingBlueprint {
  schemaVersion: typeof LANDING_BLUEPRINT_VERSION;
  id: string;
  candidateId: string;
  product: {
    name: string;
    advertiser: string | null;
    sourceLandingUrl: string | null;
  };
  sourceAd: {
    id: string;
    copy: string | null;
    previewUrl: string | null;
  };
  supplier: { name: string | null; reference: string | null };
  brief: LandingBrief;
  economics: LandingEconomics;
  visualDirection: string;
  sections: LandingSection[];
  assets: LandingAsset[];
  claims: LandingClaim[];
  price: LandingPrice;
  validations: LandingValidationIssue[];
  exports: LandingExportRecord[];
  experiments: LandingExperiment[];
  updatedAt: string;
}

export interface LandingProject {
  blueprint: LandingBlueprint;
  versions: LandingVersion[];
}

export function studioId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function estimated(value: number | null | undefined, source: string): SourcedNumber {
  return { value: value ?? null, kind: value === null || value === undefined ? "missing" : "estimate", source: value === null || value === undefined ? null : source };
}

export function createLandingBlueprint(candidate: WinningProductCandidate, now = new Date().toISOString()): LandingBlueprint {
  const name = candidate.productName ?? "Producto sin identificar";
  const adClaim = candidate.adCopy?.trim() || `Propuesta principal de ${name}`;
  const heroAsset: LandingAsset = {
    id: "asset_hero",
    kind: candidate.format === "video" ? "video" : "image",
    url: candidate.previewUrl,
    alt: name,
    source: candidate.previewUrl ? "Creatividad del anuncio de origen" : null,
  };
  return {
    schemaVersion: LANDING_BLUEPRINT_VERSION,
    id: studioId("landing"),
    candidateId: candidate.id,
    product: { name, advertiser: candidate.advertiser, sourceLandingUrl: candidate.landingUrl },
    sourceAd: { id: candidate.id, copy: candidate.adCopy, previewUrl: candidate.previewUrl },
    supplier: { name: null, reference: null },
    brief: {
      audience: "",
      problem: "",
      promise: "",
      tone: "editorial",
      primaryCta: "Pedir contrareembolso",
      visualDirection: "Editorial, precisa y centrada en el producto",
    },
    economics: {
      salePrice: estimated(candidate.economics?.salePriceEstimate ?? candidate.detectedPrice?.amount, candidate.economics?.salePriceEstimate != null ? "Estimación de Pedro" : "Precio detectado en la landing de origen"),
      deliveryRate: estimated(null, ""),
      productCost: estimated(candidate.economics?.costEstimate, "Estimación de Pedro"),
      vat: estimated(null, ""),
      shipping: estimated(candidate.economics?.shippingCost, "Estimación de Pedro"),
      codFee: estimated(null, ""),
      handling: estimated(null, ""),
      returnCost: estimated(candidate.economics?.returnCost, "Estimación de Pedro"),
      cac: estimated(null, ""),
    },
    visualDirection: "Editorial, precisa y centrada en el producto",
    sections: [
      { id: "section_hero", type: "hero", eyebrow: "Nuevo", title: name, body: adClaim, items: [], claimIds: ["claim_source"], assetIds: [heroAsset.id], visible: true },
      { id: "section_benefits", type: "benefits", eyebrow: "Lo esencial", title: "Por qué puede ayudarte", body: "Beneficios pendientes de validar.", items: ["Beneficio pendiente de evidencia", "Uso sencillo", "Pago contrareembolso"], claimIds: [], assetIds: [], visible: true },
      { id: "section_offer", type: "offer", eyebrow: "Pedido seguro", title: "Paga cuando lo recibas", body: "Revisa el pedido y confirma tus datos antes del envío.", items: [], claimIds: [], assetIds: [], visible: true },
      { id: "section_faq", type: "faq", eyebrow: "Preguntas", title: "Antes de pedir", body: "Información clara sobre pago y entrega.", items: ["¿Cómo se paga? — Contrareembolso.", "¿Cuándo se envía? — Tras confirmar el pedido."], claimIds: [], assetIds: [], visible: true },
    ],
    assets: [heroAsset],
    claims: [{ id: "claim_source", text: adClaim, status: "hypothesis", evidence: candidate.adCopy ? "Copy del anuncio de origen; pendiente de demostrar" : null }],
    price: { current: candidate.economics?.salePriceEstimate ?? candidate.detectedPrice?.amount ?? null, currency: "EUR", compareAt: null, compareAtEvidence: null },
    validations: [],
    exports: [],
    experiments: [{ id: studioId("experiment"), name: "Test inicial", status: "draft", primaryMetric: "confirmed_order", variants: [{ id: "A", versionId: null, label: "Control" }, { id: "B", versionId: null, label: "Variante" }] }],
    updatedAt: now,
  };
}

export function cloneBlueprint(blueprint: LandingBlueprint): LandingBlueprint {
  return JSON.parse(JSON.stringify(blueprint)) as LandingBlueprint;
}
