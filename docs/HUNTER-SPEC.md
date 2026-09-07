# Winning Hunter + Landing Studio — decisiones de implementación

Este documento fija cómo se resuelven las divergencias entre el encargo, los
contratos vigentes del repositorio y las dos skills de entrada. Los contratos
del repositorio prevalecen.

## Decisiones obligatorias

1. **Persistencia del Hunter, sí; persistencia server-side del Studio, no.** El
   Hunter necesita candidatos y auditoría propios y se implementa en SQLite.
   `LandingBlueprint` v1 y sus proyectos siguen en `localStorage`, tal como
   exige `LANDING-STUDIO.md`; no se crean tablas `landing_projects`, versiones
   ni exportaciones.
2. **El backend calcula y desglosa el score.** La UI únicamente presenta el
   resultado y sus pasos. Esto coincide con `PRODUCT-HUNTER-CONTRACT.md`.
3. **La economía no usa un multiplicador automático como verdad contable.** El
   PVP sugerido se presenta como propuesta configurable, nunca como dato real.
   Margen, CPA máximo y break-even reutilizan el modelo real y sus constantes;
   ante una entrada ausente devuelven `null`.
4. **Liquid gana a Dawn mediante un ID, no mediante `!important`.** Todos los
   selectores empiezan por `#shopify-section-{{ section.id }}`. El lint lo
   exige con `todos_los_selectores_scopeados_por_id`. Solo se admitiría un
   `!important` puntual si la misma línea cita la evidencia `DAWN: selector`;
   la auditoría actual no encontró ninguna excepción necesaria.
5. **El HTML es una entrada de importación, no el estado del editor.** El
   compositor puede producir un HTML autocontenido y el conversor puede
   trocearlo, pero ningún HTML vuelve a ser la fuente de verdad de un proyecto
   ya creado: esa fuente sigue siendo `LandingBlueprint` v1.
6. **No se publica ni se escribe en Shopify.** Tanto el HTML como Liquid son
   artefactos locales. Los enlaces de checkout quedan inactivos o configurables.
7. **Sin evidencia no hay afirmación.** Medidas, peso, coste, claims y notas de
   mercado desconocidos quedan en `null`/“dato por confirmar”. No se puntúan
   demanda, competencia o saturación.

## Reglas duras incorporadas desde las skills

- HTML autocontenido, tokens HEX en `:root`, cero `rem`, tipografía móvil y
  escritorio separada, breakpoints únicamente 750px y 990px.
- Cada bloque del HTML es un `section[data-bloque]` hijo directo de `body`;
  placeholders vacíos; JS aislado por IIFE; sticky bar por umbral de scroll.
- Una sección Liquid por bloque, nombres de schema de hasta 25 caracteres,
  rangos exactos de hasta 101 pasos, richtext con `<p>`, textos configurables,
  medios como pickers y scoping por `section.id`.
- Las reglas subjetivas de estética (“anti-slop”) se conservan como guía, pero
  no se convierten en falsos tests deterministas.

## Huecos honestos

- AliExpress y otros marketplaces pueden entregar un shell de JavaScript o
  bloquear el fetch. En ese caso se conserva la URL y el candidato queda
  `nuevo`, sin score y con datos críticos pendientes.
- La atribución de CPA real por candidato solo se mostrará cuando exista una
  relación verificable entre candidato/producto/campaña. No se inferirá por
   parecido de nombres.
- Demanda, competencia, saturación y recompra no se obtienen de marketplaces;
  permanecen como evaluación manual explícita.

## Decisiones de la segunda vuelta

- **Esquema 19.** La rama se apoya en Workspace de atención: su migración 18
  crea `users`, `sessions` y `audit_log`; Hunter crea `product_candidates` y
  `candidate_events` en la 19. Partir de schema 17 ejecuta ambas en orden.
- **PVP obligatorio.** `FINANCE-MODEL.md` y `BUSINESS-METRICS.md` no contienen
  un PVP del organizador ni explican los 12,02 €/9,14 € como una cuenta
  reproducible. Se retiró el 36,90 € deducido: sin precio introducido por
  Pedro no hay margen, CPA máximo ni score.
- **Peso volumétrico desactivado.** Ni `BEEPING-INTEGRATION.md` ni
  `BEEPING-API-CONTRACT.md` dicen que Beeping facture por volumen o indiquen
  un divisor. Por defecto el tramo usa peso real. Solo se activa con
  `HUNTER_VOLUMETRIC_DIVISOR` después de confirmarlo con Beeping.
- **Reparto con Product Intelligence Engine.** PI Engine descubre, agrupa y
  vigila señales de mercado. Hunter conserva la economía COD auditada y la
  generación de landing. No se han unido los catálogos hasta decidir un ID
  canónico; el inventario detallado está en `HUNTER-VS-PI-ENGINE.md`.
- **Operación owner-only y local.** `/api/hunter` comprueba el rol owner. La
  generación deja artefactos locales, nunca escribe ni publica en Shopify.

## Constantes económicas con fuente (07-09-2026)

| Constante | Valor | Fuente | Dónde |
|---|---|---|---|
| Picking & packing | 1,40 € por pedido enviado | contrato Beeping actualizado (Pedro, 05/06-09) | `scoring.ts` `PICKING_EUR` (única fuente; `predictive/estimate.ts` la re-exporta) — entra en el margen del scoring **y** en la estimación predictiva |
| Comisión COD | 0,70 € por entregado | contrato Beeping | `COD_FEE_EUR` |
| Transporte de salida | 3,80 / 3,86 / 3,94 / 4,00 € (≤1 / ≤2 / ≤3 / ≤4 kg) | Correos Express con recargo de combustible (Pedro, 06-09) | `SHIPPING_TIERS`; >4 kg sin tramo confirmado → no se puntúa |
| Tasa de entrega supuesta | 0,629 | hipótesis de partida, no break-even | `DEFAULT_ASSUMED_DELIVERY_RATE` (ver `FINANCE-MODEL.md`) |
| CPA histórico, coste de rechazo, rango de ticket, pesos, `targetMargin` | 7,77 · 9,37 · 29,9–59,9 · 30/25/20/10/10/5 · 10 % | **estimación interna, sin dato de Pedro** | comentadas como tales en el código |

**Penalización por peso: eliminada (decisión de Pedro, 07-09).** Con la tarifa
casi plana el salto entre tramos es de céntimos y ese coste ya entra en
`margen_unitario` vía `outboundShippingCost`; restar puntos además era contar
dos veces.

**Pesos redistribuidos (decisión de Pedro, 07-09, segunda pasada).** Con
0,20 € de rango entre 1 y 4 kg el tramo dejó de ser una variable
discriminante: ponderarlo con 20 puntos sobreponderaba una señal muerta. Esos
20 puntos pasan a lo que decide si un producto aguanta anuncios — el margen
neto por enviado y el CPA máximo soportable — repartidos 10/10 para conservar
la proporción previa entre ambos:

| Factor | Antes | Ahora |
|---|---|---|
| `margen_unitario` (margen/12 € × peso) | 30 | **40** |
| `cpa_maximo` (CPA máx./7,77 € × peso) | 25 | **35** |
| `tramo_envio` | 20 | **0** (se sigue calculando: >4 kg = sin tramo = sin score) |
| `variantes` | 10 | 10 |
| `ticket` | 10 | 10 |
| `recompra` | 5 | 5 |

Escala 100 y umbrales 80/60/40 sin cambios. Efecto práctico: un producto con
margen y CPA justos ya no recibe 20 puntos "gratis" por pesar poco; el
veredicto depende de la economía real.

**Impacto en el caso de ejemplo** (fixture organizador, 190 g, coste 3,29 €, PVP 34,99 €):

| Caso | Antes (4,08 € envío, sin picking, tramo 20 pt) | Tras tramos reales (3,80 €) | Tras picking 1,40 € en el scoring | **Tras redistribuir pesos (40/35/0)** |
|---|---|---|---|---|
| 1 ud | margen 10,72 € · CPA máx. 10,72 · break-even 38,3 % · score 91,8 (prioritario) | 11,00 € · 11,00 · 37,7 % · 92,5 (prioritario) | 9,60 € · 9,60 · 40,9 % · 89,0 (prioritario) | **9,60 € · 9,60 · 40,9 % · 87,0 (prioritario)** |
| pack 2 uds (coste 6,58 €, 380 g) | 7,43 € · 7,43 · 45,9 % · 82,5 (prioritario) | 7,71 € · 7,71 · 45,2 % · 84,1 (prioritario) | 6,31 € · 6,31 · 48,4 % · 76,1 (probar) | **6,31 € · 6,31 · 48,4 % · 69,5 (probar)** |

El pack de 2 bajó de «prioritario» a «probar» al contar el picking (antes el
scoring lo sobrevaloraba en 1,40 € por envío) y pierde otros 6,6 puntos al
dejar de cobrar el tramo: su margen (6,31 €) y su CPA máximo (6,31 € frente a
7,77 € históricos) son justos, y ahora el score lo dice.
