# Qué campo sale de dónde

Cada métrica importante viaja con su `MetricProvenance`. Esta tabla es el
contrato: si un campo aparece en la interfaz sin poder situarlo aquí, es un
fallo a corregir.

| Campo | Origen | Procedencia |
|---|---|---|
| `advertiserCount`, `activeAds`, `totalAds` | contado sobre los anuncios recogidos | OBSERVED |
| `creativeCount`, `creativesPerAdvertiser` | contado | OBSERVED |
| `oldestActiveAdDays` | fechas del proveedor | OBSERVED |
| `newAds7d`, `newAdvertisers7d` | contado con fechas; `null` si no hay fechas | OBSERVED |
| `observedPriceMin/Max` | precios vistos en anuncios | OBSERVED |
| `supplierCost` | `product_costs` si ya vendemos algo parecido | INTERNAL_REAL |
| `deliveryRate`, `shippingRate`, `rawCPA` | mismo origen que la Calculadora COD | INTERNAL_REAL |
| `historicalRefusalRate` | eje de cierre de `orders`, agregado | INTERNAL_REAL |
| `expectedProfit`, `margin`, `roi`, `realCPA` | Modelo Pedro (`cod-calculator`) | CALCULATED |
| `breakEvenCPA` | `computeBreakEven` | CALCULATED |
| Scores (mercado, momentum, saturación…) | funciones puras de este módulo | CALCULATED |
| `problemClarity`, `demoability`, riesgos… | modelo leyendo copy público | AI_INFERENCE |
| Resumen "inferido" y "riesgos" | modelo, sobre datos ya observados | AI_INFERENCE |
| Ventas estimadas de TikTok Shop | lo estima WinningHunter | PROVIDER_ESTIMATE |

## Lo que NO existe y no se puede pedir

Ventas, ROAS, gasto publicitario, beneficio o conversiones **de un
competidor**. Ninguna fuente pública los da para anuncios comerciales. Si
algún proveedor los estima, se marcan como `PROVIDER_ESTIMATE` y la interfaz
dice "estimado por proveedor externo" — nunca se presentan como hechos.
