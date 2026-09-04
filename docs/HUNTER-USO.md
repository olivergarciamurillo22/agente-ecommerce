# Cómo usar Winning Hunter

Winning Hunter guarda productos que tú le das, comprueba si tienen suficientes datos para calcular su economía y propone si merece la pena probarlos. No busca ventas ni inventa demanda. Tampoco publica nada en Shopify.

## Los cuatro comandos de trabajo

1. `npm run hunter:add -- --url <URL>` inspecciona una página sin guardar. Revisa el JSON antes de seguir.
2. `npm run hunter:add -- --url <URL> --apply` guarda el candidato. Si faltan datos, lo guarda como incompleto y sin puntuación.
3. `npm run hunter:score -- --id N` recalcula un candidato. También puedes usar `--all` para recalcular todos.
4. `npm run landing:e2e -- --candidate N [--out <carpeta>]` genera el HTML, lo separa en secciones Liquid y pasa todas las comprobaciones. Si algo no es válido, termina con error y no da la landing por buena.

Los comandos `landing:build`, `landing:sections` y `landing:lint` quedan disponibles para investigar un paso concreto, pero normalmente no hacen falta.

## Cómo leer la ficha

En **Cazador de productos → Economics** verás el coste puesto en España, dimensiones del paquete, peso real y volumétrico, tramo de envío, PVP propuesto, margen por enviado, CPA máximo y punto de equilibrio de entrega. Debajo aparece la puntuación desglosada: cada fila explica los puntos que suma. Si falta una medida del paquete de venta, el producto no recibe score.

Los veredictos significan:

- **prioritario**: 80–100 puntos; candidato fuerte para preparar una prueba.
- **probar**: 60–79,99; tiene economics suficientes, pero aún hay que validar la oferta.
- **dudoso**: 40–59,99; hay riesgos o poco colchón; completa datos antes de gastar.
- **descartar**: menos de 40; no compensa con los datos actuales.

“Generar landing” escribe archivos locales en `outputs/landings`. Antes de usarlos, sustituye los medios, configura la variante de checkout y completa la información legal. Solo un usuario owner puede abrir estas operaciones.
