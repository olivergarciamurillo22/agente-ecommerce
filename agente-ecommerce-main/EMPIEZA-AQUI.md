# Kit 02 · Empieza aquí

Bienvenido. Vas a montar tu propio agente de IA conectado a WhatsApp en menos de 15 minutos. No vas a tocar código — solo seguir 3 pasos.

> 📘 ¿Quieres el recorrido completo de principio a fin (instalar → entrenar → desplegar 24/7), con todos los detalles? Léelo en **[`GUIA-COMPLETA.md`](GUIA-COMPLETA.md)**, incluida dentro del kit.

---

## Paso 1 · Abre esta carpeta con VS Code

VS Code es el editor donde vas a tener todo. Es gratuito.

- **¿No lo tienes?** Descárgalo aquí: https://code.visualstudio.com/Download
- Una vez instalado, en VS Code: `Archivo → Abrir carpeta...` y elige la carpeta de este kit

---

## Paso 2 · Abre Claude Code y escribe `/setup`

Claude Code es la extensión que va a hacer todo el trabajo por ti dentro de VS Code.

- **¿No la tienes?** Instálala desde el marketplace de VS Code: busca "Claude Code" y dale a "Instalar"
- **Importante**: Claude Code requiere **suscripción Claude Pro** (~$20/mes) o cuenta API de Anthropic. Si prefieres no usar el chat, el kit trae un asistente por terminal (sección "Sin Claude Code" de este archivo)
- Ábrela con el atajo de teclado o desde el panel lateral
- En el chat de Claude Code escribe: `/setup`

Claude te va a guiar paso a paso. Te ayudará a conseguir tu API key de OpenRouter y a guardarla en un archivo seguro del kit (la cuenta y la key son gratuitas; cargas unos 5 € de saldo tú mismo, pago único que te dura meses de uso normal) y se encarga del resto: instala dependencias, conecta tu WhatsApp, te abre el panel de control.

> **Windows**: instala también [Git for Windows](https://git-scm.com/download/win) — Claude Code necesita Bash en Windows. Solo es darle siguiente al instalador.

---

## Paso 3 · Personaliza tu agente con `/personaliza`

Cuando el bot ya esté conectado a WhatsApp, escribe en Claude Code: `/personaliza`

Te hará 9 preguntas sobre tu negocio (nombre, cliente ideal, qué vendes y a qué precio, cómo se cierra, tono...) y adaptará el agente para ti. Sin tocar archivos. Sin programar.

---

## Sin Claude Code: el asistente por terminal

Si no quieres usar Claude Code, el kit incluye un asistente que te guía desde la terminal. Antes de nada: necesitas **Node.js 20 o superior** instalado (gratis, descárgalo en https://nodejs.org).

Abre la Terminal (macOS) o PowerShell (Windows) en esta carpeta y ejecuta estos dos comandos, en orden:

```
npm install
```

Descarga las piezas que el kit necesita para funcionar. Solo hace falta la primera vez y tarda 1-2 minutos.

```
npm run wizard
```

Arranca el asistente: te pide tu API key de OpenRouter, conecta tu WhatsApp y te deja el agente funcionando.

---

## Si algo falla

Escribe en Claude Code: **"el bot no responde"** o **"tengo un error"**. Claude tiene contexto del kit y te ayudará a diagnosticar.

Si no usas Claude Code, vuelve a ejecutar `npm run wizard` (sección anterior): detecta lo que falta y te dice cómo arreglarlo.

---

## ¿Y luego?

Cuando tengas el bot funcionando en tu ordenador, el siguiente paso es desplegarlo a un servidor para que funcione 24/7. Escribe `/deploy` y te guío hasta Hostinger.

---

> Cualquier duda → pregúntala en la comunidad donde conseguiste el kit. Allí te ayudamos a aplicarlo a tu caso real.
