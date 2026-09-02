> **ARCHIVED — KIT ORIGINAL.** Documentación del kit genérico del que nació
> este repo. El proyecto real es el Casamable Control Center: fuente de
> verdad en `docs/README.md`. Conservado porque las skills /setup y
> /personaliza aún lo referencian.

# 02 · Conectar tu WhatsApp

El agente se conecta a WhatsApp como si fueras a `web.whatsapp.com` — escaneando un código QR.

## Antes de empezar

> **⚠️ MUY IMPORTANTE**: usa un número de WhatsApp del **negocio**, no tu personal. El móvil quedará vinculado al bot. Si ahora mismo no tienes un número aparte, plantéate comprar una segunda SIM (10€/mes) o usar un número virtual como TextNow.

## Configurar la API key de OpenRouter

1. Crea cuenta en https://openrouter.ai si no tienes
2. Ve a https://openrouter.ai/keys y crea una API key nueva
3. Cárgale 5€ en saldo (panel `Credits`). Sin saldo, el agente NO funcionará en producción
4. Copia el `.env.example` a `.env.local`:

### macOS / Linux
```
cp .env.example .env.local
```

### Windows (PowerShell)
```
Copy-Item .env.example .env.local
```

5. Abre `.env.local` en VS Code y pega tu API key donde dice `OPENROUTER_API_KEY=`

## Arrancar el bot + dashboard

En la terminal del proyecto, compila primero el panel. Solo hace falta la primera vez y cuando cambies el código, y tarda alrededor de un minuto:

```
npm run build
```

Este paso es obligatorio: `start:all` arranca el panel en modo producción y, sin un build previo, se para con el error "Could not find a production build". Cuando termine, arranca todo:

```
npm run start:all
```

Verás dos colores de logs entrelazados (BOT amarillo, WEB cian). El bot tarda unos segundos en arrancar.

Alternativa sin compilar: abre dos terminales y ejecuta `npm run start:bot` (solo el bot) en una y `npm run dev` (el panel en modo desarrollo, no necesita build) en la otra.

## Abrir el dashboard

Abre el navegador en: http://localhost:3000

Verás un **código QR**.

## Escanear el QR desde el móvil

1. Abre WhatsApp en el móvil del **negocio**
2. `Configuración → Dispositivos vinculados`
3. Pulsa **Vincular un dispositivo**
4. Escanea el QR de tu pantalla

Cuando conecte, el dashboard cambiará automáticamente a la vista de conversaciones.

## Probarlo

Desde **otro WhatsApp** (el de un compañero, o un segundo número), escribe "hola" al número que acabas de conectar. En 2-5 segundos verás que el agente responde con un mensaje genérico.

¡Funciona! 🎉

## Si algo falla

| Síntoma | Solución |
|---|---|
| El QR no aparece (queda cargando) | Espera 30 segundos. Si persiste, recarga la página. Si sigue, ejecuta `npm run doctor` |
| El QR aparece pero al escanear, el móvil dice "no se pudo vincular" | Asegúrate de que tu móvil tiene buena conexión a internet. Vuelve a generar QR recargando la página del navegador |
| Conecta pero el bot no responde a "hola" | Comprueba que `OPENROUTER_API_KEY` está en `.env.local` y es válida. Reinicia con Ctrl+C y `npm run start:all` |
| Sale "error 440" en el log | Ya está mitigado en el kit. Si aparece, ejecuta `npm run doctor`. Probablemente sea un dispositivo viejo vinculado en tu WhatsApp |

## Siguiente paso

Sigue a [03-personalizar-prompt.md](03-personalizar-prompt.md) para adaptar el agente a tu negocio.
