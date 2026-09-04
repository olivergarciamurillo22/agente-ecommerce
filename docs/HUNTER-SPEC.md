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
