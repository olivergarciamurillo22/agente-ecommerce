# Operar el AI Winner Radar

## Créditos: dónde se va el dinero

WinningHunter cobra **1 crédito por llamada**. Los frenos, en orden:

1. **Caché** — la misma consulta dentro de 30 min no se repite.
2. **Tope por búsqueda** — máximo **24 llamadas**; al llegar, se para.
3. **Tope de consultas** — la expansión emite 8 por defecto.
4. **Freno de repetición** — una búsqueda cada 30 s.
5. **Ritmo** — 1,1 s entre llamadas (la API permite 60/min).

Un 401 o 403 **no se reintenta**: la clave no se arregla sola y reintentar
solo gasta cuota. Un 429 por créditos agotados **aborta**.

El consumo del día se ve en el panel y en `hunter_provider_runs`.

## Antes de gastar

El botón **"Analizar criterios"** interpreta la frase y enseña las consultas
que se lanzarían **sin salir a la red**. Conviene usarlo siempre: corregir un
filtro ahí es gratis, corregirlo después cuesta créditos.

## Momentum: por qué al principio no aparece

Hace falta que el radar haya visto el producto **al menos dos veces con días
de diferencia**. En la primera búsqueda dirá "sin histórico todavía". No es un
fallo: es la alternativa a inventarse una tendencia con una sola medición.

## Mantenimiento

- `runSnapshotRefresh()` — foto diaria de lo vigilado. **No sale a la red.**
- `runWatchlistAlerts()` — avisos internos (nunca WhatsApp ni correo).
- `runHunterMaintenance()` — limpia la caché caducada.

Los tres usan los leases del repo: dos contenedores duplicando snapshots no
solo gastarían créditos, falsearían el momentum.

## Cuando una fuente falla

La búsqueda termina en **PARCIAL** con lo que haya. La confianza baja sola; el
score **no** se toca. Abortar entera sería tirar resultados buenos y créditos
ya gastados.
