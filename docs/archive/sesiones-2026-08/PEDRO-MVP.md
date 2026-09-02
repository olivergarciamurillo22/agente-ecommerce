> **ARCHIVED / SUPERSEDED (03-09-2026).** Fuente de verdad actual: `docs/README.md`.

# Casamable™ · Confirmación de pedidos COD por WhatsApp

Sistema para la tienda Shopify de Casamable™ (`casamable.es` /
`qmbr1z-vf.myshopify.com`): cada pedido contra reembolso creado con **Releasit
COD Form** dispara un WhatsApp automático confirmando pedido, dirección y
recogiendo notas para el repartidor. Pedro solo llama a quien **no contesta**
o tiene **algún problema**.

**KPI: reducir drásticamente las llamadas manuales.**

> ⚠️ **REGLA DE SEGURIDAD**: el sistema arranca en **SAFE MODE** y NO puede
> enviar mensajes ni tocar Shopify hasta que se abren varias llaves a la vez.
> Lee "Seguridad y rollout" antes de cambiar nada en `.env.local`.

---

## 1 · Qué hace

1. Shopify avisa por webhook cuando entra un pedido.
2. Es COD si lleva el tag **`releasit_cod_form`** (confirmado en 49/49 pedidos
   reales; hay fallback por keywords). El tag `error Dropi` u otros no molestan.
3. WhatsApp al cliente con la voz de Pedro (productos reales del pedido,
   total en formato `39,97 €`, dirección completa) y tres opciones:
   - **1** → `CONFIRMADO` + tag `WA_CONFIRMED` en Shopify (tagsAdd: no borra
     los tags existentes).
   - **2** → pide la dirección completa; lo que escriba queda como *dirección
     propuesta* para revisión de Pedro. NUNCA se cambia Shopify solo.
   - **3** → pide la **nota para el repartidor**; se guarda en el pedido y se
     vuelve a pedir el 1/2 (la nota NO confirma).
   - **Silencio** → recordatorio a los 30 min; a las 2 h pasa a `NECESITA
     LLAMADA` (configurable).
   - **Respuesta rara** → una aclaración; si reincide, `NECESITA LLAMADA`.
     Jamás se confirma con una respuesta ambigua.
4. Varios pedidos activos en el mismo teléfono → se pide el número de pedido
   ("35010484 1"). Nada se confirma ni se anota "al que sea".
5. Dashboard: KPIs + tabla (productos, total, dirección, **nota repartidor**,
   estado) + el filtro crítico **📞 NECESITAN LLAMADA** + banner de seguridad
   permanente con el modo actual.

Sin IA (`OPENROUTER_API_KEY` vacía = 0 €): todo el flujo es determinista.

## 2 · El número de WhatsApp

El sistema opera con un **número empresarial DEDICADO de Casamable™**
(línea nueva/eSIM que Pedro está contratando), registrado en **WhatsApp
Business** y vinculado por QR. **Nunca el número personal de Pedro.**

- Cuando exista la línea: ponla en `BUSINESS_WHATSAPP_NUMBER` (ej.
  `34XXXXXXXXX`). Si alguien escanea el QR con otro teléfono, el bot avisa en
  el log (`[SAFETY] El WhatsApp conectado NO es el número Business...`).
- `ALERT_WHATSAPP` es otra cosa: el móvil (puede ser el personal de Pedro) que
  RECIBE avisos técnicos del sistema.
- Los mensajes siguen firmando "Soy Pedro, de atención al cliente de
  Casamable™": Pedro es quien da la cara, aunque el número sea de la empresa.

## 3 · Arquitectura (sin cambios de la aprobada)

```
Shopify ──POST /api/webhooks/shopify/orders-create──▶ Next.js (dashboard+APIs)
   (HMAC + tag releasit_cod_form + dedupe + edad máx.)      │
                                                            ▼
                                     SQLite (data/messages.db) ← fuente de verdad
                                                            ▲
bot (npm run start:bot): Baileys + scheduler (20s) + outbox │
   inicial → recordatorio → NECESITA LLAMADA ───────────────┘
```

Sin n8n, sin Supabase, sin Airtable, sin Redis, sin colas externas.

**Safety gates** (`src/lib/safety.ts`) — TODA acción externa pasa por aquí:

| Acción | Requiere TODO esto a la vez |
|---|---|
| WhatsApp real | `APP_MODE=production` + `WHATSAPP_SEND_ENABLED=1` + `EMERGENCY_STOP=0` + teléfono permitido por `TEST_MODE`/allowlist |
| Escribir en Shopify (solo `tagsAdd WA_CONFIRMED`) | `APP_MODE=production` + `SHOPIFY_WRITE_ENABLED=1` + `EMERGENCY_STOP=0` |

Además: pedidos con más de `MAX_ORDER_AGE_MINUTES` (30) → `ignored_old`, sin
acciones jamás (anti-replay/backfill); mensajes de outbox con más de
`OUTBOX_MAX_AGE_MINUTES` (60) quedan retenidos; grupos/broadcast/newsletter
bloqueados; números sin pedido activo se ignoran en silencio (jamás "no
encuentro tu pedido" a un amigo de Pedro); idempotencia por pedido Y por
acción (imposible duplicar inicial/recordatorio/tag).

## 4 · Instalación

```bash
npm install
npm run dev:all        # bot + dashboard → http://localhost:3000
```

`.env.local` ya está preparado: solo faltan `SHOPIFY_WEBHOOK_SECRET` (paso 6)
y, cuando exista, `BUSINESS_WHATSAPP_NUMBER`. El token de Admin API ya está
puesto. Con la configuración por defecto (SAFE) **no puede salir nada**.

## 5 · Conectar WhatsApp (el número Business)

1. `npm run dev:all` → http://localhost:3000 → QR.
2. En el teléfono con la línea dedicada de Casamable: **WhatsApp Business →
   Ajustes → Dispositivos vinculados → Vincular un dispositivo** → escanear.
3. El panel pasa a "Conectado". La sesión persiste en `auth/`.
4. Comprueba en el log que no aparece el aviso de número equivocado.

## 6 · Shopify: token y webhook

**Token Admin API** (ya rellenado): app con scopes **mínimos** `read_orders` +
`write_orders` (write solo se usa para `tagsAdd`; no pedimos fulfillment,
refunds ni nada más). Sin token: todo funciona, sin tag (retro-tag al ponerlo).

**Webhook**: Shopify Admin → **Configuración → Notificaciones → Webhooks →
Crear webhook**: evento *Creación de pedidos*, formato JSON, URL
`https://TU-TUNEL/api/webhooks/shopify/orders-create`. La clave de firma que
sale en esa misma página → `SHOPIFY_WEBHOOK_SECRET`. (Si el webhook se crease
vía app/API, el secret sería el *client secret* de la app.)

**Túnel local** (gratis): `cloudflared tunnel --url http://localhost:3000`
(la URL cambia en cada arranque: actualiza el webhook). Si expones el panel,
pon `DASHBOARD_PASSWORD` (webhooks y /api/health siguen abiertos).

## 7 · Seguridad y rollout por etapas

El banner del dashboard y el arranque del bot muestran SIEMPRE el modo actual.
`EMERGENCY_STOP=1` en cualquier momento = todo parado al instante (el panel y
la recepción de webhooks siguen funcionando).

### ETAPA A — SAFE (config actual por defecto)

```env
APP_MODE=safe
TEST_MODE=1
WHATSAPP_SEND_ENABLED=0
SHOPIFY_WRITE_ENABLED=0
EMERGENCY_STOP=1
```

Objetivo: crear un pedido de prueba y verificar que TODO se simula: el pedido
aparece en el panel como EN COLA, el log muestra `[SAFE MODE] WhatsApp NO
enviado | Destino: ... | Mensaje preparado: ...` y outbox queda vacío
(`npm run outbox:inspect`). **Nada sale.**

### ETAPA B — WhatsApp real SOLO a nuestros números

```env
APP_MODE=production
TEST_MODE=1
TEST_PHONE_ALLOWLIST=TU_NUMERO,NUMERO_PEDRO      # ej. 34600111222,34600333444
WHATSAPP_SEND_ENABLED=1
SHOPIFY_WRITE_ENABLED=0
EMERGENCY_STOP=0
```

Objetivo: pedido con TU teléfono → te llega el WhatsApp real → respondes
1/2/3. Shopify sigue en solo-lectura. Cualquier pedido de un cliente real se
guarda pero se ignora (`[TEST MODE] Pedido ignorado: teléfono fuera de allowlist`).

### ETAPA C — probar el tag con nuestro pedido

```env
SHOPIFY_WRITE_ENABLED=1        # (resto igual que B)
```

Objetivo: pedido nuestro → WhatsApp nuestro → respondemos 1 → el pedido de
prueba recibe `WA_CONFIRMED` en Shopify (sin tocar sus otros tags).

### ETAPA D — piloto real controlado (NO activar todavía)

```env
TEST_MODE=0
```

Solo tras validar A-C. El arranque lo avisa en rojo. El kill switch
(`EMERGENCY_STOP=1`) queda siempre a un segundo de distancia.

**Antes de pasar de etapa**: `npm run outbox:inspect` (cola limpia) y
`npm run outbox:clear-safe` si hay restos de pruebas.

## 8 · Primera prueba real (Etapas B–C)

1. Rellena `.env.local` (webhook secret + allowlist con tu número).
2. Conecta el WhatsApp Business por QR.
3. Túnel: `cloudflared tunnel --url http://localhost:3000` → URL al webhook.
4. Para no esperar: `FIRST_REMINDER_MINUTES=1`, `NEEDS_CALL_MINUTES=2`.
5. Crea un pedido COD con el formulario Releasit usando TU teléfono.
6. Verifica en Shopify que el pedido lleva el tag `releasit_cod_form`.
7. Te llega el WhatsApp ("Soy Pedro, de atención al cliente de Casamable™…").
8. Responde `1` → dashboard **CONFIRMADO** → (Etapa C) tag `WA_CONFIRMED`.
9. Prueba nota: en otro pedido responde `3` → "Llamar antes de subir" → la
   nota aparece en el panel (columna *Nota repartidor* y en el detalle) →
   responde `1` → confirmado (la nota se conserva).
10. Prueba silencio: no contestes → recordatorio al minuto → a los 2 min pasa
    a **📞 NECESITAN LLAMADA** en el panel.
11. Al acabar: tiempos reales (30/120) y revisa el rollout de la sección 7.

## 9 · Dashboard

- **Pedidos** (vista principal): KPIs, filtros (el rojo **📞 Necesitan
  llamada** es el crítico), tabla con Productos / Total (€ es-ES) / Dirección /
  Nota repartidor / Estado / Hora, y detalle con dirección actual vs propuesta,
  nota del repartidor y los datos del formulario Releasit (p.ej. "¿A qué hora
  estarás en casa?").
- Acciones: Ver, ✓ Confirmar, 📞 Llamar, ↻ Reenviar (pide confirmación
  explícita con cliente+teléfono+pedido), Descartar. Todas pasan por los gates.
- Banner de seguridad SIEMPRE visible: SAFE / TEST / PRODUCTION + estado de
  WhatsApp sending / Shopify writes / Emergency stop.

## 10 · Parar el sistema

Ctrl+C en la terminal (`dev:all` para bot y web). Estado en SQLite: al volver
a arrancar retoma donde iba. Pánico → `EMERGENCY_STOP=1` y reiniciar (o
directamente Ctrl+C). Shopify reintenta webhooks 8 veces/4h; los pedidos que
lleguen tarde con más de 30 min se marcan `ignored_old` y no disparan nada.

## 11 · Límites actuales

- Baileys (WhatsApp Web) hasta migrar a la Cloud API oficial; el código de
  envío está aislado en `src/lib/whatsapp.ts` para ese cambio.
- La dirección propuesta y la nota NO se escriben en Shopify/Dropi (a
  propósito; Dropi vendrá después).
- Un pedido `ignored_old` no se puede "reenviar" salvo subiendo
  `MAX_ORDER_AGE_MINUTES` (protección deliberada).
- Una tienda, un número emisor.

## 12 · Chuleta

```bash
npm run dev:all            # bot + dashboard
npm test                   # 70 tests (flujo + seguridad + adversariales), DB temporal, sin red
npm run typecheck && npm run build
npm run outbox:inspect     # ver mensajes pendientes de envío
npm run outbox:clear-safe  # descartarlos SIN enviarlos
npm run doctor             # diagnóstico
npm run clean              # ⚠️ borra data/ y auth/ (pedidos locales y sesión)
```

### Notas de la auditoría preproducción (2026-08-20)

- **Allowlist**: los teléfonos se normalizan igual que los de los pedidos —
  "600111222", "+34 600 11 12 22" y "34600111222" son el mismo número.
- **Acciones manuales en TEST_MODE**: Confirmar y Reenviar solo funcionan
  sobre pedidos de la allowlist (403 con explicación en el resto). Marcar
  para llamar y Descartar son internas y siempre se permiten.
- **Entrega WhatsApp**: patrón claim→send→revert en el outbox. WhatsApp no
  ofrece clave de idempotencia, así que se prioriza **no duplicar jamás** un
  mensaje: en el peor crash posible un mensaje puede perderse, y la red de
  recordatorio/needs_call recoge al cliente. Riesgo residual documentado.
- **Agente IA legacy**: doble opt-in (`OPENROUTER_API_KEY` + `AI_AGENT_ENABLED=1`).
  Una key suelta en el .env ya no puede activar un bot comercial.
- **Dependencias**: `npm audit` limpio (0 vulnerabilidades) tras actualizar,
  entre otras, Baileys a 6.7.24 (fix crítico de spoofing de mensajes).
