"use client";

interface ModeToggleProps {
  mode: "AI" | "HUMAN";
  onChange: (mode: "AI" | "HUMAN") => void;
}

export default function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="inline-flex rounded-lg overflow-hidden border border-brand-border p-0.5 bg-brand-bg">
      <button
        onClick={() => onChange("AI")}
        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
          mode === "AI"
            ? "bg-brand-gold text-black"
            : "text-brand-muted hover:text-brand-text"
        }`}
      >
        Agente IA
      </button>
      <button
        onClick={() => onChange("HUMAN")}
        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
          mode === "HUMAN"
            ? "bg-wa-green text-black"
            : "text-brand-muted hover:text-brand-text"
        }`}
      >
        Modo Humano
      </button>
    </div>
  );
}
