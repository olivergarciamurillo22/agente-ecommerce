// ============================================================
// Escenarios guardados de la Calculadora COD (tabla cod_scenarios, v15).
// Guardar/duplicar/borrar escenarios NO toca ningún dato real.
// ============================================================

import { systemDbHandle } from "../db";
import type { CODCalculatorInputs, CODModelType, CODScenario } from "./types";

export function listCodScenarios(): CODScenario[] {
  return systemDbHandle().prepare("SELECT * FROM cod_scenarios ORDER BY updated_at DESC").all() as CODScenario[];
}

export function saveCodScenario(s: {
  id?: number;
  name: string;
  productSku?: string | null;
  modelType: CODModelType;
  assumptions: CODCalculatorInputs & Record<string, unknown>;
}): number {
  const db = systemDbHandle();
  const name = s.name.trim().slice(0, 80);
  if (!name) throw new Error("el escenario necesita un nombre");
  const json = JSON.stringify(s.assumptions);
  if (s.id) {
    db.prepare("UPDATE cod_scenarios SET name = ?, product_sku = ?, model_type = ?, assumptions_json = ?, updated_at = unixepoch() WHERE id = ?").run(
      name,
      s.productSku ?? null,
      s.modelType,
      json,
      s.id
    );
    return s.id;
  }
  const info = db
    .prepare("INSERT INTO cod_scenarios (name, product_sku, model_type, assumptions_json) VALUES (?, ?, ?, ?)")
    .run(name, s.productSku ?? null, s.modelType, json);
  return Number(info.lastInsertRowid);
}

export function duplicateCodScenario(id: number): number | null {
  const row = systemDbHandle().prepare("SELECT * FROM cod_scenarios WHERE id = ?").get(id) as CODScenario | undefined;
  if (!row) return null;
  const info = systemDbHandle()
    .prepare("INSERT INTO cod_scenarios (name, product_sku, model_type, assumptions_json) VALUES (?, ?, ?, ?)")
    .run(`${row.name} (copia)`.slice(0, 80), row.product_sku, row.model_type, row.assumptions_json);
  return Number(info.lastInsertRowid);
}

export function deleteCodScenario(id: number): void {
  systemDbHandle().prepare("DELETE FROM cod_scenarios WHERE id = ?").run(id);
}
