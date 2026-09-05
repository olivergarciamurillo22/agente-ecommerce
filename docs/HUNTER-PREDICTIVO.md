# Hunter predictivo

El Hunter predictivo sirve antes de importar un producto: busca evidencia de
coste mayorista y PVP DTC para decidir si merece seguir investigandose. No
sustituye al Hunter de decision. El Hunter de decision sigue exigiendo coste,
medidas y PVP confirmados antes de puntuar o justificar gasto.

## Busqueda y fuentes

La aplicacion no dispone por si sola de un buscador web. Usa un adaptador HTTP
configurable mediante `HUNTER_PREDICTIVE_SEARCH_API_URL` y, opcionalmente,
`HUNTER_PREDICTIVE_SEARCH_API_TOKEN`. Sin ese servicio declara y persiste
`sin_acceso_a_busqueda: true`; no genera cifras.

El endpoint recibe `POST` con `query`, `competitorUrl` y `kind` (`wholesale` o
`retail`) y devuelve `{ "results": [...] }`. Cada resultado debe incluir URL
HTTPS, titulo, `priceEur`, cantidad y peso en gramos cuando se conozcan. Para
mayoristas solo se aceptan Alibaba, AliExpress, 1688 y CJ Dropshipping. El
contenido remoto se valida como datos; nunca se ejecuta ni se interpreta como
instrucciones. Meta Ad Library no se considera disponible sin un proveedor que
la exponga explicitamente en este contrato.

Se exigen al menos dos dominios distintos para formar un rango. Los rangos
guardan minimo, maximo, media probable, fuentes y fecha. Caducan a los 30 dias,
porque precios y disponibilidad mayorista cambian rapidamente.

## Viabilidad preliminar

La estimacion cruza el rango minorista con el coste a 500 unidades. Aplica los
costes conocidos de Beeping: picking 1,70 EUR, COD 0,70 EUR y envio 4,08 EUR
hasta 1 kg o 6,50 EUR hasta 4 kg. Sin peso fiable no hay veredicto.

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
