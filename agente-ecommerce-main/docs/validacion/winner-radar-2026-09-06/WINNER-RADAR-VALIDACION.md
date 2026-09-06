# Validación local del Winner Radar — 6 de septiembre de 2026

Rama `feat/ai-winner-radar`, HEAD `72b5001`. Clon aislado descargado de origin. No se usó hunter-end-to-end-v1. Sin NAS, despliegue, PR ni merge. Servidor local y navegador detenidos al terminar.

## Puertas

- Tests: VERDE, 744 tests OK, 0 fallos, código 0.
- Typecheck: VERDE, sin errores, código 0.
- Build: VERDE, compilado y páginas generadas, código 0.
- Windows: Node 24.19.0; Next 16.3.1. Se utilizó npm.cmd por la política de PowerShell. Instalación y tests necesitaron salir del sandbox por restricciones de caché/red y userInfo de tsx.
- Next avisó del package-lock.json de la carpeta superior al clon. El dev regeneró next-env.d.ts dentro del clon; no se editaron fuentes funcionales.

## Doctor

```text
● PROVIDER             meta
○ META                 ERROR
    respuesta 400
◐ MODELO_IA            NOT_CONFIGURED
● JOBS                 READY
● SE PUEDE BUSCAR — Listo para buscar con la Biblioteca de Anuncios de Meta.
```

Código de salida 0 pese a META ERROR. OPENAI_API_KEY ausente y OPENROUTER_API_KEY vacía en el archivo disponible. Se utilizó una copia del .env.local de la carpeta de trabajo, cuya última modificación es el 2 de septiembre. No se imprimieron claves.

## Migración

Copia consistente realizada con SQLite backup API. Original `data/messages.db`: user_version 0, 0 pedidos, integridad ok. Copia `winner-radar/data/migration/messages.db`: versión 20, 0 pedidos, integrity_check ok. Original comprobado otra vez: sigue en versión 0, 0 pedidos, integridad ok.

Esto valida 0 → 20 sobre la base local vacía; NO acredita 19 → 20 con pedidos. La guía copia a prueba-20.db pero DATA_DIR apunta a un directorio donde el código abre messages.db: ese comando no comprobaría la copia indicada. Se corrigió únicamente la disposición de archivos de la prueba.

## Búsqueda real en Chromium

Panel iniciado mediante npm run dev, puerto local 3107. Entrada por Cazador, texto solicitado, botón Buscar oportunidades. Sin fixtures.

- Consulta: Productos de mascotas para España, contrareembolso, 25-50 €, no frágiles.
- 8 consultas a Meta; 0 anuncios y 0 productos.
- Duración registrada por el motor: 9546 ms. Medición de navegador hasta captura: 13,579 s, incluidos sondeo y espera de renderizado.
- Estado final partial; sourcesFailed: meta_ad_library; error: `Sin resultados; fallaron: meta_ad_library`.
- Las seis etapas constan en el resultado; explorar falla, agrupación termina sin anuncios, las tres últimas se omiten.
- No se pudo validar separación, pestaña Anuncios ni ninguna de las tres salidas: no había productos que abrir.
- La pantalla final dice que se prueben otras palabras y atribuye el vacío al vocabulario; no muestra el fallo de Meta.

## Error literal de Meta

El doctor reduce el fallo a `respuesta 400`. Una consulta mínima adicional con los mismos campos recuperó:

```text
HTTP 400
{"error":{"message":"Error validating access token: Session has expired on Wednesday, 02-Sep-26 07:00:00 PDT. The current time is Sunday, 06-Sep-26 07:55:10 PDT.","type":"OAuthException","code":190,"error_subcode":463,"fbtrace_id":"AfOmSzgN5Bw52kXinHwyp-5"}}
```

## Otras observaciones

- La guía dice HEAD 7934bef, aunque el HEAD solicitado y descargado es 72b5001.
- El plan reconoce mascotas, España, 25–50 y no frágiles, pero deja codFit=null con la palabra «contrareembolso» de la consulta pedida.
- El proveedor lee META_AD_LIBRARY_API_VERSION (por defecto v21.0); el archivo disponible configura META_GRAPH_API_VERSION=v26.0, que este proveedor no lee.
- El código limita el intervalo a 1200 ms. Ese intervalo por sí solo permitiría 3000 consultas/hora, no respeta un techo de 200/hora sostenido. En esta prueba solo se hicieron ocho consultas de búsqueda y las sondas descritas.

Evidencia: winner-radar-test.log, winner-radar-typecheck.log, winner-radar-build.log, winner-radar-doctor.log, winner-radar-migration.log, winner-radar-search.json, winner-radar-search.png y winner-radar-meta-response.txt, en esta misma carpeta.
