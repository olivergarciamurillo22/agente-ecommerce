"use client";

// ============================================================
// SONDEO QUE SE CALLA CUANDO NADIE MIRA.
//
// El panel refrescaba solo con `setInterval` a secas. Eso tiene dos problemas
// que juntos hacían que todo fuera a trompicones:
//
//   1. La pestaña en segundo plano seguía pidiendo. Con el panel abierto en
//      una pestaña olvidada, el NAS recibía peticiones toda la tarde para
//      pintar algo que nadie estaba viendo.
//   2. Si una respuesta tardaba más que el intervalo, se acumulaban
//      peticiones solapadas y cada una competía con las demás. Cuanto más
//      lento iba, más peticiones lanzaba: exactamente al revés de lo que
//      hace falta.
//
// Este hook resuelve las dos: pausa mientras el documento está oculto,
// refresca al volver, y NUNCA lanza una petición si la anterior sigue viva.
// ============================================================

import { useEffect, useRef } from "react";

export interface PollingOptions {
  /** Milisegundos entre refrescos mientras la pestaña está visible. */
  intervalMs: number;
  /** `false` detiene el sondeo sin desmontar nada. */
  enabled?: boolean;
  /** Refrescar al volver a la pestaña, para no ver datos viejos. */
  refreshOnFocus?: boolean;
}

export function usePolling(fn: () => void | Promise<void>, opts: PollingOptions): void {
  const { intervalMs, enabled = true, refreshOnFocus = true } = opts;
  // La función se guarda en una ref para que cambiarla no reinicie el reloj:
  // si no, un callback recreado en cada render dispararía peticiones sin fin.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enVuelo = useRef(false);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    const ejecutar = async () => {
      // Solapamiento: si la anterior no ha vuelto, esta se salta. Sin esto,
      // una respuesta lenta genera una cola que empeora la lentitud.
      if (enVuelo.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      enVuelo.current = true;
      try {
        await fnRef.current();
      } finally {
        enVuelo.current = false;
      }
    };

    const timer = setInterval(() => void ejecutar(), intervalMs);

    const alVolver = () => {
      if (!document.hidden) void ejecutar();
    };
    if (refreshOnFocus && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", alVolver);
    }

    return () => {
      clearInterval(timer);
      if (refreshOnFocus && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", alVolver);
      }
    };
  }, [intervalMs, enabled, refreshOnFocus]);
}
