# Mapa de deuda técnica del Hunter

## BLOCKER

- Renovar `META_AD_LIBRARY_ACCESS_TOKEN`. La credencial local caducó el 2 de septiembre y devuelve HTTP 401 / Graph 190.
- Obtener una primera captura real antes de calibrar clustering, ruido, momentum u Opportunity Score.

## IMPORTANT

- Auditar qué campos funcionan con el token renovado; una petición combinada puede fallar si Meta rechaza un campo opcional.
- Incorporar una fuente real de PVP observada. Meta Ad Library no garantiza precio y `ad_snapshot_url` no debe tratarse como landing comercial.
- Confirmar pesos o dimensiones para poder aplicar costes logísticos sin inventarlos.
- Revisar el clustering con anuncios reales: hoy prioriza `page_id` y similitud léxica conservadora.
- Migrar el almacenamiento JSON si el volumen real deja de ser bounded; por ahora conserva locks, backups y escritura atómica.

## LATER

- Indexar fingerprints si el clustering cuadrático supera el presupuesto medido.
- Permitir selección dinámica de packs de términos desde CLI/API.
- Añadir retención configurable de runs y snapshots después de medir crecimiento real.
- Mejorar la presentación del historial en el panel.
- Evaluar una cola de trabajo controlada antes de cualquier ejecución recurrente.

No se activa Auto Hunt 24/7 mientras exista cualquiera de los blockers de datos reales.

