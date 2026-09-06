// ============================================================
// AI Winner Radar — DATASET DE APRENDIZAJE.
//
// NO se entrena ningún modelo todavía (§40). Lo que se hace es guardar bien
// los datos para poder hacerlo algún día: criterios de búsqueda, señales EN
// EL MOMENTO de decidir, decisión de Pedro, motivo y qué pasó después.
//
// Sin PII: aquí no hay clientes, solo productos y decisiones.
// ============================================================

import { systemDbHandle } from "../db";

export interface TrainingRow {
  productId: string;
  canonicalName: string;
  decision: string;
  reason: string | null;
  decidedAt: number;
  signalsAtDecision: Record<string, unknown> | null;
  scoresAtDecision: Record<string, unknown> | null;
  /** Estado final conocido: permite comparar la decisión con el desenlace. */
  finalStatus: string;
  searchPrompt: string | null;
  searchFilters: Record<string, unknown> | null;
}

function parse<T>(s: unknown): T | null {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function exportHunterTrainingDataset(): TrainingRow[] {
  const rows = systemDbHandle()
    .prepare(
      `SELECT d.product_id, d.decision, d.reason, d.decided_at,
              d.signals_at_decision_json, d.scores_at_decision_json,
              p.canonical_name, p.status,
              s.prompt, s.filters_json
         FROM hunter_decisions d
         JOIN hunter_products p ON p.id = d.product_id
         LEFT JOIN hunter_searches s ON s.id = d.search_id
        ORDER BY d.decided_at ASC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    productId: String(r.product_id),
    canonicalName: String(r.canonical_name),
    decision: String(r.decision),
    reason: (r.reason as string) ?? null,
    decidedAt: Number(r.decided_at),
    signalsAtDecision: parse(r.signals_at_decision_json),
    scoresAtDecision: parse(r.scores_at_decision_json),
    finalStatus: String(r.status),
    searchPrompt: (r.prompt as string) ?? null,
    searchFilters: parse(r.filters_json),
  }));
}

/**
 * Comprobación de privacidad para el exportador. Se ejecuta en los tests: si
 * algún día alguien añade una columna con datos de cliente a estas tablas,
 * esto lo caza antes de que salga por la puerta.
 */
export function findPIIInDataset(rows: TrainingRow[]): string[] {
  const problemas: string[] = [];
  const texto = JSON.stringify(rows);
  if (/[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(texto)) problemas.push("correo electrónico");
  if (/(?:\+?34[\s-]?)?[6-9]\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}\b/.test(texto)) problemas.push("teléfono");
  for (const clave of ["phone", "email", "customer_name", "address_line1", "raw_payload"]) {
    if (texto.includes(`"${clave}"`)) problemas.push(`clave ${clave}`);
  }
  return problemas;
}
