const SECRET_PATTERNS = [/(Bearer\s+)[^\s"']+/gi, /(access[_-]?token["'=:\s]+)[^\s,"'}]+/gi, /(app[_-]?secret["'=:\s]+)[^\s,"'}]+/gi, /(cookie["'=:\s]+)[^\r\n]+/gi];
export function redactProductIntelligence(value: unknown): string { let output = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value); for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "$1[REDACTED]"); return output; }

export function sanitizeProductIntelligencePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProductIntelligencePayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/token|secret|authorization|cookie/i.test(key))
    .map(([key, child]) => [key, sanitizeProductIntelligencePayload(child)]));
}
