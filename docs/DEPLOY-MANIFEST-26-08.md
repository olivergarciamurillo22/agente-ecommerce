# DEPLOY MANIFEST — 26-08-2026 · cierre operativo

**Preparado en local. NADA de este documento se ha ejecutado en el NAS.**

## Versión objetivo

| Qué | Valor |
|---|---|
| Rama a desplegar | `main` |
| Commit objetivo (merge del cierre) | `73884b13b89f669ac955eef6fe97ac236efa5ac3` |
| Contenido | `feat/operational-closure` @ `cadaaae7472a912d28c799949b90dcb55721f7e2` (main y fix/hardening-casamable **contenidos**: grafo lineal, cero commits de producción fuera) |
| Rama que corre HOY el NAS | `fix/hardening-casamable` @ `c6cc2260dbfa1b933321a16ccb035bc1ba92c7f5` (confirmado por el equipo de Pedro el 26-08 noche: esquema 10, backfill ordered_at 85/85). Apuntar igualmente `git rev-parse HEAD` antes de tocar nada — es el commit de rollback |
| Esquema objetivo | **v11** (el NAS está en v9 o v10 según el commit real) |
| Tests | 493 OK · typecheck ✓ · build ✓ · simulate 10/10 · readiness LOCAL READY |

## Migraciones que correrán solas al arrancar

| Versión | Cambio | Riesgo | Reversible | Acción de Pedro |
|---|---|---|---|---|
| v10 | `ALTER TABLE orders ADD COLUMN ordered_at` + índice | Bajo (aditiva, idempotente) | Sí: el código viejo ignora la columna | Ninguna (backfill `backfill-ordered-at` es opcional y aparte) |
| v11 | `CREATE TABLE IF NOT EXISTS action_resolutions` | Bajo (tabla nueva, idempotente) | Sí: el código viejo ignora la tabla | Ninguna |

Ninguna migración borra, renombra ni transforma datos. Ninguna necesita backfill para operar.

## Variables de entorno

- **NEW REQUIRED: ninguna.** Todo lo que lee el código nuevo ya existe en el `.env` del NAS.
- **NEW OPTIONAL: ninguna nueva** (los añadidos a `.env.example` son huecos documentados de secretos ya conocidos: Meta/Retell/Dropea, para el Mac de Óliver).
- **REMOVED / RENAMED: ninguna.**
- **LEGACY:** `DROPIPRO_WEBHOOK_SECRET` sigue marcada LEGACY_DO_NOT_CONFIGURE (no rellenar).
- Semántica reafirmada: `TEST_MODE` y `EMERGENCY_STOP` **sin definir = ACTIVOS** (fail-closed). En el NAS deben estar **explícitos** (`TEST_MODE=0`, `EMERGENCY_STOP=0` para operar normal). `deploy:precheck` lo avisa.

## Qué NO cambia con este deploy

- Proveedor de WhatsApp: sigue **Baileys** (`WHATSAPP_PROVIDER` no se toca; el precheck bloquea cambios no intencionados).
- Llamadas Retell: el deploy **no cambia su estado**. Realidad del NAS (26-08 noche): EN PRODUCCIÓN (`ai_calls_enabled=1`, shadow 0, cap 10, allowlist vacía). Con el código nuevo, mantener las llamadas de producción exige el paso explícito `npm run calls:mode -- production` (ver §Llamadas de la guía); sin él, el fail-closed del piloto las bloquea a las 9:00.
- Dropea: escrituras **bloqueadas** (createOrder desactivado a propósito).
- Dropi: fail-closed, sin API.
- La máquina de estados operativa (`status`) y su CHECK SQL: intactos.

## Checklist de despliegue (la ejecuta Pedro; comandos exactos en PEDRO-DEPLOY-OPERACIONAL.md)

- [ ] Backup de la DB hecho y verificado (tamaño > 0)
- [ ] Repo del NAS limpio (`git status`) y `.env` presente en su sitio
- [ ] `git fetch` + commit actual APUNTADO (rollback)
- [ ] Checkout del commit objetivo `73884b13b89f669ac955eef6fe97ac236efa5ac3` (o `origin/main`)
- [ ] `npm run deploy:precheck` dentro del contenedor → **SAFE TO DEPLOY CODE**
- [ ] Rebuild + `up -d --force-recreate` (fuera de 10:00–21:00)
- [ ] `docker compose ps` → healthy
- [ ] `npm run db:health` → OK (esquema 11/11)
- [ ] WhatsApp reconecta **sin pedir QR**
- [ ] Webhook Shopify: sin `bad_signature` nuevos
- [ ] Pestaña **Acciones** carga como vista por defecto
- [ ] Outbox sin retenidos nuevos
- [ ] Rollback ensayado mentalmente (sección de abajo leída ANTES de empezar)

## Smoke test del Action Center (con datos reales existentes, sin crear nada)

1. Abrir `agente.casamable.es` → la vista por defecto es **Acciones**.
2. Si hay pedidos con petición de cancelar / duplicados / needs_call reales, deben aparecer ordenados (cancelaciones primero) con texto en imperativo.
3. Marcar UNO como resuelto con nota → desaparece de la bandeja.
4. Refrescar la página → sigue resuelto (persistencia en `action_resolutions`).
5. Comprobar en la ficha del pedido que su estado NO cambió (resolver no toca el pedido).
6. Si la bandeja está vacía y verde: correcto — significa "nada pendiente", no "roto".

## Salud de la DB post-deploy — interpretación

`docker compose exec casamable-agent npm run db:health`

| Resultado | Veredicto |
|---|---|
| Integridad `ok` + esquema `11 (esperada: 11)` + WAL normal | **OK** |
| Aviso de WAL hinchado, o backups con aviso de edad | **WARNING ACEPTABLE** (no bloquea; anotar) |
| Integridad ≠ ok, o esquema < 11 tras arrancar, o SQLite no responde | **STOP/ROLLBACK** |

## Ventana de observación: 30 minutos tras el deploy

No declarar estable antes. Vigilar (pestaña Sistema + terminal):

1. `docker compose ps` cada ~10 min: **0 reinicios** del contenedor.
2. WhatsApp: conectado, sin QR, y si entra un mensaje real, se registra.
3. Outbox: los pendientes bajan, nada retenido nuevo.
4. Schedulers: latido reciente (pestaña Sistema), leases sin dueños zombis.
5. Acciones: carga y responde (marcar/desmarcar de prueba con nota "test deploy").
6. Shopify: si llega un webhook en la ventana, entra sin `bad_signature`.
7. Llamadas: el comportamiento coincide con `npm run calls:mode` — en producción, ninguna llamada fuera de franja ni por encima del cap; en piloto sin allowlist, CERO llamadas.
8. DB: `db:health` una vez al final de la ventana.
9. Ni un WARNING nuevo sin explicación; ningún CRITICAL.

## ROLLBACK (real, no genérico)

**Commit de vuelta:** el apuntado en el paso 3 de la checklist (el HEAD del NAS antes del pull; si no se apuntó: `c6cc2260dbfa1b933321a16ccb035bc1ba92c7f5` = HEAD de fix/hardening-casamable).

1. `git checkout <commit-apuntado>` (con el contenedor de git de siempre, `-c safe.directory=/repo`).
2. `docker compose up -d --build --force-recreate`.
3. **NO tocar la DB.** El código viejo (v9/v10) sobre una DB v11 funciona: las columnas y la tabla nuevas se ignoran, y `user_version` solo se sube, nunca se baja (verificado en el código de fe53c9d). El panel del código viejo mostrará "esquema 11 (esperada: 9/10)" — es cosmético.
4. Lo ÚNICO que se pierde al volver atrás: la pestaña Acciones y sus resoluciones dejan de verse (los datos quedan en la tabla, intactos, para el siguiente intento).
5. **JAMÁS `docker compose down -v`** (borra el volumen = borra la DB).

## Bloqueos externos conocidos (no bloquean ESTE deploy)

- Coexistence del número real pendiente (el circuito Cloud API completo YA está validado con la plantilla `order_confirmation_request` APPROVED y un ciclo entero real; el NAS volvió a baileys a propósito).
- Retell: **método de pago pendiente** (crédito de prueba; al agotarse las llamadas se paran sin aviso claro — lo más urgente de la lista externa). Prompt v6 YA validado con llamada real.
- Backfill histórico con `read_all_orders` pendiente de verificar en NAS.
