# Despliegue en el NAS — producción real

Documento **versionado**: todo lo que se cita aquí existe en el repositorio.
No depende de `artifacts/` (que está en `.gitignore` y no viaja con el
código). Si un comando de aquí no existe, es un fallo a corregir.

## Identidad de producción (leer antes de nada)

| Dato | Valor |
|---|---|
| Proyecto de Compose | **`repo-v3c`** (declarado en `docker-compose.yml` con `name:`) |
| Contenedor | `casamable-agent` |
| Carpeta persistente | `/volume1/docker/CasamableAgent` (`auth/`, `data/`, `backups/`) |
| Esquema esperado | **24** con `release/casamable-v4.3` (era 18 con `7fd8014`, 05-09) |
| Proveedor de WhatsApp | `cloud_api` |

### ¿Qué commit corre ahora mismo? (`PRODUCTION_COMMIT`)

Desde el repo **no se puede saber**: ni la imagen ni el health lo exponían
(07-09-2026). Hay dos maneras, y solo la primera vale hoy:

1. **Hoy, en el NAS (Pedro):** en la carpeta del checkout con el que se
   construyó la imagen, `git rev-parse HEAD`, y contrastarlo con la fecha de
   creación de la imagen: `docker inspect casamable-agent --format
   '{{.Config.Image}} {{.Created}}'` frente a `git log -1 --format=%ci`. Si el
   checkout se movió después de construir, el commit real es el del reflog
   (`git reflog`) anterior a esa fecha. Pegar el resultado en
   `PRODUCTION_COMMIT=` de `docs/REAL-PILOT-02-09.md` y en
   `ESTADO-PRODUCCION.md`.
2. **A partir del próximo despliegue, automático:** `scripts/nas-verify-v43.sh`
   exporta `GIT_SHA=$(git rev-parse HEAD)` antes de `docker compose build`, el
   `Dockerfile` lo incrusta (`CASAMABLE_BUILD_SHA`, etiqueta
   `org.opencontainers.image.revision`) y `/api/health/live` lo devuelve como
   `build` junto a `schemaVersion`. El script FALLA si el contenedor en marcha
   no coincide con el checkout. Comprobación manual desde cualquier sitio:
   `curl -s https://agente.casamable.es/api/health/live` → `"build":"<sha>"`.
   Si dice `"sin_confirmar"`, la imagen se construyó sin el build arg: la
   incógnita es explícita, nunca un commit supuesto.

**Por qué importa el proyecto de Compose.** Por defecto Compose nombra el
proyecto según la carpeta desde la que se ejecuta. Producción nació bajo
`repo-v3c`; hacer `docker compose up -d` desde una copia del repo en otra
carpeta habría creado un proyecto distinto y **un segundo bot sobre la
misma base SQLite**: dos schedulers enviando, dos watchdogs avisando y
estado corrompido. Desde el 03-09 el nombre viaja dentro de
`docker-compose.yml` (`name: repo-v3c`), así que `up -d` **reemplaza** el
contenedor en marcha desde cualquier carpeta. No hace falta acordarse de
`-p`, pero si lo usas, que sea `-p repo-v3c`.

## Antes de tocar nada

```bash
# 1 · ¿Hay UN solo bot sobre los datos de producción?
#     SE EJECUTA EN EL NAS, NO dentro del contenedor: necesita ver Docker
#     (dentro no hay socket y el comando sale con "no se pudo hablar con
#     Docker", que es honesto pero no responde a la pregunta).
cd <carpeta del repo en el NAS>
npm run deploy:guard -- --data-dir /volume1/docker/CasamableAgent/data
```

Si dice **PELIGRO**, hay dos contenedores compartiendo la base: para uno y
repite. **No se despliega con dos vivos.**

```bash
# 2 · Estado real del sistema
docker exec casamable-agent npm run db:health          # esquema 18 + integridad
docker exec casamable-agent npm run readiness:runtime  # lo que importa EN producción
```

`readiness:runtime` es el que vale en el NAS. `npm run readiness` es de
release y compila y ejecuta la suite: **no** se usa dentro del contenedor.

```bash
# 3 · Copia de seguridad fresca (siempre, antes de desplegar)
docker exec casamable-agent npm run backup
ls -lt /volume1/docker/CasamableAgent/backups | head -3
```

## Desplegar

Ventana: **fuera de 10:00–21:00** (reiniciar corta WhatsApp).

```bash
cd <carpeta del repo en el NAS>
git fetch origin && git checkout <SHA a desplegar> && git rev-parse HEAD

docker compose build casamable-agent          # el build, fuera del momento crítico
docker compose up -d --no-build casamable-agent
```

`docker compose` usa `repo-v3c` automáticamente (viene en el fichero).
**Nunca** `docker compose down -v`: borraría volúmenes.

## Comprobar que ha ido bien

```bash
docker ps --filter name=casamable-agent            # Up + healthy
docker exec casamable-agent npm run db:health      # esquema 18, integridad ok
docker exec casamable-agent npm run readiness:runtime
docker exec casamable-agent npm run whatsapp:templates:doctor
docker exec casamable-agent npm run retell:doctor
docker logs --tail 100 casamable-agent
```

Esperado: contenedor *healthy*, **WhatsApp reconecta sin pedir QR**, esquema
18, plantillas 7 ACTIVE PASS / 1 DISABLED / 0 FAIL, y ningún secreto en los
logs.

Si algo no cuadra: `docs/deploy/ROLLBACK.md`.

## Lo que NUNCA se hace

- `docker compose down -v` (destruye volúmenes).
- Restaurar la base de datos por un problema que no sea de datos.
- Desplegar con dos contenedores sobre la misma carpeta de datos.
- Ejecutar `npm run readiness` (el de release) dentro del contenedor: no
  lleva dependencias de desarrollo y daría rojos falsos.
- Poner secretos en el repositorio. Viven en el `.env` del NAS.
