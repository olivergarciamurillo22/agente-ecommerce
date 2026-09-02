# Winning Product Intelligence Engine

Implementación inicial aislada del brief `CODEX_PRODUCT_INTELLIGENCE_ENGINE.md` entregado por Pedro.

## Estado

La primera versión incluye motor manual y autónomo por ciclos, garantía de búsqueda exacta inicial, cola con deduplicación y prioridad, análisis determinista, scoring configurable, lifecycle, recomendaciones y persistencia separada en `data/product-intelligence.json`.

No modifica campañas, pedidos, WhatsApp, Shopify ni la base de datos existente. El provider inicial es de importación JSON; el adapter de Meta Ad Library deberá conectarse cuando se disponga de su contrato/credenciales de solo lectura.

## Uso

```text
npm run product-intelligence -- research "juanetes" anuncios.json
npm run product-intelligence -- auto-hunt anuncios.json
```

Sin un JSON, el ciclo se ejecuta de forma segura y devuelve cero hallazgos. El JSON debe ser un array de anuncios con los campos definidos en `src/lib/product-intelligence/types.ts`.
