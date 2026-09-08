#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# DESPLIEGUE DEL CAZADOR INTERNO EN EL NAS (esquema 30 → 31) — 08-09-2026
# docs/PRODUCT-HUNTER-BACKEND-ESTADO.md · runbook aprobado, pasos 3 a 9
#
# UN SOLO SCRIPT para no teclear placeholders a mano. Se ejecuta EN EL NAS,
# desde cualquier carpeta, como root (sudo). Variables UNA vez, aquí arriba.
# Se detiene en el primer fallo. No es «ejecutar y olvidar»: leer cada PASS.
#
# Qué hace, en orden: sanity → precheck (esquema y recuentos) → guarda de
# doble bot → backup fuera del repo → comprobación del .env → etiqueta de la
# imagen actual → fetch/checkout con alpine/git → build con GIT_SHA →
# recreate → health (esquema 31, build, recuentos) → primera ejecución
# (sync de Dropea, campos crudos, cruce de 20) → informe rellenado.
#
# Lo que NO hace: merge (se hace en el PC), tocar pedidos/WhatsApp/Shopify,
# `down -v`, restaurar la base. Rollback: docs/PRODUCT-HUNTER-BACKEND-ESTADO.md
# (PRODUCT_HUNTER_SOURCE=off + rebuild, o imagen casamable-agent:pre-cazador).
# ============================================================

# ─── VARIABLES: rellenar SHA_MERGE (40 hex, el del merge en release/casamable-v4.3) ───
SHA_MERGE="${SHA_MERGE:-}"
REPO="${REPO:-/volume1/docker/CasamableAgent/repo-v3c}"
PROJECT="${PROJECT:-repo-v3c}"
SERVICE="${SERVICE:-casamable-agent}"
CONTAINER="${CONTAINER:-casamable-agent}"
DATA_DIR="${DATA_DIR:-/volume1/docker/CasamableAgent/data}"
AUTH_DIR="${AUTH_DIR:-/volume1/docker/CasamableAgent/auth}"
BACKUP_ROOT="${BACKUP_ROOT:-/volume1/docker/CasamableAgent-release-backups}"
BASE_URL="${BASE_URL:-https://agente.casamable.es}"
BRANCH="${BRANCH:-release/casamable-v4.3}"
SCHEMA_BEFORE="${SCHEMA_BEFORE:-30}"
SCHEMA_AFTER="${SCHEMA_AFTER:-31}"
CRUCE_LIMITE="${CRUCE_LIMITE:-20}"
IMAGE_TAG_PREV="${IMAGE_TAG_PREV:-casamable-agent:pre-cazador}"
# SKIP_FIRST_RUN=1 para desplegar sin lanzar el sync ni el cruce (se pueden lanzar después a mano).
SKIP_FIRST_RUN="${SKIP_FIRST_RUN:-0}"
# FORCE_WINDOW=1 solo si Pedro decide desplegar dentro de 10:00–21:00 (corta WhatsApp unos segundos).
FORCE_WINDOW="${FORCE_WINDOW:-0}"

pass() { printf 'PASS · %s\n' "$1"; }
fail() { printf 'FAIL · %s\n' "$1" >&2; exit 1; }
info() { printf 'INFO · %s\n' "$1"; }
git_in_repo() { docker run --rm -v "$REPO:/git" alpine/git:latest "$@"; }
# Lecturas SOLO LECTURA de la base con el better-sqlite3 que ya lleva el contenedor.
db_read() { docker exec "$CONTAINER" node -e "const D=require('better-sqlite3');const d=new D('/app/data/messages.db',{readonly:true});$1"; }
schema_now() { db_read "console.log(d.pragma('user_version',{simple:true}))"; }
counts_now() { db_read "console.log([d.prepare('SELECT COUNT(*) n FROM orders').get().n,d.prepare('SELECT COUNT(*) n FROM conversations').get().n,d.prepare('SELECT COUNT(*) n FROM messages').get().n].join('/'))"; }

printf '\nCASAMABLE · DESPLIEGUE DEL CAZADOR INTERNO (30 → 31)\n\n'

# ─── 0 · Sanity ───
[[ "$SHA_MERGE" =~ ^[0-9a-f]{40}$ ]] || fail "SHA_MERGE tiene que ser el SHA COMPLETO (40 hex) del merge. Ahora vale: '${SHA_MERGE:-vacío}'"
hora="$(TZ=Europe/Madrid date +%H)"
if [ "$FORCE_WINDOW" != "1" ] && [ "$hora" -ge 10 ] && [ "$hora" -lt 21 ]; then
  fail "son las ${hora}:xx en Madrid: dentro de la franja 10:00–21:00. El recreate corta WhatsApp unos segundos. FORCE_WINDOW=1 para forzar."
fi
test -d "$REPO" || fail "no existe el checkout $REPO"
test -d "$DATA_DIR" || fail "no existe $DATA_DIR"
test -f "$REPO/.env" || fail "no existe $REPO/.env"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || fail "el contenedor $CONTAINER no está en marcha"
pass "sanity: SHA_MERGE=$SHA_MERGE · fuera de horario (${hora}:xx Madrid) · repo, datos y contenedor presentes"

# ─── 1 · Precheck: esquema y recuentos REALES ───
PRE_SCHEMA="$(schema_now)"
PRE_COUNTS="$(counts_now)"
[ "$PRE_SCHEMA" = "$SCHEMA_BEFORE" ] || fail "el esquema en producción es $PRE_SCHEMA y se esperaba $SCHEMA_BEFORE: PARAR y revisar antes de migrar"
docker exec "$CONTAINER" npm run db:health -- --full
pass "precheck: esquema $PRE_SCHEMA · recuentos orders/conversations/messages = $PRE_COUNTS"

# ─── 2 · Guarda de doble bot ───
n_bots="$(docker ps --format '{{.Names}}' | grep -c "^${CONTAINER}$" || true)"
[ "$n_bots" = "1" ] || fail "hay $n_bots contenedores llamados $CONTAINER"
docker compose -p "$PROJECT" ps
pass "un solo bot sobre los datos"

# ─── 3 · Backup fresco fuera del repo ───
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rescue_dir="${BACKUP_ROOT%/}/cazador-${stamp}"
mkdir -p "$rescue_dir"
docker exec "$CONTAINER" npm run backup
cp -a "$DATA_DIR" "$rescue_dir/data"
cp -a "$AUTH_DIR" "$rescue_dir/auth"
test -s "$rescue_dir/data/messages.db" || fail "el backup no contiene messages.db"
test -n "$(find "$rescue_dir/auth" -mindepth 1 -print -quit)" || fail "el backup no contiene la sesión de WhatsApp"
pass "backup en $rescue_dir"

# ─── 4 · .env (no se imprime ningún valor) ───
grep -qE '^PRODUCT_HUNTER_SOURCE=internal$' "$REPO/.env" || fail "falta PRODUCT_HUNTER_SOURCE=internal en $REPO/.env (añádelo y relanza)"
ADLIB_TOKEN_PRESENTE="$(grep -cE '^META_AD_LIBRARY_ACCESS_TOKEN=.+' "$REPO/.env" || true)"
DROPEA_KEY_PRESENTE="$(grep -cE '^DROPEA_API_KEY=.+' "$REPO/.env" || true)"
DROPEA_API_ENABLED="$(grep -E '^DROPEA_API_ENABLED=' "$REPO/.env" | cut -d= -f2 || true)"
[ "$ADLIB_TOKEN_PRESENTE" = "1" ] || info "META_AD_LIBRARY_ACCESS_TOKEN no está: el cruce y la fuente Ad Library dirán que falta (no bloquea)"
[ "$DROPEA_KEY_PRESENTE" = "1" ] && [ "${DROPEA_API_ENABLED:-0}" = "1" ] || info "Dropea sin DROPEA_API_KEY o sin DROPEA_API_ENABLED=1: el sync dirá que la lectura está deshabilitada (no bloquea)"
pass ".env: PRODUCT_HUNTER_SOURCE=internal · token Ad Library presente=$ADLIB_TOKEN_PRESENTE · Dropea key presente=$DROPEA_KEY_PRESENTE · DROPEA_API_ENABLED=${DROPEA_API_ENABLED:-vacío}"

# ─── 5 · Etiqueta de la imagen actual (rollback de código) ───
IMAGE_PREV="$(docker inspect --format='{{.Image}}' "$CONTAINER")"
docker tag "$IMAGE_PREV" "$IMAGE_TAG_PREV"
pass "imagen actual $IMAGE_PREV etiquetada como $IMAGE_TAG_PREV"

# ─── 6 · Fetch y checkout EXACTO ───
git_in_repo fetch origin "$BRANCH" -v
git_in_repo checkout "$SHA_MERGE"
HEAD_NOW="$(git_in_repo rev-parse HEAD | tr -d '[:space:]')"
[ "$HEAD_NOW" = "$SHA_MERGE" ] || fail "el checkout quedó en $HEAD_NOW, no en $SHA_MERGE"
pass "checkout en $HEAD_NOW"

# ─── 7 · Build con identidad y recreate ───
export GIT_SHA="$SHA_MERGE"
( cd "$REPO" && docker compose -p "$PROJECT" build "$SERVICE" )
pass "imagen construida con GIT_SHA=$GIT_SHA"
( cd "$REPO" && docker compose -p "$PROJECT" up -d --no-build --force-recreate "$SERVICE" )
pass "contenedor reemplazado"

# ─── 8 · Health ───
for i in $(seq 1 30); do
  estado="$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo desconocido)"
  [ "$estado" = "healthy" ] && break
  sleep 5
done
[ "$estado" = "healthy" ] || fail "el contenedor no está healthy tras 150 s (estado: $estado). Ver docker logs --tail 150 $CONTAINER"
reinicios="$(docker inspect --format='{{.RestartCount}}' "$CONTAINER")"
[ "$reinicios" = "0" ] || fail "el contenedor se ha reiniciado $reinicios veces"
POST_SCHEMA="$(schema_now)"
POST_COUNTS="$(counts_now)"
[ "$POST_SCHEMA" = "$SCHEMA_AFTER" ] || fail "esquema tras el despliegue: $POST_SCHEMA, esperado $SCHEMA_AFTER"
[ "$POST_COUNTS" = "$PRE_COUNTS" ] || fail "los recuentos cambiaron: antes $PRE_COUNTS, ahora $POST_COUNTS"
LIVE_BUILD="$(curl -sS "$BASE_URL/api/health/live" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')"
[ "$LIVE_BUILD" = "$SHA_MERGE" ] || fail "/api/health/live dice build=${LIVE_BUILD:-vacío} y se desplegó $SHA_MERGE"
docker exec "$CONTAINER" npm run db:health -- --full
docker exec "$CONTAINER" npm run doctor:v43 || info "doctor:v43 con avisos: revisar la salida (F9 sin tests en la imagen es esperado)"
pass "healthy · 0 reinicios · esquema $POST_SCHEMA · recuentos intactos ($POST_COUNTS) · build $LIVE_BUILD"

# ─── 9 · Primera ejecución ───
SYNC_EXIT="omitido"; SYNC_RESUMEN="omitido"; DROPEA_RAW_CAMPOS="omitido"; CRUCE_RESUMEN="omitido"
if [ "$SKIP_FIRST_RUN" != "1" ]; then
  set +e
  docker exec "$CONTAINER" npm run hunter:dropea:sync | tee /tmp/cazador-sync.log
  SYNC_EXIT="${PIPESTATUS[0]}"
  set -e
  SYNC_RESUMEN="$(grep -E '✓|✗|⚠' /tmp/cazador-sync.log | tr '\n' ' ' | cut -c1-300)"
  case "$SYNC_EXIT" in
    0) pass "sync del catálogo de Dropea completo" ;;
    3) info "sync PARCIAL (código 3): la copia está mezclada con la anterior; relanzar hunter:dropea:sync cuando termine el despliegue" ;;
    2) info "sync sin credenciales de Dropea (código 2): el resto del Cazador funciona; añadir DROPEA_API_KEY/DROPEA_API_ENABLED=1 después" ;;
    *) info "sync terminó con código $SYNC_EXIT: revisar /tmp/cazador-sync.log" ;;
  esac
  if [ "$SYNC_EXIT" = "0" ] || [ "$SYNC_EXIT" = "3" ]; then
    # Extra gratis: ¿trae Dropea peso o medidas no documentados? Solo las CLAVES, ningún valor.
    DROPEA_RAW_CAMPOS="$(db_read "const r=d.prepare('SELECT raw_json FROM dropea_catalog LIMIT 1').get();console.log(r?Object.keys(JSON.parse(r.raw_json).variant).join(','):'sin filas')")"
    info "campos crudos por variante en Dropea: $DROPEA_RAW_CAMPOS"
    set +e
    docker exec "$CONTAINER" npm run hunter:cruce-dropea -- --limite "$CRUCE_LIMITE" | tee /tmp/cazador-cruce.log
    cruce_exit="${PIPESTATUS[0]}"
    set -e
    CRUCE_RESUMEN="$(grep -E 'Parada:' /tmp/cazador-cruce.log | head -1)"
    [ "$cruce_exit" = "0" ] && pass "primer cruce lanzado: $CRUCE_RESUMEN" || info "el cruce terminó con código $cruce_exit ($CRUCE_RESUMEN): revisar /tmp/cazador-cruce.log (sin token de Ad Library sale con 2)"
  fi
fi

# ─── Informe ───
cat <<EOF

CAZADOR INTERNO DEPLOY REPORT
SHA_MERGE=$SHA_MERGE
PRE_DEPLOY_SCHEMA=$PRE_SCHEMA
POST_DEPLOY_SCHEMA=$POST_SCHEMA
PRE_COUNTS=$PRE_COUNTS
POST_COUNTS=$POST_COUNTS
BACKUP=$rescue_dir
DEPLOY_GUARD=un solo bot
IMAGE_PREV=$IMAGE_PREV ($IMAGE_TAG_PREV)
HEALTH=healthy, $reinicios reinicios
HEALTH_LIVE_BUILD=$LIVE_BUILD
ADLIB_TOKEN_PRESENTE=$ADLIB_TOKEN_PRESENTE
DROPEA_KEY_PRESENTE=$DROPEA_KEY_PRESENTE
DROPEA_API_ENABLED=${DROPEA_API_ENABLED:-vacío}
SYNC_EXIT=$SYNC_EXIT
SYNC_RESUMEN=$SYNC_RESUMEN
DROPEA_RAW_CAMPOS=$DROPEA_RAW_CAMPOS
CRUCE=$CRUCE_RESUMEN
PANEL_BUSCAR_DROPEA=      (rellenar a mano tras validar en el panel)
PANEL_CRUCE=
PANEL_HECHOS_SCORE=
PANEL_STUDIO=
ROLLBACK_REQUIRED=No
FINAL_VERDICT=
EOF
printf '\nPASS · despliegue del Cazador interno verificado. Conserva esta salida y valida el panel (paso 9 del runbook).\n'
