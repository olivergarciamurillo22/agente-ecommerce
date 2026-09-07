# Release Casamable v4.3 — NAS

Este procedimiento complementa `NAS-PRODUCTION.md`. Se ejecuta en el NAS, fuera de la ventana 10:00–21:00, y mantiene cerradas las llamadas automáticas, la rampa y las escrituras Shopify salvo decisión posterior de Pedro.

## Vía recomendada: verificación automatizada

Desde la raíz del repositorio en el NAS, define `V43_BACKUP_ROOT` con una ruta de rescate confirmada por Pedro y ejecuta `bash scripts/nas-verify-v43.sh`. El script sustituye la secuencia manual de las secciones siguientes: se detiene en el primer fallo y cubre doble bot, backups, integridad, build, recreación, doctor y smoke HTTP.

La automatización **no** significa «ejecutar y olvidar»: el operador debe leer cada línea, conservar la salida y comprobar el detalle del doctor. Las secciones manuales siguientes siguen siendo la referencia para diagnosticar o reanudar un paso fallido.

## 0. Antes de tocar el NAS (07-09)

- Con una copia real de `messages.db` del NAS: `npm run migration:verify -- --db <copia>` en local. Debe terminar en `user_version 15 → 30`, `integrity ok → ok` y recuentos intactos (`MIGRATION-v4.3.md` §2). Sin copia real, el fixture (`--fixture`) solo prueba la herramienta.
- Construir con `GIT_SHA=$(git rev-parse HEAD)` (lo hace `scripts/nas-verify-v43.sh`); tras arrancar, `/api/health/live` debe devolver ese `build`. `sin_confirmar` = la imagen se construyó sin SHA: no aceptar.
- Nada nuevo se activa por sí solo: los tres flags (`ADDRESS_AI_VALIDATION_ENABLED`, `AUTO_DISPATCH_COOLDOWN_ENABLED`, `POST_CONFIRMATION_AI_ENABLED`) siguen a 0 y `dispatch_channels` nace vacía. Solo la capa 1 de direcciones (determinista) actúa, y solo abre alertas. Ver `ESTADO-PRODUCCION.md` §3.

## 1. Identidad y doble bot

```bash
cd <carpeta-del-repo-en-el-NAS>
npm run deploy:guard -- --data-dir /volume1/docker/CasamableAgent/data
docker compose -p repo-v3c ps
```

La guarda debe declarar un solo contenedor sobre los datos. Un resultado `PELIGRO` o `UNAVAILABLE` bloquea el despliegue. No se levanta otro proyecto Compose.

## 2. Rescate previo fuera del repositorio

```bash
sudo mkdir -p /volume1/docker/CasamableAgent-release-backups/v4.3-predeploy
docker exec casamable-agent npm run backup
sudo cp -a /volume1/docker/CasamableAgent/data /volume1/docker/CasamableAgent-release-backups/v4.3-predeploy/data
sudo cp -a /volume1/docker/CasamableAgent/auth /volume1/docker/CasamableAgent-release-backups/v4.3-predeploy/auth
docker inspect --format='{{.Image}}' casamable-agent
docker tag <sha256-anterior> casamable-agent:pre-v4.3
```

Anotar el SHA Git y el SHA de imagen anteriores. Comprobar que las copias contienen `messages.db` y la sesión, tienen tamaño mayor que cero y están fuera del checkout.

## 3. Construir y reemplazar

```bash
git fetch origin
git checkout <SHA-v4.3-aprobado>
git rev-parse HEAD
docker compose -p repo-v3c build casamable-agent
docker compose -p repo-v3c up -d --no-build casamable-agent
```

No usar `down`, `down -v`, otro nombre de proyecto ni `up --build` en la ventana crítica.

## 4. Verificación obligatoria

```bash
docker compose -p repo-v3c ps
docker inspect --format='{{.RestartCount}} {{.State.Health.Status}}' casamable-agent
docker exec casamable-agent npm run db:health -- --full
docker exec casamable-agent npm run whatsapp:templates:doctor -- --check-only
docker exec casamable-agent npm run retell:doctor
docker exec casamable-agent npm run readiness:runtime
docker logs --tail 150 casamable-agent
```

Aceptar únicamente con:

- contenedor `healthy`, cero reinicios y un solo bot;
- SQLite `integrity_check=ok`, `user_version=30` (19 = Hunter, 20 = predictivo, 21 = discovery, 22 = validación de direcciones, 23 = auto-despacho, 24 = canal de despacho, 25 = auto-cancelación IA, 26 = aviso de despacho, 27 = tope diario de IA, 28 = estado de corrida de discovery, 29 = cola de búsquedas, 30 = tipos de trabajo de la cola (auditoría y cadena); el doc decía 19 antes de la consolidación del 07-09; tablas nuevas desde 15: `users`, `sessions`, `audit_log`, `product_candidates`, `candidate_events`, `hunter_predictive_estimates`, `adlib_*`, `address_validations`, `address_alerts`, `dispatch_cooldowns`, `intent_classifications`, `dispatch_channels`, `ai_cancellations`, `ai_call_log`, `discovery_jobs`, además de las de atribución/versión de agente) y recuentos de pedidos, conversaciones, mensajes, outbox y eventos coherentes con los anotados antes del despliegue;
- WhatsApp: 7 plantillas activas PASS, 1 deshabilitada y 0 FAIL;
- Retell y readiness sin bloqueos ocultos. `UNAVAILABLE_API` para saldo Retell es un aviso conocido: se comprueba manualmente en Billing;
- `/api/health/live` devuelve `build` igual al SHA desplegado;
- ningún envío real inesperado y ningún secreto en logs.

## 5. Rollback de código/imagen

Si falla una condición:

```bash
cat > docker-compose.rollback-v43.yml <<'YAML'
services:
  casamable-agent:
    image: casamable-agent:pre-v4.3
YAML
docker compose -p repo-v3c -f docker-compose.yml -f docker-compose.rollback-v43.yml up -d --no-build --force-recreate casamable-agent
docker compose -p repo-v3c ps
docker exec casamable-agent npm run db:health -- --full
npm run deploy:guard -- --data-dir /volume1/docker/CasamableAgent/data
```

El rollback revierte la imagen, **no revierte la migración SQLite 15→30**. No se restaura la DB automáticamente y nunca se usa `down -v`. Si el código anterior no entiende schema 30, mantener `EMERGENCY_STOP=1`, conservar datos y escalar antes de cualquier restauración. La copia externa de `data/` y `auth/` solo se restaura con autorización expresa y diagnóstico de corrupción de datos.
