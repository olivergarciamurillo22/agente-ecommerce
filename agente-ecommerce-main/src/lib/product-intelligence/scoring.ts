import { PRODUCT_INTELLIGENCE_CONFIG } from "./config";
import type { Lifecycle, Recommendation, ScoreInput } from "./types";

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function opportunityScore(input: ScoreInput): number {
  const weighted = Object.entries(PRODUCT_INTELLIGENCE_CONFIG.weights).reduce(
    (total, [key, weight]) => total + input[key as keyof typeof PRODUCT_INTELLIGENCE_CONFIG.weights] * weight,
    0
  );
  return clamp(weighted - (input.penalties ?? 0));
}

export function scoreBreakdown(input: ScoreInput): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, weight] of Object.entries(PRODUCT_INTELLIGENCE_CONFIG.weights)) result[key] = Math.round(input[key as keyof typeof PRODUCT_INTELLIGENCE_CONFIG.weights] * weight * 10) / 10;
  result.penalties = -(input.penalties ?? 0);
  result.total = opportunityScore(input);
  return result;
}

export function classifyLifecycle(input: ScoreInput, advertisers: number): Lifecycle {
  if (input.saturation >= 75 && advertisers >= 12) return "SATURATING";
  if (input.momentum <= 25 && input.creativeVelocity <= 25) return "DECLINING";
  if (input.momentum >= 70 && input.creativeVelocity >= 60) return "SCALING";
  if (input.longevity >= 70 && input.metaValidation >= 65) return "VALIDATED";
  if (input.momentum >= 50 && advertisers <= 5) return "EMERGING";
  return "UNKNOWN";
}

export function recommend(score: number, input: ScoreInput): Recommendation {
  if (score >= 80 && input.casamableFit >= 70 && input.economics >= 60 && input.saturation < 80) return "TEST_NOW";
  if (score >= 65) return "WATCHLIST";
  if (score >= 45) return "RESEARCH_MORE";
  return "REJECT";
}
