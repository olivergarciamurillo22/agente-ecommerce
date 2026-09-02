> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

# Guía para Pedro — dar de alta WhatsApp oficial (Cloud API de Meta)

> Paso a paso, sin tecnicismos. Nada de esto lo hace el código solo: hace
> falta que TÚ entres en Meta con tu cuenta. Hazlo con Óliver a mano
> (llamada o pantalla compartida), sobre todo el paso 4.
>
> ⚠️ **Regla de oro: no confirmes nada dentro de Meta que hable de
> "transferir" o "migrar" el número sin leerlo con Óliver.** Lo que queremos
> es COEXISTENCIA: la app de tu móvil sigue funcionando Y ADEMÁS el sistema
> puede usar el número. Hay otra modalidad que desconecta la app — esa NO.

## Qué vas a conseguir

- Tu número de siempre, funcionando igual en tu móvil.
- El sistema manda mensajes con **botones de verdad** (el cliente pulsa
  "✅ Confirmar pedido" en vez de escribir "1").
- Sabemos si cada mensaje se **entregó** y se **leyó**.
- Se acaba el QR y los sustos de "WhatsApp desconectado".

## Antes de empezar (5 minutos)

1. Actualiza **WhatsApp Business** en tu móvil (Play Store/App Store).
   Hace falta una versión reciente.
2. Ten a mano el acceso a tu cuenta de **Facebook/Meta de empresa**.
3. Avisa a Óliver para hacerlo juntos.

## Paso 1 · Entrar en Meta for Developers

1. Ve a **developers.facebook.com** y entra con tu cuenta de Meta.
2. "Mis apps" → **Crear app** → tipo **Empresa/Business**.
3. Nombre: por ejemplo `Casamable Agente`. Vincúlala a tu **portfolio de
   empresa** (Business Manager) de Casamable. Si no tienes portfolio, el
   asistente te lo crea.

## Paso 2 · Añadir WhatsApp a la app

1. Dentro de la app: **Añadir producto → WhatsApp → Configurar**.
2. Meta te preguntará qué número usar. **AQUÍ está lo importante:** elige la
   opción de usar tu número **existente** de WhatsApp Business
   ("coexistencia" / "usar el número de la app"). Te pedirá **escanear un
   QR desde tu móvil** (WhatsApp Business → Ajustes → Dispositivos
   vinculados, o el flujo que te indique).
3. Te preguntará si quieres **importar el historial de chats** (hasta 6
   meses) o empezar de cero. **Esta elección no se puede cambiar después**
   — decididla juntos. Recomendación: importar.

## Paso 3 · Copiar los identificadores

En la configuración de WhatsApp de la app verás estos datos. Cópialos TODOS
en un mensaje **a Óliver por un canal privado** (nunca en un chat público):

| Qué buscar en pantalla | Dónde va |
|---|---|
| **Phone number ID** | `META_WHATSAPP_PHONE_NUMBER_ID` |
| **WhatsApp Business Account ID** | `META_WHATSAPP_BUSINESS_ACCOUNT_ID` |
| **App ID** y **App Secret** (en Ajustes de la app → Básico) | `META_WHATSAPP_APP_SECRET` (el secret) |
| **Token de acceso permanente** (se crea un "usuario del sistema" en el Business Manager con permiso whatsapp_business_messaging — Óliver te guía) | `META_WHATSAPP_ACCESS_TOKEN` |

⚠️ El token temporal que enseña la pantalla de pruebas caduca en 24 h. Para
producción hace falta el permanente (usuario del sistema).

## Paso 4 · Guardarlos en el NAS

En el `.env` del NAS (como siempre, nunca en Git ni en chats):

```
META_WHATSAPP_API_ENABLED=1
META_WHATSAPP_PHONE_NUMBER_ID=(lo copiado)
META_WHATSAPP_BUSINESS_ACCOUNT_ID=(lo copiado)
META_WHATSAPP_ACCESS_TOKEN=(el token permanente)
META_WHATSAPP_APP_SECRET=(el app secret)
META_WHATSAPP_VERIFY_TOKEN=(inventa una contraseña larga cualquiera)
```

`WHATSAPP_PROVIDER` se queda en `baileys` de momento: configurar Meta no
cambia nada del funcionamiento hasta que se decida el piloto.

## Paso 5 · Configurar el webhook

En la app de Meta → WhatsApp → **Configuration → Webhook**:

- **Callback URL:** `https://agente.casamable.es/api/webhooks/whatsapp`
- **Verify token:** exactamente el mismo que pusiste en
  `META_WHATSAPP_VERIFY_TOKEN`
- Pulsa **Verificar y guardar** (el sistema responde solo si el token
  coincide).
- En **Webhook fields**, suscribe: `messages`.

## Paso 6 · Crear las plantillas

En **WhatsApp Manager → Plantillas de mensaje**, crear las 6 de
`config/whatsapp-templates.json` (Óliver te pasa los textos uno a uno),
categoría **Utility**, idioma **Español**. Meta tarda de minutos a horas en
aprobarlas. Sin plantillas aprobadas el sistema no puede escribir a nadie
que lleve más de 24 h sin contestar.

## Paso 7 · Probar con tu teléfono (piloto)

Cuando Óliver lo diga:

1. En el `.env` del NAS: `WHATSAPP_PROVIDER=cloud_api` (con `TEST_MODE=1` y
   tu móvil en la allowlist, como siempre).
2. Reiniciar el contenedor **fuera de 10:00–21:00**.
3. Se crea un pedido de prueba a tu número → te llega el mensaje **con
   botones**. Pulsa "Confirmar" → el panel debe marcarlo confirmado.
   Se repite con "Cambiar dirección" y "Dejar nota".
4. En el panel → Sistema → WhatsApp verás "API oficial de Meta" y los
   estados entregado/leído.

## Cómo volver atrás en cualquier momento

En el `.env`: `WHATSAPP_PROVIDER=baileys` y reiniciar el contenedor. Todo
vuelve a funcionar como hoy. Si Baileys pidiera QR (puede pasar tras
vincular la coexistencia), se escanea desde el panel como siempre.

## Recuerda a partir de entonces

- **Abre WhatsApp Business en tu móvil al menos una vez cada 14 días** — si
  no, Meta corta la conexión de la API hasta que vuelvas a abrirla.
- No borres la app del móvil ni cambies de teléfono sin avisar a Óliver.
