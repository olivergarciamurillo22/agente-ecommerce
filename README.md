# Kit 02 · WhatsApp AI Agent Kit

> ⚠️ **Este repositorio se ha adaptado al MVP de confirmación de pedidos COD
> de Pedro (Shopify → WhatsApp).** La guía de uso actual es
> **[PEDRO-MVP.md](PEDRO-MVP.md)**. Este README describe el kit base sobre el
> que está construido (Baileys, SQLite, dashboard); su flujo de agente IA es
> ahora OPCIONAL y está desactivado si no configuras `OPENROUTER_API_KEY`.

> Tu agente de WhatsApp con IA, listo para desplegar en una tarde — sin programar.

Cualquier duda que tengas, la resuelves en la comunidad donde conseguiste el kit.

---

## Qué hace este kit

Te entrega un **agente de IA conectado a WhatsApp** que:

- Recibe los mensajes que escriben a tu número de empresa
- Los responde automáticamente con un modelo de IA (GPT, Claude, Gemini... a elegir)
- Califica leads haciendo las preguntas que tú definas
- Guarda los leads en Airtable (CRM, opcional)
- Comparte tu enlace de reserva (Cal.com, Calendly...) cuando el lead encaja, si lo añades a los enlaces de tu negocio con `/personaliza`
- Cierra la conversación por chat sin pasarte el relevo a mitad; si algo deja de funcionar, la vigilancia automática (watchdog) te avisa por WhatsApp

Todo corre en **tu ordenador** primero (para probar) y luego en **tu propio servidor 24/7** (Hostinger VPS + EasyPanel + Cloudflare Access).

---

## Lo que necesitas

| Requisito | Para qué | Coste |
|---|---|---|
| **Node.js 20+** | Motor del kit | Gratis |
| **VS Code** | Editor donde abres el kit | Gratis |
| **Claude Code** | El setup guiado se hace desde aquí | **Requiere suscripción Claude Pro/Max o API pay-per-use** (~$20/mes Pro) |
| **Cuenta OpenRouter** | El cerebro de IA del agente | La cuenta y la key son gratuitas; cargas ~5 € de saldo tú mismo (pago único, te dura meses de uso normal) |
| **VPS (opcional)** | Si quieres tenerlo 24/7 | ~5,50-8 €/mes en Hostinger |
| **WhatsApp del negocio** | Un número, NO el personal | Gratis o 10€/mes una SIM aparte |

> **Nota Windows**: si trabajas en Windows, instala también [Git for Windows](https://git-scm.com/download/win) o [WSL2](https://learn.microsoft.com/es-es/windows/wsl/install). Claude Code necesita un shell con Bash.

---

## Cómo usarlo · 3 pasos

### Paso 1 · Instalar

Abre [EMPIEZA-AQUI.md](EMPIEZA-AQUI.md). 3 instrucciones en lenguaje humano. Si tienes Claude Code, escribe `/setup` y te lleva de la mano.

¿Prefieres la terminal en vez del chat de Claude Code? `npm install && npm run wizard`

### Paso 2 · Conectar tu WhatsApp

`/setup` (o `npm run wizard`) te lleva hasta el momento del QR. Lo escaneas desde el WhatsApp del negocio y listo.

> ⚠️ Usa un número de WhatsApp del **negocio** — el móvil queda vinculado al bot.

### Paso 3 · Personalizar a tu negocio

En Claude Code: `/personaliza`. Te hace 9 preguntas y deja el agente adaptado a TU caso (guion, precios, enlaces, tono y los filtros de seguridad). Sin tocar código.

¿Quieres un ejemplo? Mira `prompts/ejemplos/`:
- `agencia-ia.md` — servicios B2B (agencia)
- `ecommerce.md` — tienda online
- `infoproducto.md` — venta de cursos

---

## Cómo conversar con Claude Code dentro del kit

Una vez instalado, abre la carpeta en VS Code + Claude Code y escribe cualquiera de estas en lenguaje natural:

- *"empieza"* / *"qué hago"* → Claude te sugiere `/setup`
- *"personaliza el agente"* → Claude lanza `/personaliza`
- *"desplegar a producción"* → Claude lanza `/deploy`
- *"el bot no responde"* → Claude ejecuta `npm run doctor` y diagnostica
- *"quiero cambiar el modelo"* → Claude edita `.env.local`
- *"añade una tool que consulte stock"* → Claude crea una tool nueva por ti

---

## Preguntas frecuentes

**¿Funciona en Windows?**
Sí. Todo el kit es cross-platform Node.js. Probado en Mac y Windows.

**¿Necesito saber programar?**
No. El target es alguien que abre VS Code por primera vez. Claude Code se encarga del trabajo técnico.

**¿Es la API oficial de WhatsApp?**
NO. Es **Baileys** (conexión tipo WhatsApp Web, escaneando QR). Funciona perfecto para responder a leads que ya te escriben. Para outbound masivo a desconocidos → necesitas la API oficial de Meta. Detalle en `docs/07-errores-comunes.md`, y la comparativa con la vía oficial en `docs/11-whatsapp-coexistence.md`.

**¿Cuánto cuesta correrlo 24/7?**
Entre **8-13 €/mes**: ~5,50-8€ de VPS (Hostinger KVM 1/KVM 2) + 2-5€ de OpenRouter por agente. Un VPS KVM 2 puede albergar 5-10 agentes simultáneos (el cuello de botella real son las vCPU, no la RAM).

**¿Puedo correr varios bots con distintos números?**
Sí. Una instancia del kit por número de WhatsApp. Si vendes esto a clientes, una app de EasyPanel por cliente.

**¿Esto se puede vender a clientes?**
Sí, esa es exactamente la idea. Tarifas de mercado a 2026:
- **Diagnóstico**: 150-300 €
- **Implementación con tools**: 800-1.500 €
- **Mantenimiento mensual**: 80-200 €/mes
- Con 10 clientes a 150€/mes de mantenimiento → **1.500€/mes recurrentes** con ~30€ de coste real

**¿Y si algo falla?**
Ejecuta `npm run doctor`. Si no se arregla, dile a Claude Code "tengo un error: [pega el mensaje]". Si sigue sin resolverse → pregunta en la comunidad donde conseguiste el kit.

**¿Por qué OpenRouter y no API directa de OpenAI/Anthropic?**
OpenRouter te deja cambiar de modelo (GPT, Claude, Gemini, Llama, DeepSeek...) cambiando UNA línea del `.env.local`. Sin cambiar código. Es la flexibilidad máxima.

---

## Estructura del proyecto

```
02-kit-agente-whatsapp/
├── EMPIEZA-AQUI.md          ← Punto de entrada del usuario
├── GUIA-COMPLETA.md         ← Recorrido completo: instalar → entrenar → desplegar 24/7
├── README.md                ← Este archivo
├── CLAUDE.md                ← Cerebro de Claude Code (cómo te trata el agente)
├── errores-sesion.md        ← Post-mortem: los errores reales ya resueltos, uno a uno
├── package.json             ← Engines + scripts + deps
├── nixpacks.toml            ← Configuración de deploy a EasyPanel
├── Procfile                 ← Cómo arranca el proceso en el servidor
├── .nvmrc                   ← Versión de Node que usa el kit
├── .env.example             ← Plantilla de variables (se copia a .env.local)
│
├── .claude/
│   ├── settings.json             ← Permisos pre-aprobados para Claude Code
│   ├── agents/
│   │   └── kit-onboarding.md     ← Subagente experto en diagnóstico
│   └── commands/
│       ├── setup.md              ← /setup
│       ├── personaliza.md        ← /personaliza
│       └── deploy.md             ← /deploy
│
├── src/
│   ├── app/                      ← Next.js 16 (dashboard + APIs)
│   ├── components/               ← UI (ConnectionGate, QRScreen, Dashboard...)
│   └── lib/
│       ├── db.ts                 ← SQLite + WAL + helpers tipados
│       ├── baileys/              ← Cliente WhatsApp Web (client, handler, outbox)
│       ├── openrouter.ts         ← LLM con tool calling
│       ├── system-prompt.ts      ← Lee prompts/negocio.md automáticamente
│       ├── guardrails.ts         ← Filtros de seguridad (precios, enlaces, anti-fuga)
│       ├── memory.ts             ← Memoria de largo plazo (Supabase, opcional)
│       ├── watchdog.ts           ← Autovigilancia + avisos por WhatsApp (opcional)
│       ├── airtable.ts           ← CRM de leads (opcional)
│       ├── humanize.ts · transcribe.ts · vision.ts · insights.ts
│       └── tools/                ← guardarLead · calificar (las 2 tools activas)
│
├── scripts/
│   ├── env-loader.ts             ← Side-effect: carga .env.local
│   ├── start-bot.ts              ← Arranca el proceso Baileys
│   ├── wizard.ts                 ← Asistente de instalación por terminal (sin Claude Code)
│   ├── check-system.ts           ← Verifica requisitos del SO
│   ├── doctor.ts                 ← Diagnóstico de errores comunes
│   ├── redteam.mts               ← Prueba de seguridad: ataques típicos contra el agente
│   └── test-airtable.mts         ← Valida la conexión con Airtable
│
├── prompts/
│   ├── README.md
│   ├── negocio.md                ← El guion de tu negocio (llega como plantilla; /personaliza lo rellena)
│   ├── negocio.example.md        ← Plantilla de referencia
│   └── ejemplos/                 ← 3 casos completos rellenados
│
├── docs/
│   ├── 00-arquitectura.md        ← Cómo funciona el sistema por dentro
│   ├── 01-instalar.md
│   ├── 02-conectar-whatsapp.md
│   ├── 03-personalizar-prompt.md
│   ├── 04-configurar-tools.md
│   ├── 05-cloudflare-access.md
│   ├── 06-deploy-hostinger.md
│   ├── 07-errores-comunes.md
│   ├── 08-memoria-supabase.md
│   ├── 09-personalizar-dashboard.md
│   ├── 10-watchdog.md
│   └── 11-whatsapp-coexistence.md
│
├── data/                         ← Runtime (no se sube a Git)
└── auth/                         ← Sesión Baileys (no se sube a Git)
```

---

## Stack técnico

- **Next.js 16** + React 19 + Tailwind 4 (dashboard)
- **@whiskeysockets/baileys** 6.7+ (WhatsApp Web)
- **better-sqlite3** + WAL (base de datos local)
- **OpenRouter** SDK (hub de modelos de IA)
- **tsx + concurrently** (arrancar bot + dashboard juntos)
- **Nixpacks** (deploy sin Docker)

Todas las decisiones técnicas y las lecciones aprendidas ya están aplicadas en el código (ver `errores-sesion.md`).

---

## Créditos y atribución

Este kit reúne arquitectura, código, documentación y todas las lecciones aprendidas pisando los errores uno a uno hasta dejarlo blindado y cross-platform, con una experiencia de instalación guiada por Claude Code.

Stack open-source:
- [Baileys](https://github.com/WhiskeySockets/Baileys) — cliente WhatsApp Web
- [Next.js](https://nextjs.org/) — framework React
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — SQLite para Node
- [OpenRouter](https://openrouter.ai/) — hub de modelos LLM
- [Nixpacks](https://nixpacks.com/) — build sin Docker

---

## Licencia y uso

Kit de uso privado. No es de uso libre ni código abierto.

**Lo que SÍ puedes hacer:**
- Usarlo para tus propios proyectos y negocio.
- Montar agentes para tus clientes y **cobrar por ello**.

**Lo que NO puedes hacer:**
- Compartir, revender, redistribuir o publicar el kit (ni su código).
- Pasárselo a alguien que no haya adquirido el acceso.

El acceso al kit es parte de tu membresía en la comunidad donde lo conseguiste. Cuídalo.

---

## Soporte

¿Te atascas o quieres aplicar esto a un caso real? Para eso está la **comunidad donde conseguiste el kit**:

- Resuelve dudas (técnicas y de negocio) con el resto de la comunidad
- Comparte tu primer agente y recibe feedback
- Aprende a vender el servicio: prompts que convierten, cómo cerrar clientes, despliegue blindado

Todo el soporte vive **dentro de esa comunidad**. Aprovéchalo.
