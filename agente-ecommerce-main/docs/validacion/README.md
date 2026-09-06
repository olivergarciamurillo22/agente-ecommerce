# Evidencia de validaciones

Extraído de `.validation/` (que a partir de la consolidación del 07-09-2026 está
en `.gitignore`: allí viven clones, `node_modules` y volcados que no deben
subirse). Aquí solo entran `.md`, `.log`, `.json` y `.png` que sirven como
evidencia de una validación real.

| Carpeta | Qué es |
|---|---|
| `winner-radar-2026-09-06/` | Validación del Winner Radar del 06-09-2026: informes (`WINNER-RADAR-*.md`), logs de build/typecheck/test/doctor/migración, respuestas de búsqueda y detalle (`*-search.json`, `*-details.json`) y capturas de la UI (búsqueda, producto 1-3, salidas). |

Dejado fuera a propósito: `winner-radar-live-search.json` (2,1 MB, volcado
crudo de la Ad Library — su resumen está en `winner-radar-search.json` y en
la captura `winner-radar-live-search.png`), los scripts `radar-*.cjs`, el
clon `winner-radar/` y `browser-tools/`, y el borrador
`platform-initial-draft-20260906/` (pertenece a platform-companies).
