# RUNBOOK DE PEDRO — el día a día de Casamable

Máximo 2 páginas. Sin jerga. Si algo de aquí no funciona como dice, es un bug:
apúntalo y díselo a Óliver.

## Tu rutina diaria (5 minutos)

1. Abre `agente.casamable.es`. La pestaña **Acciones** es lo primero que ves.
2. **Si está vacía y en verde: no tienes que hacer nada.** De verdad. Cierra.
3. Si hay elementos, van ordenados por urgencia. Cada uno te dice qué pasó y
   qué hacer. Trabaja de arriba a abajo:

| Insignia | Qué significa | Qué haces |
|---|---|---|
| **PIDE CANCELAR** | El cliente pidió cancelar y lo confirmó | Decide tú: anula en Shopify si procede y avísale. El agente NUNCA cancela solo |
| **POSIBLE DUPLICADO** | Dos pedidos que parecen el mismo | Compara, deja UNO vivo, cancela el otro en Shopify. Que no salgan los dos (~9,37 € el rehúse) |
| **INCIDENCIA ENVÍO** | El transportista reporta problema | Mira el panel del proveedor; escribe tú al cliente si hace falta (el bot no lo hace solo) |
| **HAY QUE LLAMAR** | No contestó al WhatsApp | Llámale tú, o deja que el agente de llamadas lo haga cuando esté encendido |
| **DIRECCIÓN NUEVA** | El cliente mandó otra dirección | Revísala en la ficha y cámbiala en Shopify si es válida |
| **ERROR PROVEEDOR** | Confirmado pero no puede ir al proveedor | Lee el motivo; si es mapping/pedido raro, mételo a mano en Dropi PRO |

4. Al terminar cada uno pulsa **"✓ Marcar resuelto"** y escribe una nota corta
   ("cancelado el 1103", "eran distintos, van los dos"). No borra nada: solo
   lo saca de tu bandeja.

## La pestaña Sistema (una mirada, no un estudio)

- **Verde**: sigue con tu vida.
- **Amarillo/rojo**: el propio mensaje te dice qué hacer (p. ej. "FALTA
  RETELL_API_KEY — pégala en el .env del NAS y reinicia"). Si el mensaje no
  te dice qué hacer, eso es un bug: apúntalo.

## Cosas que el agente NUNCA hace solo (para que duermas tranquilo)

- Cancelar pedidos (ni en Shopify ni en el proveedor).
- Escribir a un cliente por una incidencia de reparto.
- Llamar fuera de la franja legal o con el kill switch cerrado.
- Marcar nada como "entregado" porque Shopify diga "enviado".

## Si algo va mal

| Síntoma | Qué haces |
|---|---|
| No llegan pedidos nuevos al panel | Sistema → Shopify. Si habla de "firma inválida": el secreto del webhook está mal. `npm run shopify:doctor` en el NAS |
| No salen WhatsApps | Sistema → WhatsApp. Baileys: ¿pide QR? Escanéalo. Cloud API: ¿faltan credenciales? El mensaje lo dice |
| El bot dice cosas raras a un cliente | Abre Chats → esa conversación → botón **Tomar conversación** (modo HUMAN). El bot se calla y sigues tú |
| Emergencia total ("que pare TODO") | En el `.env` del NAS: `EMERGENCY_STOP=1` y reinicia el contenedor. Nada sale: ni WhatsApp, ni llamadas, ni tags |
| Reiniciar el contenedor | `docker compose restart` en el NAS. **Nunca entre las 10:00 y las 21:00** (corta WhatsApp). No se pierde nada: todo está en la base de datos |

## Reglas de oro del despliegue

1. Solo desplegar fuera de 10:00–21:00.
2. Tras desplegar: contenedor *healthy*, WhatsApp reconecta **sin pedir QR**,
   y la pestaña Sistema sin rojos nuevos.
3. Si algo se rompe justo después de desplegar: vuelve al commit anterior
   (`git checkout <commit anterior> && docker compose up -d --build`) y avisa
   a Óliver. No debugues en caliente a las 23:00.
