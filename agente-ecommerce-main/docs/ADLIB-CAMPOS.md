# Auditoría real de campos de Meta Ad Library

**Fecha:** 5 de septiembre de 2026  
**Query controlada:** `juanetes`  
**País:** ES  
**API configurada:** Graph v26.0

## Resultado

El encargo informa de que la app Casamable Agente ya obtuvo capacidad de Ad Library. Sin embargo, la credencial presente en el entorno local caducó el 2 de septiembre de 2026. Meta respondió HTTP 401, Graph code 190, en todas las consultas controladas. Esto demuestra un problema de credencial local, no permite concluir que la aprobación de la app haya desaparecido.

| Campo | Resultado real | Ejemplo sanitizado | Uso previsto |
| --- | --- | --- | --- |
| `id` | ERROR 401/190 | Sin dato | deduplicación |
| `page_id` | ERROR 401/190 | Sin dato | advertiser estable |
| `page_name` | ERROR 401/190 | Sin dato | presentación |
| `ad_snapshot_url` | ERROR 401/190 | Sin dato | trazabilidad |
| `ad_delivery_start_time` | ERROR 401/190 | Sin dato | longevidad |
| `ad_delivery_stop_time` | ERROR 401/190 | Sin dato | actividad |
| `ad_creative_bodies` | ERROR 401/190 | Sin dato | clustering/señal |
| `ad_creative_link_captions` | ERROR 401/190 | Sin dato | clustering/señal |
| `ad_creative_link_titles` | ERROR 401/190 | Sin dato | nombre candidato |
| `publisher_platforms` | ERROR 401/190 | Sin dato | contexto |
| `languages` | ERROR 401/190 | Sin dato | contexto |
| `impressions` | ERROR 401/190 | Sin dato | opcional; no se infiere |
| `estimated_audience_size` | ERROR 401/190 | Sin dato | ruido opcional |

Clasificación total:

- AVAILABLE: 0
- EMPTY: 0
- NOT_AVAILABLE: 0
- ERROR: 13

No se ha registrado el token, cabeceras de autorización ni payload sensible.

## Próximo intento

1. Generar un token nuevo para la app ya autorizada.
2. Sustituir solamente `META_AD_LIBRARY_ACCESS_TOKEN` en el entorno ignorado.
3. Ejecutar `npm run hunter:smoke-real -- --confirmar-red-real juanetes`.
4. No activar Auto Hunt.
5. Actualizar esta tabla con `AVAILABLE`, `EMPTY`, `NOT_AVAILABLE` o `ERROR` para cada campo.

Un campo que falle no bloquea los demás: el doctor los consulta de forma independiente.

