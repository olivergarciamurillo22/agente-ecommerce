import type { LandingBlueprint, LandingValidationIssue } from "./types";

const FORBIDDEN_PATTERNS: Array<{ code: string; pattern: RegExp; message: string }> = [
  { code: "FAKE_REVIEW", pattern: /(?:\d(?:[.,]\d)?\s*\/\s*5|estrellas|clientes satisfechos|reseñas?)/i, message: "Las reseñas o valoraciones necesitan evidencia verificable." },
  { code: "FAKE_STUDY", pattern: /(?:estudio|científicamente|clínicamente) (?:demuestra|probado|comprobado)/i, message: "Los estudios y afirmaciones científicas necesitan una fuente demostrable." },
  { code: "FAKE_CERTIFICATION", pattern: /certificad[oa]|homologad[oa]/i, message: "Las certificaciones deben estar documentadas." },
  { code: "FAKE_URGENCY", pattern: /(?:solo hoy|últimas? horas?|termina hoy)/i, message: "La urgencia temporal debe corresponder a una campaña configurada." },
  { code: "FAKE_SCARCITY", pattern: /(?:últimas? unidades?|quedan? \d|casi agotado)/i, message: "La escasez debe provenir de inventario real." },
  { code: "BEFORE_AFTER", pattern: /antes y después|antes\/después/i, message: "Un antes/después requiere evidencia y autorización de los assets." },
  { code: "UNPROVEN_GUARANTEE", pattern: /garantía (?:total|de por vida|100 ?%)/i, message: "La garantía debe estar configurada y documentada." },
];

export function validateLandingBlueprint(blueprint: LandingBlueprint): LandingValidationIssue[] {
  const issues: LandingValidationIssue[] = [];
  if (!blueprint.product.name.trim() || blueprint.product.name === "Producto sin identificar") {
    issues.push({ code: "PRODUCT_MISSING", severity: "blocker", message: "Falta identificar el producto." });
  }
  if (blueprint.sections.filter((s) => s.visible).length === 0) {
    issues.push({ code: "NO_VISIBLE_SECTIONS", severity: "blocker", message: "La landing necesita al menos una sección visible." });
  }
  for (const asset of blueprint.assets) {
    if (!asset.url) issues.push({ code: "ASSET_MISSING", severity: "blocker", message: `Falta el archivo o URL del asset «${asset.alt || asset.id}».` });
    if (!asset.alt.trim()) issues.push({ code: "ASSET_ALT_MISSING", severity: "warning", message: `El asset ${asset.id} no tiene texto alternativo.` });
  }
  for (const claim of blueprint.claims) {
    if (claim.status === "blocked") issues.push({ code: "CLAIM_BLOCKED", severity: "blocker", message: `Claim bloqueado: «${claim.text}».` });
    if (["hypothesis", "pending"].includes(claim.status)) issues.push({ code: "CLAIM_PENDING", severity: "blocker", message: `Claim pendiente de evidencia: «${claim.text}».` });
    if (["verified", "supplier", "pedro"].includes(claim.status) && !claim.evidence?.trim()) {
      issues.push({ code: "CLAIM_EVIDENCE_MISSING", severity: "blocker", message: `El claim «${claim.text}» no enlaza su evidencia.` });
    }
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(claim.text) && claim.status !== "verified") issues.push({ code: rule.code, severity: "blocker", message: rule.message });
    }
  }
  if (blueprint.price.current === null || blueprint.price.current <= 0) {
    issues.push({ code: "PRICE_MISSING", severity: "blocker", message: "Falta un precio actual válido." });
  }
  if (blueprint.price.compareAt !== null) {
    if (!blueprint.price.compareAtEvidence?.trim()) issues.push({ code: "COMPARE_PRICE_UNPROVEN", severity: "blocker", message: "El precio anterior no tiene evidencia documentada; no se puede mostrar descuento." });
    if (blueprint.price.current !== null && blueprint.price.compareAt <= blueprint.price.current) issues.push({ code: "COMPARE_PRICE_INVALID", severity: "blocker", message: "El precio anterior debe ser mayor que el actual." });
  }
  if (!blueprint.brief.audience.trim()) issues.push({ code: "BRIEF_AUDIENCE", severity: "warning", message: "El brief no define la audiencia." });
  if (!blueprint.brief.promise.trim()) issues.push({ code: "BRIEF_PROMISE", severity: "warning", message: "El brief no define una promesa principal." });
  return issues;
}

export function canExportLanding(blueprint: LandingBlueprint): boolean {
  return !validateLandingBlueprint(blueprint).some((issue) => issue.severity === "blocker");
}
