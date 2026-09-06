"use client";

// ============================================================
// QUE "ATRÁS" HAGA LO QUE TODO EL MUNDO ESPERA.
//
// EL PROBLEMA REAL QUE ARREGLA ESTO:
// el panel navegaba siempre con `replaceState`, que reemplaza la entrada del
// historial en vez de añadir una. Consecuencias, las dos malas:
//
//   · Ir de Inicio → Pedidos → Seguimiento y pulsar atrás no te devolvía a
//     Pedidos: te sacaba de la aplicación entera.
//   · Abrir la ficha de un pedido y pulsar atrás tampoco cerraba la ficha:
//     también te sacaba.
//
// En escritorio molesta. En el móvil, donde "atrás" es un gesto del sistema
// que se usa sin pensar, hace que la aplicación se sienta rota.
//
// `useOverlayBack` registra una entrada de historial cuando se abre algo
// encima (ficha, panel lateral, diálogo). El gesto de atrás la consume y
// cierra la capa, en lugar de abandonar la app. Y `Escape` hace lo mismo,
// porque en escritorio esa es la tecla que la gente prueba.
// ============================================================

import { useEffect, useRef } from "react";

// ============================================================
// EL CIERRE DE LA ENTRADA SE APLAZA UN TICK.
//
// Bug real, visto el 06-09 con la ficha de producto: al abrirla se cerraba
// sola y encima te sacaba del Cazador.
//
// La causa: el efecto de esta capa puede MONTARSE, LIMPIARSE Y VOLVER A
// MONTARSE de forma inmediata — React en modo estricto lo hace siempre en
// desarrollo, y un componente cargado con `lazy` puede suspender y rehacer el
// montaje también en producción. En esa secuencia, la limpieza llamaba a
// `history.back()` justo después de que el segundo montaje hubiera apilado su
// entrada: el `popstate` resultante se leía como "el usuario ha pulsado
// atrás" y se cerraba la capa recién abierta.
//
// La solución es esperar un tick antes de retirar la entrada. Si en ese tick
// vuelve a montarse la misma capa, se cancela la retirada y se REUTILIZA la
// entrada que ya estaba puesta. Un montaje-desmontaje-montaje deja de
// distinguirse de un montaje normal, que es exactamente lo que es.
// ============================================================

let retiradaPendiente: ReturnType<typeof setTimeout> | null = null;

function programarRetirada(): void {
  if (retiradaPendiente) clearTimeout(retiradaPendiente);
  retiradaPendiente = setTimeout(() => {
    retiradaPendiente = null;
    window.history.back();
  }, 0);
}

/** ¿Había una retirada en vuelo? Si la hay se cancela y se reutiliza la entrada. */
function rescatarEntrada(): boolean {
  if (retiradaPendiente === null) return false;
  clearTimeout(retiradaPendiente);
  retiradaPendiente = null;
  return true;
}

/**
 * Mientras `open` sea true, atrás (y Escape) ejecutan `onClose` en vez de
 * salir de la aplicación.
 *
 * `onClose` se guarda en una ref para que volver a crearla en cada render no
 * reinstale los escuchadores: si no, cerrar la capa se volvería intermitente.
 */
export function useOverlayBack(open: boolean, onClose: () => void): void {
  const cerrarRef = useRef(onClose);
  cerrarRef.current = onClose;
  /** ¿Fuimos NOSOTROS quienes añadimos la entrada? Solo entonces la retiramos. */
  const marcaPuesta = useRef(false);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;

    // Si veníamos de una retirada aplazada, la entrada sigue en el
    // historial: reutilizarla en vez de apilar otra.
    if (!rescatarEntrada()) window.history.pushState({ casamableOverlay: true }, "");
    marcaPuesta.current = true;

    const alVolver = () => {
      // El navegador YA ha retirado nuestra entrada al disparar popstate, así
      // que aquí solo hay que cerrar; retirarla otra vez sacaría de la app.
      marcaPuesta.current = false;
      cerrarRef.current();
    };
    const alPulsarTecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cerrarRef.current();
      }
    };

    window.addEventListener("popstate", alVolver);
    document.addEventListener("keydown", alPulsarTecla);

    return () => {
      window.removeEventListener("popstate", alVolver);
      document.removeEventListener("keydown", alPulsarTecla);
      // Si la capa se cerró con la X (no con atrás), nuestra entrada sigue en
      // el historial: hay que quitarla o el siguiente "atrás" no haría nada
      // visible y parecería que el botón está roto.
      if (marcaPuesta.current) {
        marcaPuesta.current = false;
        programarRetirada();
      }
    };
  }, [open]);
}

/**
 * Navegación entre secciones. `push` añade entrada (para poder volver) y
 * `replace` la sustituye (para sincronizar sin ensuciar el historial).
 *
 * Antes todo era `replace`, y por eso atrás nunca funcionaba entre secciones.
 */
export function navigateHash(hash: string, mode: "push" | "replace" = "push"): void {
  if (typeof window === "undefined") return;
  if (window.location.hash === hash) return;
  if (mode === "push") window.history.pushState(null, "", hash);
  else window.history.replaceState(null, "", hash);
}
