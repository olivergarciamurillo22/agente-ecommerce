# DESPLIEGUE DEL CIERRE OPERATIVO — pasos exactos para Pedro

> Máximo 2 páginas. Comandos para TU NAS, copiables tal cual.
> Regla de oro: **fuera de la franja 10:00–21:00** y **jamás `down -v`**.
> Detalle completo y rollback: `docs/DEPLOY-MANIFEST-26-08.md`.

## 0 · Qué vas a desplegar

`main` con el cierre operativo (commit `73884b1`). Contiene TODO lo que ya
corre en producción más: pestaña **Acciones** (tu bandeja), detección de
duplicados al entrar el pedido, watchdog de cancelaciones, y los comandos
`deploy:precheck`, `casamable:simulate` y `readiness`. **No cambia** ni el
proveedor de WhatsApp (sigue Baileys) ni las llamadas (siguen apagadas) ni
ninguna variable del `.env`.

## 1 · Backup (2 min) — SIEMPRE antes

```bash
cd /volume1/docker/casamable   # tu carpeta del compose
docker compose exec casamable-agent npm run backup
ls -lh backups/ | tail -3      # la copia de hoy, tamaño > 0
```

## 2 · Apuntar el commit actual (tu rollback)

El NAS no tiene git: usa el contenedor desechable de siempre.

```bash
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo rev-parse HEAD
```

**Escribe ese hash en un papel o nota.** Es tu vuelta atrás.

## 3 · Traer y situarse en la versión nueva

```bash
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo fetch origin
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo status --porcelain
# ↑ debe salir VACÍO. Si hay cambios locales, PARA y avisa a Óliver.
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo checkout 73884b1
ls repo/.env   # el .env sigue en su sitio (trampa conocida del checkout)
```

## 4 · Pre-check ANTES de reconstruir

Con el contenedor viejo aún corriendo no puedes ejecutar el script nuevo, así
que el precheck va justo DESPUÉS del build y ANTES de dar por bueno el
arranque — el orden correcto es:

```bash
docker compose build casamable-agent
docker compose run --rm casamable-agent npm run deploy:precheck
```

- **`SAFE TO DEPLOY CODE`** → sigue.
- **`BLOCKED: …`** → NO sigas. El propio mensaje dice qué falta. Arregla el
  `.env` y repite. (Los ⚠ avisos: léelos, no los ignores.)

## 5 · Levantar la versión nueva

```bash
docker compose up -d --force-recreate casamable-agent
docker compose ps          # esperar a "healthy"
```

## 6 · Verificación (10 min)

```bash
# DB migrada y sana (esquema 11/11, integridad ok):
docker compose exec casamable-agent npm run db:health

# WhatsApp: en el panel debe salir CONECTADO SIN pedir QR.
# Si pide QR: escanéalo una vez; si lo vuelve a pedir → rollback.
```

**Llamadas (IMPORTANTE, antes de las 9:00):** el código nuevo trae el
interruptor propio del piloto. Como tus llamadas están EN PRODUCCIÓN
(decisión del 26-08), decláralo explícitamente o el fail-closed las
bloqueará a las 9:00:

```bash
docker compose exec casamable-agent npm run calls:mode -- production
docker compose exec casamable-agent npm run calls:mode   # verificar: "PRODUCCIÓN" y a quién se llamará
```

(Para volver al modo seguro en cualquier momento: `npm run calls:mode -- pilot`.
Nada de esto toca TEST_MODE, WhatsApp ni Shopify.)

En el navegador, `agente.casamable.es`:

1. La vista por defecto ahora es **Acciones** (tu bandeja de trabajo).
2. Si hay cancelaciones/duplicados reales pendientes, salen ordenados con
   qué hacer. Marca UNO como resuelto con nota → refresca → sigue resuelto.
3. Pestaña Sistema: sin rojos nuevos; Shopify sin "firma inválida" nueva.
4. Llamadas: pestaña Sistema en verde con \"EN PRODUCCIÓN... cap diario 10\" (o lo que digas en calls:mode).

## 7 · Observación: 30 minutos

Déjalo correr media hora antes de darlo por estable. Cada ~10 min:
`docker compose ps` (0 reinicios), panel Sistema en verde, outbox bajando,
y **cero** intentos de llamada. Lista completa en el manifest.

## 8 · Si algo va mal → rollback (5 min)

```bash
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo checkout <HASH-DEL-PASO-2>
docker compose up -d --build --force-recreate casamable-agent
```

- **NO toques la base de datos.** El código viejo funciona sobre la DB
  migrada (las novedades se ignoran; nada se pierde).
- **JAMÁS `docker compose down -v`**: borra el volumen y con él la DB.
- Después: dile a Óliver qué viste (mensaje de error, pestaña, hora).
