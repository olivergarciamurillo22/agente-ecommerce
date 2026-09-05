# Hunter Discovery integrado

El descubrimiento reutiliza el Product Intelligence Engine de Oliver. No existe un segundo catálogo ni una API paralela.

Responsabilidades:

- buscar la root exacta primero;
- expandir queries después;
- normalizar respuestas sanitizadas;
- agrupar por advertiser y producto;
- marcar ruido sin eliminar evidencia;
- persistir snapshots append-only;
- calcular momentum únicamente con historial.

El pack inicial `CASAMABLE_60_PLUS_ES` está en `config/hunter-search-terms/casamable-60-plus-es.json`. Auto Hunt permanente permanece apagado.

Véase `HUNTER-END-TO-END.md` y `HUNTER-REAL-DATA-AUDIT.md`.

