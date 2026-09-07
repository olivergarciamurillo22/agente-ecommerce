# Ensayo de migración v4.3

`scripts/test-migration-v43.ts` crea una SQLite temporal en schema 17 con 116 pedidos, 63 conversaciones, 349 mensajes, 180 elementos de outbox y 1.700 eventos de integración.

El ensayo aplica las migraciones 18 y 19 dos veces, exige `PRAGMA integrity_check = ok`, conserva exactamente todos los recuentos y comprueba las tablas `users`, `sessions`, `audit_log`, `product_candidates` y `candidate_events`. La base temporal se elimina al terminar y nunca abre la base de producción.

La duración se muestra en cada ejecución porque depende del disco y del host; no se fija un número histórico como si fuera una garantía de producción.
