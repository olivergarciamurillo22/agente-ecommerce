"use client";

/**
 * Fondo ambiental sutil (formas orgánicas que se mecen) que combina
 * tecnología (grid de puntos sutil) y energía (brasas doradas flotando),
 * un fondo ambiental sutil. Va detrás de todo, sin capturar el ratón.
 */

// Hoja de palmera generada por código: un raquis curvo con foliolos a los lados.
function PalmFrond() {
  const folioles = 15;
  const leaves = [];
  for (let i = 0; i < folioles; i++) {
    const t = i / (folioles - 1);
    const ry = 296 - t * 286;
    const rx = 108 - t * 8;
    const len = 78 * (1 - t * 0.55);
    const lift = 26 + t * 34;
    leaves.push(
      <path key={`r${i}`} d={`M${rx} ${ry} Q ${rx + len * 0.6} ${ry - lift * 0.4} ${rx + len} ${ry - lift}`} stroke="url(#frondGrad)" strokeWidth={2.4} strokeLinecap="round" fill="none" />
    );
    leaves.push(
      <path key={`l${i}`} d={`M${rx} ${ry} Q ${rx - len * 0.6} ${ry - lift * 0.4} ${rx - len} ${ry - lift}`} stroke="url(#frondGrad)" strokeWidth={2.4} strokeLinecap="round" fill="none" />
    );
  }
  return (
    <svg viewBox="0 0 200 300" className="w-full h-auto" aria-hidden="true">
      <defs>
        <linearGradient id="frondGrad" x1="100" y1="300" x2="100" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1f3d1a" />
          <stop offset="0.6" stopColor="#3a5a1e" />
          <stop offset="1" stopColor="#fac51c" />
        </linearGradient>
      </defs>
      <path d="M110 300 C 96 210 96 120 100 12" stroke="url(#frondGrad)" strokeWidth={3.2} strokeLinecap="round" fill="none" />
      {leaves}
    </svg>
  );
}

// Contenedor que orienta una palmera (transform base) mientras el SVG interior
// se balancea (propiedad `rotate` animada, independiente del transform).
function Palm({
  className,
  transform,
  anim,
}: {
  className: string;
  transform: string;
  anim: string;
}) {
  return (
    <div className={`absolute ${className}`} style={{ transform, transformOrigin: "bottom center" }}>
      <div className={anim} style={{ transformOrigin: "bottom center" }}>
        <PalmFrond />
      </div>
    </div>
  );
}

// Brasas doradas: posiciones deterministas (sin random, evita hydration mismatch)
const EMBERS = Array.from({ length: 18 }, (_, i) => ({
  left: (i * 61) % 100,
  size: 2 + (i % 3),
  delay: (i * 0.9) % 11,
  duration: 11 + (i % 6),
  drift: ((i % 5) - 2) * 22,
}));

export default function AmbientBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
      {/* Grid tecnológico sutil */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: "radial-gradient(circle, #fac51c 1px, transparent 1.4px)",
          backgroundSize: "42px 42px",
        }}
      />

      {/* Palmeras en las esquinas, meciéndose */}
      <Palm className="w-[360px] opacity-[0.16] top-[-70px] left-[-80px]" transform="rotate(35deg)" anim="brand-sway" />
      <Palm className="w-[320px] opacity-[0.13] top-[-60px] right-[-70px]" transform="rotate(-40deg) scaleX(-1)" anim="brand-sway-slow" />
      <Palm className="w-[300px] opacity-[0.12] bottom-[-120px] left-[-50px]" transform="rotate(-18deg)" anim="brand-sway-alt" />
      <Palm className="w-[340px] opacity-[0.10] bottom-[-130px] right-[-60px]" transform="rotate(18deg) scaleX(-1)" anim="brand-sway" />

      {/* Brasas doradas flotando hacia arriba */}
      {EMBERS.map((e, i) => (
        <span
          key={i}
          className="brand-ember absolute rounded-full bg-brand-gold"
          style={{
            left: `${e.left}%`,
            width: e.size,
            height: e.size,
            // @ts-expect-error CSS custom property
            "--drift": `${e.drift}px`,
            animationDelay: `${e.delay}s`,
            animationDuration: `${e.duration}s`,
            boxShadow: "0 0 6px 1px rgba(250,197,28,0.6)",
          }}
        />
      ))}
    </div>
  );
}
