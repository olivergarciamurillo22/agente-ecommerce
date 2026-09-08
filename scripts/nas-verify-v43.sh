#!/usr/bin/env bash
set -euo pipefail

# Verificación/despliegue v4.3 para ejecutar EN EL NAS desde la raíz del repo.
# No es «ejecutar y olvidar»: hay que leer cada PASS y cualquier salida del doctor.

PROJECT="repo-v3c"
SERVICE="casamable-agent"
CONTAINER="casamable-agent"
DATA_DIR="${V43_DATA_DIR:-/volume1/docker/CasamableAgent/data}"
AUTH_DIR="${V43_AUTH_DIR:-/volume1/docker/CasamableAgent/auth}"
BASE_URL="${V43_BASE_URL:-http://127.0.0.1:${HOST_PORT:-3000}}"

# CONFIRMAR CON PEDRO: definir fuera del repositorio una carpeta de rescate
# con espacio suficiente, por ejemplo mediante `export V43_BACKUP_ROOT=...`.
: "${V43_BACKUP_ROOT:?CONFIRMAR CON PEDRO: define V43_BACKUP_ROOT fuera del repositorio}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rescue_dir="${V43_BACKUP_ROOT%/}/v4.3-${stamp}"

pass() { printf 'PASS · %s\n' "$1"; }
expect_http() {
  expected="$1"
  method="$2"
  url="$3"
  actual="$(curl -sS -o /dev/null -w '%{http_code}' -X "$method" "$url")"
  test "$actual" = "$expected"
  pass "$method $url → $actual"
}

printf '\nCASAMABLE v4.3 · VERIFICACIÓN NAS\n\n'

# La guarda acepta cero o un contenedor sobre DATA_DIR y falla si detecta dos.
# El contenedor actual puede existir: se necesita para hacer el backup previo.
npm run deploy:guard -- --data-dir "$DATA_DIR"
pass "guarda de doble bot"

test -d "$DATA_DIR"
test -d "$AUTH_DIR"
mkdir -p "$rescue_dir"
docker exec "$CONTAINER" npm run backup
docker exec "$CONTAINER" npm run db:health -- --full
cp -a "$DATA_DIR" "$rescue_dir/data"
cp -a "$AUTH_DIR" "$rescue_dir/auth"
test -s "$rescue_dir/data/messages.db"
test -n "$(find "$rescue_dir/auth" -mindepth 1 -print -quit)"
pass "backup DB íntegro y auth en $rescue_dir"

# Identidad del build (07-09): el SHA del checkout viaja dentro de la imagen y
# lo devuelve /api/health/live como `build`. Así nunca vuelve a ser una incógnita.
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo sin_confirmar)"; export GIT_SHA
printf 'INFO · construyendo commit %s\n' "$GIT_SHA"
# Inline además del export: si alguien ejecuta este script sin sudo y docker
# lo exige, «sudo docker compose» no heredaría la variable (incidencia 08-09).
GIT_SHA="$GIT_SHA" docker compose -p "$PROJECT" build "$SERVICE"
pass "imagen construida"
docker compose -p "$PROJECT" up -d --no-build --force-recreate "$SERVICE"
pass "contenedor reemplazado"

docker exec "$CONTAINER" npm run doctor:v43
pass "doctor:v43"

expect_http 307 GET "$BASE_URL/"
expect_http 200 GET "$BASE_URL/api/health"
# El contenedor en marcha tiene que ser EXACTAMENTE el commit que acabamos de
# construir: /api/health/live devuelve `build` con el SHA incrustado.
live_build="$(curl -sS "$BASE_URL/api/health/live" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')"
if [ "$live_build" != "$GIT_SHA" ]; then
  printf 'FAIL · el contenedor dice build=%s y el checkout es %s\n' "${live_build:-vacío}" "$GIT_SHA"
  exit 1
fi
pass "el contenedor en marcha es exactamente el commit $GIT_SHA (PRODUCTION_COMMIT)"
expect_http 200 GET "$BASE_URL/login"
expect_http 401 POST "$BASE_URL/api/webhooks/retell/call-events"

printf '\nPASS · RELEASE v4.3 verificada. Conserva esta salida y revisa los logs.\n'
