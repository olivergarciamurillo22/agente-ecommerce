> **ARCHIVED — KIT ORIGINAL.** Fuente de verdad actual: `docs/README.md`.

# Guía completa — Tu agente de WhatsApp con IA, de cero a producción

> Guía paso a paso para montar tu agente, incluida dentro del kit.
> Síguela en orden: **instalar → entrenar → probar → desplegar 24/7 → proteger**.
>
> No necesitas saber programar. Claude Code (dentro de VS Code) ejecuta todo por ti;
> tú solo conversas y confirmas.

---

## Qué vas a conseguir

Al terminar tendrás un agente de WhatsApp con IA que:
- Responde solo a quien te escribe, con la personalidad de **tu negocio**
- Califica leads, responde dudas y guarda los que encajan en tu CRM; si usas un enlace de reserva (Cal.com, Calendly...), lo comparte cuando toca
- Corre **24/7 en un servidor** (no depende de tu ordenador)
- Tiene un **panel de control** protegido con contraseña para ver conversaciones y atender a mano

**Tiempo total**: ~1 hora la primera vez. **Coste**: 8-13 €/mes (servidor + IA).

---

## Requisitos previos

| Necesitas | Para qué | Coste |
|---|---|---|
| **VS Code** + **Claude Code** | El entorno donde Claude te guía | VS Code gratis · Claude Pro ~20 $/mes |
| **Node.js 20 o superior** | El motor del kit | Gratis |
| **Cuenta de OpenRouter** | El cerebro de IA del agente | Cuenta y key gratuitas; cargas ~5 € de saldo tú mismo (pago único, te dura meses de uso normal) |
| **WhatsApp del NEGOCIO** | Un número, **nunca** el personal | Gratis (o ~10 €/mes una SIM aparte) |
| **(Para 24/7)** VPS Hostinger + cuenta GitHub | Servidor y repositorio | VPS desde ~5,50 €/mes · GitHub gratis |

> ⚠️ Usa siempre un número **secundario o del negocio**. El móvil que vincules queda atado al bot.

---

## FASE 1 · Instalar el agente (`/setup`)

Abre la carpeta del kit en VS Code y escribe **`/setup`** en Claude Code. Esto hace, en orden:

1. **Comprueba tu sistema** (Node, npm, espacio en disco). Si te falta Node, te da el enlace para instalarlo.
2. **Instala el proyecto** (`npm install`).
   - *Si vieras un error raro de `npm` (tipo `reify`/`rollback`)*: es un `node_modules` a medias. Claude lo limpia y reinstala. Ya está contemplado.
3. **Configura OpenRouter**: Claude crea tu `.env.local` a partir de la plantilla y te lo abre en el editor para que pegues tu API key AHÍ, en la línea `OPENROUTER_API_KEY` (la key empieza por `sk-or-v1-` y **nunca se pega en el chat**). Cuando le digas "listo", Claude la lee del archivo y la valida con una llamada de prueba. Ese archivo **nunca** se sube a ningún sitio.
   - La cuenta y la key son gratuitas; carga unos **5 € de saldo** en openrouter.ai (pago único, te dura meses de uso normal). Sin saldo, el agente no responde.
   - Modelo por defecto del kit: `anthropic/claude-haiku-4.5` (ya viene configurado). Alternativa barata: `openai/gpt-4o-mini`. **No uses modelos `:free`** — se saturan.
4. **Conecta tu WhatsApp**: arranca el bot y el panel, y te muestra un **código QR** en `http://localhost:3000`.
   - En tu móvil del negocio: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo** → escanea el QR.
5. **Prueba**: desde **otro** móvil, escribe "hola" a tu número. El agente responde.

✅ **Al final de la Fase 1**: tu agente responde en tu ordenador, todavía con el guion de plantilla del kit (lo adaptas a tu negocio en la Fase 2).

---

## FASE 2 · Entrenar el agente a tu negocio (`/personaliza`)

Aquí es donde el agente deja de ser genérico y empieza a hablar como **tu** negocio. Escribe **`/personaliza`**. Claude te hará **9 preguntas, una a una** (responde en lenguaje natural, sin formato):

| # | Pregunta | Ejemplo |
|---|---|---|
| 1 | **Nombre del negocio y qué vende** (1 frase) | "Agencia Lobo — automatizamos reportes con IA para agencias" |
| 2 | **Tu cliente ideal** (perfil, su problema, qué le frena) | "Agencias de 5-20 personas que pierden horas en reportes. Les frena pensar que la IA es cara" |
| 3 | **El nombre de tu agente** | "Leo" |
| 4 | **Qué ofreces y a qué precio** | "Auditoría 300 €. Implantación 1.200 €" — son los ÚNICOS precios que podrá decir |
| 5 | **Pago y garantía** | "50% al firmar y el resto al entregar. Si no ahorras horas, te devolvemos" |
| 6 | **Cómo calificar al lead** (2-4 preguntas + señales) | "BUENO: factura +5k/mes, con urgencia. MALO: solo curiosea" |
| 7 | **Cómo se cierra** cuando el lead encaja | 1) Enlace de compra · 2) Enlace para agendar (Cal.com, Calendly...) · 3) Otra cosa |
| 8 | **Tus enlaces oficiales** | "agencialobo.com y agencialobo.com/reservar" — los ÚNICOS que podrá enviar |
| 9 | **El tono** (+ una frase que SÍ y otra que NO diría) | "Cercano y directo. NO diría: estimado cliente, le informamos de que..." |

Al terminar, Claude:
- Redacta él mismo tus **preguntas frecuentes y objeciones** a partir de lo que le has contado, y te las muestra para que las revises.
- Te muestra un **resumen** para que confirmes.
- Guarda tus respuestas en **`prompts/negocio.md`** (este es el "cerebro de negocio" del agente; el código no se toca).
- Si le das un enlace de reserva (Cal.com, Calendly...), lo añade a la sección de **Enlaces** de `prompts/negocio.md` para que el agente pueda compartirlo.
- Sincroniza los **filtros de seguridad** de `.env.local` con tus datos: tus precios en `ALLOWED_PRICES` y tus dominios en `ALLOWED_HOSTS`. Cualquier cifra o enlace fuera de esas listas se bloquea antes de salir.
- **No reinicia nada**: el agente relee `prompts/negocio.md` en cada mensaje, así que el guion nuevo entra en la siguiente respuesta.

> 💡 ¿No sabes qué responder? Mira `prompts/ejemplos/` — hay 3 casos completos (agencia de IA, ecommerce, infoproducto) para inspirarte.

✅ **Al final de la Fase 2**: escribe "hola" desde otro móvil → el agente responde **con la personalidad de tu negocio**, califica y actúa según tus reglas. El agente cierra la conversación por chat, sin pasarle el relevo a nadie a mitad; si quieres enterarte al momento de lo que pasa, la vigilancia automática (watchdog, `ALERT_WHATSAPP`) te avisa por WhatsApp — ver `docs/10-watchdog.md`.

> Puedes repetir `/personaliza` siempre que quieras afinar el mensaje.

---

## FASE 3 · Desplegar 24/7 en un servidor (`/deploy`)

Para que funcione sin tu ordenador encendido, lo subimos a un servidor. Escribe **`/deploy`** y Claude te guía. Resumen de las partes:

### Parte 0 · Requisitos técnicos (git + GitHub)
El servidor lee tu código desde un repositorio Git, así que necesitas:
- **git instalado** (Claude lo comprueba; si falta, te guía: Mac `xcode-select --install` · Windows `git-scm.com`).
- **Acceso a GitHub**: lo más fácil es tener la **GitHub CLI** (`gh`) conectada; si no, Claude te guía con un token.

### Parte 1 · Contratar el VPS (Hostinger)
- Contrátalo en **https://www.hostinger.com/juanpe** y aplica el código **JUANPE** al pagar (10% de descuento).
- Plan **KVM 1** (~5,50 €/mes) basta para un agente. **KVM 2** (~8 €) si vas a alojar varios. Mira el precio vigente en su web: Hostinger cambia las promociones a menudo.
- Sistema: **Ubuntu 24.04 con Docker**. Anota la **IP**.

### Parte 2 · Instalar EasyPanel
- Conéctate al VPS por SSH (botón "Terminal" de Hostinger) y pega:
  ```
  docker run --rm -it -v /etc/easypanel:/etc/easypanel -v /var/run/docker.sock:/var/run/docker.sock:ro easypanel/easypanel setup
  ```
- Abre `http://<IP>:3000` y crea tu cuenta de admin.

### Parte 3 · Subir el kit a GitHub (privado)
- Claude crea el repositorio **privado** y sube el código (con `gh`, en un solo paso).
- El `.gitignore` ya protege lo sensible: `.env.local`, `data/` y `auth/` **nunca** se suben.

### Parte 4 · Crear la app en EasyPanel
1. **Create → App** → Source **GitHub** → conecta tu cuenta y elige el repo (rama `main`).
   - *Si dice "Github token is missing"*: es normal con repos privados. Crea un **GitHub Token** (solo ese repo, lectura) y pégalo en *Settings → GitHub*. Claude te guía.
2. **Builder**: Nixpacks (se autodetecta).
3. **Variables** (pestaña *Environment*):
   ```
   OPENROUTER_API_KEY=<tu key>
   OPENROUTER_MODEL=anthropic/claude-haiku-4.5
   ```
4. **Volúmenes persistentes** (pestaña *Mounts* → *Add Volume Mount*) — ⚠️ **EL PASO MÁS IMPORTANTE**:
   | Mount Path | Guarda |
   |---|---|
   | `/app/data` | La base de datos (todas las conversaciones) |
   | `/app/auth` | La sesión de WhatsApp (sin esto re-escaneas el QR en cada actualización) |
5. **Dominio**: usa el gratuito `*.easypanel.host` que te asigna, o uno propio.
6. **Deploy**. Cuando termine, abre el dominio → verás el **QR** → escanéalo con el WhatsApp del negocio.

> El kit ya viene **blindado** contra los dos fallos típicos del deploy: el nuevo formato de direcciones **`@lid`** de WhatsApp (recibir y responder) y el bloqueo del *build* de la base de datos. No tendrás que tocar nada de eso.

### Parte 5 · Proteger el panel (¡obligatorio!)
Tu panel queda accesible por internet. Cualquiera con el link vería tus conversaciones. Protégelo:
- **Con dominio `*.easypanel.host`** → pestaña **Security** de la app → **Basic Auth** → usuario + contraseña fuerte.
- **Con dominio propio** → **Cloudflare Access** (login con email, gratis). Ver `docs/05-cloudflare-access.md`.

✅ **Al final de la Fase 3**: tu agente corre **24/7**, con conversaciones y sesión que **sobreviven a las actualizaciones**, y el panel protegido con contraseña.

---

## FASE 4 · Mantenimiento y negocio

**Actualizar el agente** (p. ej. tras un nuevo `/personaliza`): dile a Claude Code **"sube los cambios"** y él hace el commit y el push por ti — tú no tocas la terminal. Después, en EasyPanel pulsa **Deploy** y listo (la base de datos y la sesión se conservan gracias a los volúmenes).

> Solo como referencia, si no usas Claude Code, los comandos equivalentes son:
> ```
> git add .
> git commit -m "cambios"
> git push
> ```

**Costes reales**: ~5,50-8 € de VPS + 2-5 € de OpenRouter por agente = **8-13 €/mes**. Un KVM 2 aloja 5-10 agentes.

**Cómo cobrar** (tarifas de mercado 2026): diagnóstico 150-300 € · implementación 800-1.500 € · mantenimiento 80-200 €/mes. Con 10 clientes a 150 €/mes → ~1.500 €/mes recurrentes.

**Seguridad**: trata tus API keys como contraseñas. Si alguna se expone (por ejemplo en un log), **rótala** en openrouter.ai/keys y actualízala en EasyPanel.

---

## Solución rápida de problemas

| Síntoma | Qué hacer |
|---|---|
| El bot no conecta / no aparece el QR | `npm run doctor` y revisa que el bot está arrancado |
| Conecta pero **no responde** a mensajes | Ya está resuelto en el kit (formato `@lid`). Asegúrate de escribir desde **otro** móvil |
| Error 405 / 440 / 515 | El kit ya los mitiga. El **515 no es error** (es señal de emparejamiento OK) |
| "OPENROUTER_API_KEY undefined" | Falta la key en `.env.local` (local) o en *Environment* (EasyPanel) |
| El build del deploy falla | El kit ya está blindado; si persiste, pega el log en la comunidad |

Documentación técnica detallada por tema en la carpeta **`docs/`** (empieza por `00-arquitectura` — cómo funciona el sistema por dentro — y sigue en orden numérico) y los errores conocidos en **`errores-sesion.md`**.

---

## ¿Te atascas? La comunidad está para eso

Todo el soporte vive en la **comunidad donde conseguiste el kit**.

Pega tu error (y el output de `npm run doctor`), enseña tu agente, y resuélvelo con el resto de la comunidad.

---

*Kit de uso privado. No lo compartas fuera de la comunidad donde lo conseguiste.*
