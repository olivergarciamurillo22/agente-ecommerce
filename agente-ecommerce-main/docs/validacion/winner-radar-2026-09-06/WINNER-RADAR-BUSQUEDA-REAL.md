# Búsqueda real — 6 de septiembre de 2026

Rama feat/ai-winner-radar, HEAD ed16a47. Panel local y base de prueba; sin NAS ni despliegue. Servidor y navegador detenidos al terminar.

Consulta: «Productos de mascotas para España, contrareembolso, 25-50 €, no frágiles».

Meta respondió sin errores. Ejecución hs_93bd981573b94d95a16c, estado complete, sin fixtures. Duración del motor 99.838 segundos; medición del navegador 110.991 segundos incluyendo petición inicial, sondeo y captura. Ocho consultas, 361 anuncios únicos, 197 candidatos, ninguno descartado. codFit=true, fragile=false, país ES y rango 25–50 reconocidos.

## Resultado: NO validado

1. Mezcla real de productos en una ficha. «White Tea Fragrance Oil Refill», hp_metaadlibrary11098987181, tiene 18 anuncios. Incluye ambientador de té blanco (anuncio 1077173521347253, Gropething) y guante de limpieza para mascotas (1109898718142509, Notifyrange-YR). Ambos visibles en la captura winner-radar-product-2.png, pestaña Anuncios. Validación detenida al revisar esta evidencia.
2. Relevancia incorrecta. El primer recomendado es «Mejores amigas. Mismo enemigo. Misma venganza.», con 25 anuncios del mismo relato de ficción. También se recomienda otro conjunto de historias. El informe propone buscar proveedor para esos títulos pese a solicitar productos de mascotas.
3. Las tres salidas (Volver a los resultados, Escape, atrás del navegador) devuelven al formulario inicial, no al listado. Comprobadas en tres fichas desde una búsqueda recuperada de Historial. Los resultados siguen persistidos y se recuperan desde Historial; no se borraron de la base. Capturas winner-radar-exit-button.png, winner-radar-exit-Escape.png y winner-radar-exit-browser-back.png. La automatización terminó las tres comprobaciones antes de que se revisara el texto que evidenció la mezcla de productos.
4. OpenAI permite la sonda de conexión pero falla al generar. Eventos hunter_llm_failed registrados para gpt-4o y gpt-4o-mini:

```text
429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.
```

El plan y el informe quedaron con aiUsed=false y aiGenerated=false. Esta ejecución no valida el análisis con IA.

Evidencia adicional: winner-radar-live-search.json, winner-radar-details.json y capturas winner-radar-product-1.png a winner-radar-product-3.png. No se aplicaron arreglos ni se abrió PR.
