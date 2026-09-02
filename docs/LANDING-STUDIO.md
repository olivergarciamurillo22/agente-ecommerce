# Landing Studio — contrato y límites

**Estado:** implementado en la rama `feat/control-center-v4-apple-redesign`,
sin desplegar y sin ninguna escritura a Shopify.

## Fuente de verdad

`src/lib/landing-studio/types.ts` define `LandingBlueprint` v1. El preview,
la validación y los ficheros Shopify se derivan siempre del blueprint; el HTML
no se guarda ni vuelve a entrar al editor.

El proyecto conserva: producto, anuncio de origen, proveedor, brief, dirección
visual, secciones, assets, claims y evidencias, precio, economía, validaciones,
versiones, exportaciones y experimento A/B. La primera versión persiste los
proyectos en `localStorage` del navegador del operador. No es aún un repositorio
compartido ni multiusuario.

## Flujo

`Candidato → viabilidad → brief → blueprint/editor → preview → validación →
versión → exportación`.

- El candidato se lee mediante el contrato `ProductHunterDataSource`.
- La viabilidad es determinista en `viability.ts`. Un componente ausente deja
  el resultado en `null`; nunca se sustituye por cero.
- Cada claim lleva estado: verificado, proveedor, Pedro, hipótesis, pendiente o
  bloqueado. Patrones de reseñas, estudios, certificaciones, urgencia, escasez,
  antes/después y garantías no demostradas bloquean la exportación.
- El precio anterior solo se acepta con evidencia y si supera al precio actual.
- El editor permite reordenar con botones accesibles, añadir, ocultar, duplicar,
  eliminar y editar secciones; incluye previews desktop/tablet/móvil.
- Las versiones son snapshots completos del blueprint y se pueden restaurar.

## Economía

Por pedido creado:

```text
precio × tasa de entrega
− producto
− IVA aplicable
− transporte
− comisión COD × tasa de entrega
− preparación
− coste devolución × (1 − tasa de entrega)
− CAC
= contribución esperada
```

Cada entrada declara si es dato real, estimación, escenario o dato ausente, más
su fuente. El cálculo no usa multiplicadores automáticos sobre el coste.

## Exportación Shopify

`shopify-export.ts` genera localmente un ZIP estándar sin compresión con:

- una sección Liquid por sección visible;
- template JSON de producto;
- CSS y JS compartidos;
- locale español;
- manifest con `published: false`.

Liquid usa BEM, scoping por `section.id`, schema nativo (`image_picker`,
`video`, `product`, `font_picker`, `color_scheme`) y blocks repetibles. El
validador rechaza JSON/schema inválido y cualquier `!important`.

El botón solo descarga un archivo. No llama a Shopify, no crea temas y no
publica. El preview sobre un tema no publicado queda preparado como siguiente
integración manual; necesita que Pedro elija el tema y autorice credenciales de
solo escritura de temas en una sesión separada.

## Persistencia

Landing Studio v1 utiliza `localStorage` **deliberadamente**. La UI lo declara
(badge "Beta" + "Guardado localmente en este navegador") para que nadie
suponga que hay sincronización.

La persistencia server-side/SQLite queda **DEFERRED** hasta que exista una
necesidad real demostrada, como:

- compartir proyectos entre Pedro y Óliver
- trabajar desde varios dispositivos
- auditoría server-side necesaria
- que otro flujo real dependa de ello

**No subir el schema solo para sustituir `localStorage`.** Un experimento de
persistencia (schema v18 + `landing_projects/versions/exports` + rutas
`/api/landing-studio`) se escribió el 02-09-2026 y se descartó sin integrar:
no satisfacía ninguno de los criterios de arriba, no tenía tests y ninguna
pantalla lo consumía. La copia local vive fuera de git en
`artifacts/landing-studio-server-persistence-experimental.patch`.
