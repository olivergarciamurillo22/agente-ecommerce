> ⚠️ **DESACTUALIZADO — corregido el 26-08-2026 con datos verificados en el
> alta real.** Dos afirmaciones de este documento resultaron falsas:
>
> 1. **Coexistence SÍ está disponible en la UE** desde octubre de 2025
>    (mundial desde mayo de 2026). España está soportada — el alta de
>    Casamable se hizo el 25-08-2026.
> 2. **NO hace falta un BSP**: se puede hacer directo con app propia de Meta
>    + Embedded Signup + Webhook Override, que es exactamente como se hizo.
>
> **Lo vigente, en corto** (provenance: guías de integradores 2026 +
> verificación propia en el alta del 25-08; lo marcado *third-party* no está
> confirmado con documento first-party de Meta):
>
> - **Cloud API directa YA está en uso** con el número de PRUEBAS: webhook
>   verificado con un evento real (first-party: lo vimos nosotros).
> - **Coexistence** permitiría conservar el número real de Pedro con la app
>   del móvil funcionando (third-party: pendiente de verlo en el Embedded
>   Signup real).
> - ⚠️ **Baileys es un dispositivo companion y el alta de coexistencia
>   desvincula los companions** (third-party): la sesión de producción puede
>   caerse y pedir QR. Por eso coexistencia es un PASO OPERACIONAL SENSIBLE
>   que **no se ejecuta hasta que el piloto de Cloud API esté limpio** — con
>   el piloto validado, quedarse sin Baileys unos minutos es molesto; sin
>   piloto, es quedarse sin canal.
> - La elección de importar historial (≤6 meses) es **única e irreversible**
>   (third-party).
>
> La referencia vigente es `docs/META-WHATSAPP-MIGRATION.md` (arquitectura y
> políticas) y `docs/PEDRO-META-WHATSAPP-SETUP.md` (el alta paso a paso).
> Este archivo se conserva por el contexto histórico de la decisión.

# 11 · WhatsApp Coexistence (API oficial + app a la vez)

> Investigado el 2026-06-02 a raíz de una duda de un alumno: un vídeo de YouTube
> decía que Meta había sacado la opción de tener WhatsApp Business y la API oficial
> conviviendo en el mismo número, "desde YCloud". **Es verdad.** Aquí está lo que hay
> que saber, y cómo encaja (o no) con este kit.

## Qué es

Función **oficial de Meta**, lanzada el **6 de mayo de 2025**. Permite usar la **app de
WhatsApp Business** (la del móvil) y la **WhatsApp Cloud API** sobre el **mismo número, a
la vez**, sin perder contactos ni historial de chats.

- Los mensajes se **espejan en ambos lados** en tiempo real (Meta lo llama *Messaging
  Echoes*, vía webhooks): lo que respondes a mano desde el móvil aparece en la API, y lo
  que envía la API/un bot aparece en la app.
- Antes esto era imposible: o tenías el número en la app, o lo migrabas a la API y perdías
  el chat normal. Ahora **conviven**. Ese es el avance real.

## YCloud y otros BSP

**YCloud existe y es legítimo**: es un **BSP oficial** de WhatsApp (proveedor autorizado
por Meta, ISO 27001). No se inventan nada — son una de las plataformas que ofrece activar
Coexistence. Hay muchas otras: 360Dialog, Wati, respond.io, HighLevel, etc. La activación
**siempre se hace a través de un BSP** (no lo haces tú solo), escaneando un QR.

## ⚠️ Lo más importante: NO disponible en la UE

Coexistence **NO está disponible en la Unión Europea, EEE ni Reino Unido** (regulación /
GDPR). Tampoco en Australia, Japón, Nigeria, Filipinas, Rusia, Corea del Sur, Sudáfrica ni
Turquía.

**Si el número es español (+34) o de cualquier país de la UE, HOY no se puede activar**,
por mucho que YCloud u otro BSP lo anuncie. Vigilar si Meta lo abre en la UE más adelante.

## Letra pequeña

- **Precio**: lo enviado desde la app del móvil sigue gratis. Lo enviado por la API se cobra
  según la tarifa por conversación de Meta (varía por país y tipo de mensaje).
- **Requisitos**: app WhatsApp Business v2.24.17+, número con actividad reciente (si es nuevo,
  Meta puede rechazarlo), embedded signup vía BSP, escaneo de QR.
- **Funciones que se pierden** en chats 1:1: editar/borrar mensajes, mensajes temporales,
  confirmaciones de lectura, ubicación en vivo; las listas de difusión quedan en solo lectura.
  **No hay grupos, ni llamadas, ni catálogos/pedidos** por la vía API.

## Cómo encaja con este kit

Este kit va por **Baileys** (WhatsApp Web no oficial). Coexistence es la vía **oficial**. Son
caminos distintos:

| | **Este kit (Baileys)** | **Coexistence (API oficial)** |
|---|---|---|
| Tecnología | WhatsApp Web no oficial | API oficial de Meta |
| Coste | Gratis | Mensajes API se pagan |
| Riesgo | Zona gris en los ToS | 100% aprobado por Meta |
| En la UE | Funciona | **Bloqueado hoy** |
| Montaje | El propio usuario, 15 min | Vía BSP, con verificación |

**Recomendación**: para aprender, probar y dar servicio con el agente IA → seguir con el kit
(Baileys). Para outbound masivo legal y serio → API oficial (ver también `docs/07` sección de
riesgo de ban). Coexistence es la mejor cara de la API oficial el día que esté disponible en la UE.

## Fuentes

- [What is WhatsApp Business App Coexistence? — YCloud](https://www.ycloud.com/blog/whatsapp-business-app-coexistence-meta-update)
- [Enable WhatsApp Business App Coexistence — YCloud](https://www.ycloud.com/whatsapp-business-app-coexistence)
- [Multi-solution conversations — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/multi-solution-conversations/)
- [WhatsApp Coexistence — 360Dialog Docs](https://docs.360dialog.com/docs/resources/phone-numbers/coexistence)
- [WhatsApp Coexistence: qué es y cómo activarlo — Clientify](https://clientify.com/en/blog/communication/whatsapp-coexistence)
