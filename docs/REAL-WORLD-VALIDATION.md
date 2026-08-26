# REAL-WORLD VALIDATION — lo que el local NO puede demostrar

`npm run readiness` en verde significa **LOCAL READY**: el código compila,
493 tests pasan, los 10 flujos operativos funcionan contra una DB desechable
y el entorno local no tiene peligros. Nada de eso demuestra que:

1. **El WhatsApp llegue de verdad** — solo el piloto (número de Pedro en
   allowlist, TEST_MODE activo) lo demuestra.
2. **La plantilla de Meta esté aprobada** en la WABA real — Meta tarda y las
   plantillas no se transfieren entre WABAs.
3. **La llamada de Retell suene y hable bien** — shadow primero, transcripciones
   revisadas, después allowlist, después el mundo.
4. **Dropea acepte la key real y firme los webhooks** — `npm run dropea:doctor`
   EN el NAS.
5. **El backfill cubra todo el histórico** — scope `read_all_orders` verificado
   con `coverage` completo, EN el NAS.
6. **El contenedor sobreviva su entorno real** — volumen montado, backups
   corriendo, WhatsApp reconectando sin QR tras reinicio.

**El orden del piloto real** (cada paso valida el anterior):

    deploy fuera de franja → healthy + sin QR → shopify:webhooks --ensure
    → pedido de PRUEBA de Pedro → WhatsApp le llega → responde "1"
    → confirmado en panel → Acciones vacía → backfill → dropea:doctor
    → shadow de llamadas 1 semana → revisar transcripciones → allowlist real

Los pasos concretos con comandos están en `docs/ESTADO-PRODUCCION.md` § 9 y
`docs/PEDRO-NAS-TODO.md`. Este documento existe para una sola cosa: que nadie
confunda "todo verde en el Mac de Óliver" con "funciona para los clientes".
