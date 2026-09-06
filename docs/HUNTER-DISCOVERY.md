# Hunter de descubrimiento en Meta Ad Library

Este modulo descubre senales publicitarias antes de estimar precios. La cadena
es: descubrimiento y momentum -> Hunter predictivo -> Hunter de decision con
datos reales. Aqui no se calculan margenes ni se escribe en Meta o Shopify.

## Consulta

`npm run hunter:discovery -- --terminos config/hunter-discovery-terms.json --pais ES --dias 14`

`npm run hunter:discovery:doctor -- "termino de prueba"` comprueba cada campo
por separado sin persistir candidatos, para que uno opcional rechazado no
oculte los que funcionan.

Los terminos son configuracion, no reglas del motor. El set inicial deriva de
`docs/nicho-abuelos-pain-points.md` y cubre visión, audición, movilidad,
dolor/circulación, memoria/medicación, noche, seguridad, tecnología, salidas y
tareas domésticas. El comprador habitual (hijos de 35–55) queda documentado
como contexto, no como filtro automático de Meta.

La consulta usa `ad_reached_countries`, ventana `ad_delivery_date_min/max`,
anuncios activos y paginacion por `paging.cursors.after`. Entre paginas espera
1 segundo y corta a 20 paginas por termino. Lee las cabeceras `X-App-Usage`,
`X-Business-Use-Case-Usage` y `X-Ad-Account-Usage`; Meta no publica un cupo
unico estable aplicable a todas las apps, por lo que se conserva el uso que
devuelva la cuenta en cada consulta y nunca se pagina sin pausa.

## Agrupacion, ruido y momentum

Los anuncios se agrupan por `page_id` y similitud Jaccard >= 0,55 entre tokens
de captions, bodies y titles. Un grupo, no una fila cruda, es el candidato.

Heuristicas de ruido (pueden producir falsos positivos): texto con terminos de
apps/servicios/contenido; ausencia total de texto comercial; o audiencia
estimada maxima >= 1.000.000, usada como indicio de marca ya establecida.

Cada consulta y cada grupo se guardan en schema 21. Primer snapshot:
`sin_historico`. Desde el segundo, momentum `fuerte` exige al menos 5 anuncios
activos y crecimiento >= 2 frente al snapshot anterior; cualquier otra
comparacion queda `debil`. Cero anuncios es `sin_datos`.

Solo un snapshot `fuerte` y no marcado como ruido puede convertirse mediante
`predictiveInputFor` en entrada del Hunter predictivo. El puente aporta texto
y URL de evidencia, pero no copia ningun score ni calcula economia.

El texto creativo es contenido de terceros: se limita, normaliza y persiste
como dato inerte. Nunca se interpreta como instrucciones ni se reenvia a un
modelo.
