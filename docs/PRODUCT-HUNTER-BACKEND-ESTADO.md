# Product Hunter Backend — estado a 08-09-2026

Rama `feat/product-hunter-backend`, desde `24eb6c0` (que ya está en
`release/casamable-v4.3`, desplegada en el NAS). HEAD `ecea647`, 7 commits,
803 tests OK. Semáforo local: `predeploy:check --fixture --commit ecea647` →
**LISTO CON AVISOS, 0 fallos** (avisos esperados sin copia real del NAS).

## Origen del problema

El panel «Cazador de productos» (Estado / Economics / Landing Studio) llevaba
semanas inutilizable: exigía `PRODUCT_HUNTER_SOURCE=api` apuntando a un
backend externo que nunca se construyó. Se investigó y descartó sacar el
coste por scraping de proveedores: AliExpress es una cáscara JavaScript,
Dropi/Dropea es un catálogo privado y la tienda propia no expone coste de
compra.

## Lo que se construyó

- `PRODUCT_HUNTER_SOURCE=internal` (valor nuevo). `api` conserva su
  significado original de backend externo, que sigue sin existir.
- Búsqueda por fuentes: Ad Library (el discovery ya validado, token de Meta
  funcionando), copia local del catálogo de Dropea (`hunter:dropea:sync`;
  Dropea no tiene endpoint de búsqueda y son 4.142 productos), candidatos
  locales y cruces.
- Coste real desde Dropea (de la API, no manual). Peso y medidas: Dropea no
  los expone; se teclean en el panel o con `hunter:add` y quedan anotados
  como manuales.
- **Score de Oportunidad Validada** (F6a): cruce catálogo Dropea × Ad
  Library. Detecta si un producto del catálogo ya se anuncia en Meta, desde
  cuándo (momentum) y calcula margen si el precio está escrito en el
  anuncio. Fórmula: 40 validación + 40 margen + 20 confianza del match.
  CLI por lotes con presupuesto: `npm run hunter:cruce-dropea -- --limite N`.
- Limitación honesta: el precio de competencia es «detectado en el texto
  del anuncio», nunca confirmado; no se visita la landing del competidor.
  Un score alto con precio detectado es una señal para revisar a mano, no
  una decisión automática de comprar stock.
- Tablas nuevas (migración 31, aditiva): `dropea_catalog`, `hunter_pipeline`
  (ids con prefijo `adlib:` `local:` `dropea:` `cruce:`), `hunter_cruce_runs`,
  `hunter_cruces`.

## Refuerzos de la segunda pasada (db5b855, 026b14a, ecea647)

- Matching: los nombres genéricos de una sola palabra («Soporte», «Funda»)
  ya no pueden dar «si»: quedan «dudoso» con la confianza recortada a la
  mitad y anotado en el desglose. Tallas, colores, medidas y cantidades se
  filtran de las palabras clave, que salen del nombre del producto de
  Dropea, no de la variante.
- Sync resiliente: cortado a mitad no corrompía la copia (una transacción
  por página), pero la dejaba mezclada sin avisar. Ahora queda registrado si
  la pasada terminó, el CLI avisa y sale con código 3, y cuenta las
  variantes que Dropea ya no devolvió.
- Parser de precios: 30 frases reales de anuncios españoles («29€»,
  «29'99€», «29€99», «14,99 euros»; prioriza solo/ahora/PVP; ignora envío,
  descuento, cupón, regalo, «valorado en»; marca «sin IVA» sin ajustar el
  importe; detecta «desde» y «N por X €» como precio de lote). Lo que no
  reconoce está documentado, no se adivina.
- Doc de uso con la sesión típica del CLI (sync, primer cruce de 20,
  tandas por categoría, `--ver`, `--repetir`, códigos de salida, cómo leer
  un score de 84, 38 o 18).
- Dos tests intermitentes diagnosticados y arreglados, ambos en los tests,
  no en código de producción: A6 unit economics (fecha local de la máquina
  frente a día de negocio de Madrid) y el test del flujo «opción 3, nota al
  repartidor», que no drenaba la cola de pedidos que dejan los tests de
  validación de direcciones (el scheduler envía 20 por tick).

## Estado: listo para revisión y despliegue

Guía de uso y activación: `PRODUCT-HUNTER-BACKEND-USO.md`. Plan e inventario:
`PRODUCT-HUNTER-BACKEND-PLAN.md`. Prompt de despliegue: se genera con el
formato de siempre sobre el SHA del merge.

Decisión pendiente para Pedro: solo el momento del despliegue.
