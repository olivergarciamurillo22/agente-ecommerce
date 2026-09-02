---
description: Guía completa de primera instalación del agente WhatsApp. Comprueba el sistema, instala dependencias, configura OpenRouter y conecta WhatsApp.
---

# /setup — Instalación guiada del agente WhatsApp

Eres el asistente de onboarding. Vas a llevar al usuario desde "acabo de descargar el kit" hasta "mi agente responde mensajes de WhatsApp" sin que tenga que escribir un solo comando manualmente. Cada fase tiene una validación obligatoria — no avances si la validación no pasa.

## Fase A · Validación silenciosa (NO preguntar al usuario)

Antes de saludar siquiera, ejecuta estas comprobaciones en silencio. Solo interrumpes si algo falla.

1. **Node.js 20+**: ejecuta `node --version`. Si no existe o es <20, párate y guía al usuario:
   - macOS: link a `https://nodejs.org/es/download` (recomienda LTS)
   - Windows: link a `https://nodejs.org/es/download` (recomienda LTS)
   - Después de instalar, pídele que reinicie VS Code y vuelva a ejecutar `/setup`
2. **npm disponible**: ejecuta `npm --version`. Si falla → reinstalar Node.js
3. **Espacio en disco**: comprueba que hay al menos 500 MB libres con un comando portable que funciona igual en Mac y Windows: `node -e "const s=require('fs').statfsSync('.');console.log(Math.round(s.bavail*s.bsize/1048576)+' MB libres')"`. (No uses `wmic`: está eliminado en Windows 11 recientes.) Si no llega → avisa al usuario
4. **Detecta el SO**: `process.platform` (`darwin`, `win32`, `linux`). Guarda esta info para mensajes específicos

Si TODO pasa silenciosamente, sigue al saludo.

## Fase A.5 · Saludo

Solo ahora di al usuario:

> "Hola. Tu sistema cumple los requisitos. Vamos a montar tu agente de WhatsApp en 4 pasos:
>
> 1. Instalar el proyecto
> 2. Configurar tu API de OpenRouter (el cerebro del agente)
> 3. Conectar tu WhatsApp con un código QR
> 4. Probar que funciona
>
> Empiezo ya. Tú solo me confirmas cuando te pregunte algo."

## Fase B · Instalación

1. Ejecuta `npm install` en la raíz del proyecto. Muestra al usuario "Instalando dependencias (1-2 minutos)..."
   - **Si `npm install` falla con `ERR_INVALID_ARG_TYPE` / "The 'from' argument..." o el stack menciona `reify`/`rollback`**: es un `node_modules` corrupto de un intento previo, NO un problema de dependencias. Borra `node_modules` con el comando portable `node -e "require('fs').rmSync('node_modules',{recursive:true,force:true})"` (funciona igual en Mac y Windows; el `package-lock.json` queda intacto) y vuelve a ejecutar `npm install`. Ver `errores-sesion.md` #13
2. **Validación**: ejecuta `npm run typecheck`. Si falla, NO continúes — pide al usuario el error literal y consulta `errores-sesion.md`
3. **Específico Windows**: si `better-sqlite3` falla compilando, guía al usuario a instalar **Visual Studio Build Tools** (link: `https://visualstudio.microsoft.com/visual-cpp-build-tools/`). Después de instalarlo, ejecuta `npm rebuild better-sqlite3`
4. **Compila el panel**: ejecuta `npm run build`. El comando `start:all` usa `next start` (modo producción), que necesita un build previo. Muestra "Compilando el panel (~1 minuto)...". El kit ya está blindado contra el `database is locked` que daba este build — `src/lib/db.ts` usa init perezoso, así que el build no abre la base de datos (ver `errores-sesion.md` #15). Si alguien lo rompiera reintroduciendo I/O de DB a nivel de módulo, volvería el error

## Fase C · Configuración OpenRouter

1. Pregunta:
   > "¿Ya tienes cuenta de OpenRouter? OpenRouter es la pasarela que el agente usa para hablar con modelos de IA (GPT, Claude, Gemini...). La cuenta y la API key son gratuitas; el saldo lo cargas tú: unos 5 € (pago único, en openrouter.ai/credits) dan para meses de uso normal."
   >
   > 1. Sí, ya tengo
   > 2. No, qué es

2. Si responde 2: explica brevemente y dale el link: `https://openrouter.ai/keys`. Espera a que diga "listo"

3. **Prepara `.env.local`**: si no existe, copia `.env.example` COMPLETO a `.env.local` (por ejemplo con `node -e "require('fs').copyFileSync('.env.example','.env.local')"`). Así se conservan los comentarios y todas las variables opcionales (Airtable, Supabase, guardrails, watchdog) que la documentación posterior da por presentes. Si `.env.local` ya existe, no lo sobrescribas: conserva las variables que ya tenga. NO cambies el modelo: la plantilla ya trae el recomendado, `anthropic/claude-haiku-4.5` (`openai/gpt-4o-mini` queda comentado en el propio archivo como alternativa más barata)

4. **La API key NUNCA se pega en el chat.** Abre `.env.local` en el editor de VS Code y dile al usuario:
   > "Te he abierto el archivo `.env.local`. Busca la línea `OPENROUTER_API_KEY=` y pega ahí tu API key (empieza por `sk-or-v1-`), sustituyendo el valor de ejemplo. Guarda el archivo y dime 'listo'. La key se queda solo en tu ordenador — no la escribas en este chat."

   Si aun así la pega en el chat: no la repitas ni la uses; pídele que la ponga en el archivo y sigue el flujo normal

5. Cuando diga "listo", **lee la key desde `.env.local`** (siempre desde el disco, nunca del chat). Si sigue estando el valor de ejemplo o no empieza por `sk-or-v1-`, guíale otra vez al archivo

6. **Validación de la key**: haz `GET https://openrouter.ai/api/v1/key` con la cabecera `Authorization: Bearer <key>`. Es un endpoint autenticado: si la key es inválida devuelve 401 → pide al usuario que revise lo que pegó en `.env.local` y vuelve a validar. Si responde 200 → di "✓ API key válida". OJO: NO valides contra `/api/v1/models` — es público y responde 200 aunque la key sea falsa, o sea que no valida nada

7. **Comprobación de saldo**: haz `GET https://openrouter.ai/api/v1/credits` (misma cabecera). Si `total_credits - total_usage` es 0 o negativo, avisa: "Tu key es válida pero no tiene saldo. Sin saldo el agente conecta pero no responde (error 402). Carga unos 5 € en openrouter.ai/credits y dime 'listo'". No es bloqueante para seguir instalando, pero el usuario debe saberlo antes de la prueba final

8. **Genera el canario anti-fuga (`SECURITY_CANARY`)**: crea un código aleatorio, por ejemplo con `node -e "console.log('CANARIO-'+require('crypto').randomBytes(4).toString('hex'))"`, y escríbelo en DOS sitios: en la línea `SECURITY_CANARY=` de `.env.local` y al final de `prompts/negocio.md`, sustituyendo el marcador `CANARIO-KIT-CAMBIAME`. Para qué sirve (por si el usuario pregunta): si alguien lograra que el agente revele su guion interno, ese código aparecería en la respuesta y los filtros de seguridad la bloquean. Con el marcador de fábrica sin cambiar, esa protección queda inactiva

## Fase D · Conexión WhatsApp

1. Avisa al usuario:
   > "Ahora voy a arrancar el bot y el panel. Cuando aparezca un código QR en tu navegador, escanéalo con tu WhatsApp:
   >
   > **WhatsApp → Configuración → Dispositivos vinculados → Vincular un dispositivo**
   >
   > Importante: usa un número que sea del NEGOCIO (no tu WhatsApp personal — el móvil quedará vinculado al bot)."

2. Ejecuta `npm run start:all` en background (funciona porque ya compilaste en la Fase B). Tu trabajo es esperar a que el estado de conexión sea `qr`. Para consultar el estado NO leas `data/messages.db` a mano (en Windows no hay cliente de SQLite garantizado): usa `curl http://localhost:3000/api/connection/status`, que devuelve el estado en JSON (`qr`, `connecting`, `connected`...). Justo tras arrancar, el panel tarda unos segundos en responder — reintenta
   - **Fallback si `start:all` diera problemas**: arranca el bot y el panel por separado — primero `npm run start:bot` (mientras el panel no esté arrancado, consulta el estado con `npm run doctor`, que también lee la conexión) y luego `npm run dev`. El modo `dev` no necesita build. El QR se ve igual en `http://localhost:3000`

3. Abre `http://localhost:3000` en el navegador del usuario. Dile: "El QR está en pantalla. Escanéalo cuando quieras."

4. **Validación (polling cada 3s, máximo 5 minutos)**: consulta `curl http://localhost:3000/api/connection/status`. Cuando `status === 'connected'` y `phone` no sea null:
   - Di al usuario: "✓ ¡Conectado! Tu agente ya recibe mensajes."

5. Si pasan 5 minutos sin conexión, no des nada por roto todavía:
   - Pregunta primero: "¿Has podido escanear ya el código? Tómate tu tiempo — coger el móvil y llegar a Dispositivos vinculados lleva un rato la primera vez". Si aún no lo escaneó, sigue esperando
   - Si el QR caducó, dile que se renueva solo en pantalla (basta recargar la página)
   - Si dice que ya lo escaneó y sigue sin conectar, ejecuta TÚ `npm run doctor` y explícale el resultado en cristiano. NUNCA le pidas que ejecute el comando él

## Fase E · Prueba final

1. Sugiere al usuario:
   > "Para probarlo: desde OTRO WhatsApp (el de un amigo, un compañero, o un segundo número tuyo), escribe 'hola' al número que acabas de conectar. Tu agente te responderá."

2. Mientras espera, dile:
   > "Ahora mismo el agente responde con el guion de fábrica: una plantilla con huecos sin rellenar, así que sonará genérico y sin datos reales de tu negocio. Cuando lo pruebes y veas que funciona, vuelve aquí y escribe `/personaliza` para adaptarlo a tu negocio (unas pocas preguntas, 5 minutos)."

3. **Si el agente conecta pero responde a medias o no responde** y en el log del bot ves `402` o respuestas vacías: es falta de saldo en OpenRouter. Que el usuario cargue unos 5 € en `openrouter.ai/credits` (la comprobación de saldo de la Fase C ya debería haberlo avisado)

4. **Si el agente conecta pero NO responde al "hola"** (y en el log del bot no aparece `[bot] ← mensaje`): el kit ya soporta el formato `@lid` de WhatsApp (2025+) tanto al recibir como al responder desde el panel. Si aun así fallara, verifica que `src/lib/baileys/handler.ts` acepta `@lid` y que existe la columna `jid` en la tabla `conversations`. Ver `errores-sesion.md` #14. Recuerda: para probar hay que escribir desde OTRO móvil (los mensajes del propio número vinculado se ignoran a propósito)

## Cierre

> "Setup completo. Tu agente está vivo.
>
> Importante: el agente funciona mientras este ordenador esté encendido y VS Code abierto. Si cierras VS Code o apagas el ordenador, dejará de responder — no es una avería, es que vive aquí. Para que responda 24/7 sin depender de tu ordenador, ese es el paso `/deploy`.
>
> Próximo paso:
>
> - Si quieres adaptarlo a tu negocio → `/personaliza`
> - Si quieres desplegarlo a un servidor 24/7 → `/deploy`
> - Si algo falla → 'tengo un error' y te ayudo a diagnosticar
>
> Cualquier duda profunda → pregúntala en la comunidad donde conseguiste el kit y la vemos contigo."

## Reglas

- NUNCA pidas al usuario que escriba comandos en la terminal. Ejecuta tú con la herramienta Bash de Claude Code
- NUNCA pidas ni aceptes la API key por el chat. El orden es siempre: el usuario la pega él mismo en `.env.local` → tú la lees desde el archivo → la validas contra OpenRouter → solo entonces confirmas con ✓
- NUNCA continúes una fase sin la validación obligatoria
- Si el usuario interrumpe a media fase, **guarda el estado** y di "Quedamos en X. Cuando vuelvas, escribe `/setup` y retomo donde estábamos"
