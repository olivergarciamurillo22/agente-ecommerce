# Hunter predictivo integrado

El tramo predictivo enriquece candidatos de Product Intelligence con evidencia mayorista y minorista. No altera el Opportunity Score como si la estimación fuese un hecho y nunca habilita la decisión final.

- Fuente por defecto: `off`.
- Fuentes opcionales: API configurable o scraping público.
- Rango: mínimo, máximo y probable.
- Confianza: `LOW`, `MEDIUM` o `SIN_DATOS`; nunca `HIGH` para scraping público.
- Evidencia: URL y timestamp obligatorios.
- Fallos: estado no disponible; nunca valor inventado.
- Resultado: `sourceType=ESTIMATED` y `decisionEligible=false`.

El veredicto preliminar requiere coste a 500 unidades, PVP observado y peso logístico. Si falta cualquiera, devuelve `null`.

