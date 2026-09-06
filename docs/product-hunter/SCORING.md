# Cómo puntúa el AI Winner Radar

Todas las funciones son puras y deterministas, y los pesos viven en
`src/lib/hunter/scoring/weights.ts` con `SCORING_VERSION`. Al cambiar pesos
hay que subir la versión: los scores guardados se calcularon con la anterior
y compararlos entre versiones no significa nada.

## Regla que gobierna todo

**`score` y `confidence` van siempre juntos y son independientes.** Una
oportunidad de 88 con 42 % de confianza es información honesta. Un 88 a secas
es falsa precisión, y es la forma más silenciosa de gastar el presupuesto en
el producto equivocado.

Corolario: **si falta un dato, el resultado es `null` con motivo, nunca 0.**
Un 0 se lee como "malísimo" y "no lo sé" no es "malísimo".

## Market Score (35 % del total)

Longevidad del anuncio (24 %) · densidad de anuncios activos (16 %) ·
diversidad de anunciantes (16 %) · inversión creativa (18 %) · velocidad
creativa (10 %) · velocidad de anunciantes (8 %) · multiplataforma (8 %).

La longevidad pesa más que nada porque es la señal más difícil de fingir:
nadie quema presupuesto dos meses en algo que no convierte.

Las señales que faltan **no puntúan 0**: se ignoran y los pesos se
renormalizan sobre las que sí hay. Eso baja la confianza, no el score.

## Momentum

Premia **aceleración**, no tamaño. Sin foto anterior devuelve
`INSUFFICIENT_HISTORY` — con una sola medición cualquier producto parece que
sube, y ese es el autoengaño más fácil del módulo.

`boundedGrowth()` usa suelo en el denominador (lo pequeño no explota), `log1p`
(crecer desde base grande cuenta) y referencia de **triplicarse** para el 100.
Con referencia de duplicarse, 7→18 y 40→90 daban los dos 100 y el score
dejaba de distinguir justo entre los productos calientes.

## Saturation

0 = mercado vacío, 100 = lleno. La concentración va **invertida**: que un solo
anunciante tenga el 90 % significa que aún hay hueco; repartido entre veinte,
llegas tarde.

## Product Score (25 %)

Features inferidas por IA sobre texto público. Las de riesgo (frágil, tallas,
regulatorio, complejidad, devoluciones) se **invierten** antes de ponderar.
Confianza con techo de 0,55: lo dijo un modelo leyendo publicidad, no es una
medición.

## Casamable Score (40 % — el que más pesa)

Margen (30 %) · beneficio por pedido (22 %) · entrega histórica (16 %) ·
rehúses (10 %) · proveedor (12 %) · encaje COD (6 %) · sencillez de envío (4 %).

Pesa más que el mercado a propósito: un producto que arrasa en TikTok pero
deja 3 € en COD español es una oportunidad para otro, no para nosotros.

## Opportunity Score

**No es una media.** Media ponderada (mercado 35 / producto 25 / Casamable 40)
por penalizaciones **multiplicativas**:

| Penalización | Factor | Por qué |
|---|---|---|
| Riesgo regulatorio alto | −45 % | puede costar la cuenta publicitaria entera |
| Margen bajo el 25 % | −50 % | no hay volumen que arregle vender a pérdida |
| Proveedor sin stock | −35 % | sin proveedor no hay negocio |
| Saturación ≥ 80 | −30 % | llegas tarde y pagas el CPA de todos |
| Frágil | −25 % | cada rotura en COD es un rehusado más la mercancía |

Multiplicativas porque dos defectos graves no se compensan: se agravan.

**El proveedor "no comprobado" (`null`) NO penaliza.** Castigar la ignorancia
enterraría todo producto nuevo, que es justo el que interesa descubrir.

## Confianza

Cobertura de scores (30 %) · nº de fuentes (20 %) · profundidad de histórico
(15 %) · frescura del dato (15 %) · solidez del cluster (20 %).

Que una fuente se caiga baja la confianza, **no** el score.
