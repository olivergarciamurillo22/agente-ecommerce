# Casamable Control Center

Centro de operaciones de **Casamable™** (`casamable.es`, Shopify): confirma
por WhatsApp los pedidos contra reembolso, escala a llamada (Retell) los que
no contestan, libera al almacén (Beeping) solo lo confirmado, sigue los
envíos hasta el cierre real (entregado/rehusado) y calcula la rentabilidad
con datos reales (Meta Ads read-only + atribución UTM).

El flujo de confirmación es **determinista** (sin IA en el camino crítico) y
todo el sistema es **fail-closed**: recién instalado no puede enviar nada.

## Arquitectura (2 minutos)

```
Shopify ─webhook─▶ SQLite (4 ejes de estado) ─▶ WhatsApp Cloud API
                                  │                 └─ sin respuesta → Retell (manual)
                                  ▼
                     Beeping / Dropea (fulfillment) ─▶ tracking ─▶ cierre
                                  ▼
                     Finanzas · Meta Ads · Calculadora COD
```

Detalle: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
Estado real de producción: [docs/ESTADO-PRODUCCION.md](docs/ESTADO-PRODUCCION.md) ·
Índice completo: [docs/README.md](docs/README.md)

## Ejecutar en local

```bash
npm install
npm run env:init        # crea .env.local desde la plantilla (secretos vacíos)
npm run env:doctor      # qué falta y dónde va
npm run dev:all         # bot + panel → http://localhost:3000
```

Con los defaults **no sale ningún mensaje** (TEST_MODE y EMERGENCY_STOP son
fail-closed). Los tests jamás tocan `data/` ni la red.

## Verificar

```bash
npm test                   # suite única (~557 tests), SQLite temporal, sin red
npm run typecheck
npm run build
npm run casamable:simulate # los 10 flujos operativos de punta a punta
npm run readiness          # veredicto LOCAL READY / NOT READY
```

## Doctors (solo lectura, por integración)

```bash
npm run env:doctor -- --profile local-safe
npm run dropea:doctor           npm run dropi:diagnose
npm run whatsapp:templates:doctor   # verifica plantillas REALES de la WABA
npm run retell:doctor               # agente, versión publicada, prompt en vivo
npm run calls:simulate              # preflight de llamada sin red
npm run beeping:doctor              npm run meta-ads:doctor
npm run deploy:precheck             # SAFE TO DEPLOY CODE / BLOCKED
```

## Desplegar (o mejor: cómo NO hacerlo)

Producción es un NAS con `docker compose`; **el despliegue lo hace Pedro a
mano** siguiendo [docs/DEPLOY-HOTFIX-02-09.md](docs/DEPLOY-HOTFIX-02-09.md),
siempre fuera de la franja 10:00–21:00 (reiniciar corta WhatsApp) y con
backup previo. Desde una sesión de desarrollo: **nunca** se despliega, no se
toca el NAS y no se abren flags de escritura.

## Ramas

- `feat/control-center-v3-operational-polish` — desarrollo actual (en validación real)
- `feat/casamable-control-center-v2` — lo desplegado en el NAS
- `main` — estable anterior; no refleja producción

Reglas de trabajo para sesiones de Claude: [CLAUDE.md](CLAUDE.md).

## Stack

Next.js · TypeScript · SQLite (`better-sqlite3`) · WhatsApp Cloud API
(Baileys como fallback de rollback) · Retell · Docker.
Origen: *WhatsApp AI Agent Kit* ([archivado](docs/archive/kit/12-kit-original-readme.md)).
