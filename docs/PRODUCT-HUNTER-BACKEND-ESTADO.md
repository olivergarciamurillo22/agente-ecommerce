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

## Avisos del semáforo, uno por uno

`predeploy:check --fixture --commit <sha>` termina en LISTO CON AVISOS. Ninguno
es un fallo real de esta rama; cada uno con qué es, por qué no bloquea y qué
mirar después del despliegue:

| Aviso | Qué es | Por qué no bloquea | Qué monitorizar tras el despliegue |
|---|---|---|---|
| Migración (fixture): datos sintéticos | La migración 17→31 se ensaya sobre un fixture, no sobre la base real | La mecánica (idempotencia, integridad, tablas) es la misma; la migración 30→31 solo crea 4 tablas nuevas | El script del despliegue mide el esquema antes (30) y después (31) y compara recuentos de orders/conversations/messages: tienen que ser idénticos |
| Cobertura de canales: no evaluada | Sin copia real no hay catálogo de productos de despacho que comprobar | No cambia nada del despacho en esta rama; `dispatch_channels` sigue como estaba | `docker exec casamable-agent npm run dispatch:coverage` después, si se quiere el dato; no es de esta feature |
| Interruptores generales: APP_MODE vacío | El PC de desarrollo no tiene APP_MODE | En el NAS `APP_MODE=production` está en el `.env`; el semáforo lee el entorno local | `readiness:runtime` en el contenedor tras el despliegue |
| npm test: 5 omitidos | Tests que exigen `npx` con registro; en Windows se omiten siempre | 804 tests OK; los omitidos no cubren nada de esta rama | Nada |

## Script de despliegue (sin placeholders a mano)

`scripts/nas-deploy-cazador.sh` hace los pasos 3 a 9 del runbook con las
variables declaradas UNA vez arriba. Pedro lo revisa entero y lo ejecuta en
el NAS como root. Uso:

```
sudo SHA_MERGE=<sha completo del merge> bash /volume1/docker/CasamableAgent/repo-v3c/scripts/nas-deploy-cazador.sh
```

El script se niega a arrancar si el SHA no es de 40 caracteres, si está
dentro de la franja 10:00–21:00 de Madrid (`FORCE_WINDOW=1` para forzar), si
el esquema medido no es 30 o si falta `PRODUCT_HUNTER_SOURCE=internal` en el
`.env`. Se detiene en el primer fallo, etiqueta la imagen anterior como
`casamable-agent:pre-cazador`, hace backup fuera del repo, comprueba que el
esquema queda en 31 con los recuentos intactos y que `/api/health/live`
devuelve el SHA, lanza el sync de Dropea y el primer cruce de 20, e imprime
el informe con los campos rellenados (los del panel se rellenan a mano).
`SKIP_FIRST_RUN=1` despliega sin lanzar el sync ni el cruce. El build pasa
`GIT_SHA` inline al comando (`sudo` no hereda un `export`; incidencia del
despliegue de los fixes del 08-09).

El script vive en el propio commit que se despliega: primero el checkout
(el script hace fetch y checkout al SHA), así que la primera vez hay que
traerlo con `docker run --rm -v /volume1/docker/CasamableAgent/repo-v3c:/git alpine/git:latest fetch origin release/casamable-v4.3`
y `checkout <sha>` antes de poder ejecutarlo; a partir de ahí es idempotente.

## Garantía del rollback (verificada en seco)

Con `PRODUCT_HUNTER_SOURCE=off` el resto del sistema no lee ninguna tabla
del esquema 31. Hay un test que lo demuestra de dos formas: estático (las
tablas solo se nombran en el módulo interno, sus dos CLIs, la migración y el
verificador; el proceso del bot no carga el Cazador) y dinámico (con la
fuente en off, todas las operaciones de la ruta responden NOT_CONFIGURED y
ninguna sentencia SQL nombra esas tablas). Un valor desconocido de la
variable, como `internal` visto por un código anterior, cae en «off» sin
reventar: volver a la imagen `pre-cazador` con el `.env` sin tocar también
es seguro.

## Estado: listo para revisión y despliegue

Guía de uso y activación: `PRODUCT-HUNTER-BACKEND-USO.md`. Plan e inventario:
`PRODUCT-HUNTER-BACKEND-PLAN.md`. Prompt de despliegue: se genera con el
formato de siempre sobre el SHA del merge.

Decisión pendiente para Pedro: solo el momento del despliegue.
