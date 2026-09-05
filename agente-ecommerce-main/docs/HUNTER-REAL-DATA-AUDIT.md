# Auditoría del primer dataset real Hunter

**Fecha:** 5 de septiembre de 2026  
**Estado:** bloqueado por token local caducado; pipeline no maquillado.

## Ejecución controlada

Se intentaron dos comprobaciones de solo lectura:

- health del provider Product Intelligence;
- doctor independiente de 13 campos con la query exacta `juanetes`.

Resultado:

| Métrica | Valor real |
| --- | ---: |
| Queries de dataset | 0 completadas |
| Ads raw | 0 |
| Ads normalizados | 0 |
| Grupos | 0 |
| Candidatos | 0 |
| Ruido | 0 |
| Duplicados | No evaluable |
| Problemas de cluster | No evaluable |
| Provider errors | 13 × HTTP 401 / Graph 190 |

La respuesta de Meta indica que la sesión del token expiró el 2 de septiembre. No se lanzaron las 3–5 roots ni se intentó alcanzar 100–500 anuncios porque repetir llamadas con una credencial inválida no aporta evidencia.

## Calibración inicial

No es posible seleccionar cinco candidatos buenos, cinco malos y cinco dudosos con cero anuncios reales. Por tanto:

- false positives: `unknown`
- false negatives: `unknown`
- clasificación manual: pendiente
- reajuste de pesos: no realizado

## Top 10 candidatos reales

No disponible. No se inventan candidatos, advertisers, precios ni momentum.

## Proveedores mayoristas

No se ejecutaron en masa porque no hubo candidatos reales que enriquecer. Las pruebas unitarias mockeadas confirman aislamiento ante 403/captcha, confianza baja con una fuente, media con tres y coste nulo cuando fallan todas.

## Segunda captura

No existe histórico real. El estado correcto es `SIN_HISTORICO`. El comando preparado es:

```text
npm run hunter:snapshot-refresh -- --termino "juanetes" --pais ES
```

Debe usarse solo después de renovar el token y obtener la primera captura real.

