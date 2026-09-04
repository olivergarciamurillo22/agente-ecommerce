import fs from "node:fs";
import path from "node:path";
import type { ProductCandidate } from "../hunter/types";
import { composeLanding } from "./composer";
import { convertLanding } from "./converter";
import { LANDING_LINT_RULES, lintLiquidDir } from "./lint";

export interface LandingPipelineResult {
  htmlFile: string;
  sectionsDir: string;
  sectionCount: number;
  generatedFiles: string[];
  lintRuleCount: number;
  placeholders: string[];
}

export function runLandingPipeline(candidate: ProductCandidate, outputRoot: string): LandingPipelineResult {
  const root = path.resolve(outputRoot);
  const sectionsDir = path.join(root, `candidato-${candidate.id}-secciones`);
  const htmlFile = path.join(root, `candidato-${candidate.id}.html`);
  fs.mkdirSync(root, { recursive: true });
  const html = composeLanding(candidate);
  fs.writeFileSync(htmlFile, html, "utf8");
  const generatedFiles = convertLanding(html, sectionsDir);
  const issues = lintLiquidDir(sectionsDir);
  if (issues.length) {
    throw new Error(issues.map((x) => `${x.rule} · ${x.file}: ${x.message}`).join("\n"));
  }
  const placeholders = ["medios de producto", "variante de checkout", "información legal"];
  return {
    htmlFile,
    sectionsDir,
    sectionCount: (html.match(/<section\b[^>]*data-bloque=/g) ?? []).length,
    generatedFiles,
    lintRuleCount: LANDING_LINT_RULES.length,
    placeholders,
  };
}
