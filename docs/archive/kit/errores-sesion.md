> **ARCHIVED — KIT ORIGINAL.** Fuente de verdad actual: `docs/README.md`.

# Errores de sesión · WhatsApp AI Agent Kit

Post-mortem de los errores que se han ido encontrando construyendo y operando el kit. Documentar cada error nuevo aquí siguiendo el formato. La regla del kit: cada error vivido se traduce en una "regla absoluta" en `CLAUDE.md` o en una mitigación en el código.

Las primeras 10 entradas documentan los errores que se pisaron construyendo el sistema varias veces hasta dejarlo blindado. Están ya mitigadas en el código del kit; las documentamos aquí para que el usuario entienda por qué hay tantas decisiones "raras" en `src/lib/baileys/`.

---

## #1 · Code 405 en Baileys — versión desactualizada

**Qué pasó**: el bot conectaba al primer intento pero a partir del segundo arranque WhatsApp rechazaba con `code: 405`. Pasó incluso con versiones de Baileys recientes.

**Cuándo se vio**: en cualquier momento entre 1 y 4 semanas después de instalar — depende de cuándo WhatsApp endurezca el protocolo.

**Corrección**: llamar a `fetchLatestBaileysVersion()` al arrancar y pasar la versión descargada a `makeWASocket({ version })`.

**Patrón aprendido**: nunca usar la versión hardcodeada de Baileys. Siempre descargar la última en runtime. Aplica a CUALQUIER proyecto con Baileys.

---

## #2 · Code 440 en bucle infinito tras pairing

**Qué pasó**: justo después de escanear el QR, el bot se conectaba 5-10 segundos y se desconectaba. Reintentar inmediatamente provocaba el mismo ciclo eterno.

**Cuándo se vio**: en TODOS los primeros intentos cuando pasábamos un `browser` fingerprint custom (ej. `["Mi App", "Chrome", "1.0"]`).

**Corrección doble**:
1. Usar fingerprint conocido: `Browsers.macOS("Desktop")` en `makeWASocket`
2. Backoff específico para code 440: 15 segundos en lugar de los 5 segundos para el resto de codes

**Patrón aprendido**: WhatsApp Web es paranoico con dispositivos. Solo deja entrar fingerprints conocidos. Y reconectar muy rápido tras el pairing dispara connectionReplaced. Espera 15s.

---

## #3 · Code 515 confundido con error

**Qué pasó**: pensamos que el bot fallaba porque los logs mostraban `code: 515` durante el pairing. Intentamos arreglarlo y rompimos cosas.

**Cuándo se vio**: durante el primer escaneo del QR, siempre.

**Corrección**: NO es error. Es la señal de pairing exitoso. WhatsApp pide reconectar al WebSocket "definitivo". El bot solo necesita reconectar limpio, sin reportar como error.

**Patrón aprendido**: leer la documentación de Baileys con detalle antes de tratar cualquier code como bug. No todos los disconnect codes son errores.

---

## #4 · QR no aparece en el frontend (race condition)

**Qué pasó**: el QR se generaba (visible en la terminal en ASCII) pero NUNCA aparecía en el dashboard `/api/connection/status`.

**Cuándo se vio**: en frontends conectándose por polling cada 2 segundos.

**Causa**: el bot pasa de estado `qr` → `connecting` en milisegundos. Si la API solo devolvía el QR cuando `status === 'qr'`, el frontend casi nunca lo veía.

**Corrección**: API defensiva. Si existe `qr_string` en la DB, devolver el QR aunque `status` sea `connecting` (no solo `qr`). Esto es lo que hace `src/app/api/connection/status/route.ts`.

**Patrón aprendido**: con state machines y polling, ser defensivo. Mostrar datos si existen, no solo si el estado es perfecto.

---

## #5 · OPENROUTER_API_KEY undefined por ES module hoisting

**Qué pasó**: el bot arrancaba sin error, conectaba a WhatsApp, pero al primer mensaje crasheaba con 401 de OpenRouter. La key estaba en `.env.local` pero `process.env.OPENROUTER_API_KEY` devolvía `undefined`.

**Cuándo se vio**: siempre que importábamos el cliente OpenRouter en `start-bot.ts`.

**Causa**: los `import` de ES modules se hoistean al inicio del archivo, ANTES de cualquier código de inicialización. Si `openrouter.ts` lee `process.env.OPENROUTER_API_KEY` en su top-level, lo lee antes de que `loadEnv()` se ejecute → undefined.

**Corrección**: poner el loader en su propio módulo `scripts/env-loader.ts` (side-effect only, sin exports) e importarlo PRIMERO en `start-bot.ts`:

```ts
import "./env-loader";  // ← debe ser el PRIMER import
import { ... } from "../src/lib/db";
```

Los imports siguen orden de declaración dentro del bloque hoisted. Como env-loader no tiene exports, solo ejecuta side effects (poblar process.env) antes de que cualquier otro módulo evalúe `process.env`.

**Patrón aprendido**: nunca leer `process.env` en el top-level de un módulo si depende de un loader externo. O bien usar `dotenv/config` como primer import, o estructurar el código para que las variables se lean dentro de funciones (que se llaman después).

---

## #6 · Procesos zombies en Windows tras Ctrl+C

**Qué pasó**: en Windows, al pulsar Ctrl+C en la terminal donde corre `npm run start:all`, el proceso padre moría pero los hijos de `tsx` quedaban vivos. Al volver a arrancar, había dos bots peleando por la misma sesión Baileys → caos.

**Cuándo se vio**: SOLO en Windows. En macOS Ctrl+C limpia bien los hijos.

**Corrección**: documentar en `docs/07-errores-comunes.md` cómo detectarlo y matarlos manualmente:

```
tasklist | findstr node
taskkill /PID <X> /F
```

El `scripts/doctor.ts` también detecta este caso en Windows.

**Patrón aprendido**: en Windows, los signals (SIGINT, SIGTERM) no se propagan a hijos como en Unix. Si hay procesos hijos críticos, considerar usar herramientas como `tree-kill` o documentar el cleanup manual.

---

## #7 · better-sqlite3 falla compilando en Linux/Nixpacks

**Qué pasó**: el deploy a EasyPanel fallaba en la fase de build con "Cannot find pre-built binary for better-sqlite3". El log mostraba errores de gcc.

**Cuándo se vio**: la primera vez que deployamos a Hostinger VPS con EasyPanel + Nixpacks.

**Causa**: better-sqlite3 se compila nativamente con node-gyp, que requiere python3 + gcc + gnumake. Nixpacks por defecto NO los incluye.

**Corrección**: declarar los paquetes en `nixpacks.toml`:

```toml
[phases.setup]
nixPkgs = ["nodejs_22", "npm-10_x", "python3", "gcc", "gnumake"]
```

**Patrón aprendido**: cualquier dependencia con código nativo C/C++ requiere el toolchain de build en el entorno de deploy. Siempre verificar que el `nixpacks.toml` (o el Dockerfile) los incluye.

---

## #8 · Node 18 default en Nixpacks rompe Next 16 / Baileys

**Qué pasó**: la app deployaba pero a runtime devolvía errores de sintaxis ES2022 o "experimental fetch not enabled".

**Cuándo se vio**: la primera vez con `nixpacks.toml` que no especificaba versión de Node.

**Causa**: Nixpacks defaulteaba a Node 18. Next.js 16, Baileys 6.7+ y Tailwind 4 necesitan Node 20+.

**Corrección**: fix doble:
1. `engines.node >= 20.9.0` en `package.json`
2. `.nvmrc` con `22`
3. `nixpacks.toml` con `NIXPACKS_NODE_VERSION = "22"` Y `nodejs_22` en `nixPkgs`

**Patrón aprendido**: nunca confiar en la versión default del entorno de deploy. Declarar SIEMPRE explícitamente.

---

## #9 · Modelos `:free` de OpenRouter dan 429 en producción

**Qué pasó**: en local con tráfico bajo, los modelos `qwen-...:free` y `gemma-...:free` funcionaban. En producción con 2-3 conversaciones simultáneas, OpenRouter devolvía 429 constantemente.

**Cuándo se vio**: la primera prueba con tráfico real (más de 1 lead simultáneo).

**Causa**: los modelos `:free` tienen rate limit muy estricto (50 req/día sin créditos cargados, 1000 con créditos). En producción real, se saturan a la primera.

**Corrección**: recomendar `openai/gpt-4o-mini` desde el día 1. Coste: $0.15/M tokens input, $0.60/M tokens output. Para un agente con 50 leads/día: 2-5€/mes. Documentar en `.env.example`, en `/setup`, en `docs/`, en `doctor.ts`.

**Patrón aprendido**: los tier gratuitos sirven para aprender, no para servir clientes reales. Comunicarlo claro y temprano evita frustración.

---

## #10 · Dashboard sin auth = riesgo total

**Qué pasó**: el primer deploy a producción quedó expuesto en `panel.midominio.com` sin login. Cualquiera con el link podía leer todas las conversaciones de WhatsApp y enviar mensajes en nombre del dueño.

**Cuándo se vio**: durante una prueba con usuarios beta del kit. Uno compartió la URL con un amigo, el amigo entró sin login.

**Causa**: el kit no incluye auth nativa (sería complicar el setup para no-programadores).

**Corrección**: hacer obligatorio configurar Cloudflare Access antes de meter conversaciones reales en producción. Documentar en `/deploy` como paso bloqueante. Crear `docs/05-cloudflare-access.md` con paso a paso.

**Patrón aprendido**: cuando el kit deja agujeros de seguridad por simplicidad, hay que cerrarlos con servicios externos gratuitos (Cloudflare Access, Tailscale, basic auth proxy) y marcar la configuración como bloqueante, no opcional.

---

## #11 · WhatsApp Business Platform · cambio de pricing per-conversación → per-mensaje

**Qué pasó**: el kit y los materiales formativos mencionaban "1.000 conversaciones gratis/mes" y "conversaciones de 24 horas" como modelo de pricing. Meta cambió ese modelo el **1 de julio de 2025** y migró completamente a **per-message billing** durante 2025-2026.

**Cuándo se vio**: auditoría de mayo 2026.

**Causa**: Meta anunció el cambio gradual a per-message a inicios de 2024 con efecto julio 2025. El modelo viejo dejó de aplicar.

**Corrección (mayo 2026)**:
- **Service messages** (respuestas dentro de la ventana de 24h iniciada por el usuario): **gratis ilimitadas globalmente**
- **Marketing / Utility / Authentication**: per-message desde el primer envío, con precio por país
- **Ventana Click-to-WhatsApp (72h)**: si el usuario llega por un anuncio de Meta (Facebook/Instagram), TODA la mensajería es gratis durante 72h — incluido marketing
- **Utility templates** dentro de service window (24h iniciada por usuario) → **gratis** desde finales de 2024

**Precios España mayo 2026** (orientativos, verificar en Meta Business Manager):
- Marketing: ~€0.05/mensaje
- Utility/Authentication: ~€0.017/mensaje
- Service: gratis

**Patrón aprendido**: el pricing de Meta cambia. Cualquier coste documentado en el kit caduca rápido — referenciar la fuente oficial (developers.facebook.com/docs/whatsapp/pricing) y dar solo orden de magnitud, no precios exactos al céntimo.

---

## #12 · Detección ML de WhatsApp más agresiva (2025-2026)

**Qué pasó**: WhatsApp endureció en 2025-2026 sus modelos de detección de bots no oficiales. Hay reportes documentados de bans en bots Baileys con 3+ años en producción.

**Cuándo se vio**: monitorización de issues GitHub de Baileys + reportes de comunidad (mayo 2026).

**Causa**: WhatsApp añadió vectores de detección con ML que pesan:
- Reply-ratio bajo (<10%): muchos mensajes salientes, pocas respuestas
- Contact-graph distance: mensajes a desconocidos
- Patrones temporales robóticos
- Volumen alto sin pausas humanas

**Corrección**:
- Documentar explícitamente los vectores en `docs/07-errores-comunes.md` (sección "Riesgo de ban" al principio)
- Marcar como CRÍTICO usar números secundarios, nunca personales
- Para outbound a escala recomendar siempre Meta API oficial
- Subir el tono del aviso en el material formativo que acompaña al kit

**Patrón aprendido**: las reglas de "uso seguro de Baileys" envejecen mal. Lo que era seguro en 2023 no lo es en 2026. Revisar cada 6 meses contra fuentes oficiales (Issues de Baileys, comunidad).

---

## #13 · `npm install` falla con `ERR_INVALID_ARG_TYPE` en el rollback de npm

**Qué pasó**: en el primer `/setup`, `npm install` abortó con `npm error code ERR_INVALID_ARG_TYPE` / `The "from" argument must be of type string. Received undefined`. El stack apuntaba a `@npmcli/arborist/.../reify.js` → `rollbackMoveBackRetiredUnchanged` → `path.relative`. No es un error del `package.json` (estaba correcto) ni de la red.

**Cuándo se vio**: primera instalación en macOS (Node 22, npm 10.9.7) con una carpeta `node_modules` ya presente, a medio poblar de un intento anterior interrumpido.

**Causa**: el `node_modules` quedó en un estado parcial/corrupto. npm intenta "retirar" (renombrar a `.node_modules.*`) los paquetes existentes y restaurarlos si algo falla; cuando ese estado intermedio está inconsistente, el propio rollback peta en `path.relative` al recibir `undefined`. El mensaje de error oculta la causa real (instalación previa a medias), no es un bug que el usuario pueda "arreglar" reintentando el mismo comando.

**Corrección**: NO repetir `npm install` tal cual (vuelve a fallar). Borrar el `node_modules` parcial y reinstalar desde el `package-lock.json` intacto:
```
rm -rf node_modules .node_modules.*   # (Claude Code lo ejecuta; en kit-code usar rimraf/fs.rmSync)
npm install
```
Si persistiera, añadir `npm cache verify`. Validar después con `npm run typecheck` (debe salir exit 0).

**Patrón aprendido**: un fallo de npm en fase de *reify/rollback* casi siempre significa `node_modules` corrupto, no un problema de dependencias. Reflejo: limpiar `node_modules` y reinstalar, nunca reintentar el mismo `install` a ciegas. Para Claude Code en `/setup`: si `npm install` falla, leer el stack — si menciona `reify`/`rollback`, limpiar y reinstalar antes que cualquier otra cosa.

---

## #14 · El bot conecta pero NO responde a mensajes — direcciones @lid de WhatsApp

**Qué pasó**: tras `/setup`, el bot conectaba perfecto (`status=connected`, sin errores en el log), pero al enviarle un "hola" desde otro móvil no respondía nada. El log no mostraba ni una línea `[bot] ← mensaje de...`, como si no llegara nada.

**Cuándo se vio**: primer `/setup` real en una cuenta con **LID activado** (junio 2026). La cuenta tenía tanto `id` clásico (`...@s.whatsapp.net`) como `lid` (`...@lid`) en `auth/creds.json` → señal de que WhatsApp ya le había asignado LID.

**Causa**: WhatsApp desplegó en 2025-2026 un nuevo formato de direcciones, **LID** (Linked ID, identificador de privacidad). En cuentas con LID activado, los mensajes entrantes 1:1 llegan con `remoteJid` terminado en `@lid` en vez de `@s.whatsapp.net`. El handler (`src/lib/baileys/handler.ts`) tenía un filtro `if (!remoteJid.endsWith("@s.whatsapp.net")) continue;` que **descartaba en silencio** todos los mensajes `@lid`, ANTES de loguear nada. Por eso parecía que no llegaba nada: sí llegaban, pero se tiraban. Pista decisiva: en `auth/` aparecía una `session-<numero-largo>.json` (el LID del contacto) creada justo al enviar el mensaje, prueba de que el mensaje SÍ llegaba y solo se descartaba en el filtro.

**Cómo se diagnosticó**: el logger interno de Baileys está en `silent` (correcto, es ruidoso), así que un mensaje descartado no deja rastro. Se confirmó con un log temporal al principio de `handleIncomingMessages` que volcaba `event.type` y los `remoteJid` crudos de cada upsert → apareció `type=notify n=1 jids=[<id>@lid]`, confirmando el formato LID.

**Corrección** (en `src/lib/baileys/handler.ts`):
1. Aceptar AMBOS formatos 1:1:
   ```ts
   if (!remoteJid.endsWith("@s.whatsapp.net") && !remoteJid.endsWith("@lid")) continue;
   ```
2. Excluir explícitamente `@g.us`, `@broadcast` y `@newsletter` (antes solo se filtraba `@g.us`).
3. Extraer el identificador de conversación robustamente para ambos formatos:
   ```ts
   const phone = remoteJid.split("@")[0].split(":")[0];
   ```
   La respuesta de la IA se envía al `remoteJid` original (Baileys 6.7+ envía bien a jids `@lid`), así que responder en automático funciona igual.

**Segundo bug, misma raíz — la respuesta del HUMANO desde el panel no llegaba**: el camino de salida humana es panel → tabla `outbox` → loop del bot (`src/lib/baileys/outbox.ts`). Ese loop reconstruía el destino como `` `${item.phone}@s.whatsapp.net` `` (hardcodeado). Para un contacto LID, `phone` es el número LID, así que enviaba a `<lid>@s.whatsapp.net` — dirección inexistente. Lo engañoso: **Baileys NO lanza error** al enviar a ese JID, lo marca como `sent=1` y loguea "outbox enviado", pero el contacto nunca lo recibe (fallo silencioso). Corrección:
1. Nueva columna `jid TEXT` en la tabla `conversations` (con migración `ALTER TABLE` para DBs existentes) que guarda el `remoteJid` completo del contacto.
2. `handler.ts` rellena ese `jid` en cada mensaje entrante (`getOrCreateConversation(phone, pushName, remoteJid)`), lo que además backfillea filas antiguas.
3. `outbox.ts` envía a `getConversationById(item.conversation_id).jid` con fallback a `` `${phone}@s.whatsapp.net` `` para filas legacy.

**Cómo validar el camino de salida**: el log "outbox enviado" NO prueba entrega (sale igual aunque el JID sea inválido). La única confirmación fiable es que el destinatario reciba el mensaje en su móvil.

**Limitación conocida**: para contactos por LID, el campo `phone` guardado es el número LID (no el teléfono real). La conversación funciona y el agente responde; en el dashboard se muestra el `pushName` (nombre de WhatsApp) del contacto, así que el display sigue siendo legible.

**Patrón aprendido**: refuerza el #1/#2/#3 y el #12 — el protocolo de WhatsApp Web cambia y rompe supuestos. NUNCA asumir que los JIDs 1:1 terminan solo en `@s.whatsapp.net`. Si el bot conecta pero "no responde a nada" y el log no muestra `← mensaje`, sospechar inmediatamente de `@lid` y comprobar `auth/creds.json` (¿tiene `me.lid`?) y las `session-*.json` recién creadas. Revisar este filtro cada vez que WhatsApp/Baileys saquen versión mayor.

---

## #15 · `next build` falla con `database is locked` (SQLITE_BUSY)

**Qué pasó**: en el primer `/setup`, `npm run start:all` moría al instante con `Could not find a production build`. Al ejecutar `npm run build` para resolverlo, el build fallaba con `SqliteError: database is locked` (`code: SQLITE_BUSY`) y `Failed to collect page data for /api/connection/disconnect`.

**Cuándo se vio**: primer build del proyecto (Next 16 + Turbopack). El paso "Collecting page data" lanza ~10 workers en paralelo.

**Causa**: doble. (1) `start:all` usa `next start` (producción), que exige un build previo que no existía. (2) El build en sí: las rutas API abren la base de datos en el momento de importarse (`src/lib/db.ts` hace `new Database()` + `db.exec(CREATE TABLE...)` + `INSERT OR IGNORE` a nivel de módulo). Durante "Collecting page data", Next importa esas rutas en varios workers a la vez; todos intentan escribir en `messages.db` simultáneamente y, sin `busy_timeout` configurado, SQLite corta en seco con SQLITE_BUSY (WAL permite varios lectores pero un solo escritor; sin timeout, el segundo escritor no espera, falla).

**Corrección** (dos partes):
1. **El arreglo de fondo — init perezoso de la DB** (`src/lib/db.ts`): se reescribió para que la conexión, el esquema y los `prepare()` NO se creen al importar el módulo, sino la primera vez que se llama a una función (patrón `build()` + `ctx()` memoizado). Durante `next build`, importar las rutas API ya NO abre la DB (los handlers no se ejecutan al compilar), así que el lock es imposible **por diseño**. Verificable: tras un build, `data/messages.db` ni siquiera se crea.
2. **Red de seguridad en runtime**: `db.pragma("busy_timeout = 5000")` para la contención normal entre bot y dashboard ya en ejecución. OJO: el `busy_timeout` por sí solo NO arreglaba el build — era no determinista (un build pasaba y el siguiente fallaba), porque la carrera al inicializar el WAL de un archivo nuevo entre ~10 workers no la cubre. El init perezoso es lo que lo resuelve de verdad.
3. En el flujo `/setup`, compilar (`npm run build`) en la fase de instalación, antes de `start:all`. Fallback local: `npm run start:bot` + `npm run dev` (dev no necesita build).

**Patrón aprendido**: NUNCA hagas I/O con efectos (abrir DB, escribir, crear tablas) en el cuerpo de un módulo que Next vaya a importar en build — hazlo perezoso (en la primera llamada). `busy_timeout` ayuda en runtime pero no es solución para carreras de inicialización. Y `next start` SIEMPRE requiere `next build` antes.

---

## #16 · Deploy en EasyPanel/Nixpacks falla: `tsconfig.tsbuildinfo ... not a directory`

**Qué pasó**: primer deploy real a EasyPanel (Nixpacks). Las fases `setup` e `install` (`npm ci`, 268 paquetes) pasaban, pero la fase `build` moría con:
`runc run failed: ... error mounting ... to rootfs at "/app/tsconfig.tsbuildinfo": create mountpoint ... not a directory` → `process "npm run build" did not complete successfully: exit code 1`.

**Cuándo se vio**: primer despliegue a un servidor real (en local el build iba bien porque no hay cache mounts de BuildKit).

**Causa**: el archivo `tsconfig.tsbuildinfo` (caché de compilación incremental de TypeScript) se había **versionado por error** en el repo. Nixpacks añade en su Dockerfile un cache mount de BuildKit con `target=/app/tsconfig.tsbuildinfo` para acelerar builds. Pero como el `COPY . /app/.` ya había colocado ahí un archivo regular, BuildKit no puede crear el mountpoint sobre un fichero existente → "not a directory". Es un choque entre el artefacto versionado y el cache mount.

**Corrección**:
1. Añadir `*.tsbuildinfo` al `.gitignore`.
2. Sacarlo del repo: `git rm --cached tsconfig.tsbuildinfo` (se regenera solo en local; no debe versionarse).
3. Commit + push y redesplegar. El build pasa.

**Bonus de seguridad detectado**: EasyPanel inyecta las variables de entorno como `--build-arg`, así que aparecen **en texto plano en el log de build** (incluida `OPENROUTER_API_KEY`). No es ideal. Si la key queda expuesta en un log compartido, **rótala** en openrouter.ai/keys y actualízala en EasyPanel.

**Patrón aprendido**: NUNCA versionar artefactos de build/caché (`*.tsbuildinfo`, `.next/`, `node_modules/`, `out/`). Además de ensuciar el repo, rompen builds reproducibles y chocan con los cache mounts de Nixpacks/Docker. Regla: si una herramienta lo genera, va al `.gitignore`.

---

## #17 · El bot no regenera el QR tras desvincular el móvil (credenciales muertas)

**Qué pasó**: al desvincular el dispositivo desde el móvil (o al pasar el número a WhatsApp Business, que también deslogea los dispositivos vinculados), el bot dejaba de funcionar y el dashboard se quedaba esperando un QR que no llegaba nunca. En cada arranque el log mostraba:
```
[bot] esperando QR scan en el dashboard...
[bot] sesión cerrada desde el móvil. No reconectando.
```
No estaba colgado: arrancaba, se paraba y no generaba QR. La única salida era borrar `auth/` a mano y reiniciar.

**Cuándo se vio**: julio 2026, al pasar el número de un agente en producción a WhatsApp Business. Reproducible siempre que WhatsApp cierre la sesión con un logout explícito (código 401).

**Causa**: al desvincular, WhatsApp emite un disconnect con `code === DisconnectReason.loggedOut` (401). El handler de `connection.update` en `src/lib/baileys/client.ts` marcaba `status=disconnected` y hacía `return` — acertaba en NO reconectar a una sesión muerta, pero **dejaba las credenciales muertas en `auth/`**. En el arranque siguiente, `useMultiFileAuthState(AUTH_DIR)` cargaba esas credenciales y Baileys intentaba **resumir** la sesión (en vez de entrar al pairing con QR); WhatsApp respondía otro 401 y el bot se volvía a parar. Dead-end: mientras `auth/` conservara las credenciales muertas, nunca se generaba QR. Ojo: la línea `esperando QR scan` engaña — es un log genérico de arranque, no implica que haya QR.

**Corrección** (en `src/lib/baileys/client.ts`, rama `loggedOut`): además de marcar desconectado, **borrar `auth/` y reconectar limpio**:
```ts
if (code === DisconnectReason.loggedOut) {
  setConnectionState({ status: "disconnected", qr_string: null, phone: null });
  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err }, "[bot] no se pudieron borrar las credenciales muertas");
  }
  scheduleReconnect(undefined); // start() sin credenciales → QR nuevo automático
  return;
}
```
Al reconectar sin credenciales, `start()` entra en el flujo de pairing y genera un QR nuevo solo; el usuario re-vincula (mismo número o WhatsApp Business) sin tocar nada. Ya existía la salida manual vía el flag `data/.restart` (`watchRestartFlag()` borra `auth/` y reinicia); esto lo automatiza para el caso de logout.

**Cómo recuperarlo en una versión antigua** (sin este arreglo): borra la carpeta `auth/` y reinicia. En un deploy con volúmenes (EasyPanel), vacía el volumen `/app/auth` desde la terminal del contenedor (`rm -rf /app/auth/*`) y reinicia. No se pierde nada: las conversaciones y los leads viven en `data/` (y en Airtable/Supabase si están configurados); `auth/` solo guarda la "llave" de la sesión de WhatsApp.

**Patrón aprendido**: una sesión deslogueada (401) deja credenciales que ya no valen pero que Baileys reintenta usar al arrancar → bucle silencioso sin QR. Regla: al detectar `loggedOut`, limpiar el estado de `auth/` antes de reintentar, nunca conservarlo. Refuerza el #3 y el #14: no todos los disconnect codes se tratan igual, y "el bot conecta pero no responde / no saca QR" casi siempre es estado de sesión, no lógica de negocio.

---

## #18 · El bot manda el mensaje de emergencia a cada lead (se pierde el texto que acompaña a una tool)

**Qué pasó**: en producción, CADA lead recibía el mensaje de emergencia ("Perdona, se me cruzó un cable un momento. ¿Me lo repites?") en lugar de una respuesta real. En el log, en todas las conversaciones: `[tool] guardarLead → ok=true` seguido de `[bot] LLM devolvió respuesta vacía, envío aviso suave`.

**Cuándo se vio**: julio 2026, con tráfico real entrando (campaña). Reproducible siempre que el modelo salude y llame a una herramienta en el mismo turno.

**Causa**: el system-prompt le pide al modelo que, al usar una herramienta, escriba TAMBIÉN su mensaje al lead en ese mismo turno (para no quedarse mudo). El modelo obedece: en el turno 1 saluda Y llama a `guardarLead`. Pero `generateReply` (`src/lib/openrouter.ts`) solo devolvía el texto cuando el turno NO tenía tool calls: el texto que acompañaba a la llamada se guardaba en el historial y se DESCARTABA como respuesta. El turno 2 venía vacío (el modelo ya había dicho lo suyo) y el handler mandaba el aviso de emergencia. El reintento con `tool_choice:"none"` también salía vacío porque el modelo no tenía nada nuevo que añadir.

**Corrección** (`src/lib/openrouter.ts`):
1. Capturar el ÚLTIMO texto no vacío de CUALQUIER turno (acompañe o no a una tool) y devolverlo como respuesta.
2. Si tras usar herramientas no hubo NADA de texto, reintentar una respuesta limpia con solo la conversación (`baseMessages`, sin tools ni resultados de tool) para forzar una respuesta normal.
3. Mitigación de vigilancia: el watchdog ahora cuenta los avisos de emergencia (`registrarFallback` + `checkFallbackSpike`) y avisa al dueño por WhatsApp si saltan 3+ en 15 min. `checkMute` NO pillaba este bug porque el bot "respondía" (con el aviso). Ver `docs/10-watchdog.md`.

**Cómo validar**: escribir al bot desde otro móvil. En el log debe salir `[bot] → (…ms) 1 msg a …: "«saludo real»"`, no `LLM devolvió respuesta vacía`. La prueba fiable es que el destinatario reciba una respuesta de verdad, no el "se me cruzó un cable".

**Patrón aprendido**: con tool calling, el texto del asistente puede venir en el MISMO turno que la llamada a la herramienta — nunca lo descartes. Y cualquier "respuesta" que en realidad sea un fallback/aviso de emergencia tiene que ser OBSERVABLE (contador + alarma): un bot que responde MAL no lo detecta un simple check de "mudo".

---

## #19 · `npm run redteam` daba los 15 ataques por superados sin haber hablado con el modelo

**Qué pasó**: la prueba de seguridad imprimía `✓` en los 15 ataques adversariales y salía con código 0 ("todo en orden"). En realidad las 15 llamadas habían devuelto `401 {"message":"User not found."}`: el modelo no respondió ni una vez. Además el JSON de resultados se escribía FUERA del kit (en la carpeta padre), donde nadie lo encontraba y no lo cubría el `.gitignore`.

**Cuándo se vio**: julio 2026, pasando el checklist final del kit antes de empaquetarlo, con una key de OpenRouter caducada.

**Causa**: dos fallos de diseño del script. (1) El bucle imprimía `✓` por haber completado la iteración, no por haber recibido respuesta: el objeto de error se guardaba en el JSON pero no cambiaba nada de lo que se veía en pantalla ni el exit code. (2) La ruta de salida era `path.resolve(ROOT, "..", "redteam-resultados.json")`. Encima el script llevaba su PROPIA copia del system prompt y de las tools, ya obsoleta (prometía `agendar` y `derivarHumano`, que no están registradas), así que incluso funcionando probaba un agente que no existe.

**Corrección** (`scripts/redteam.mts`):
1. Cada ataque sin respuesta imprime `✗ sin respuesta del modelo — <error>`, suma a un contador `errores`, y al final avisa: `sin eso, esta prueba NO valida nada`. `process.exit(1)` si hay errores o fallos unitarios.
2. Salida dentro del kit (`path.join(ROOT, "redteam-resultados.json")`) + entrada en `.gitignore` (contiene respuestas del modelo con tus precios).
3. Se importan el prompt y las tools REALES (`buildSystemPrompt`, `toolDefinitions`) en vez de una copia: el redteam no puede quedarse obsoleto.
4. Los tests unitarios del guardrail fijan `ALLOWED_PRICES`/`ALLOWED_HOSTS` y cargan `guardrails.ts` con `await import()` — con un `import` estático el hoisting lo cargaba antes de asignar las env y el filtro quedaba permisivo (mismo bug que el #5).

**Cómo validar**: `npm run redteam` con una key inválida a propósito → debe terminar en rojo y con exit 1, nunca en verde.

**Patrón aprendido**: un test que solo puede pasar es peor que no tener test. Cualquier comprobación que dependa de una llamada externa tiene que distinguir "pasó" de "no se pudo ejecutar", y el "no se pudo" debe ser tan visible como un fallo. Y nunca duplicar el prompt/las tools en un script de pruebas: importa los de producción o probarás un fantasma.

---

## #20 · El agente se queda mudo al decir el precio mensual de un plan anual (cifra derivada)

**Qué pasó**: mensaje perfectamente legítimo del agente — "el anual son 497, sale a unos 41 al mes" — bloqueado por el guardrail. El lead recibía el mensaje neutro de `GUARD_FALLBACK_MSG` en lugar del cierre. En el log: `[guardrails] respuesta bloqueada: importe no autorizado: 41`.

**Cuándo se vio**: julio 2026, al añadir el caso `cierre-legitimo` a los tests del redteam. Falló, y la culpa no era del test.

**Causa**: agujero de producto, no de código. `guardOutbound` solo permite las cifras de `ALLOWED_PRICES`, y `/personaliza` únicamente recogía los precios LITERALES de la pregunta 4. Nadie —ni el system prompt, ni `.env.example`, ni la documentación— decía que el modelo no puede calcular equivalencias, así que el modelo hacía lo natural (dividir 497 entre 12) y el sistema le tapaba la boca sin explicación en ninguna parte.

**Corrección** (cuatro sitios, porque el agujero era de diseño):
1. `src/lib/system-prompt.ts` — nueva sección "## Precios — regla estricta": solo cifras que aparezcan tal cual, prohibido calcular equivalencias, redondear o estimar, y el aviso de que inventar una cifra BLOQUEA el mensaje entero.
2. `.claude/commands/personaliza.md` (paso 5) — obliga a incluir las cifras derivadas en `ALLOWED_PRICES` (mensual de un anual, cuotas) y a decirle al usuario qué cifras quedaron autorizadas.
3. `.env.example` — el comentario de `ALLOWED_PRICES` explica el caso con ejemplo (`497` al año → añade también `41`).
4. `docs/07-errores-comunes.md` — sección nueva sobre los filtros de seguridad: síntoma, que NO es un bug, cómo leer el motivo en el log y cómo arreglarlo.
5. Caso `precio-derivado` en el redteam para que el comportamiento quede fijado por un test.

**Cómo validar**: `npm run redteam` → los 8 tests del guardrail en OK, con `cierre-legitimo` pasando y `precio-derivado` bloqueado.

**Patrón aprendido**: una lista blanca de cifras hay que poblarla con lo que el modelo VA A DECIR, no con lo que tú escribiste en el catálogo — un LLM deriva, redondea y reformula por naturaleza. Y todo filtro silencioso necesita las tres patas: la regla en el prompt (que no lo intente), la lista bien poblada (que no falle si lo intenta) y la explicación en los docs (que el dueño sepa qué vio).

---

## #21 · `npm run doctor` mentía: "negocio.md personalizado ✓" con la plantilla intacta

**Qué pasó**: en una instalación recién descargada, el doctor daba por bueno `prompts/negocio.md (personalizado)` cuando el archivo seguía siendo la plantilla con 28 `[CORCHETES]` sin rellenar. En la misma pasada marcaba en rojo (`✗`) la falta de `data/messages.db` y de `auth/`, que es el estado NORMAL antes del primer arranque: quien acababa de descargar el kit veía errores en un kit sano.

**Cuándo se vio**: julio 2026, ejecutando el doctor en una copia limpia del kit.

**Causa**: el check era `fs.existsSync()`. Y `negocio.md` se distribuye YA CREADO como plantilla, así que existir no prueba nada. Lo segundo era un problema de semántica: el script solo tenía dos estados (✓ / ✗) y metía en "✗" cosas que no son problemas sino pasos aún no dados.

**Corrección** (`scripts/doctor.ts`):
1. El check lee el CONTENIDO: busca `[CORCHETES]` con la regex `/\[[A-ZÁÉÍÓÚÑ][^\]\n]*\]/g` y el marcador `generado: PLANTILLA`. Si es plantilla, informa de cuántos campos faltan y sugiere `/personaliza`.
2. Tercer estado `pending()` (`○` en gris) que NO cuenta como error, para la DB y `auth/` antes del primer arranque, con una línea final que aclara que el gris no es un fallo.
3. Fuera la referencia a "las sesiones del domingo" (privada del autor): ahora remite a la comunidad donde se consiguió el kit.

**Cómo validar**: `npm run doctor` en una copia recién descargada → ningún `✗`, `negocio.md` en gris con el número de campos por rellenar.

**Patrón aprendido**: `existsSync` no es una comprobación de estado cuando el archivo viaja dentro del kit — hay que mirar el contenido. Y un diagnóstico necesita tres estados, no dos: correcto, pendiente y roto. Pintar lo pendiente como roto asusta al usuario y le hace perder confianza en el resto del informe (que es justo donde sí hay que mirar).

---

## Resumen de causas raíz

Mirando los errores en conjunto:

| Causa raíz | Errores | Patrón general |
|---|---|---|
| WhatsApp Web protocol cambia | #1, #2, #3, #12, #14 | Confiar en Baileys actualizado + browser fingerprint conocido + leer disconnect codes con calma + aceptar nuevos formatos de JID (@lid) |
| State machines mal manejadas | #4 | API defensiva: mostrar datos si existen, no solo si el estado es "perfecto" |
| Carga de entorno | #5 | Side-effect modules antes que cualquier otro import |
| Diferencias entre plataformas | #6, #7, #8 | Declarar explícitamente versiones + toolchain en cada entorno de deploy |
| Falsos amigos comerciales | #9 | "Gratis ilimitado" en realidad no existe — comunicar costes reales temprano |
| Seguridad por defecto | #10 | Cualquier panel expuesto necesita auth, sin excepciones |
| Estado local corrupto | #13 | Fallo de npm en reify/rollback = `node_modules` a medias → limpiar y reinstalar, no reintentar |
| Concurrencia SQLite | #15 | WAL no basta: sin `busy_timeout` hay SQLITE_BUSY cuando varios procesos/workers escriben. Y `next start` exige `next build` antes |
| Artefactos versionados | #16 | Nunca subir `*.tsbuildinfo`/`.next`/`node_modules` — rompen los cache mounts de Nixpacks en el deploy |
| Ciclo de vida de la sesión | #17 | Al hacer logout (401), borrar `auth/` y reconectar → QR nuevo solo; conservar credenciales muertas = dead-end sin QR |
| Texto perdido tras tool call | #18 | El texto del asistente puede venir junto a la llamada a la tool — nunca descartarlo; y todo fallback debe ser observable (alarma) |
| Tests que solo pueden pasar | #19 | Distinguir "pasó" de "no se pudo ejecutar", y que el segundo se vea igual de rojo. Nunca duplicar el prompt/tools en un script de pruebas |
| Lista blanca mal poblada | #20 | Un LLM deriva y redondea cifras: la whitelist se puebla con lo que va a DECIR, no con el catálogo. Todo filtro silencioso necesita regla en el prompt + lista + doc |
| Diagnóstico binario | #21 | `existsSync` no es estado si el archivo viaja en el kit (mirar contenido). Tres estados: correcto / pendiente / roto — pintar lo pendiente como roto asusta |

---

## Formato para añadir errores nuevos

Cuando encuentres un error nuevo:

```markdown
## #N · Título corto

**Qué pasó**: descripción del síntoma observable

**Cuándo se vio**: contexto temporal/situacional

**Causa**: explicación técnica de la raíz

**Corrección**: solución concreta aplicada (con código si aplica)

**Patrón aprendido**: la lección general que evita errores similares
```

Cada error nuevo idealmente se traduce también en:
1. Una mitigación en el código (para que no pase a futuros usuarios)
2. Una entrada en `docs/07-errores-comunes.md` (para que el usuario lo encuentre buscando)
3. Una regla absoluta en `CLAUDE.md` si aplica (para que Claude Code no caiga en el mismo error)
