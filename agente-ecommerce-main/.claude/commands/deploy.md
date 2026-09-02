---
description: Guía paso a paso para desplegar el agente a un VPS de Hostinger con EasyPanel para que funcione 24/7. Incluye la protección del dashboard (Cloudflare Access o Basic Auth).
---

# /deploy — Despliegue a producción 24/7

Vas a guiar al usuario hasta tener su agente corriendo en un servidor 24/7. Hostinger VPS + EasyPanel sin Docker. Después le protegerás el dashboard con un login (Cloudflare Access o Basic Auth, según su dominio). Es un proceso largo (45-60 min) — divídelo en fases claras y celebra cada hito.

## Antes de empezar — Pre-checks

1. Verifica que el bot funciona localmente (existe `data/messages.db` y `connection_state.status === 'connected'`)
2. Verifica que el usuario ha completado `/personaliza`: lee `prompts/negocio.md` y comprueba su CONTENIDO (el archivo siempre existe — el kit lo trae de plantilla). Si el frontmatter dice `generado: PLANTILLA` o el texto contiene marcadores tipo `[NOMBRE DEL NEGOCIO]` o `CANARIO-KIT-CAMBIAME`, aún NO está personalizado
3. Si falta alguno → "Antes de desplegar conviene tener el agente funcionando local y personalizado. ¿Quieres que vayamos paso a paso? Escribe `/setup` y luego `/personaliza`"

## Saludo

> "Vamos a desplegar tu agente a un servidor para que funcione 24/7. Esto cuesta entre 8-13€/mes (VPS + OpenRouter) y te lleva una hora. Lo haremos en 5 partes:
>
> 1. Contratar VPS en Hostinger
> 2. Instalar EasyPanel en el VPS
> 3. Subir el kit a un repositorio Git (necesitamos esto para que EasyPanel lo lea)
> 4. Crear la app en EasyPanel
> 5. Proteger el dashboard con un login (Cloudflare Access o la contraseña de EasyPanel, según tu dominio)
>
> (Antes de la parte 3 hago una comprobación técnica rápida — que tengas **git** y **acceso a GitHub**. Si te falta algo, te guío para instalarlo en 2 minutos.)
>
> ¿Empezamos? Si te pierdes en cualquier momento, dime 'pausa' y retomamos."

## Parte 0 · Requisitos técnicos (git + acceso a GitHub)

EasyPanel lee el código desde un repositorio Git, así que la Parte 3 necesita **git instalado** y **una forma de autenticarte con GitHub**. Un usuario desde cero normalmente NO tiene ninguna de las dos (sobre todo en Windows). Verifícalo TÚ en silencio antes de llegar a la Parte 3 — idealmente al principio, para que pueda instalar mientras provisiona el VPS.

### 1. ¿Está git instalado?

Ejecuta `git --version`.
- Si responde una versión → OK, sigue.
- Si falla:
  - **macOS**: ejecuta `xcode-select --install` (abre un instalador del sistema con git). Alternativa: `https://git-scm.com/download/mac`. Tras instalar, reinicia VS Code.
  - **Windows**: descarga e instala desde `https://git-scm.com/download/win` (deja todas las opciones por defecto). Tras instalar, reinicia VS Code y vuelve a `/deploy`.
  - **Linux**: `sudo apt install git` (Debian/Ubuntu) o el gestor que corresponda.

### 2. ¿Hay forma de autenticarse con GitHub?

Para hacer `push` a un repo **privado** necesitas credenciales. Comprueba si está la GitHub CLI: ejecuta `gh auth status`.

- **`gh` instalado y con "Logged in"** → camino fácil. Podrás crear el repo y subir todo en un solo paso en la Parte 3 (`gh repo create ... --private --source=. --push`). No hace falta nada más.
- **`gh` instalado pero NO logueado** → guía al usuario: `gh auth login` (elige GitHub.com → HTTPS → "Login with a web browser", pega el código). Repite `gh auth status` para confirmar.
- **`gh` NO instalado** → dos opciones:
  - **Recomendado**: instalar la GitHub CLI (`brew install gh` en Mac con Homebrew; `winget install GitHub.cli` en Windows; o `https://cli.github.com`) y luego `gh auth login`.
  - **Plan B sin `gh`** (token): el usuario crea un **Personal Access Token** en `https://github.com/settings/personal-access-tokens/new` (fine-grained, solo el repo del agente, permiso *Contents: Read and write*). Luego configuras el remoto con el token embebido en la URL HTTPS para poder hacer push. Guárdalo con cuidado.

### 3. No avances a la Parte 3 sin esto

Si git no está instalado o no hay forma de autenticarse, **párate aquí** y resuélvelo primero. Las Partes 1 y 2 (VPS + EasyPanel) no necesitan git, así que el usuario puede ir contratando el VPS mientras instala git/gh en paralelo.

> Nota: el repositorio será **privado**, así que EasyPanel también necesitará un **GitHub Token** suyo para clonarlo (ver Parte 4). No te asustes si EasyPanel dice "Cannot find public repository / Github token is missing" — es esperado y se resuelve ahí.

## Parte 1 · Contratar VPS en Hostinger

> "Contrata el VPS en Hostinger desde este enlace: **https://www.hostinger.com/juanpe** — al pagar, aplica el código **JUANPE** para un 10% de descuento. Entra en la sección de VPS. El plan **KVM 2** vale para 5-10 agentes simultáneos (~8€/mes). Si vas a usar el VPS solo para ESTE agente, KVM 1 es suficiente (~5,50€/mes). Los precios cambian con sus promociones — mira el vigente en la web.
>
> Una vez compres:
> - Sistema operativo: **Ubuntu 24.04 con Docker** (NO el de plantillas — Ubuntu limpio con Docker)
> - Datacenter: el más cercano a tus clientes
> - Anota la IP del VPS (la verás en el panel de Hostinger)
>
> Avísame cuando lo tengas listo."

Espera a que diga "ya lo tengo" o similar. Pídele la IP del VPS (la usarás más tarde).

## Parte 2 · Instalar EasyPanel

> "Conéctate al VPS por SSH (Hostinger te da un botón 'Terminal' en su panel — el más fácil) y ejecuta este comando (lo copias y pegas — es el instalador actualizado, el mismo que documenta `docs/06-deploy-hostinger.md`):
>
> ```
> docker run --rm -it -v /etc/easypanel:/etc/easypanel -v /var/run/docker.sock:/var/run/docker.sock:ro easypanel/easypanel setup
> ```
>
> Tarda 2-3 minutos. Cuando termine, EasyPanel te dará una URL del tipo `http://<IP_VPS>:3000`. Ábrela en el navegador y crea tu cuenta de admin.
>
> Avísame cuando estés dentro del dashboard de EasyPanel."

## Parte 3 · Subir el kit a Git

EasyPanel necesita leer el código desde un repositorio Git. Hay dos opciones:

### Opción A · Repositorio privado en GitHub (recomendado)

**Pasos comunes (siempre):**
- `git init` en la carpeta del kit (si no hay `.git`)
- Configura identidad si falta: `git config user.name "..."` y `git config user.email "..."`
- `git add -A`, luego **VERIFICACIÓN DE SEGURIDAD**: `git status --short` y comprueba que NO aparecen `.env.local`, `data/` ni `auth/` (el `.gitignore` ya los excluye; `.env.example` SÍ se sube y es correcto, es solo plantilla)
- `git commit -m "Initial commit — WhatsApp AI Agent Kit"`

**Si en la Parte 0 `gh` estaba autenticado (camino fácil):** crea el repo privado Y sube en un solo comando, sin que el usuario toque github.com:
```
gh repo create <nombre> --private --source=. --remote=origin --push
```
Confirma con el usuario el nombre del repo antes (es un recurso permanente en su cuenta). Luego verifica que es privado y que no subió secretos: `gh repo view <nombre> --json visibility`.

**Si NO hay `gh` (plan B con token):**
> "Crea un repositorio nuevo, **privado**, en github.com (sin README). Pásame la URL."

Cuando dé la URL:
- `git branch -M main`
- `git remote add origin <URL>`
- `git push -u origin main` — pedirá autenticación; usa el Personal Access Token de la Parte 0 (como contraseña, o embebido en la URL HTTPS)

**Aviso de seguridad permanente**: nunca subas `.env.local`. Si alguna vez ves que se va a subir, párate. El `.gitignore` ya protege `data/`, `auth/` y `.env*` — pero verifica siempre con `git status` antes del primer commit.

### Opción B · Gitea / GitLab self-hosted

Si el usuario prefiere otra plataforma Git, el flujo es idéntico. Adapta los comandos.

## Parte 4 · Crear la app en EasyPanel

> "Volvamos a EasyPanel. Vamos a crear una nueva app:
>
> 1. Click en **Create > App**
> 2. Source: **GitHub** (o el provider que uses)
> 3. Conecta tu cuenta de GitHub (te abrirá una ventana de OAuth)
> 4. Selecciona el repositorio que creamos en la Parte 3 (con el nombre que elegiste) y la rama `main`
> 5. Build path: `/` (raíz)
> 6. Builder: **Nixpacks** (EasyPanel lo detectará por el `nixpacks.toml` que el kit incluye)
> 7. Aún NO le des a 'Deploy' — primero configura las variables y volúmenes"

### Variables de entorno

> "En la pestaña **Environment**, copia de tu `.env.local` TODAS las variables que tengas rellenas — si olvidas alguna aquí, esa función (CRM, memoria, guardrails, avisos...) se pierde en el servidor sin avisar. Las dos obligatorias:
>
> ```
> OPENROUTER_API_KEY=<tu key actual, la de tu .env.local>
> OPENROUTER_MODEL=anthropic/claude-haiku-4.5
> ```
>
> En `OPENROUTER_MODEL` pon el mismo modelo que ya usas en tu `.env.local` (el recomendado del kit es `anthropic/claude-haiku-4.5`; la alternativa más barata es `openai/gpt-4o-mini`).
>
> Y estas son las opcionales — copia las que tengas configuradas en local:
>
> | Variable | Para qué sirve |
> |---|---|
> | `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_LEADS_TABLE`, `AIRTABLE_AGENT_UTM` | CRM de leads en Airtable |
> | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Memoria de largo plazo (el agente recuerda a cada persona) |
> | `TRANSCRIPTION_MODEL`, `VISION_MODEL` | Transcribir notas de voz e interpretar imágenes |
> | `BUFFER_SECONDS` | Segundos que espera para agrupar mensajes seguidos |
> | `ALLOWED_PRICES`, `ALLOWED_HOSTS`, `CHECKOUT_URL`, `SECURITY_CANARY` | Guardrails de seguridad (precios y enlaces permitidos, anti-fuga) |
> | `ALERT_WHATSAPP` | Avisos del watchdog a tu móvil personal |
> | `PORT`, `LOG_LEVEL` | Puerto del panel y nivel de detalle del log |
>
> **Importante**: copia la API key de tu `.env.local` actual. NO uses una nueva — el agente ya tiene historial con esa key (créditos consumidos, etc.)."

### Volúmenes persistentes (PASO CRÍTICO)

> "En la pestaña **Mounts** (o **Volumes**), añade DOS rutas como volúmenes persistentes:
>
> 1. `/app/data` → guarda la base de datos (todas las conversaciones)
> 2. `/app/auth` → guarda la sesión de WhatsApp (sin esto, cada redeploy te obliga a re-escanear el QR)
>
> Si te saltas esto, perderás conversaciones y tendrás que reconectar WhatsApp constantemente. Es la causa #1 de problemas en producción."

### Dominio

> "En la pestaña **Domains**, añade el dominio que vayas a usar. Tienes dos opciones, y la elección condiciona cómo protegeremos el panel en la Parte 5:
>
> - **Subdominio de tu propio dominio** (ej: `panel.tu-empresa.com`) → lo protegeremos con Cloudflare Access
> - **El `*.easypanel.host` que te dan gratis** → NO sirve para Cloudflare Access (ese DNS es de EasyPanel, no tuyo); lo protegeremos con la contraseña integrada de EasyPanel (Basic Auth)
>
> Al añadir el dominio, en el campo **Port** pon `3000` (el puerto donde escucha el panel). Si apunta a otro puerto, el dominio dará error de conexión y no verás el QR.
>
> Anota el dominio — lo usaremos en la Parte 5."

### Deploy

> "Ahora sí: click en **Deploy**. Tarda 3-5 minutos (el build de better-sqlite3 es lo más lento). Cuando termine, abre el dominio en el navegador.
>
> Verás el QR de WhatsApp como en local. Escanéalo desde el móvil del negocio.
>
> Avísame cuando hayas conectado."

### Si el build falla

Pide al usuario que copie el log y consulta `errores-sesion.md`. Los errores típicos:
- `better-sqlite3 build error` → faltó python3/gcc en nixpacks. Pero el `nixpacks.toml` ya los declara — extraño
- `Node version mismatch` → el VPS tiene Node viejo. Revisa que el `.nvmrc` está en el repo
- `npm ERR! Cannot find module 'tsx'` → tsx está en devDependencies en vez de dependencies (no debería pasar, pero verifica)
- El build termina bien pero el dominio da error 502/504 o "conexión rechazada" → el dominio en EasyPanel apunta a otro puerto. En la pestaña **Domains**, edita el dominio y pon Port `3000`

## Parte 5 · Proteger el dashboard

> "Tu dashboard ahora está expuesto en internet. Cualquiera con el link puede ver todas las conversaciones de WhatsApp y enviar mensajes en tu nombre. Vamos a ponerle un login — es gratis y tarda 5 minutos."

El método depende del dominio que eligió en la Parte 4:

- **Subdominio gratis `*.easypanel.host`** → Opción A (Basic Auth). Cloudflare Access NO es posible aquí: exige añadir el dominio a Cloudflare cambiando sus nameservers, y ese DNS es de EasyPanel, no del usuario
- **Dominio propio** → Opción B (Cloudflare Access). Referencia completa en `docs/05-cloudflare-access.md`

### Opción A · Basic Auth de EasyPanel (subdominio gratis)

> "Vamos a activar la contraseña integrada de EasyPanel:
>
> 1. En EasyPanel, entra en la app del agente
> 2. Abre la pestaña **Security** (en algunas versiones aparece como **Basic Auth**)
> 3. Activa Basic Auth y añade un usuario y una contraseña fuerte (larga y única — guárdala en un gestor de contraseñas)
> 4. Guarda
>
> Desde ahora, el navegador pedirá ese usuario y contraseña antes de mostrar el panel."

**Validación**: abre el dominio en una ventana de incógnito. Debe aparecer el diálogo del navegador pidiendo usuario y contraseña antes de ver el panel.

### Opción B · Cloudflare Access (dominio propio)

> "**Concepto**: Cloudflare Access actúa como un portero delante de tu dashboard. Antes de que nadie llegue a tu panel, le pide un código de un solo uso que le llega por email. Solo los emails que tú autorices entran."

#### Pasos

1. Crea cuenta en `dash.cloudflare.com` si no tienes
2. Añade tu dominio a Cloudflare (te pedirá cambiar los nameservers — guía al usuario)
3. En el panel: **Zero Trust → Access → Applications → Add an application → Self-hosted**
4. Nombre: "WhatsApp Panel"
5. Dominio: el que pusiste en EasyPanel
6. Policy: "Allow" con regla "Emails ending in `@tudominio.com`" (o lista explícita de emails: el tuyo + el del cliente)
7. **Identity provider: Email One-Time PIN** (viene activado por defecto, sin configuración extra). Cloudflare manda un código de 6 dígitos al email cuando alguien entra al dashboard. Es más simple que Google OAuth porque NO requiere crear credenciales en Google Cloud Console
8. Guardar

> **Nota sobre el rebranding**: si buscas "Access" directamente en el panel de Cloudflare puede mandarte a otro sitio. La ubicación correcta es bajo el menú **"Zero Trust"** (Cloudflare One es el paraguas comercial actual).

#### Validación

> "Abre el dominio en una ventana de incógnito. Cloudflare te pedirá tu email y luego un código de 6 dígitos que te llega a ese email (el One-Time PIN). Solo si tu email está en la regla, entrarás al dashboard. Compruébalo con un email NO autorizado para asegurarte de que rechaza correctamente."

## Cierre

> "✓ Despliegue completo. Tu agente está corriendo 24/7 con:
>
> - Dashboard protegido con login (código de un solo uso por email con Cloudflare Access, o usuario y contraseña con Basic Auth)
> - Base de datos persistente (no pierdes conversaciones en redeploys)
> - Sesión WhatsApp persistente (no re-escaneas QR)
>
> A partir de ahora, cada vez que hagas un cambio en el código local:
>
> ```
> git add .
> git commit -m 'cambios'
> git push
> ```
>
> EasyPanel redespliega automáticamente.
>
> ¿Cuánto te ha costado correrlo 24/7? 8-13€/mes. ¿Cuánto puedes cobrar a tu cliente? 80-200€/mes de mantenimiento + 800-1.500€ de implementación. Las matemáticas dan.
>
> Si quieres ayuda para vender este servicio → la comunidad donde conseguiste el kit (ahí compartimos cómo cerrar clientes y cobrar)."

## Reglas

- Si el usuario se atasca en SSH/Git → es señal de que no tiene experiencia técnica. Sugiérele pedir ayuda en la comunidad donde consiguió el kit para deployar acompañado
- NUNCA pidas al usuario que escriba la API key en el chat de Claude Code. Pide que la copie de su `.env.local` directamente al panel de EasyPanel
- NUNCA recomiendes deployar SIN proteger el panel: Cloudflare Access si hay dominio propio, o Basic Auth de EasyPanel si se usa el subdominio gratis. Un panel abierto es un agujero de seguridad demasiado grande
- Si el cliente final del usuario quiere su propio servidor, sugiere clonar este flujo para cada cliente — 1 VPS, varios agentes (una instancia por cliente)
