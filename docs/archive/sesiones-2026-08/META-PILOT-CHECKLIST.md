> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

# Checklist del día del piloto — WhatsApp Cloud API

> Actualizada el 26-08-2026 tras T1: **el primer mensaje a un cliente nuevo
> sale como PLANTILLA** (está siempre fuera de la ventana de 24 h porque
> nunca escribió). Los interactivos con botones llegan DESPUÉS de que
> responda. Fuera de 10:00–21:00. **Coexistence NO se toca hoy.**

## Antes de encender

1. [ ] Backup: `docker compose exec casamable-agent npm run backup`
2. [ ] `npm run db:health` → esquema **10**, integridad ok
3. [ ] Confirmar que el proveedor sigue en Baileys (`WHATSAPP_PROVIDER` sin tocar aún)
4. [ ] Plantilla `order_confirmation_request` **APPROVED** en WhatsApp Manager (y verificar que es **UTILITY** — el catálogo local declara la intención, no la aprobación)
5. [ ] Cloud API apuntando SOLO al número de prueba (Phone Number ID del número de test)
6. [ ] `TEST_MODE=1` y solo Pedro/Óliver en `TEST_PHONE_ALLOWLIST`

## Encender

7. [ ] `.env`: `WHATSAPP_PROVIDER=cloud_api` + `META_WHATSAPP_API_ENABLED=1` → reiniciar. El log debe decir "Baileys NO se arranca"

## Probar

8. [ ] Crear pedido de prueba al móvil de Pedro
9. [ ] **El primer mensaje llega como PLANTILLA** (con botones de plantilla). En la cola de envíos: `message_type=template`, `template_name=order_confirmation_request`
10. [ ] Pedro responde cualquier cosa → la ventana de 24 h se abre
11. [ ] Los siguientes mensajes ya pueden ser **interactivos** normales
12. [ ] Crear segundo pedido → ahora sí llega el interactivo (dentro de ventana) → **✅ Confirmar** → panel `confirmed`
13. [ ] Botón **📍 Cambiar dirección** → escribir dirección → `proposed_address`
14. [ ] Botón **📝 Dejar nota** → escribir nota → guardada
15. [ ] Cola de envíos: **entregado** marca; ⚠️ **leído puede no llegar** (en coexistencia las confirmaciones de lectura se desactivan — validar hasta `delivered` basta)
16. [ ] Escribir "CANCELAR nnnn" → pedido con insignia PIDE CANCELAR

## Salir

17. [ ] Rollback: `WHATSAPP_PROVIDER=baileys` → reiniciar → WhatsApp de siempre (si pide QR, escanear del panel)
18. [ ] Comprobar que NO hay mensajes duplicados en la conversación de prueba ni filas raras en la cola

## Si algo falla

- El error de la cola lleva el código de Meta (`[code 131047]…`) — copiarlo entero para Óliver.
- `template_not_configured_outside_window` = falta plantilla aprobada para ese mensaje.
- Nada de esto toca clientes reales: `TEST_MODE=1` + allowlist lo impiden en tres capas.
