# Hunter predictivo

El Hunter predictivo sirve antes de importar un producto: busca evidencia de
coste mayorista y PVP DTC para decidir si merece seguir investigandose. No
sustituye al Hunter de decision. El Hunter de decision sigue exigiendo coste,
medidas y PVP confirmados antes de puntuar o justificar gasto.

## Busqueda y fuentes

Hay dos proveedores opt-in mediante `HUNTER_PREDICTIVE_SEARCH_SOURCE`: `api`
usa `HUNTER_PREDICTIVE_SEARCH_API_URL` y `scraping_publico` consulta las
paginas publicas de resultados de AliExpress, 1688 y Alibaba. El valor por
defecto es `off`: declara y persiste `sin_acceso_a_busqueda: true`.

El endpoint recibe `POST` con `query`, `competitorUrl` y `kind` (`wholesale` o
`retail`) y devuelve `{ "results": [...] }`. Cada resultado debe incluir URL
HTTPS, titulo, `priceEur`, cantidad y peso en gramos cuando se conozcan. Para
mayoristas solo se aceptan Alibaba, AliExpress, 1688 y CJ Dropshipping. El
contenido remoto se valida como datos; nunca se ejecuta ni se interpreta como
instrucciones. Meta Ad Library no se considera disponible sin un proveedor que
la exponga explicitamente en este contrato.

Se exige al menos una fuente real para formar un rango; con una sola la
confianza queda marcada como baja. Los rangos guardan minimo, maximo, media
probable, fuentes y fecha. Caducan a los 30 dias, porque precios y
disponibilidad mayorista cambian rapidamente.

En `scraping_publico`, cada sitio se consulta con el User-Agent identificable
`Casamable-Hunter-Predictivo/1.0`, timeout de 7 segundos y como maximo un
reintento ante red, 429 o 5xx. Un 403, login, captcha, HTML vacio o ausencia de
precios EUR se registra como `no_disponible` con el motivo y no bloquea las
otras fuentes. Se leen como maximo 10 resultados por sitio (configurable entre
1 y 20). No se falsean cabeceras de navegador ni se intenta sortear bloqueos.

La media probable pondera cada fuente por igual: primero obtiene la media de
sus resultados y despues calcula la media entre fuentes disponibles. Una sola
fuente implica confianza `baja`; dos o tres, `media`. Nunca se declara
confianza alta. Cada observacion conserva la URL exacta. Solo se aceptan
precios mostrados en EUR: no se inventa un cambio de divisa para 1688.

## Viabilidad preliminar

La estimacion cruza el rango minorista con el coste a 500 unidades. Aplica los
costes del contrato Beeping confirmados por Pedro (2026-09-05/06): picking &
packing 1,40 EUR, COD 0,70 EUR y envio Correos Express con recargo de
combustible por tramo de peso, practicamente plano: 3,80 EUR hasta 1 kg,
3,86 EUR hasta 2 kg, 3,94 EUR hasta 3 kg y 4,00 EUR hasta 4 kg (tabla
`SHIPPING_TIERS` en `src/lib/hunter/scoring.ts`, compartida con el scoring).
Por encima de 4 kg no hay tramo confirmado y no hay veredicto. Sin peso
fiable tampoco.

- `descartar`: ni el mejor caso deja contribucion positiva.
- `investigar`: existe margen posible, pero el peor caso deja menos de 8 EUR.
- `candidato_fuerte`: incluso el peor caso deja al menos 8 EUR.

Los packs de 2 y 4 se muestran solo como estructura comercial esperada; no se
les inventa un precio ni descuento.

## Uso y persistencia

```text
npm run hunter:predictivo -- --producto "nombre" [--url <url_competidor>]
```

`--promover` crea además la ficha en el Hunter de decisión cuando el veredicto
sea `investigar` o `candidato_fuerte`; no promociona descartados ni resultados
sin veredicto.

Cada ejecucion se guarda en `hunter_predictive_estimates` (schema 20), incluso
si no hay busqueda o fuentes suficientes. Una estimacion que se promocione al
Hunter de decision conserva `costStatus=estimado` y `pvpStatus=estimado` en su
procedencia, mientras los campos confirmados quedan en `null`; por eso no puede
obtener score.

> Estos numeros nunca deben utilizarse para calcular margenes reales ni para
> decidir presupuestos de anuncios. Solo orientan si merece la pena pedir una
> muestra, negociar con proveedores y medir el producto.
