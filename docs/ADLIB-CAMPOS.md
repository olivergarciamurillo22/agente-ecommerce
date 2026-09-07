# Campos comprobados de Meta Ad Library

Referencia de contrato: endpoint oficial `/{version}/ads_archive` de Meta.
La documentacion oficial no fue accesible desde el entorno de desarrollo
(respondio 429), por lo que la lista se valida ademas campo a campo con la
cuenta de Casamable y no se da por funcional solo por estar documentada.

| Campo | Estado con esta cuenta | Nota |
|---|---|---|
| `id`, `page_id`, `ad_snapshot_url`, fechas de entrega | No verificable con el token local | HTTP 401, Graph code 190: la sesion expiro el 02-09-2026. La spec indica que los minimos respondieron con otro token probado en vivo. |
| `ad_creative_bodies`, `ad_creative_link_captions`, `ad_creative_link_titles` | No verificable con el token local | Mismo HTTP 401 / code 190; no se atribuye soporte sin una nueva sonda. |
| `page_name`, `publisher_platforms`, `languages` | No verificable con el token local | Mismo HTTP 401 / code 190. |
| `impressions`, `estimated_audience_size` | No verificable con el token local | Mismo HTTP 401 / code 190; ademas pueden estar restringidos por categoria. |

Desde el 07-09-2026 la lista tiene 15 campos: se anadio `ad_creative_link_descriptions`
(texto de la seccion de llamada a la accion) para el auditor de tiendas; sin verificar
aun con esta cuenta, como el resto.

Sonda ejecutada el 05-09-2026 con `hunter:discovery:doctor`: los 14 campos de entonces
recibieron el mismo error de token caducado, no un error especifico de campo.
Hace falta renovar `META_AD_LIBRARY_ACCESS_TOKEN` y repetirla. El motor prueba
los campos por separado; un opcional que falle se retira de la consulta sin
invalidar los que si respondan.
