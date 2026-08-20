# 07 · Errores comunes y soluciones

Lista de errores que vas a encontrar y cómo resolverlos. Antes de pedir ayuda, ejecuta:

```
npm run doctor
```

Te diagnostica los más típicos automáticamente.

## ⚠️ Riesgo de ban del número — leer ANTES de poner en producción

WhatsApp ha endurecido sus modelos de detección de bots no oficiales en 2025-2026. Hay reportes documentados de bans en cuentas con 3+ años en producción ([Issue #1869 Baileys](https://github.com/WhiskeySockets/Baileys/issues/1869), [#2309](https://github.com/WhiskeySockets/Baileys/issues/2309)).

**Los vectores que detecta WhatsApp**:

- **Reply-ratio bajo (<10%)**: muchos mensajes salientes con pocas respuestas → riesgo alto. Un agente reactivo (responde a quien le escribe) tiene ratio ~100%, está bien
- **Contact-graph distance**: mensajes a desconocidos → riesgo alto. Outbound a leads fríos = receta para ban
- **Patrones temporales robóticos**: envíos a las 03:14:00.000 todos los días → riesgo alto
- **Volumen alto sin pausas humanas**: 50 mensajes por minuto sin descanso → riesgo

**Reglas para minimizar riesgo (no eliminarlo del todo)**:

- NUNCA enviar mensajes masivos a desconocidos
- NUNCA usar el WhatsApp personal del dueño — siempre número del negocio o secundario
- Mantener ratio ≥ 1 entrante por cada saliente
- Pausas humanas entre mensajes (variar timing)
- Si vas a hacer outbound a escala → **WhatsApp Business Cloud API** (oficial), no Baileys. Desde mayo de 2025 Meta permite tener la app de WhatsApp Business y la API oficial en el MISMO número a la vez (Coexistence): comparativa honesta con este kit y disponibilidad por países en [11-whatsapp-coexistence.md](11-whatsapp-coexistence.md)

**Si te bahnean el número**: pide un nuevo número a tu operador y vuelve a conectar el bot. Las conversaciones del agente NO se pierden si tienes `data/messages.db` con volumen persistente. La sesión Baileys sí (carpeta `auth/`) — habrá que escanear nuevo QR.

---

## Errores de Baileys (WhatsApp)

### Error 405 · Versión incompatible

**Síntoma**: el bot no conecta, logs muestran `code: 405`

**Causa**: WhatsApp rechaza versiones desactualizadas de Baileys.

**Solución**: el kit ya ejecuta `fetchLatestBaileysVersion()` automáticamente, por lo que esto NO debería pasar. Si pasa:

```
npm install @whiskeysockets/baileys@latest
```

Reinicia el bot.

### Error 440 · Connection replaced (en loop)

**Síntoma**: el bot conecta, dice "connected", y a los 5-10 segundos se desconecta. Bucle infinito.

**Causa**: WhatsApp abre un WebSocket "definitivo" mientras el de pairing está activo. Si reintentas muy rápido, entras en loop.

**Solución (ya implementada en el kit)**: el cliente Baileys usa `Browsers.macOS('Desktop')` (no custom) Y un backoff de 15 segundos para code 440.

Si AÚN aparece:

1. En el móvil, abre WhatsApp → Dispositivos vinculados → **borra cualquier sesión vieja del bot**
2. Reinicia el bot

### Error 515 · No es un error

**Síntoma**: en los logs aparece `code: 515` durante el pairing.

**Causa**: es la señal de pairing exitoso. WhatsApp pide reconectar al WebSocket definitivo.

**Solución**: ignorar. El kit reconecta automáticamente.

### El bot conecta pero NO responde a ningún mensaje (direcciones @lid)

**Síntoma**: el dashboard dice "Conectado", el bot no da errores, pero al escribirle desde otro móvil no contesta nada. En los logs del bot NO aparece la línea `[bot] ← mensaje de...`. Una variante del mismo problema: las respuestas que escribes tú como humano desde el panel se marcan como enviadas pero no le llegan al contacto.

**Causa**: WhatsApp ha desplegado en 2025-2026 un nuevo formato de direcciones, **LID** (identificador de privacidad). Las cuentas con LID activado reciben los mensajes con dirección `@lid` en vez del clásico `@s.whatsapp.net`. Las versiones antiguas del kit solo aceptaban el formato clásico y descartaban los `@lid` en silencio.

**Solución**: ya está corregido en el código del kit (`src/lib/baileys/handler.ts` acepta ambos formatos). Si tienes una copia antigua y te pasa esto:
1. Asegúrate de tener la última versión del kit
2. Comprueba si tu cuenta usa LID: abre `auth/creds.json` y busca el campo `lid` dentro de `me`. Si existe, tu cuenta usa LID
3. Reinicia el bot (`npm run start:bot`) — no necesitas escanear el QR otra vez

Detalle técnico completo en `errores-sesion.md` (#14).

### El QR no aparece en el navegador

**Síntoma**: arranca `npm run start:all` pero `localhost:3000` queda en blanco o "cargando".

**Causas posibles**:

1. El bot no ha llegado a generar QR todavía. Espera 10-20 segundos
2. La API `/api/connection/status` falla. Ejecuta `npm run doctor`
3. Race condition entre `qr` y `connecting`. El kit ya mitiga esto con API defensiva — si pasa, recarga la página

## Errores de instalación

### `npm install` falla con `better-sqlite3`

**Síntoma**: error de compilación de C++ durante `npm install`.

**Causa**: better-sqlite3 se compila nativamente. Si tu sistema no tiene las dependencias, falla.

**Solución macOS**: instala Xcode Command Line Tools:

```
xcode-select --install
```

**Solución Windows**: instala Visual Studio Build Tools desde https://visualstudio.microsoft.com/visual-cpp-build-tools/ — durante la instalación, marca **Desktop development with C++**.

Después: `npm rebuild better-sqlite3`

### `Cannot find module 'tsx'` en producción

**Síntoma**: en EasyPanel/Hostinger el deploy arranca pero el bot falla con este error.

**Causa**: `tsx` está en `devDependencies` en lugar de `dependencies`. En producción, `npm ci --omit=dev` no instala devDependencies.

**Solución**: verifica `package.json`. `tsx` y `concurrently` deben estar en `dependencies`. El kit ya viene con esto correcto.

### Node 18 en lugar de Node 20+

**Síntoma**: errores tipo `experimental fetch is not enabled`, o sintaxis ES2022 que falla.

**Causa**: el sistema usa Node 18 (default en Nixpacks).

**Solución**: el kit ya tiene `.nvmrc` con `22` y `engines.node` en package.json. Si en tu local usas `nvm`, ejecuta `nvm use` en la carpeta del kit.

## Errores de OpenRouter

### `OPENROUTER_API_KEY undefined`

**Síntoma**: el bot arranca, conecta a WhatsApp, pero al recibir un mensaje crashea con error 401 o "API key not provided".

**Causa**: hoisting de ES modules — el `.env.local` no se cargó antes que los imports.

**Solución**: el kit ya tiene `scripts/env-loader.ts` como PRIMER import en `start-bot.ts`. Si modificaste `start-bot.ts`, asegúrate de que `import "./env-loader"` está en la primera línea.

### Error 429 · Rate limit

**Síntoma**: el bot responde lento o devuelve errores aleatorios.

**Causa**: estás usando un modelo `:free` y se ha saturado.

**Solución**: edita `.env.local` y pon un modelo de pago:

```
OPENROUTER_MODEL=anthropic/claude-haiku-4.5
```

(Es el modelo recomendado del kit; la alternativa más barata es `openai/gpt-4o-mini`.) Y carga 5€ de saldo en https://openrouter.ai/credits. Reinicia el bot.

## El agente responde con un mensaje neutro (filtros de seguridad)

### "Eso no te lo puedo dar por aquí, pero encantado te ayudo…"

**Síntoma**: el agente contesta bien casi siempre, pero de vez en cuando —normalmente al hablar de precios o al mandar un enlace— suelta ese mensaje genérico en lugar de lo que tocaba.

**Causa**: NO es un fallo. Es el guardrail de salida haciendo su trabajo: el agente intentó decir una cifra de dinero que no está en `ALLOWED_PRICES`, o enlazar un dominio que no está en `ALLOWED_HOSTS`, y el sistema sustituyó el mensaje entero por el texto neutro de `GUARD_FALLBACK_MSG`. En los logs del bot lo verás como `[guardrails] respuesta bloqueada: importe no autorizado: 41`.

**Solución**: mira el motivo en el log y añade lo que falte en `.env.local`:

- **Un importe**: añádelo a `ALLOWED_PRICES` (separado por comas, sin símbolo de moneda). Ojo con las cifras **derivadas**: si vendes un plan anual de 497 y el agente calcula "unos 41 al mes", el 41 también tiene que estar en la lista. Lo mismo con cuotas y descuentos.
- **Un enlace**: añade el dominio a `ALLOWED_HOSTS` (sin `https://` ni rutas). `wa.me` está permitido siempre.

Después reinicia el bot (las dos variables se leen al arrancar). Si prefieres que el agente no invente cifras en vez de ampliar la lista, es la opción más segura: el system prompt ya le prohíbe calcular equivalencias por su cuenta.

> Las listas vacías dejan el guardrail **permisivo** (no filtra nada). `/personaliza` las rellena por ti a partir de tu `negocio.md`.

### Quiero cambiar ese mensaje neutro

Pon el tuyo en `GUARD_FALLBACK_MSG` de `.env.local`. Que sea corto y no delate que hay un filtro.

### Comprobar los filtros sin esperar a un cliente real

`npm run redteam` prueba el guardrail con 8 casos y lanza 15 ataques al agente (necesita key con saldo). Los resultados quedan en `redteam-resultados.json`: las respuestas del modelo **las juzgas tú leyéndolas** — el campo `check` de cada ataque dice qué debería haber hecho el agente.

## Errores del dashboard

### `localhost:3000` no carga

**Causa**: el proceso de Next.js no arrancó.

**Solución**: verifica que `npm run start:all` está corriendo y no se ha caído. Si solo arrancaste el bot (`npm run start:bot`), también tienes que arrancar el dashboard (`npm run dev` o `npm run start`).

### Las conversaciones no aparecen

**Causa**: el dashboard hace polling cada 2s. Si no aparecen mensajes:

1. Verifica que en el log del bot se ven los mensajes entrantes
2. Revisa `data/messages.db` — abre con DB Browser for SQLite si quieres ver el contenido
3. Ejecuta `npm run doctor`

## Errores específicos de Windows

### Procesos zombies tras Ctrl+C

**Síntoma**: cierras el bot con Ctrl+C pero el puerto sigue ocupado o procesos `node.exe` siguen vivos.

**Solución**: matar manualmente:

```
tasklist | findstr node
taskkill /PID <X> /F
```

Donde `<X>` es el PID de cada `node.exe` zombi.

### `npm install` se queda colgado

**Causa**: a veces antivirus de Windows ralentiza la descarga/compilación.

**Solución**: temporalmente desactiva el antivirus durante el `npm install`, o añade la carpeta del kit como excepción.

## Errores en deploy

### `nixpacks: command not found`

**Causa**: estás intentando deployar manualmente sin EasyPanel.

**Solución**: usa EasyPanel (ver doc 06). EasyPanel ejecuta Nixpacks automáticamente.

### El bot conecta pero pierde la sesión en cada redeploy

**Causa**: no configuraste los **volúmenes persistentes** `/app/data` y `/app/auth` en EasyPanel.

**Solución**: en la app de EasyPanel, pestaña **Mounts**, añade los dos volúmenes. Después haz redeploy.

## Cuando nada de esto funciona

1. Ejecuta `npm run doctor` y copia el output
2. Mira `errores-sesion.md` (en la raíz del kit) por si hay algo más reciente
3. Pregunta en la comunidad donde conseguiste el kit: pega el error y el output del doctor, y te ayudamos

Si encuentras un error nuevo no documentado aquí, **añádelo a `errores-sesion.md`** con el formato post-mortem. Así el siguiente usuario no tropezará igual.
