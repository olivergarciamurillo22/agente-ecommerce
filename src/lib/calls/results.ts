// ============================================================
// Resultados de una llamada de confirmación — tabla ÚNICA de verdad.
//
// El evento `call_analyzed` del proveedor trae un resultado como string; se
// parsea de forma ESTRICTA contra este enum. Cualquier valor desconocido →
// manual_review (nunca se interpreta "algo parecido").
// ============================================================

export const CALL_RESULTS = [
  "confirmado",
  "confirmado_con_correccion",
  "cancelado",
  "no_reconoce_pedido",
  "numero_equivocado",
  "no_volver_a_llamar",
  "incidencia_precio",
  "no_disponible",
  "rellamar",
  "no_contesta",
  "buzon_de_voz",
  "fallo_tecnico",
] as const;

export type CallResult = (typeof CALL_RESULTS)[number];

export interface ResultOutcome {
  /** ¿Se planifica otro intento automáticamente? */
  retry: boolean;
  /** ¿Consume uno de los 5 contactos? */
  consume: boolean;
  /** ¿Marca la confirmación del pedido? (NUNCA delivered — closure sigue). */
  confirm: boolean;
  /** ¿Aplica correcciones de datos si vienen? */
  corrections: boolean;
  /** ¿Cierra el pedido (closure cancelled, source llamada_ia)? */
  closeCancelled: boolean;
  /** ¿Bloquea el teléfono globalmente (DNC)? */
  dnc: boolean;
  /** ¿Pasa a revisión manual? */
  review: boolean;
  /** ¿Usa momento_rellamada en vez de la cadencia? (no consume). */
  reschedule: boolean;
}

const O = (o: Partial<ResultOutcome>): ResultOutcome => ({
  retry: false,
  consume: true,
  confirm: false,
  corrections: false,
  closeCancelled: false,
  dnc: false,
  review: false,
  reschedule: false,
  ...o,
});

/** La tabla completa. Cada enum tiene su fila; los tests la recorren entera. */
export const RESULT_OUTCOMES: Record<CallResult, ResultOutcome> = {
  confirmado: O({ confirm: true }),
  confirmado_con_correccion: O({ confirm: true, corrections: true }),
  cancelado: O({ closeCancelled: true }),
  no_reconoce_pedido: O({ closeCancelled: true, review: true }),
  numero_equivocado: O({ review: true }),
  no_volver_a_llamar: O({ dnc: true }),
  incidencia_precio: O({ review: true }),
  no_disponible: O({ review: true }),
  // rellamar NO consume contacto y usa momento_rellamada.
  rellamar: O({ retry: true, consume: false, reschedule: true }),
  no_contesta: O({ retry: true }),
  buzon_de_voz: O({ retry: true }),
  // Un fallo técnico no es culpa del cliente: reintenta SIN consumir cupo
  // (con su propio tope de fallos seguidos → provider_error_exhausted).
  fallo_tecnico: O({ retry: true, consume: false }),
};

/** Parser estricto: normaliza espacios/mayúsculas, nada más. */
export function parseCallResult(raw: unknown): CallResult | null {
  if (typeof raw !== "string") return null;
  const limpio = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return (CALL_RESULTS as readonly string[]).includes(limpio) ? (limpio as CallResult) : null;
}
