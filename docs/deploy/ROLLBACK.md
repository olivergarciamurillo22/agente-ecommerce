# Rollback — volver a la versión anterior

Documento **versionado**. Todo lo que se cita existe en el repositorio.

## Regla de oro

El rollback devuelve el **código**, nunca los **datos**. La base de datos se
queda como está: el esquema 17 lo entiende también la versión anterior
(demostrado en ensayo local, ida y vuelta, con los datos intactos).
**No restaures la base** salvo orden expresa de Óliver.

## Antes: identifica la imagen de rescate por su ID

Nunca por la etiqueta `:latest` — apunta a lo que acabas de construir, que
es justo lo que quieres abandonar.

```bash
# ID de la imagen que está corriendo AHORA (antes de desplegar, apúntalo)
docker inspect --format='{{.Image}}' casamable-agent
```

Ese `sha256:…` es tu rescate. Etiquétalo antes de desplegar:

```bash
docker tag <sha256 del rescate> casamable-agent:pre-deploy
```

## Volver atrás

```bash
cd <carpeta del repo en el NAS>

# Override mínimo que fija la imagen anterior
cat > docker-compose.rollback.yml <<'YAML'
services:
  casamable-agent:
    image: casamable-agent:pre-deploy
YAML

docker compose -f docker-compose.yml -f docker-compose.rollback.yml \
  up -d --no-build --force-recreate casamable-agent
```

El proyecto sigue siendo **`repo-v3c`** (viene en `docker-compose.yml`), así
que esto **reemplaza** el contenedor en marcha en vez de crear otro. Si
prefieres ser explícito: añade `-p repo-v3c` a los dos comandos.

**Nunca** `docker compose down -v`.

## Comprobar

```bash
docker inspect --format='{{.Image}}' casamable-agent   # == la imagen de rescate
docker ps --filter name=casamable-agent                # Up + healthy
docker exec casamable-agent npm run db:health          # esquema 17, integridad ok
docker exec casamable-agent npm run deploy:guard       # UN solo bot
```

Y en el panel: los pedidos siguen ahí y WhatsApp **no pide QR**.

## Si el rollback tampoco levanta

1. `docker logs --tail 200 casamable-agent` — pega la salida a Óliver.
2. No borres nada. No restaures la base.
3. La carpeta `/volume1/docker/CasamableAgent` es la que hay que preservar:
   `auth/` (sesión de WhatsApp), `data/` (SQLite) y `backups/`.
