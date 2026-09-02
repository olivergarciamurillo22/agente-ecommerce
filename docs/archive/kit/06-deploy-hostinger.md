> **ARCHIVED — KIT ORIGINAL.** Documentación del kit genérico del que nació
> este repo. El proyecto real es el Casamable Control Center: fuente de
> verdad en `docs/README.md`. Conservado porque las skills /setup y
> /personaliza aún lo referencian.

# 06 · Deploy en Hostinger VPS + EasyPanel

Vas a poner tu agente a correr 24/7 en un servidor. El stack: Hostinger VPS + EasyPanel + Nixpacks (sin Docker). Coste total: 8-13 €/mes.

## Plan

1. Contratar VPS en Hostinger
2. Instalar EasyPanel
3. Subir el kit a un repositorio Git
4. Crear la app en EasyPanel
5. Proteger el dashboard con un login — Cloudflare Access (dominio propio) o Basic Auth (subdominio gratis), ver [05-cloudflare-access.md](05-cloudflare-access.md)

Tiempo total: ~45 minutos la primera vez.

## 1. Contratar VPS en Hostinger

1. Contrata el VPS desde este enlace: **https://www.hostinger.com/juanpe** — al pagar, aplica el código **JUANPE** para un 10% de descuento. Entra en la sección de VPS
2. Planes recomendados. Los precios son **orden de magnitud**: Hostinger cambia sus promociones a menudo, así que mira el precio real en la web antes de pagar. Lo que no cambia es la relación entre planes:

   | Plan | Precio aprox. | RAM | vCPU | Agentes simultáneos |
   |---|---|---|---|---|
   | KVM 1 | ~5,50 €/mes | 4 GB | 1 | 2-4 (1 vCPU limita) |
   | KVM 2 | **~8 €/mes** | 8 GB | 2 | 5-10 (recomendado) |
   | KVM 4 | ~11 €/mes | 16 GB | 4 | 15-25 |

   **Nota técnica importante**: el cuello de botella real son las **vCPU**, no la RAM. Cada agente Baileys consume poca RAM (~150 MB) pero usa CPU para WebSocket + cifrado. Si vas a vender esto a varios clientes, KVM 2 es el sweet spot.

3. Sistema operativo: **Ubuntu 24.04 con Docker** (Hostinger lo tiene como plantilla; trae docker-ce + docker-compose preinstalados)
4. Datacenter: el más cercano a tus clientes
5. Anota la **IP del VPS** que te dan

## 2. Instalar EasyPanel

EasyPanel se instala con un comando en el VPS:

1. En el panel de Hostinger, busca el botón **Terminal** (o "Terminal web con IA"). Te abre SSH directo sin tener que configurar nada
2. Pega este comando y dale enter (es el instalador oficial de EasyPanel):

```
docker run --rm -it -v /etc/easypanel:/etc/easypanel -v /var/run/docker.sock:/var/run/docker.sock:ro easypanel/easypanel setup
```

3. Espera 2-3 minutos. (Si ese comando fallara, existe el instalador clásico como alternativa: `curl -sSL https://get.easypanel.io | sh`)
4. Cuando termine, EasyPanel te da una URL del tipo `http://<TU_IP_VPS>:3000`
5. Ábrela en el navegador
6. Crea tu cuenta de admin (email + contraseña)

> **Nota**: EasyPanel tiene 4 ediciones. La **self-hosted Developer es gratis** y es la que estamos usando. Si visitas easypanel.io/pricing verás planes cloud-hosted de pago — ignóralos, no los necesitas.

## 3. Subir el kit a un repositorio Git

EasyPanel necesita leer el código desde un repositorio. Lo más fácil: GitHub privado.

### Si no tienes cuenta de GitHub

1. Crea en https://github.com/signup
2. Crea un repositorio nuevo, **privado**, llamado `mi-agente-whatsapp`
3. NO inicialices con README — déjalo vacío

### Subir el kit

En la terminal de VS Code dentro del kit:

```
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<TU_USUARIO>/mi-agente-whatsapp.git
git branch -M main
git push -u origin main
```

GitHub te pedirá autenticarte. Sigue las instrucciones (te puede pedir un Personal Access Token — créalo en `Settings → Developer settings → Tokens`).

**Importante**: el `.gitignore` ya está bien configurado. Tu `.env.local`, `data/` y `auth/` NO se suben.

## 4. Crear la app en EasyPanel

### Crear

1. En EasyPanel, click **Create → App**
2. **Source**: GitHub
3. Conecta tu cuenta de GitHub (te abre OAuth)
4. **Repository**: `mi-agente-whatsapp`
5. **Branch**: `main`
6. **Build path**: `/`
7. **Builder**: Nixpacks (EasyPanel lo autodetecta por el `nixpacks.toml` del kit)
8. NO le des a Deploy todavía — primero configura variables y volúmenes

> **Aviso sobre Nixpacks**: a finales de 2025, Railway (creador de Nixpacks) lo puso en **modo mantenimiento** y lanzó **Railpack** como sucesor. Nixpacks SIGUE funcionando perfectamente hoy y EasyPanel lo soporta oficialmente — pero si dentro de 12-18 meses notas que algo deja de funcionar, considera migrar a **Dockerfile** (EasyPanel también lo soporta) o esperar a que EasyPanel adopte Railpack. Para este kit, hoy, Nixpacks es la opción correcta.

### Variables de entorno

En la pestaña **Environment** del app, copia de tu `.env.local` TODAS las variables que tengas rellenas — si olvidas alguna, esa función (CRM, memoria, guardrails, avisos...) se pierde en el servidor sin avisar. Las dos obligatorias:

```
OPENROUTER_API_KEY=<la key que tienes en tu .env.local>
OPENROUTER_MODEL=anthropic/claude-haiku-4.5
```

En `OPENROUTER_MODEL` pon el mismo modelo que ya usas en tu `.env.local` (el recomendado del kit es `anthropic/claude-haiku-4.5`; la alternativa más barata es `openai/gpt-4o-mini`).

Y estas son las opcionales — copia las que tengas configuradas en local:

| Variable | Para qué sirve |
|---|---|
| `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_LEADS_TABLE`, `AIRTABLE_AGENT_UTM` | CRM de leads en Airtable — ver [04-configurar-tools.md](04-configurar-tools.md) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Memoria de largo plazo (el agente recuerda a cada persona) — ver [08-memoria-supabase.md](08-memoria-supabase.md) |
| `TRANSCRIPTION_MODEL`, `VISION_MODEL` | Transcribir notas de voz e interpretar imágenes |
| `BUFFER_SECONDS` | Segundos que espera para agrupar mensajes seguidos |
| `ALLOWED_PRICES`, `ALLOWED_HOSTS`, `CHECKOUT_URL`, `SECURITY_CANARY` | Guardrails de seguridad (precios y enlaces permitidos, anti-fuga) |
| `ALERT_WHATSAPP` | Avisos del watchdog a tu móvil personal — ver [10-watchdog.md](10-watchdog.md) |
| `PORT`, `LOG_LEVEL` | Puerto del panel y nivel de detalle del log |

### Volúmenes persistentes (CRÍTICO)

Sin esto, cada redeploy borra conversaciones Y obliga a re-escanear el QR. Es el error #1 en producción.

En la pestaña **Mounts** (o **Volumes**):

| Mount path | Type |
|---|---|
| `/app/data` | Volume |
| `/app/auth` | Volume |

EasyPanel creará volúmenes persistentes en esas rutas.

### Dominio

En la pestaña **Domains**. La elección condiciona cómo protegerás el panel en el paso 5:

- Opción A: subdominio de tu dominio. Ej: `panel.tu-empresa.com` → podrás protegerlo con Cloudflare Access
- Opción B: subdominio gratis que da EasyPanel (algo tipo `<id>.easypanel.host`) → NO sirve para Cloudflare Access (ese DNS es de EasyPanel, no tuyo); lo protegerás con Basic Auth

Al añadir el dominio, en el campo **Port** pon `3000` (el puerto donde escucha el panel). Si apunta a otro puerto, el dominio dará error de conexión y no verás el QR.

Anota el dominio — lo usarás en el paso 5.

### Deploy

Click en **Deploy**. Tarda 3-5 minutos:

- `better-sqlite3` se compila nativamente (por eso `nixpacks.toml` declara python3 + gcc)
- Next.js se compila
- El bot arranca

Cuando termine, abre el dominio. Verás el QR de WhatsApp como en local. Escanéalo desde el móvil del negocio.

## 5. Proteger el dashboard

Antes de meter conversaciones reales, **ponle un login al panel**. El método depende del dominio que elegiste:

- **Dominio propio** → Cloudflare Access. Ver [05-cloudflare-access.md](05-cloudflare-access.md)
- **Subdominio gratis `*.easypanel.host`** → Basic Auth de EasyPanel: en la app del agente, pestaña **Security** (o **Basic Auth**), actívalo y pon usuario + contraseña fuerte. Cloudflare Access no funciona con ese subdominio porque exige controlar el DNS del dominio, y ese DNS es de EasyPanel

## Redeploy cuando cambies algo local

Cada vez que cambies código (o `negocio.md`) en tu local:

```
git add .
git commit -m "cambios"
git push
```

EasyPanel redespliega automáticamente. Tarda 2-3 minutos.

## Si el build falla

| Error | Solución |
|---|---|
| `better-sqlite3 build error` | Inspecciona el log — probablemente faltan deps de sistema. El `nixpacks.toml` del kit ya declara python3+gcc+gnumake. Si no las declara, fíjalo |
| `Node version mismatch` | Verifica que `.nvmrc` está en el repo. Si no, el VPS usa Node 18 default. Crea `.nvmrc` con `22` |
| `Cannot find module 'tsx'` | tsx debe estar en `dependencies`, no devDependencies. Verifica tu `package.json` |
| El build va bien pero el dominio da error 502/504 o "conexión rechazada" | El dominio en EasyPanel apunta a otro puerto. En **Domains**, edita el dominio y pon Port `3000` |

Si te atascas, ejecuta `npm run doctor` en local con las mismas variables de entorno (copia `.env.production` del VPS a `.env.local` temporalmente). Suele dar pistas.

## Cuántos agentes caben en un VPS

| Plan Hostinger | RAM | vCPU | Agentes simultáneos recomendados |
|---|---|---|---|
| KVM 1 (~5,50€) | 4 GB | 1 | 2-4 (1 vCPU limita) |
| KVM 2 (~8€) | 8 GB | 2 | 5-10 |
| KVM 4 (~11€) | 16 GB | 4 | 15-25 |

Un agente típico usa ~150 MB RAM. **El cuello de botella real son las vCPU**, no la RAM — Baileys + Next.js compiten por CPU cuando hay tráfico simultáneo.

Cada agente nuevo = nueva app en EasyPanel apuntando al mismo repo, con `.env.local` y volúmenes propios.

## Negocio: rentabilidad

| Concepto | Coste mensual |
|---|---|
| VPS Hostinger KVM 2 | ~8 € |
| OpenRouter (50 leads/día × varios agentes) | 10-30 € |
| **Total coste tuyo** | **18-38 €/mes** |

Si cobras 150 €/mes de mantenimiento por agente y montas 5 agentes (1 VPS): 750 €/mes - 38 €/mes = **712 €/mes de margen**. Implementación inicial 800-1.500 € por cliente.

## Siguiente paso

Sigue a [07-errores-comunes.md](07-errores-comunes.md) para diagnosticar problemas comunes en producción.
