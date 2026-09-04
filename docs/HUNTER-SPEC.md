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
4. **Liquid no llevará `!important`.** La skill de conversión lo exige en toda
   declaración, pero `LANDING-STUDIO.md` ordena que el exportador lo rechace.
   Prevalece el contrato: el conversor genera CSS correctamente scopeado y el
   lint incluye la regla `sin_important` en lugar de `important_en_todo`.
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
