# PEDRO — DESPLIEGUE DEEP DIVE COMPLETO (nivel 2 del Cazador)

Ya está listo y probado en el PC: `npm run typecheck` limpio, `npm run build`
limpio, `npm test` 815 OK / 0 fallos, migración 32 con columnas aditivas
(ALTER guardado, idempotente). Ejecución real en modo manual contra
`cloudcore.es` (catálogo, precio, margen, coherencia, recomendación).

Lleva:
- Pipeline completo del deep dive: búsqueda por palabra (saturación cruzada),
  radiografía de cuenta con ritmo de testeo y madurez del ángulo ganador,
  minería de otros productos de la tienda con búsqueda en Dropea, coherencia
  de precio anuncio/catálogo, vídeo por OpenAI (solo audio), recomendación con
  motivo, texto claro y enlace público del anuncio.
- Fix ya desplegado antes (`69d5aad`): ventana de fechas `[2018-05-07 – hoy]`.
- Sonda con pasos 5 y 6 (cuenta y vídeo).

Detrás de flag / clave (todo apagado si falta):
- Vídeo: solo con `OPENAI_API_KEY` (ya existe en el .env para direcciones);
  tope `DEEP_DIVE_VIDEO_DAILY_LIMIT` (default 50/día).
- Visión e interpretación: solo con `OPENROUTER_API_KEY`.
- Nada de esto toca WhatsApp, Shopify, pedidos ni el flujo COD.

CANDIDATO: `release/casamable-v4.3` @ `df59ef601638c5ad747338e61c6a63f2e8e4b4d9`
IMPORTANTE: NO asumir el schema previo. Antes del deploy lo medimos.

==================================================
1 · VENTANA
==================================================
Fuera de 10:00–21:00. El deploy reinicia el contenedor (~1 min sin webhook).

==================================================
2 · PRECHECK (solo lectura)
==================================================
```
cd /volume1/docker/CasamableAgent/repo-v3c
sudo docker compose -p repo-v3c ps
sudo docker exec casamable-agent node -e "const D=require('better-sqlite3');const d=new D('/app/data/messages.db',{readonly:true});console.log('schema',d.pragma('user_version',{simple:true}));console.log('deep_dives',d.prepare('SELECT COUNT(*) n FROM hunter_deep_dives').get().n);console.log('cruces_con_match',d.prepare(\"SELECT COUNT(*) n FROM hunter_cruces WHERE match<>'no'\").get().n)"
sudo docker run --rm -v /volume1/docker/CasamableAgent/repo-v3c:/git alpine/git:latest rev-parse HEAD
```
Anota: PRE_DEPLOY_SCHEMA= · PRE_DEEP_DIVES= · CRUCES_CON_MATCH= · SHA_ACTUAL=
No continúes si el contenedor no está `Up` o el schema no es 32.

==================================================
3 · BACKUP FRESCO FUERA DEL REPO
==================================================
```
sudo docker exec casamable-agent npm run backup
sudo mkdir -p /volume1/docker/CasamableAgent/backups-manuales
sudo cp /volume1/docker/CasamableAgent/repo-v3c/data/messages.db /volume1/docker/CasamableAgent/backups-manuales/messages-pre-deepdive-$(date +%Y%m%d-%H%M).db
ls -la /volume1/docker/CasamableAgent/backups-manuales | tail -3
```
Anota: BACKUP=<ruta y tamaño>
No continúes sin el archivo copiado.

==================================================
4 · .ENV DEL NAS (comprobar, no pegar valores en el chat)
==================================================
```
sudo grep -E '^(OPENAI_API_KEY|OPENROUTER_API_KEY|META_AD_LIBRARY_ACCESS_TOKEN|EMERGENCY_STOP|DEEP_DIVE_)' /volume1/docker/CasamableAgent/repo-v3c/.env | sed -E 's/=(.).*/=\1…/'
```
Si falta, añadir (valores por defecto, sin secretos nuevos):
```
DEEP_DIVE_TRANSCRIBE_MODEL=whisper-1
DEEP_DIVE_VIDEO_DAILY_LIMIT=50
```
Anota: OPENAI_KEY_PRESENTE=sí/no · OPENROUTER_KEY_PRESENTE=sí/no · TOKEN_META_PRESENTE=sí/no

==================================================
5 · ACTUALIZAR REPO / BUILD / DEPLOY
==================================================
```
cd /volume1/docker/CasamableAgent/repo-v3c
sudo docker run --rm -v /volume1/docker/CasamableAgent/repo-v3c:/git alpine/git:latest fetch origin release/casamable-v4.3
sudo docker run --rm -v /volume1/docker/CasamableAgent/repo-v3c:/git alpine/git:latest checkout df59ef601638c5ad747338e61c6a63f2e8e4b4d9
sudo docker run --rm -v /volume1/docker/CasamableAgent/repo-v3c:/git alpine/git:latest rev-parse HEAD
sudo GIT_SHA=df59ef601638c5ad747338e61c6a63f2e8e4b4d9 docker compose -p repo-v3c build casamable-agent
sudo docker compose -p repo-v3c up -d --no-build --force-recreate casamable-agent
```
(`GIT_SHA` va INLINE: `sudo` no hereda `export`.)
Anota: DEPLOYED_SHA= · BUILD_OK=sí/no

==================================================
6 · HEALTH Y MIGRACIÓN
==================================================
```
sudo docker compose -p repo-v3c ps
sudo docker exec casamable-agent npm run db:health -- --full
sudo docker exec casamable-agent node -e "const D=require('better-sqlite3');const d=new D('/app/data/messages.db',{readonly:true});console.log('schema',d.pragma('user_version',{simple:true}));console.log('cols',d.prepare('PRAGMA table_info(hunter_deep_dives)').all().map(c=>c.name).join(','))"
sudo docker exec casamable-agent npm run doctor:v43
```
Acepta si: schema = 32, `cols` incluye `account_json, ad_link, recommendation, competitors, other_products, video_status, price_coherence, summary, report_json, country, spain_active_ads, opportunity, early_exit`, y existen las tablas `hunter_cod_sweeps` y `hunter_cod_stores` (`SELECT name FROM sqlite_master WHERE name LIKE 'hunter_cod%'`).
Anota: POST_DEPLOY_SCHEMA= · COLUMNAS_NUEVAS=sí/no · DB_HEALTH= · DOCTOR_V43=
No continúes si faltan columnas: rollback (bloque 10).

==================================================
7 · SONDA (pasos 5 y 6: cuenta y vídeo) — 1 + ≤ 7 peticiones
==================================================
```
sudo docker exec casamable-agent npm run hunter:deep-dive:probe -- --termino "cojin gel silla" --max-render 6 --json /app/data/deep-dive-probe-2.json
```
Anota del paso 5: P5_HTTP= · P5_ANUNCIOS= · P5_INACTIVOS= · P5_MAS_ANTIGUO= · P5_HAY_MAS_PAGINAS=
Anota del paso 6: P6_VIDEO_ENCONTRADO=sí/no · P6_DESCARGA_HTTP= · P6_BYTES= · P6_CONTENT_TYPE= · P6_TRANSCRIPCION=OK/ERROR/sin clave · P6_GANCHO=«…»
Si el paso 6 dice «ninguno de los N anuncios probados trae vídeo», repite con `--max-render 12` UNA vez; si sigue sin vídeo, anótalo (el pipeline cae a imagen+texto) y sigue.

==================================================
8 · DEEP DIVE REAL (2–3 candidatos, nunca el catálogo entero)
==================================================
Localiza los ids de los cruces con más señal:
```
sudo docker exec casamable-agent node -e "const D=require('better-sqlite3');const d=new D('/app/data/messages.db',{readonly:true});console.log(d.prepare(\"SELECT id,product_name,score,match,active_ads FROM hunter_cruces WHERE match<>'no' AND (product_name LIKE '%oj_n%gel%' OR product_name LIKE '%apas%silicona%') ORDER BY score DESC LIMIT 6\").all())"
```
Anota: IDS_ELEGIDOS=<2–3 ids>
Ejecuta (coste por candidato: ≤ 6 Ad Library, 2–4 tienda, ≤ 3 fbcdn/OpenRouter/OpenAI):
```
sudo docker exec casamable-agent npm run hunter:deep-dive -- --ids <id1>,<id2>,<id3> --json /app/data/deep-dive-real-2026-09-09.json
```
Si no hay id claro, alternativa: `--min-score 60 --limite 3`.
Pega en el chat la salida entera de cada `═══ cruce #N ═══` (ya va sin token) o el JSON.
Anota por candidato: DD_ID= · VEREDICTO= · RECOMENDACION= · CUENTA_DESDE= · ACTIVOS/TOTAL= · RITMO= · MADUREZ_ANGULO_DIAS= · COMPETIDORES= · COHERENCIA_PRECIO= · VIDEO_STATUS= · OTROS_PRODUCTOS= · ENLACE=
Acepta si: 2–3 informes persistidos, `--ver` los lista y `--ver-id N` reimprime uno sin red:
```
sudo docker exec casamable-agent npm run hunter:deep-dive -- --ver
sudo docker exec casamable-agent npm run hunter:deep-dive -- --ver-id <DD_ID>
```

==================================================
8b · BÚSQUEDA 2 (otros países) — solo si el SHA desplegado incluye «búsqueda 2»
==================================================
Verificación de ad_reached_countries ≠ ES (1 petición por país):
```
sudo docker exec casamable-agent npm run hunter:deep-dive:probe -- --termino "cuscino gel sedia" --comparar-paises ES,IT,PT,FR,DE,MX --json /app/data/probe-paises.json
```
Anota por país: PAIS= HTTP= ANUNCIOS= MISMOS_CAMPOS=sí/no ERROR=
No sigas con un país que dé error de permiso o campos distintos.
Cruce pequeño en el primer país que pase (10 productos = 10 peticiones + traducción por Claude):
```
sudo docker exec casamable-agent npm run hunter:cruce-dropea -- --limite 10 --pais IT
```
Anota: B2_PAIS= B2_PROCESADOS= B2_CON_MATCH= B2_IDS_CON_MATCH=
Deep dive de 1–2 de esos ids (comprueba España solo, +1 petición por candidato):
```
sudo docker exec casamable-agent npm run hunter:deep-dive -- --ids <id>
```
Anota: B2_DD_ID= B2_VEREDICTO= B2_COMPETENCIA_ESPANA=<N anuncios activos (verificado) | NO VERIFICADA> B2_OPORTUNIDAD= B2_RECOMENDACION=

==================================================
8c · BÚSQUEDA 3 (caza directa COD) — solo si el SHA desplegado la incluye
==================================================
Fase 1 ampliada (13 frases × 3 páginas = ≤ 39 peticiones, no audita nada; dice cuántas tiendas son nuevas respecto al barrido anterior):
```
sudo docker exec casamable-agent npm run hunter:busqueda-cod -- --paginas 3 --json /app/data/barrido-cod-2.json
```
Anota: B3_TIENDAS_NUEVAS=
Informe consolidado (0 peticiones) y tanda grande con autoexclusión:
```
sudo docker exec casamable-agent npm run hunter:busqueda-cod -- --informe --min-dias 20 --max-dias 90 --json /app/data/informe-cod.json
sudo docker exec casamable-agent npm run hunter:busqueda-cod -- --auditar --top 20 --json /app/data/auditoria-cod-2.json
```
Anota: B3_INFORME_FILAS= B3_TOP_SALTADAS= B3_TOP_TANDA= B3_CON_VIDEO=<n productos con tiene_video sí>
Anota: B3_PETICIONES= B3_ANUNCIOS_UNICOS= B3_TIENDAS_CON_FRASE= B3_PAGINAS_SIN_FRASE= B3_TOP3=<page_id · tienda · activos · días · prioridad>
Pega la tabla entera en el chat (es la calibración de frases).
Fase 2 solo sobre 2 tiendas (≤ 5 peticiones de cuenta + deep dive por producto en Dropea):
```
sudo docker exec casamable-agent npm run hunter:busqueda-cod -- --auditar --top 2 --json /app/data/auditoria-cod.json
```
Pega la salida de cada «═══ tienda … ═══». Anota por tienda: B3_TIENDA= B3_PRODUCTOS= B3_EN_DROPEA= B3_FUERTE_SIN_PROV= B3_CATALOGO=disperso/concentrado B3_PETICIONES=

==================================================
9 · VALIDAR QUE EL NÚCLEO COD SIGUE IGUAL
==================================================
```
sudo docker exec casamable-agent npm run readiness:runtime
sudo docker exec casamable-agent npm run whatsapp:templates:doctor -- --check-only
sudo docker logs --since 10m casamable-agent | grep -iE "error|unhandled" | tail -20
```
Anota: READINESS= · TEMPLATES= · ERRORES_LOG=

==================================================
10 · ROLLBACK (solo si 6 falla o el contenedor no arranca)
==================================================
```
cd /volume1/docker/CasamableAgent/repo-v3c
sudo docker run --rm -v /volume1/docker/CasamableAgent/repo-v3c:/git alpine/git:latest checkout <SHA_ACTUAL del bloque 2>
sudo GIT_SHA=<SHA_ACTUAL> docker compose -p repo-v3c build casamable-agent
sudo docker compose -p repo-v3c up -d --no-build --force-recreate casamable-agent
```
La migración es aditiva: la base con las columnas nuevas funciona con la imagen anterior; no hace falta restaurar el backup salvo corrupción.

==================================================
11 · INFORME (rellenar y devolver)
==================================================
```
DEPLOYED_SHA=
PRE_DEPLOY_SCHEMA=
POST_DEPLOY_SCHEMA=
COLUMNAS_NUEVAS=
BACKUP=
DB_HEALTH=
DOCTOR_V43=
OPENAI_KEY_PRESENTE=
OPENROUTER_KEY_PRESENTE=
TOKEN_META_PRESENTE=
P5_HTTP= P5_ANUNCIOS= P5_INACTIVOS= P5_MAS_ANTIGUO= P5_HAY_MAS_PAGINAS=
P6_VIDEO_ENCONTRADO= P6_DESCARGA_HTTP= P6_BYTES= P6_CONTENT_TYPE= P6_TRANSCRIPCION= P6_GANCHO=
IDS_ELEGIDOS=
DD_1: DD_ID= VEREDICTO= RECOMENDACION= CUENTA_DESDE= ACTIVOS/TOTAL= RITMO= MADUREZ_ANGULO_DIAS= COMPETIDORES= COHERENCIA_PRECIO= VIDEO_STATUS= OTROS_PRODUCTOS= ENLACE=
DD_2: (igual)
DD_3: (igual)
READINESS=
TEMPLATES=
ERRORES_LOG=
ROLLBACK_REQUIRED=
B2: PAISES_OK= B2_PAIS= B2_PROCESADOS= B2_CON_MATCH= B2_DD_ID= B2_COMPETENCIA_ESPANA= B2_OPORTUNIDAD= B2_RECOMENDACION=
B3: B3_PETICIONES= B3_TIENDAS_CON_FRASE= B3_PAGINAS_SIN_FRASE= B3_TIENDA_1= B3_TIENDA_2=
FINAL_VERDICT=
```
