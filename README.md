# Casamable™ · Confirmación de pedidos COD por WhatsApp

Confirma automáticamente por WhatsApp los pedidos **contra reembolso** de una
tienda Shopify, para dejar de llamar a mano a cada cliente.

El problema que resuelve: en una tienda COD hay que telefonear a cada comprador
para verificar que el pedido es real, que sigue queriéndolo y que la dirección
está completa. Eso no escala. Aquí lo hace WhatsApp, y solo quedan por llamar
los que no contestan o tienen algún problema.

```text
Shopify (Releasit COD Form)
   └─ webhook ─▶ el sistema detecta el pedido y lo guarda
                    └─ WhatsApp al cliente:
                         1 · Todo correcto          → CONFIRMADO + tag en Shopify
                         2 · Cambiar la dirección   → queda propuesta para revisar
                         3 · Nota para el repartidor → se guarda (no confirma)
                         sin respuesta              → recordatorio → NECESITA LLAMADA
```

Todo el flujo es **determinista: no usa IA** y su coste operativo es 0 €.

## Estado

Funcionando en producción controlada. Validado de punta a punta con pedidos y
clientes reales: confirmaciones, corrección de direcciones, notas al repartidor
y el tag `WA_CONFIRMED` en Shopify.

**83 tests** (flujo, seguridad, concurrencia y adversariales), typecheck y build
en verde.

## Seguridad primero

El sistema **arranca bloqueado** y no puede enviar nada por accidente. Toda
acción externa pasa por unos *safety gates* centrales
([`src/lib/safety.ts`](src/lib/safety.ts)):

| Acción | Requiere TODO esto a la vez |
|---|---|
| Enviar un WhatsApp real | `APP_MODE=production` + `WHATSAPP_SEND_ENABLED=1` + `EMERGENCY_STOP=0` + destinatario permitido |
| Escribir en Shopify (solo `tagsAdd WA_CONFIRMED`) | `APP_MODE=production` + `SHOPIFY_WRITE_ENABLED=1` + `EMERGENCY_STOP=0` |

Además: allowlist de teléfonos de prueba y autorización manual por pedido,
ventana horaria de envío (nadie recibe mensajes de madrugada), descarte de
webhooks antiguos, idempotencia por pedido y por acción, y un kill switch
global. Los grupos, los números desconocidos y los propios mensajes del bot se
ignoran por completo.

## Cómo funciona por dentro

```text
Shopify ──POST /api/webhooks/shopify/orders-create──▶ Next.js (dashboard + APIs)
   (HMAC + tag releasit_cod_form + dedupe + edad máxima)      │
                                                              ▼
                                       SQLite (data/messages.db) ← fuente de verdad
                                                              ▲
bot: Baileys (WhatsApp) + scheduler cada 20s + outbox ────────┘
```

Un único proceso sirve el panel y el bot porque **comparten la misma base de
datos**. Sin colas externas, sin Redis, sin Postgres.

- [`src/lib/orders/`](src/lib/orders/) — detección COD, mensajes, máquina de estados y scheduler
- [`src/lib/shopify/`](src/lib/shopify/) — verificación HMAC, webhook y tag
- [`src/lib/safety.ts`](src/lib/safety.ts) — los gates por los que pasa todo
- [`src/lib/whatsapp.ts`](src/lib/whatsapp.ts) — abstracción de envío (facilita migrar a la Cloud API de Meta)

## Empezar

```bash
npm install
cp .env.example .env.local     # rellena las credenciales de Shopify
npm run dev:all                # bot + dashboard → http://localhost:3000
```

Con la configuración por defecto **no puede salir ningún mensaje**: hay que
abrir las llaves a conciencia siguiendo el rollout por etapas.

📖 **[PEDRO-MVP.md](PEDRO-MVP.md)** — guía completa: instalación, conectar
WhatsApp, configurar Shopify y el rollout por etapas (A → D).

🐳 **[docs/UGREEN-DXP2800-DEPLOY.md](docs/UGREEN-DXP2800-DEPLOY.md)** —
despliegue 24/7 en un NAS con Docker, persistencia, backups y HTTPS.

🤝 **[docs/COLLABORATION.md](docs/COLLABORATION.md)** — flujo de ramas, tests
antes de subir y zonas críticas del código.

## Comandos

```bash
npm run dev:all            # bot + dashboard (desarrollo)
npm test                   # 83 tests, con base de datos temporal y sin red
npm run typecheck          # tipos
npm run build              # compilar producción
npm run backup             # copia consistente de la base de datos
npm run outbox:inspect     # ver mensajes pendientes de envío
npm run outbox:clear-safe  # descartarlos SIN enviarlos
docker compose up -d --build   # producción (NAS o servidor)
```

## Stack

Next.js · TypeScript · SQLite (`better-sqlite3`) · Baileys · Docker

Construido sobre el *WhatsApp AI Agent Kit*, cuyo agente conversacional de IA
queda desacoplado y desactivado por defecto
([README original archivado](docs/12-kit-original-readme.md)).
