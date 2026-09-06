// ============================================================
// ICONOS DE CASAMABLE — una sola familia, hecha a medida.
//
// Antes había 41 <svg> sueltos por los componentes, con grosores distintos
// (1,7 aquí, 1,8 allá) y tamaños a ojo. Eso se nota aunque nadie sepa
// decir por qué: la interfaz parece hecha a trozos.
//
// REGLAS DE LA FAMILIA (todas deliberadas):
//   · Lienzo 24×24 siempre, para que el peso visual sea el mismo.
//   · Trazo 1,75 con extremos y uniones redondeados.
//   · `currentColor`: el icono hereda el color del texto, así que funciona
//     en un botón oscuro, en un aviso rojo o en modo oscuro sin tocar nada.
//   · Sin relleno: solo contorno. Mezclar contorno y relleno es lo que hace
//     que un set parezca comprado a dos sitios distintos.
//
// POR QUÉ SVG A MANO Y NO IMÁGENES GENERADAS: un icono de interfaz tiene que
// verse nítido a 16 px, cambiar de color con el tema y pesar bytes. Un PNG
// generado no hace ninguna de las tres cosas, y añadir peticiones de red iría
// justo en contra de lo que acabamos de arreglar (que el panel cargue rápido).
// Todo este fichero pesa menos que un solo icono en imagen.
// ============================================================

import type { SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** Lado en píxeles. 20 va bien en navegación, 16 dentro de botones. */
  size?: number;
}

function Icon({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── Navegación ──────────────────────────────────────────────

export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20a1 1 0 0 0 1 1h4V15h3v6h4a1 1 0 0 0 1-1V9.5" />
  </Icon>
);

export const IconOrders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3 4 7v10l8 4 8-4V7z" />
    <path d="m4 7 8 4 8-4" />
    <path d="M12 11v10" />
  </Icon>
);

export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z" />
    <path d="M9 12h6" />
  </Icon>
);

export const IconGrowth = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 19h16" />
    <path d="m5 15 4-5 4 3 6-7" />
    <path d="M15 6h4v4" />
  </Icon>
);

export const IconHunter = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.8-3.8" />
    <path d="M11 8v6M8 11h6" />
  </Icon>
);

export const IconLanding = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4" width="17" height="16" rx="2" />
    <path d="M3.5 9h17" />
    <path d="M7 13h6M7 16.5h9" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.3M17.6 15.2l2.2 1.3M4.2 16.5l2.2-1.3M17.6 8.8l2.2-1.3" />
  </Icon>
);

// ── Acciones ────────────────────────────────────────────────

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Icon>
);

/** Volver. Flecha con asta larga: se lee como "atrás" incluso a 16 px. */
export const IconBack = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 9 7 7 7-7" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4.5h-4.5" />
  </Icon>
);

export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="12" cy="12" r="1.2" />
    <circle cx="19" cy="12" r="1.2" />
  </Icon>
);

// ── Estado ──────────────────────────────────────────────────

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const IconWarning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5 21 19.5H3z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11.5v5" />
    <circle cx="12" cy="8.2" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

// ── Negocio ─────────────────────────────────────────────────

export const IconTruck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7h11v9H3z" />
    <path d="M14 10h3.5L21 13v3h-7" />
    <circle cx="7" cy="18" r="1.8" />
    <circle cx="17" cy="18" r="1.8" />
  </Icon>
);

export const IconPhone = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 5.5 5.7 2 2 0 0 1 7 3.5z" />
  </Icon>
);

export const IconMoney = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6.5 12h.01M17.5 12h.01" />
  </Icon>
);

export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);
