# Piloto real 02-09 — MATRIZ ÚNICA DE VALIDACIÓN

Rama `feat/control-center-v3-operational-polish` @ `68889de` · esquema 17.
**Desarrollo CONGELADO**: solo se aceptan P0 (rompe operación/cliente/
dinero), P1 (impide operar) y P2 (UX observada por Pedro en uso real).

Pedro/Óliver: pegad la evidencia TAL CUAL (sin tokens ni secretos) y
cambiad PENDING por PASS/FAIL. Nada se analiza antes de estar pegado.

Falta también, para el delta de producción:

```
PRODUCTION_COMMIT=
```

---

## WHATSAPP

| Comprobación | Estado | Evidencia |
|---|---|---|
| Template doctor (`whatsapp:templates:doctor` en el NAS) | PENDING | (pegar salida) |
| Provider template (nombre real usado) | PENDING | |
| Language | PENDING | |
| Status en la WABA (APPROVED) | PENDING | |
| Variables (aridad real vs 3 del mapping) | PENDING | |
| Buttons (nº y tipo vs 3 quick-reply) | PENDING | |
| First message (pedido test de la allowlist) | PENDING | nº pedido: |
| Delivered (sent → delivered → read) | PENDING | |
| Button visible y funciona | PENDING | |
| DB transition (pedido → CONFIRMADO en panel) | PENDING | |
| Duplicate protection (¿algún mensaje duplicado?) | PENDING | |

**VERDICT: BLOCKED** (por defecto hasta evidencia)
`BLOCKED / PILOT READY / 25% READY` — nunca de piloto a 100% directo.

---

## RETELL

| Comprobación | Estado | Evidencia |
|---|---|---|
| Prompt validator (`calls:validate-prompt`) | PENDING | |
| Prompt pegado y PUBLICADO en Retell (nº versión) | PENDING | versión: |
| Agent version fijada (`RETELL_AGENT_VERSION`) | PENDING | valor: |
| Doctor (`retell:doctor` donde esté la key) | PENDING | (pegar salida) |
| Simulator (`calls:simulate` → SAFE TO DIAL) | PENDING | |
| Real call — nombre correcto (sin placeholders) | PENDING | |
| Real call — producto correcto | PENDING | |
| Real call — dirección + CP dígito a dígito | PENDING | |
| Real call — importe correcto | PENDING | |
| Real call — ¿ALGÚN placeholder oído? (SI = **P0**) | PENDING | |
| Result persistence (`resultado` + agent_version en DB) | PENDING | |
| Naturalness (<90 s, tono natural) — si solo falla esto = P2 | PENDING | |

**VERDICT: BLOCKED**
`BLOCKED / MANUAL READY / AUTO READY` — si falta UNA casilla: MANUAL.

---

## Reglas de triage acordadas (para cuando llegue la evidencia)

- Placeholder oído en llamada / variable incorrecta / resultado que no
  persiste → **P0**: fixture + test rojo + fix mínimo + commit.
- Problema SOLO de prompt/versión → se arregla en Retell/env, **sin tocar
  scheduler ni DB**.
- Análisis acotado al circuito Shopify → enqueue → template → Meta →
  reply → DB. Sin auditorías generales.
- Feedback de UI de Pedro: registrar LITERAL y clasificar
  BLOCKER / CONFUSING / COSMETIC / PREFERENCE. Solo se cambian ya los dos
  primeros; el resto se agrupa para UNA pasada posterior.

## Política de atribución (vigente desde ya, sin cambios de código)

La captura UTM empezó en `68889de`: el histórico NO tiene atribución y
no se inventa. El ROAS POR CAMPAÑA **no se presenta como métrica fiable**
hasta acumular muestra: umbral acordado = **cobertura de campaña ≥ 60% y
≥ 30 pedidos atribuidos en la ventana**; por debajo, la tabla de Anuncios
se lee con su aviso de cobertura ("Cobertura X% — datos insuficientes
para comparar campañas") y no se toman decisiones de presupuesto con ella.
El esquema se queda en v17 salvo bug funcional real.
