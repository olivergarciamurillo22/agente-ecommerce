"use client";

// ============================================================
// Fondo ambiental v3 (§33): una viñeta ESTÁTICA y sutil.
//
// La versión anterior (palmeras meciéndose + brasas doradas ascendentes)
// leía como "demo de IA", no como software de operaciones. El criterio de
// aceptación §53 lo dice explícitamente: fuera ornamento animado. El grano
// de marca (brand-grain) sigue viniendo del body.
// ============================================================

export default function AmbientBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0"
      style={{
        background:
          "radial-gradient(1000px 500px at 80% 110%, rgba(250,197,28,0.025), transparent 60%)",
      }}
    />
  );
}
