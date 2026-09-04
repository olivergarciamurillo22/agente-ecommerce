"use client";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) return setError(body.error ?? "No se pudo iniciar sesión");
    window.location.assign(body.destination);
  }
  return <main className="min-h-screen grid place-items-center bg-brand-bg px-5">
    <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-brand-border bg-brand-surface p-7 shadow-[var(--shadow-card)]">
      <div className="text-[12px] font-semibold uppercase tracking-[.14em] text-brand-accent">Casamable</div>
      <h1 className="mt-2 font-display text-[26px] font-semibold">Iniciar sesión</h1>
      <p className="mt-1 text-[13px] text-brand-muted">Accede a tu espacio de atención al cliente.</p>
      <label className="mt-6 block text-[12px] font-medium">Correo</label>
      <input name="email" type="email" required autoComplete="email" className="mt-1 h-11 w-full rounded-lg border border-brand-border px-3 outline-none focus:border-brand-border-strong" />
      <label className="mt-4 block text-[12px] font-medium">Contraseña</label>
      <input name="password" type="password" required autoComplete="current-password" className="mt-1 h-11 w-full rounded-lg border border-brand-border px-3 outline-none focus:border-brand-border-strong" />
      {error && <p role="alert" className="mt-3 text-[13px] text-red-600">{error}</p>}
      <button disabled={busy} className="mt-6 h-11 w-full rounded-lg bg-brand-text font-semibold text-white disabled:opacity-50">{busy ? "Entrando…" : "Entrar"}</button>
    </form>
  </main>;
}
