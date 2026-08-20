"use client";

function initials(label: string): string {
  const clean = label.replace(/^\+/, "").trim();
  if (/^\d+$/.test(clean)) return clean.slice(-2); // teléfonos: últimos 2 dígitos
  const parts = clean.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function Avatar({ label, size = 40 }: { label: string; size?: number }) {
  return (
    <div
      className="shrink-0 rounded-full flex items-center justify-center font-semibold text-brand-gold border border-brand-gold/25"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: "radial-gradient(circle at 30% 25%, rgba(250,197,28,0.18), rgba(250,197,28,0.05))",
      }}
    >
      {initials(label)}
    </div>
  );
}
