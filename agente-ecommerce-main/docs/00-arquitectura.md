# 00 · Arquitectura del sistema

Este documento explica cómo funciona el agente por dentro. Sirve para dos cosas:
que Claude pueda **explicártelo cuando preguntes**, y que si algún día quieres
**tocar o ampliar** algo, sepas dónde está cada pieza.

Está escrito en dos niveles: primero en cristiano, luego el detalle técnico.

---

## En cristiano (la versión de 1 minuto)

Alguien te escribe un WhatsApp. El agente:

1. **Lo recibe** (a través de WhatsApp Web, no de la API oficial).
2. **Espera unos segundos** por si esa persona sigue escribiendo, para responder
   a todo junto (como haría un humano).
3. **Pasa unos filtros de seguridad** (que no te cuelen spam, que el agente no
   invente precios ni mande enlaces raros).
4. **Recuerda quién es** esa persona si ya había hablado contigo antes.
5. **Se lo da a la IA**, que decide qué responder y, si toca, **guarda el lead**
   en tu CRM.
6. **Humaniza la respuesta** (sin símbolos raros, partida en varios mensajes) y
   **la envía**.
7. Un **vigilante** comprueba en segundo plano que todo va bien y te avisa si no.

Todo esto vive en un solo programa que corre en tu ordenador (para probar) o en
un servidor (para que funcione 24/7).

---

## El stack (con qué está hecho)

| Pieza | Para qué | Obligatorio |
|---|---|---|
| **Next.js + React** | El panel de control (dashboard) que ves en el navegador | Sí |
| **Baileys** | La conexión a WhatsApp (WhatsApp Web, por QR) | Sí |
| **OpenRouter** | La pasarela hacia el modelo de IA (Claude, GPT, etc.) | Sí |
| **SQLite** (`better-sqlite3`) | La base de datos local: conversaciones, mensajes, ajustes | Sí |
| **Airtable** | Tu CRM de leads | Opcional |
| **Supabase** | La memoria de largo plazo del agente | Opcional |

Un solo repositorio contiene **el bot y el panel**. Se arrancan juntos con
`npm run start:all` (el bot escucha WhatsApp; el panel sirve el dashboard).

---

## El recorrido de un mensaje (el flujo completo)

```
WhatsApp ──▶ Baileys (client.ts) ──▶ handler.ts
                                        │
     ┌──────────────────────────────────┤
     │  1. Identifica a la persona (canonicalPhone: resuelve el @lid al número real)
     │  2. Guarda el mensaje en SQLite (db.ts) + espeja a Supabase (memory.ts)
     │  3. guardInbound (guardrails.ts): anti-flood, trunca lo desmedido
     │  4. Espera BUFFER_SECONDS por si escribe más (agrupa la ráfaga)
     ▼
   generateReply (openrouter.ts)
     │  5. buildSystemPrompt: wrapper fijo + tu negocio.md + memoria de esa persona
     │  6. Llama al modelo con las tools (guardarLead, calificar)
     │  7. Si el modelo llama una tool → la ejecuta (tools/) y vuelve a llamar
     │  8. Si el modelo se queda sin texto tras una tool → fuerza una respuesta
     ▼
   guardOutbound (guardrails.ts): ¿precio no autorizado? ¿enlace raro? ¿fuga del prompt?
     │
     ▼
   humanize.ts: quita símbolos de bot, parte en varios mensajes (|||)
     │
     ▼
   sock.sendMessage ──▶ WhatsApp   (+ guarda la respuesta en SQLite y Supabase)

   En paralelo: watchdog.ts vigila cada 5 min (bot mudo, saldo bajo) y hace un
   parte diario con IA. Te avisa por WhatsApp a ALERT_WHATSAPP.
```

---

## Las piezas, una a una

### Conexión a WhatsApp — `src/lib/baileys/`
- **`client.ts`** — abre la sesión de WhatsApp (genera el QR, reconecta solo,
  mantiene `connection_state`). Arranca el outbox y el watchdog al conectar.
- **`handler.ts`** — el corazón. Recibe cada mensaje, lo identifica (resolviendo
  el `@lid` de WhatsApp 2025 a su número real para no duplicar personas), aplica
  el buffer de agrupación, transcribe audios, llama al LLM y envía la respuesta
  troceada. Si algo falla, manda un aviso suave en vez de quedarse mudo.
- **`outbox.ts`** — cola de los mensajes que el humano envía desde el panel.

### El cerebro — `src/lib/openrouter.ts` + `system-prompt.ts`
- **`system-prompt.ts`** arma las instrucciones: un wrapper fijo (cómo escribir,
  cómo usar las tools) + **tu `prompts/negocio.md`** + la memoria de esa persona.
- **`openrouter.ts`** llama al modelo, ejecuta las tools que pida (hasta 5 vueltas)
  y devuelve el texto. Tiene timeout y fuerza una respuesta si el modelo se calla.

### Las herramientas — `src/lib/tools/`
- **`guardarLead`** — registra/actualiza el lead en Airtable (solo cuando ya hay
  nombre + email; fusiona datos de varios mensajes) y en la memoria de Supabase.
- **`calificar`** — puntúa el interés del lead (no escribe en el CRM).

### Seguridad — `src/lib/guardrails.ts`
Capa independiente del modelo. A la ENTRADA: anti-flood. A la SALIDA: bloquea
precios que no están en tu lista (`ALLOWED_PRICES`), enlaces fuera de tu lista
(`ALLOWED_HOSTS`), fugas del prompt (el "canario") y promesas de ingresos. Si no
configuras las listas, esos guardrails quedan permisivos y el kit funciona igual.

### Memoria de largo plazo — `src/lib/memory.ts` (Supabase, opcional)
Guarda una ficha por persona (nombre, email, resumen de lo hablado) y el registro
de todos los mensajes. Cuando alguien vuelve a escribir semanas después, el agente
lo reconoce y retoma. Es best-effort: si Supabase falla, el agente responde igual.

### Autovigilancia — `src/lib/watchdog.ts` (opcional)
Cada 5 minutos comprueba si el bot se ha quedado mudo o si se acaba el saldo, y te
avisa por WhatsApp. Una vez al día, un modelo audita las conversaciones y te manda
un parte (leads a rescatar, fallos, sugerencias). Ver `docs/10-watchdog.md`.

### Humanización — `src/lib/humanize.ts`
Quita los símbolos que delatan a un bot (guiones largos, asteriscos, viñetas) y
parte la respuesta en varios mensajes cortos, con retardos, para que suene real.

### Base de datos local — `src/lib/db.ts`
SQLite (archivo `data/messages.db`). Tablas: conversaciones, mensajes, estado de
conexión, ajustes (modelo, pausa…), outbox, métricas. Es lo que alimenta el panel.

### El panel — `src/app/` + `src/components/`
Dashboard en Next.js: ver conversaciones, tomar el control de una charla, métricas,
ajustes en caliente (modelo, pausa). Rutas API en `src/app/api/`. Personalizable
(colores, logo, secciones nuevas) — ver `docs/09-personalizar-dashboard.md`.

---

## Dónde vive cada dato

- **SQLite** (`data/messages.db`, en el propio servidor): todas las conversaciones
  y mensajes, el estado, los ajustes. Es la fuente del panel. Se pierde si borras
  el volumen `/app/data` en producción → por eso ese volumen debe ser persistente.
- **`auth/`** (en el servidor): la sesión de WhatsApp. Si la pierdes, re-escaneas
  el QR. También debe ir en un volumen persistente.
- **Airtable** (en la nube, opcional): tu CRM de leads.
- **Supabase** (en la nube, opcional): la memoria de largo plazo.

---

## Cómo se despliega (resumen; detalle en `docs/06` y `/deploy`)

El mismo repo se sube a un servidor (VPS) con un panel tipo EasyPanel que lo
construye y lo mantiene vivo 24/7. Dos claves: los **volúmenes persistentes**
(`/app/data` y `/app/auth`) para no perder datos ni la sesión, y **proteger el
dashboard** (login) para que no quede abierto en internet.

---

## Si quieres ampliar el agente

- **Añadir una tool** (que el agente sepa hacer algo nuevo, p.ej. consultar stock):
  crea el archivo en `src/lib/tools/`, regístralo en `src/lib/tools/index.ts`.
- **Cambiar el guion de ventas**: `/personaliza` o edita `prompts/negocio.md`.
- **Tocar el panel**: `src/components/` y `src/app/`. Ver `docs/09`.
Pídeselo a Claude describiendo qué quieres; él sabe dónde tocar.
