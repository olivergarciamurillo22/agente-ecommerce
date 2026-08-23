# Casamable NAS Control Center — Smoke Test Report

Despliegue y validación de la rama `feat/dropi-dropea` en el NAS real de producción (UGREEN DXP2800, `192.168.2.109`). Ejecutado el **22-08-2026** entre las 19:41 y las 20:32 (hora de Madrid), guiado paso a paso y con verificación antes/después de cada acción con efecto.

**Veredicto: CONTROL CENTER STABLE ON NAS.**
*(No se declara READY FOR PRODUCTION SUPPLIER WRITES — sigue todo cerrado y así debe quedarse.)*

---

## 1 · Commit desplegado

`45c2bd9` — "El «conectado» de WhatsApp se contrasta con el latido real del bot; docs"

Rama `feat/dropi-dropea`, árbol limpio, tracking configurado contra `origin/feat/dropi-dropea`.
Versión anterior desplegada: `79fae0c` en `main`. **`main` no se ha mergeado ni modificado.**

Nota: `origin/main` también avanzó a `a83dc73` ("Docs: despliegue real en producción y guía de colaboración") y ese commit ya está incluido en la base de `feat/dropi-dropea`, así que no había nada que mergear.

## 2 · Container health

`casamable-agent` — **Up, healthy**. Imagen `casamable-agent:latest` reconstruida sin errores.
Puerto `3000→3000/TCP`. Límites 2 cores / 1.5 GB.
Política de reinicio real del motor Docker: **`unless-stopped`** (confirmado por `docker inspect`; el toggle "Auto restart: Disabled" del panel UGOS es otra cosa y NO debe usarse como fuente de verdad).

## 3 · Uptime y reinicios

Contenedor recreado a las **20:02:42**. `healthy` a los ~2 minutos (el healthcheck tiene `start_period: 90s`).
**`RestartCount: 0`** antes, después y tras 29 minutos de observación — sin restart loop.

## 4 · WhatsApp

Reconectó **solo, sin pedir QR**: `[bot] ✓ conectado como 34641308254`, 1,3 s después del arranque.
Watchdog activo. Envíos reales `ENABLED` pero limitados por `TEST_MODE=1` a la allowlist de 2 teléfonos.
Panel: OK, número enmascarado (`346XXXXXX54`).

## 5 · SQLite

`quick_check`: **ok**. Journal: **WAL**. Tamaño DB 264.0 KB. Páginas 89, freelist 2.
Sin pérdida de datos: todas las filas previas conservadas.

## 6 · Versión de esquema

**`user_version`: 0 → 2** (esperada: 2). Migración aplicada correctamente y de forma idempotente.

## 7 · Tablas nuevas

Creadas las tres: **`service_health`**, **`scheduler_runs`**, **`integration_events`**.
También presentes `supplier_product_mapping` y `supplier_webhook_events` (de los commits previos de proveedores).

## 8 · Tamaño de la DB

264.0 KB (270.336 bytes), sin cambios respecto a antes del despliegue.

## 9 · Tamaño del WAL

**3.9 MB** (4.120.032 bytes) — invariable antes, después del reinicio y tras 29 min de observación.
El reinicio **no compactó el WAL**, contra lo previsto. Es comportamiento normal de SQLite: el fichero se reutiliza y no se trunca salvo `journal_size_limit`. Sí se confirmó que el *checkpoint* funciona: durante la observación el `.db` creció de 264 KB a 356 KB (los datos del WAL se volcaron al fichero principal) mientras el WAL mantuvo su tamaño reservado.

El Control Center lo muestra pero **no lo marcó como aviso**. En ese momento el umbral exigía **ambas** condiciones — WAL > 4 MB **y** WAL > 4× el tamaño de la DB. El WAL (3.9 MB) se quedaba justo por debajo del piso absoluto de 4 MB, así que no saltaba aunque el ratio contra la DB (264 KB) estuviera muy por encima de 4×. **Corregido el mismo día**: el commit `1f1efab` baja el piso a 2 MB precisamente por este hallazgo, así que un WAL de 3.9 MB sí dispara el aviso a partir de ahora. Ver la nota actualizada en `docs/SYSTEM-CONTROL-CENTER.md`.

## 10 · Backups

**4 copias**, retención 7 días (hardcodeada en `scripts/backup-db.ts`), cron diario a las 03:00.
Copia de seguridad pre-despliegue creada a propósito: `messages-2026-08-22_2002.db` (292 KB, 18 pedidos, **integridad ok**) — es el punto de retorno exacto.
El Control Center detecta la copia correctamente y verifica su integridad.

## 11 · Schedulers

Los cuatro relojes registrados y **healthy**:

| Tarea | Intervalo | Primer latido |
|---|---|---|
| `scheduler:orders` | 20 s | 20:08:02 |
| `scheduler:outbox` | 2 s | 20:07:45 |
| `scheduler:tracking` | 5 min | 20:07:42 |
| `scheduler:watchdog` | 5 min | 20:07:43 |

⚠️ Punto importante para no confundir en el futuro: a los 4 min del arranque, `tracking` y `watchdog` aparecían como *"nunca ha dado señales"*. **No era un fallo**: su primer latido es a los 5 minutos exactos. Se confirmó al segundo (arranque 20:02:42 → latidos 20:07:42/43). Es el caso "unknown inicial ≠ fallo".

`scheduler_runs`: 0 filas al arrancar — correcto, solo se registran ticks con trabajo real.
**Validado con trabajo real durante la observación**: a los 29 min, `orders` y `outbox` mostraban "última con trabajo: 1 procesado(s)". El registro de ejecuciones funciona end-to-end, no solo el latido.

## 12 · Outbox

**0 pendientes**, 0 retenidos. 18 enviados en 24 h al desplegar → 19 tras la observación (un envío real a las **20:25:04**, procesado correctamente). Sin atascos ni retenidos en ningún momento.

## 13 · Shopify

OK. Autenticación `client_credentials`, escrituras (tag `WA_CONFIRMED`) **permitidas**. Sin token visible en el panel.
Sin errores de API registrados.

## 14 · Dropea

**APAGADO — "sin API key: integración preparada pero apagada"**. Estado correcto y deseado:

- API key: falta · Lectura: apagada · Escritura nuestra: **bloqueada**
- ¿Quién crea los pedidos?: **su app oficial (nosotros NO)**
- Mercado: ES · `store_id`: pendiente de `dropea:doctor`
- **Secreto de webhooks: falta** — confirma que `DROPEA_WEBHOOK_SECRET` no llegó a guardarse en el `.env`
- 7 días: firmas inválidas/duplicados 0/0 · adoptados/tracking/429 0/0/0

## 15 · Dropi PRO

**APAGADO — "receptor apagado (fail-closed): falta confirmar cómo firma Dropi"**. Estado correcto:

- Autenticación confirmada: **NO — pendiente**
- Mapa de estados: **pendiente** (estados → desconocido)
- Último aviso recibido: nunca · Estados sin mapear (7 días): 0

## 16 · Tracking

Motor arrancado: `[TRACKING] polling de envíos activo (cada 300s)`. Panel: OK, "sin envíos activos".

## 17 · Eventos — avisos

**Ninguno.** `integration_events`: 0 filas.

## 18 · Eventos — críticos

**Ninguno.** Panel: "Ningún problema registrado".

## 19 · Fuga de secretos / PII

**Ninguna detectada.** Revisado visualmente todo el panel:

- Teléfono del negocio enmascarado (`346XXXXXX54`) en todas las tarjetas del Control Center
- Shopify muestra el *tipo* de auth (`client_credentials`), nunca el token
- Dropea muestra "falta"/"pendiente" en API key y signing secret, nunca valores
- Sin `.env`, sin credenciales de Baileys, sin direcciones ni teléfonos de clientes
- Los logs de arranque tampoco filtran nada

## 20 · Persistencia — `auth/`

**Intacta.** 153 → 155 ficheros (crece sola, Baileys reescribe la sesión constantemente). **WhatsApp no pidió QR.**

## 21 · Persistencia — base de datos

**Intacta**, con la actividad normal del rato transcurrido:

| Tabla | Antes | Después |
|---|---|---|
| `orders` | 17 | 18 |
| `messages` | 77 | 78 |
| `outbox` | 40 | 41 |
| `conversations` | 17 | 18 |
| `connection_state` | 1 | 1 |
| `settings` | 1 | 1 |

## 22 · Errores encontrados

**Ninguno bloqueante.** Dos observaciones menores:

1. **Tiempos relativos desfasados en el panel** (~60 min). Diagnosticado como **reloj del PC de Pedro mal configurado** (probablemente CET en vez de CEST), no un fallo del Control Center. Evidencia decisiva: en la misma tarjeta de backups, el badge calculado en servidor dice "hace 9 min" (correcto) y la fila calculada en el navegador dice "hace 68 min". *Conviene confirmarlo abriendo el panel desde el móvil.*
2. **El aviso de "WAL hinchado" no saltó** con un WAL de 3.9 MB sobre una DB de 264 KB. Causa (punto 9): el piso absoluto era 4 MB en el momento del test, y 3.9 MB se quedaba justo por debajo del ratio 4×. Corregido el mismo día bajando el piso a 2 MB.

## 23 · Cosas esperadas que aparecen unknown/apagado

Todas correctas, ninguna requiere acción:

- **Dropea APAGADO** — no hay API key en el `.env`
- **Dropi APAGADO** — autenticación de sus webhooks sin confirmar (fail-closed deliberado)
- **`scheduler_runs` a 0** — solo se registran ticks con trabajo
- **`integration_events` a 0** — sin actividad de integraciones aún
- **`whatsapp`/`shopify`/`dropea`/`dropi` sin fila en `service_health`** — se registran con actividad real
- **"Última ejecución con trabajo: —"** en los 4 relojes — aún sin trabajo que procesar
- **7 líneas `[SUPPLIER] #10XX routing → unknown | manual_review`** — el subsistema evalúa pedidos y **decide no hacer nada**: exactamente el comportamiento seguro

## 24 · Cambios realizados

1. `git fetch` + `checkout feat/dropi-dropea` + `pull` (repo en disco)
2. `chmod -R u+rwX,go+rX` sobre el repo — necesario porque `alpine/git` escribe como root (mismo bug de `EACCES` del despliegue original)
3. **`chmod 600` sobre el `.env`** — el `chmod -R go+rX` anterior lo habría dejado legible por cualquier usuario del NAS. *Mejora de seguridad respecto al estado previo.*
4. `docker compose build` + `up -d` (recreación del contenedor)
5. Backup manual pre-despliegue (`npm run backup`)
6. Migración automática de esquema al arrancar (`user_version` 0 → 2, 3 tablas nuevas)

**No se tocó:** `main`, el `.env` (contenido), volúmenes, SQLite (datos), `auth/`, flags de proveedores, webhooks, Releasit, ni apps de Shopify. No se usó `down -v`. No se reinició el VPS.

## 25 · ¿Hace falta rollback?

**No.** El sistema está sano y operativo.

Procedimiento por si acaso: `git checkout main` → `docker compose build` → `docker compose up -d`. La copia `messages-2026-08-22_2002.db` es el punto de retorno de datos, aunque no haría falta: la migración es aditiva (`CREATE TABLE IF NOT EXISTS`) y `main` ignora sin más las tablas nuevas.

## 26 · ¿Estable para dejarlo funcionando?

**Sí.** Se cumplen las 8 condiciones exigidas: contenedor healthy · SQLite sano (`quick_check: ok`) · persistencia intacta (`auth/` y DB) · WhatsApp funcionando sin QR · sin restart loop (`RestartCount: 0`) · sin errores críticos · sin fuga de secretos · funcionalidad actual operativa.

## 27 · Siguiente paso recomendado

Por orden de impacto en el negocio:

1. **Arreglar el campo "Localidad" en el formulario COD de Releasit.** Sigue siendo el hallazgo nº1: el 100% de pedidos con `city = "-"` bloquea cualquier envío real, con Control Center o sin él. Es lo único de esta lista que hoy está costando dinero.
2. **Cerrar la incógnita de Dropi PRO**: abrir "Editar" en la integración `Shopify - Dropify PRO app` (Mis Tiendas) para confirmar si ya crea pedidos automáticamente. Mientras no se sepa, `LEGACY_SUPPLIER_INTEGRATIONS_DISABLED` debe seguir cerrado.
3. **Localizar la API REST de Dropi PRO** (URL base, autenticación, endpoint de creación, esquema de SKU, mapa completo `status_id → status_name`). Su panel no la expone en ningún sitio evidente; probablemente haya que pedírsela a su soporte.
4. **Guardar `DROPEA_WEBHOOK_SECRET`** en el `.env` del NAS (el panel confirma que falta) — sin activar nada aún.
5. **Verificar el desfase horario** abriendo el panel desde el móvil, para descartar del todo que sea del Control Center.
6. **Calibrar umbrales** con tráfico real (outbox 15 min, tracking 12 h, backup 24/48 h) — son env vars, no requieren tocar código.

---

## Anexo · Ventana de observación (29 minutos)

Foto tomada a las **20:32**, con el contenedor arriba desde las 20:02:42.

| Métrica | Al desplegar | A los 29 min | Veredicto |
|---|---|---|---|
| Health | healthy | **healthy** | estable |
| RestartCount | 0 | **0** | sin reinicios |
| CPU | ~1% | **1.11%** | estable |
| RAM | 366 MB / 1.5 GB | **376.7 MB / 1.5 GB** | estable, 25% del límite |
| `messages.db` | 264 KB | **356 KB** | checkpoint funcionando |
| WAL | 3.9 MB | **3.9 MB** | sin crecimiento |
| `orders` | 18 | 18 | — |
| `messages` | 78 | 79 | actividad normal |
| `outbox` | 41 | 42 | actividad normal |
| Enviados 24 h | 18 | **19** | envío real procesado a las 20:25:04 |
| Pendientes outbox | 0 | **0** | sin atascos |
| `integration_events` | 0 | **0** | sin incidencias |
| `supplier_webhook_events` | 0 | **0** | **cero escrituras a proveedores** |
| Schedulers | 4 latiendo | **4 latiendo + 2 con trabajo real** | ciclo completo validado |

Diagnóstico final del CLI: `✓ Sin problemas críticos.`

Lo más valioso de esta ventana: el sistema **no solo arrancó, sino que trabajó**. Procesó un envío real y lo registró en `scheduler_runs`, validando el ciclo entero (scheduler → outbox → WhatsApp → registro de salud) sobre infraestructura de producción. Y con `supplier_webhook_events` e `integration_events` en cero: ni un solo intento de escritura a Dropea o Dropi PRO.

---

*Smoke test ejecutado sobre infraestructura real de producción. Ninguna escritura a proveedores, ningún webhook nuevo configurado, ninguna app de Shopify modificada.*
