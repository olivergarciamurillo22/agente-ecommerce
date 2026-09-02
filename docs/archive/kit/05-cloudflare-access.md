> **ARCHIVED — KIT ORIGINAL.** Documentación del kit genérico del que nació
> este repo. El proyecto real es el Casamable Control Center: fuente de
> verdad en `docs/README.md`. Conservado porque las skills /setup y
> /personaliza aún lo referencian.

# 05 · Proteger el dashboard con Cloudflare Access

El dashboard de tu agente, cuando lo despliegues a un servidor, va a estar **expuesto en internet**. Cualquiera con el link puede:

- Leer todas las conversaciones de WhatsApp
- Cambiar a modo HUMAN y suplantar al dueño
- Borrar conversaciones

Necesitas un login antes de que se vea ese panel. La forma más rápida es **Cloudflare Access** — gratis hasta 50 usuarios, 5 minutos de setup, cero código.

## Concepto

Cloudflare Access actúa como un **portero** delante de tu dashboard. Antes de que nadie llegue a tu Next.js, le pide identificación por email. Solo los emails que tú autorices entran.

> **Nota sobre nombres**: en el panel de Cloudflare lo verás bajo el menú **"Zero Trust"** (Cloudflare One es el paraguas comercial). El producto se llama Access internamente. Si buscas "Access" directamente en el panel, te puede mandar a otra sección.

## Cuándo configurarlo

- **Si solo lo usas en tu ordenador (localhost)**: no necesario
- **Si lo despliegas a un servidor con dominio público**: OBLIGATORIO antes de meter conversaciones reales

## Pre-requisitos

- Tener un dominio **propio** (puede ser uno barato de Namecheap, IONOS o el que sea)
- Cuenta gratis en https://dash.cloudflare.com

**Importante**: el subdominio gratis `*.easypanel.host` que da EasyPanel NO sirve para Cloudflare Access — este método exige añadir el dominio a Cloudflare cambiando sus nameservers, y ese DNS es de EasyPanel, no tuyo. Si usas el subdominio gratis, protege el panel con Basic Auth (ver "Alternativas si no quieres Cloudflare" más abajo).

## Paso 1 · Añadir el dominio a Cloudflare

1. En dash.cloudflare.com, añade tu sitio (botón "Add a site")
2. Cloudflare te pedirá cambiar los **nameservers** de tu dominio a los de Cloudflare
3. Ve al panel de tu registrar (Namecheap, IONOS, etc.) y cambia los nameservers a los que te indica Cloudflare
4. Espera 5-30 min a que se propague

## Paso 2 · Crear la aplicación Access

1. En Cloudflare, ve a **Zero Trust → Access → Applications**
2. Click en **Add an application → Self-hosted**
3. Rellena:
   - **Application name**: WhatsApp Panel
   - **Session duration**: 24 hours (o lo que prefieras)
   - **Application domain**: `panel.tu-dominio.com` (o el dominio donde vayas a desplegar)
4. Continuar

## Paso 3 · Configurar la policy

1. **Policy name**: "Solo equipo autorizado"
2. **Action**: Allow
3. **Include**: añade reglas. Las opciones más prácticas:
   - **Emails** → introduce los emails autorizados separados por coma
   - **Emails ending in** → permite cualquier email de un dominio (ej: `@tu-empresa.com`)
4. Guardar

## Paso 4 · Identity provider (Email OTP recomendado)

Para usuarios no técnicos, **recomendamos Email One-Time PIN** (Cloudflare envía un código de 6 dígitos por email cada vez que se entra). Es el método que Cloudflare deja activado por defecto en cuentas nuevas y NO requiere configurar nada extra — funciona directamente.

**Cómo funciona el flujo OTP**:
1. El usuario abre tu dashboard
2. Cloudflare le pide email
3. Cloudflare manda un código de 6 dígitos al email
4. El usuario lo introduce → entra
5. La sesión dura 24h (o lo que configures)

**¿Cuándo elegir Google OAuth en lugar de OTP?**: solo si tu cliente tiene un equipo grande con Google Workspace y prefiere SSO. Para 1-3 usuarios, OTP es más simple porque NO hay que crear credenciales OAuth en Google Cloud Console (donde la gente no técnica se atasca).

Si igual quieres Google:

1. **Zero Trust → Settings → Authentication**
2. Click en **Add new** y elige Google
3. Sigue las instrucciones (te pedirá crear credenciales OAuth en Google Cloud — está bien documentado)
4. Después, en tu Access Application, añade Google como identity provider

## Paso 5 · Probar

1. Abre `https://panel.tu-dominio.com` en una **ventana de incógnito**
2. Verás la pantalla de Cloudflare Access pidiendo login
3. Si tu email está autorizado → entras al dashboard
4. Si no → Cloudflare te bloquea

Importante: prueba TAMBIÉN con un email NO autorizado para confirmar que rechaza correctamente.

## Alternativas si no quieres Cloudflare

### Basic Auth en EasyPanel

Más simple pero menos elegante. Es además la opción a usar si tu dominio es el subdominio gratis `*.easypanel.host`. En EasyPanel, en la app del agente:

1. Pestaña **Basic Auth**
2. Activar
3. Añadir usuario + contraseña
4. Guardar

Cualquier visitante verá el popup nativo del navegador pidiendo usuario y contraseña.

### Tailscale (VPN privada)

Si el panel es SOLO para ti (no compartes con clientes), monta Tailscale en el VPS y accede solo desde tu red Tailscale. Cero exposición pública.

### Middleware Next.js (avanzado)

Si quieres login con tu propio diseño, programas un middleware en Next.js con sesión + cookie. Es más trabajo (~30 min con Claude Code) pero te da control total.

## Coste

- **Cloudflare Access**: gratis hasta 50 usuarios. Después $3/usuario/mes
- **Basic Auth**: gratis ilimitado
- **Tailscale**: gratis hasta 100 dispositivos

## Siguiente paso

Sigue a [06-deploy-hostinger.md](06-deploy-hostinger.md) para desplegar el kit a producción.
