# Referencia de configuración

> La **fuente de verdad es `src/lib/config/env-schema.ts`** — este documento
> es el resumen humano. Si difieren, gana el schema (y hay que arreglar esto).

## Dónde vive cada cosa

| Entorno | Archivo | Quién lo gestiona |
|---|---|---|
| Mac (Óliver) | `.env.local` | Óliver, a mano |
| NAS (producción) | `.env` (compose `env_file`) | Pedro, a mano |
| Tests | variables fijadas en `tests/run-tests.ts` | el propio harness |

## Settings (SQLite) vs env — precedencia REAL

Estas claves se gestionan **desde el panel** (tabla `settings`) y el env solo
aporta el valor inicial si la DB no tiene nada. **No** las pongas en
`.env.local` esperando que manden:

| Clave | Fuente | Override | Default |
|---|---|---|---|
| `ai_calls_enabled` | DB settings (panel, en vivo) | env `AI_CALLS_ENABLED` solo como semilla | 0 |
| `calls_shadow_mode` | DB settings | env como semilla | 1 |
| `calls_daily_cap` | DB settings | env como semilla | 30 |
| `calls_allowlist` | DB settings | env `CALLS_ALLOWLIST` como semilla | vacía (= NADIE con TEST_MODE=1) |
| `call_first_retry_minutes` | DB settings | env como semilla | 120 |
| `paused`, `audio_enabled` | DB settings (panel) | — | — |

## Las dos allowlists (no son iguales)

| | vacía significa |
|---|---|
| `TEST_PHONE_ALLOWLIST` (WhatsApp) | **NADIE** recibe nada (fail-closed) |
| `CALLS_ALLOWLIST` (llamadas) | con `TEST_MODE=1`: **NADIE** (fail-closed del 26-08) · con `TEST_MODE=0`: sin restricción |

## Dropi: no configurar

`DROPIPRO_API_KEY` y `DROPIPRO_API_BASE_URL` existen por compatibilidad del
andamiaje. **Dropi no tiene API pública** (soporte, 25-08): rellenarlas es un
ERROR que `env:doctor` señala. `DROPIPRO_WEBHOOK_SECRET` queda reservada
(FUTURE) por si algún día firman webhooks.

## Plantillas de Meta: no son variables

El catálogo es `config/whatsapp-templates.json` (la plantilla de confirmación
es `order_confirmation_request`, idioma incluido). No existen
`META_WHATSAPP_TEMPLATE_*` en el código — añadir una variable que nadie lee
es exactamente el bug de documentación que ya nos mordió dos veces.

## El catálogo completo

`npm run env:doctor` con cada perfil ES la referencia viva: enumera cada
variable con su categoría, si es secreta, su default y qué perfil la exige.
Para el detalle de cada una: `.env.example` (comentada línea a línea) y el
schema.
