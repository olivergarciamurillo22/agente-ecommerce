// ============================================================
// NORMALIZADOR DEL `analysis` DE RETELL — función PURA.
//
// Sin DB, sin red, sin efectos. Traduce lo que entrega el proveedor a un
// objeto canónico, y nada más: la interpretación (resultados válidos,
// transiciones, DNC) sigue viviendo donde ya estaba.
//
// POR QUÉ EXISTE (03-09-2026): el agente PUBLICADO en Retell derivó del
// contrato del repo. Entrega `resultado_llamada`, `datos_corregidos` y
// `pidio_no_llamar`, mientras el repo declara `resultado` + campos planos.
// En vez de sustituir un contrato por otro —y romper el que sí está
// versionado— se aceptan AMBOS aquí, en un único punto.
//
//   CONTRATO CANÓNICO   = el del repo (config/retell/casamable-agent-prompt.md)
//   COMPATIBILIDAD LIVE = los alias que se aceptan, listados abajo
//
// Lo que NO hace: inventar resultados, ampliar la lista de los 12 válidos,
// hacer coincidencias aproximadas ni adivinar subclaves no demostradas.
// ============================================================

/** Forma canónica que consume el orquestador. `null` = no venía el dato. */
export interface NormalizedCallAnalysis {
  /** Crudo: lo valida `parseCallResult`, que sigue siendo la única autoridad. */
  resultado: unknown;
  direccionCorregida: string | null;
  localidadCorregida: string | null;
  codigoPostalCorregido: string | null;
  telefonoAlternativo: string | null;
  momentoRellamada: unknown;
  pidioNoLlamar: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Texto limpio o `null`. Nunca devuelve "" ni acepta objetos/arrays. */
function texto(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const limpio = v.trim();
  return limpio === "" ? null : limpio;
}

/**
 * Booleano INEQUÍVOCO. `Boolean("false")` es `true` en JavaScript, así que
 * una cadena solo cuenta si dice exactamente que sí. Cualquier otra cosa
 * (null, 0, "quizá", un objeto) es `false`: no llamar es una decisión del
 * cliente, no algo que se deduzca de un valor ambiguo.
 */
function siNo(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v !== "string") return false;
  return ["true", "1", "si", "sí", "yes"].includes(v.trim().toLowerCase());
}

/**
 * Subclaves de correcciones. SOLO nombres canónicos —los mismos que declara
 * `config/retell/casamable-agent-prompt.md`— tanto sueltos como dentro del
 * contenedor `datos_corregidos`. No se aceptan formas cortas
 * (`direccion`, `localidad`…) porque NADA en el repo las documenta:
 * inventarlas sería adivinar qué escribe el agente publicado.
 * → PENDIENTE de que Pedro confirme las subclaves exactas del agente LIVE.
 */
const CLAVES = {
  direccion: "direccion_corregida",
  localidad: "localidad_corregida",
  codigoPostal: "codigo_postal_corregido",
  telefono: "telefono_alternativo",
} as const;

export function normalizeRetellAnalysis(analysis: Record<string, unknown> | null | undefined): NormalizedCallAnalysis {
  const a = isRecord(analysis) ? analysis : {};
  // El contenedor del contrato live. Si viene con cualquier otra forma
  // (string, array, null) se ignora entero en vez de romper.
  const anidado = isRecord(a["datos_corregidos"]) ? (a["datos_corregidos"] as Record<string, unknown>) : {};

  // Precedencia: el contrato LIVE estructurado gana, pero SOLO con valor
  // real. Un null/""/objeto dentro de `datos_corregidos` nunca pisa un campo
  // plano válido.
  const preferido = (clave: string): string | null => texto(anidado[clave]) ?? texto(a[clave]);

  return {
    // resultado_llamada (live) → resultado (canónico) → result (histórico).
    resultado: a["resultado_llamada"] ?? a["resultado"] ?? a["result"],
    direccionCorregida: preferido(CLAVES.direccion),
    localidadCorregida: preferido(CLAVES.localidad),
    codigoPostalCorregido: preferido(CLAVES.codigoPostal),
    telefonoAlternativo: preferido(CLAVES.telefono),
    momentoRellamada: anidado["momento_rellamada"] ?? a["momento_rellamada"],
    // Independiente del resultado: el cliente puede confirmar el pedido Y
    // pedir que no se le vuelva a llamar. Su preferencia manda.
    pidioNoLlamar: siNo(anidado["pidio_no_llamar"] ?? a["pidio_no_llamar"]),
  };
}
