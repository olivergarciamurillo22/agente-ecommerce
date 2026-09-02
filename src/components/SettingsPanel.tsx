"use client";

import { useEffect, useState } from "react";

type Settings = Record<string, string>;

const MODELOS = [
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 · calidad (~$0,12/conv)" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini · el más barato (~$0,02/conv)" },
  { id: "openai/gpt-5-mini", label: "GPT-5 mini (~$0,03/conv)" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (~$0,03/conv)" },
];

const TRANS_MODELOS = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (recomendado)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (más preciso, más caro)" },
];

function Card({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-brand-border bg-brand-surface/70 p-5">
      <div className="mb-3">
        <div className="font-display text-lg font-bold text-brand-text">{title}</div>
        {desc && <div className="text-xs text-brand-muted mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export default function SettingsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setS(j.settings))
      .catch(() => {});
  }, []);

  async function save(key: string, value: string) {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const j = await r.json();
      if (j.settings) setS(j.settings);
      setSaved(key);
      setTimeout(() => setSaved((k) => (k === key ? null : k)), 1500);
    } catch {
      // silenciar
    }
  }

  if (!s) {
    return <section className="h-full flex items-center justify-center text-brand-muted">Cargando ajustes…</section>;
  }

  const paused = s.paused === "1";
  const audioOn = s.audio_enabled !== "0";
  const modelInList = MODELOS.some((m) => m.id === s.model);
  const savedTag = (k: string) =>
    saved === k ? <span className="text-[11px] text-wa-green ml-2">guardado ✓</span> : null;

  return (
    <section className="h-full overflow-y-auto p-5 bg-brand-bg/30">
      <div className="max-w-2xl mx-auto space-y-4">
        <h2 className="font-display text-xl font-bold text-brand-text">Configuración del agente</h2>

        {/* Estado / pausa */}
        <Card title="Estado del agente" desc="Pausa las respuestas sin apagar el servidor. En pausa, los mensajes siguen llegando y se ven en el panel, pero el agente no contesta.">
          <div className="inline-flex rounded-lg border border-brand-border p-0.5 bg-brand-bg">
            <button
              onClick={() => save("paused", "0")}
              className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${!paused ? "bg-wa-green text-black" : "text-brand-muted hover:text-brand-text"}`}
            >
              ● Activo
            </button>
            <button
              onClick={() => save("paused", "1")}
              className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${paused ? "bg-brand-gold text-white" : "text-brand-muted hover:text-brand-text"}`}
            >
              ⏸ En pausa
            </button>
          </div>
          {savedTag("paused")}
          {paused && <div className="text-xs text-brand-gold mt-2">El agente está en pausa: no responde a nadie ahora mismo.</div>}
        </Card>

        {/* Modelo LLM */}
        <Card title="Modelo de IA (el cerebro)" desc="Cámbialo si quieres bajar coste a gran volumen o subir calidad. Se aplica al instante, sin reiniciar.">
          <select
            value={modelInList ? s.model : "__custom__"}
            onChange={(e) => e.target.value !== "__custom__" && save("model", e.target.value)}
            className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm text-brand-text focus:outline-none focus:border-brand-gold/50"
          >
            {MODELOS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
            {!modelInList && <option value={s.model}>{s.model} (actual)</option>}
            <option value="__custom__">Otro (escribir id de OpenRouter)…</option>
          </select>
          {savedTag("model")}
          <div className="flex gap-2 mt-2">
            <input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="p. ej. anthropic/claude-sonnet-5"
              className="flex-1 bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm text-brand-text placeholder:text-brand-muted focus:outline-none focus:border-brand-gold/50"
            />
            <button
              onClick={() => customModel.trim() && save("model", customModel.trim())}
              className="px-3 py-2 rounded-lg bg-brand-gold text-white text-sm font-semibold disabled:opacity-40"
              disabled={!customModel.trim()}
            >
              Usar
            </button>
          </div>
          <div className="text-[11px] text-brand-muted mt-1.5">Modelo activo: <span className="text-brand-gold font-mono">{s.model}</span></div>
        </Card>

        {/* Creatividad */}
        <Card title="Creatividad de las respuestas" desc="Baja = más ceñido al guion. Alta = más suelto y variado. Recomendado 0,4.">
          <div className="flex items-center gap-4">
            <input
              type="range" min={0} max={1.2} step={0.1}
              value={parseFloat(s.temperature)}
              onChange={(e) => save("temperature", e.target.value)}
              className="flex-1 accent-brand-gold"
            />
            <span className="text-sm font-mono text-brand-gold w-10 text-right">{parseFloat(s.temperature).toFixed(1)}</span>
          </div>
          {savedTag("temperature")}
        </Card>

        {/* Buffer */}
        <Card title="Tiempo de espera antes de responder" desc="Segundos que espera por si el lead sigue escribiendo, para responder a todo junto. Más = más humano; menos = más rápido.">
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} max={120}
              value={s.buffer_seconds}
              onChange={(e) => setS((p) => (p ? { ...p, buffer_seconds: e.target.value } : p))}
              onBlur={(e) => save("buffer_seconds", e.target.value)}
              className="w-24 bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm text-brand-text focus:outline-none focus:border-brand-gold/50"
            />
            <span className="text-sm text-brand-muted">segundos</span>
            {savedTag("buffer_seconds")}
          </div>
        </Card>

        {/* Audios */}
        <Card title="Notas de voz" desc="El agente transcribe los audios y responde. Puedes desactivarlo o cambiar el modelo de transcripción.">
          <div className="inline-flex rounded-lg border border-brand-border p-0.5 bg-brand-bg mb-3">
            <button
              onClick={() => save("audio_enabled", "1")}
              className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${audioOn ? "bg-wa-green text-black" : "text-brand-muted hover:text-brand-text"}`}
            >
              Activados
            </button>
            <button
              onClick={() => save("audio_enabled", "0")}
              className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors ${!audioOn ? "bg-brand-gold text-white" : "text-brand-muted hover:text-brand-text"}`}
            >
              Desactivados
            </button>
          </div>
          {savedTag("audio_enabled")}
          {audioOn && (
            <select
              value={s.transcription_model}
              onChange={(e) => save("transcription_model", e.target.value)}
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm text-brand-text focus:outline-none focus:border-brand-gold/50"
            >
              {TRANS_MODELOS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
              {!TRANS_MODELOS.some((m) => m.id === s.transcription_model) && (
                <option value={s.transcription_model}>{s.transcription_model} (actual)</option>
              )}
            </select>
          )}
        </Card>

        <div className="text-[11px] text-brand-muted text-center pt-1">
          Los cambios se aplican al instante en el próximo mensaje. Se guardan en el servidor (persisten aunque se reinicie).
        </div>
      </div>
    </section>
  );
}
