# Ensayo de migración v4.3

## 1 · Ensayo sintético (`scripts/test-migration-v43.ts`)

Crea una SQLite temporal en schema 17 con 116 pedidos, 63 conversaciones, 349 mensajes, 180 elementos de outbox y 1.700 eventos de integración.

Aplica las migraciones 18→27 (`migrateWorkspaceAuth`, `migrateProductCandidates`, `migrateHunterPredictive`, `migrateHunterDiscovery`, `migrateAddressValidation`, `migrateAutoDispatch`, `migrateDispatchChannels`, `migrateAiCancellations`, `migrateDispatchNotice`, `migrateAiCallLog`) **dos veces** (idempotencia), exige `PRAGMA integrity_check = ok`, conserva exactamente todos los recuentos y comprueba que existen las tablas nuevas (`users`, `sessions`, `audit_log`, `product_candidates`, `candidate_events`, `hunter_predictive_estimates`, `adlib_*`, `address_validations`, `address_alerts`, `dispatch_cooldowns`, `intent_classifications`, `dispatch_channels`, `ai_cancellations`). La base temporal se elimina al terminar y nunca abre la base de producción.

La duración se muestra en cada ejecución porque depende del disco y del host; no se fija un número histórico como si fuera una garantía de producción.

## 2 · Verificación sobre una COPIA real (`npm run migration:verify`, 07-09-2026)

Cuando Pedro traiga una copia de `messages.db` del NAS, comprobar que migra limpia es **un solo comando**:

```
npm run migration:verify -- --db C:\ruta\a\la\copia\messages.db
npm run migration:verify -- --db ... --json     # informe en JSON
npm run migration:verify -- --db ... --keep     # conserva la copia migrada para inspeccionarla
```

Qué hace (`scripts/migration-verify.ts`):

1. **Copia** el fichero a un directorio temporal. El original **no se abre nunca** (el test de la suite comprueba el sha256 antes y después).
2. Fotografía la copia: `user_version`, `integrity_check`, recuento por tabla.
3. Abre la copia con el **`build()` real** de `src/lib/db.ts` en un proceso hijo (con `DATA_DIR` apuntando al temporal): es exactamente la ruta que ejecuta producción al arrancar, incluida la guarda `assertSchemaNotNewer` (una base «del futuro», p. ej. `user_version` 1020 de `platform-companies`, se rechaza y el comando sale con 1).
4. Vuelve a fotografiar: tablas añadidas, recuentos que cambiaron, `integrity_check`, tiempo.
5. Sale con 0 si `user_version` final = `SCHEMA_VERSION`, integridad ok y ningún recuento existente cambió; con 1 en cualquier otro caso.

Prueba de humo sin datos reales: `npm run migration:verify -- --fixture` construye un fixture realista en schema 17 (116 pedidos, 63 conversaciones, 349 mensajes, creados con el código real y rebajados a 17) y lo pasa por el mismo camino. Resultado esperado: `user_version 17 → 27`, `integrity ok → ok`, +18 tablas, recuentos intactos.

**Límite explícito:** ni el fixture ni la suite sustituyen la prueba con una copia real del NAS. Solo una copia real tiene los datos, las filas raras y los tamaños de producción. Esa prueba sigue pendiente hasta que Pedro facilite la copia; la herramienta existe para que dure un minuto cuando llegue.
