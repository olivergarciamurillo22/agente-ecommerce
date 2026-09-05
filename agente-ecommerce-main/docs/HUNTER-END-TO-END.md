# Hunter end-to-end V1

Pipeline auditable y fail-closed que conecta el Product Intelligence Engine existente con la viabilidad predictiva:

```text
DISCOVER → NORMALIZE → GROUP → FILTER → SNAPSHOT → MOMENTUM
         → PREDICTIVE ECONOMICS → PRELIMINARY VERDICT → SURFACE
```

No sustituye al Hunter de decisión, no concede score financiero final y no ejecuta compras, campañas, pedidos ni publicaciones.

## Uso

```text
npm run hunter:end-to-end -- --termino "juanetes" --pais ES --dias 14 --max-pages 2
npm run hunter:end-to-end -- --termino "juanetes" --sin-predictivo
npm run hunter:end-to-end -- --termino "juanetes" --json
npm run hunter:snapshot-refresh -- --termino "juanetes" --pais ES
```

El primer request conserva exactamente el término escrito. Solo después se añaden nombres observados y expansiones configuradas. El pack inicial vive en `config/hunter-search-terms/casamable-60-plus-es.json`; la lógica no contiene el nicho y puede cargar otro pack mediante código/configuración futura.

El smoke real es separado y exige consentimiento explícito:

```text
npm run hunter:smoke-real -- --confirmar-red-real juanetes
```

No se ejecuta desde `npm test`.

## Contratos de datos

- La respuesta cruda de Meta se conserva sanitizada en `rawProviderPayload`.
- El anuncio normalizado solo contiene campos observados. Ausencias permanecen como `undefined`.
- Los candidatos agrupan por anunciante (`page_id` preferente) y similitud conservadora del producto.
- Un cluster de confianza baja no absorbe otro producto.
- El ruido se marca con `noise` y `noiseReason`; no se borra del dataset.
- Las marcas grandes quedan con `candidateEligible=false`, pero se preservan como señal de mercado.
- Los snapshots son append-only.
- El primer snapshot produce `SIN_HISTORICO` y momentum numérico 0; nunca se fabrica un valor neutral.
- Economics predictivos siempre llevan `sourceType=ESTIMATED` y `decisionEligible=false`.

## Momentum

Se calcula únicamente desde el segundo snapshot. Se guardan:

- `deltaActiveAds`
- `deltaCreatives`
- `newAds`
- `removedAds`
- `oldAdsStillActive`
- `daysBetweenSnapshots`

Estados: `STRONG_GROWTH`, `GROWTH`, `STABLE`, `DECLINING` y `SIN_HISTORICO`.

`STRONG_GROWTH` requiere al menos cinco anuncios activos, crecimiento de dos anuncios, dos creatividades nuevas y anuncios antiguos todavía activos. La longevidad aislada nunca equivale a ganador.

## Economics predictivo

Los proveedores admitidos son:

- API configurable mediante `HUNTER_PREDICTIVE_SEARCH_SOURCE=api`.
- Scraping público opt-in mediante `HUNTER_PREDICTIVE_SEARCH_SOURCE=scraping_publico`.
- Off por defecto.

El scraping consulta AliExpress, 1688 y Alibaba con un User-Agent identificable, timeout de siete segundos y un solo reintento. HTTP 401/403/429, captcha, login, timeout o ausencia de precios EUR se registran como no disponibles. No se evaden bloqueos.

Cada precio conserva URL, fuente, cantidad, peso conocido y fecha. Una fuente produce confianza `LOW`; dos o tres producen `MEDIUM`; nunca `HIGH`. La estimación caduca conceptualmente a los 30 días y el run guarda su momento de consulta.

El veredicto preliminar aplica costes logísticos ya conocidos únicamente cuando existe peso:

- `DESCARTAR`: ni el mejor caso deja contribución positiva.
- `INVESTIGAR`: el rango cruza una zona insuficiente o incierta.
- `CANDIDATO_FUERTE`: incluso el escenario conservador deja al menos 8 EUR.

Sin coste, PVP o peso, el veredicto es `null`.

## API y dashboard

Se amplía el endpoint existente `POST /api/product-intelligence` con:

```json
{
  "action": "end-to-end",
  "query": "juanetes",
  "country": "ES",
  "predictive": true
}
```

No se creó una API paralela. El panel Productos muestra advertiser, anuncios activos, antigüedad, momentum, ruido, coste/PVP estimados, veredicto y ruta de descubrimiento. `ESTIMATED` y `SIN_DATOS` se muestran explícitamente.

## Persistencia y observabilidad

Se reutiliza la persistencia atómica JSON de Oliver:

- sesiones: `product-intelligence.json`
- snapshots/señales: `product-intelligence-state.json`
- runs end-to-end: `hunter-pipeline-runs.json`

Cada run registra identificador, inicio, duración, queries, llamadas Meta, anuncios únicos, grupos, candidatos, ruido, llamadas predictivas, enriquecimientos, errores y cabeceras de uso disponibles.

## Seguridad

- `AUTO_HUNT_ENABLED=false` sigue siendo el valor seguro.
- No existe cron ni loop permanente.
- La API no ejecuta el pipeline si Meta no figura conectado.
- Los fallos de Meta o proveedores se devuelven como datos ausentes/errores sanitizados.
- El Hunter de decisión continúa cerrado ante estimaciones.

