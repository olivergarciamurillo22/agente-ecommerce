# Checklist del día del piloto — WhatsApp Cloud API

> Imprimible. Todo lo demás está en `PEDRO-META-WHATSAPP-SETUP.md` (alta) y
> `META-WHATSAPP-MIGRATION.md` (arquitectura). Fuera de 10:00–21:00.

## Antes de tocar nada

- [ ] Backup: `docker compose exec casamable-agent npm run backup`
- [ ] Credenciales de Meta en el `.env` del NAS (5 variables, paso 3-4 de la guía)
- [ ] Webhook verificado en Meta (el panel dice "webhook vivo" tras el primer evento)
- [ ] Las 6 plantillas en estado **APPROVED** en WhatsApp Manager
- [ ] `TEST_MODE=1` y **solo** el móvil de Pedro en `TEST_PHONE_ALLOWLIST`

## Encender

- [ ] `.env`: `WHATSAPP_PROVIDER=cloud_api`
- [ ] Reiniciar contenedor → el log debe decir "Baileys NO se arranca; entrega por API oficial"
- [ ] Panel → Sistema → WhatsApp: "API oficial de Meta configurada", sin hablar de QR

## Probar (con el móvil de Pedro)

- [ ] Pedido de prueba → llega el mensaje **con 3 botones**
- [ ] **✅ Confirmar** → panel: `confirmed` · llega "¡Pedido confirmado!"
- [ ] Segundo pedido → **📍 Cambiar dirección** → escribir una dirección → aparece en `proposed_address`
- [ ] Tercer pedido → **📝 Dejar nota** → escribir la nota → guardada, pide 1/2
- [ ] Escribir "CANCELAR nnnn" → pedido a "pendiente de llamada" con insignia PIDE CANCELAR
- [ ] Cola de envíos: los mensajes marcan **entregado** y **leído** (webhook de estados vivo)
- [ ] Mandar una nota de voz → queda registrada en Chats, nada se rompe
- [ ] Esperar >5 min sin escribir y crear otro pedido → sale igualmente (dentro de ventana)

## Si algo va mal

- [ ] `.env`: `WHATSAPP_PROVIDER=baileys` → reiniciar → todo vuelve a hoy
- [ ] Si Baileys pide QR (puede pasar tras el alta de coexistencia): escanear desde el panel
- [ ] Los mensajes pendientes NO se pierden: el loop de Baileys manda su texto de fallback
- [ ] Anotar el error exacto de la cola de envíos (lleva el código de Meta) y mandárselo a Óliver

## Qué NO hacer hoy

- Clientes reales (TEST_MODE=1 se queda puesto)
- Borrar `auth/` de Baileys
- Tocar plantillas aprobadas
