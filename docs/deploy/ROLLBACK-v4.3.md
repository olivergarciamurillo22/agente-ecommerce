# Rollback de v4.3 — qué hacer, en orden, con algo yendo mal

Complementa `docs/deploy/ROLLBACK.md` (la mecánica de volver a la imagen
anterior, que no cambia). Esto es lo específico de v4.3: **apagar lo nuevo sin
desplegar nada** y, solo si eso no basta, volver el código.

**Regla que decide todo lo demás: el rollback devuelve el CÓDIGO, nunca los
DATOS.** No se restaura `messages.db` salvo corrupción demostrada y orden
expresa.

---

## Paso 0 · Contención inmediata (30 segundos)

Si el sistema está haciendo algo malo AHORA y no sabes qué:

```bash
docker exec casamable-agent sh -c 'echo EMERGENCY_STOP=1'   # ver el valor actual
# en el .env del NAS: EMERGENCY_STOP=1
docker compose -p repo-v3c restart casamable-agent
```

`EMERGENCY_STOP=1` corta **todo WhatsApp real y toda escritura en Shopify**.
Lo que **NO** corta: las llamadas a OpenAI (validación de direcciones e
intención) y las escrituras a proveedores. **Para cortar la IA hay que apagar
sus dos flags**: `ADDRESS_AI_VALIDATION_ENABLED=0` y
`POST_CONFIRMATION_AI_ENABLED=0` (paso 1). Ojo: `OPENAI_DAILY_CALL_LIMIT=0`
NO es un freno, es lo contrario — quita el tope.

---

## Paso 1 · Apagar lo nuevo sin desplegar (el 90 % de los casos)

Las cuatro funciones de v4.3 son flags. **Se apagan editando el `.env` del NAS
y reiniciando el contenedor**: no hace falta rollback de código, no se pierde
nada y se puede volver a encender.

Este es el orden recomendado, de lo más ruidoso a lo más inocuo:

| # | Si el síntoma es… | Apaga | Qué pasa con lo que ya está en vuelo |
|---|---|---|---|
| 1 | el bot cancela pedidos que no debería, o responde textos raros tras confirmar | `POST_CONFIRMATION_AI_ENABLED=0` | el texto libre post-confirmación vuelve a ir a una persona de inmediato. **Las cancelaciones ya hechas NO se deshacen solas**: revísalas con `npm run pending:review` y usa «Revertir cancelación» en cada ficha |
| 2 | se despachan pedidos que no tocaba, o se despachan demasiado pronto | `AUTO_DISPATCH_COOLDOWN_ENABLED=0` | confirmar vuelve a disparar el hook inmediato de Beeping, como en v4.2. **CUIDADO**: los pedidos que ya tenían un temporizador programado quedan CONGELADOS — nadie los despachará solo. Hay que sacarlos a mano (abajo tienes la consulta) |
| 3 | llegan avisos de envío que no deberían | `DISPATCH_NOTICE_WHATSAPP_ENABLED=0` | deja de enviarse el aviso. Los ya enviados están enviados |
| 4 | se abren alertas de dirección a mansalva, o preocupa el gasto de OpenAI | `ADDRESS_AI_VALIDATION_ENABLED=0` | la capa 2 deja de correr; queda la capa 1 determinista, que es lo que hay en producción hoy. **Las alertas ya abiertas siguen abiertas y siguen reteniendo el auto-despacho**: ciérralas desde la ficha |

Tras cualquier cambio del `.env`:

```bash
docker compose -p repo-v3c up -d --no-build casamable-agent
docker exec casamable-agent npm run pending:review
```

### Los pedidos congelados por apagar el cooldown

Con `AUTO_DISPATCH_COOLDOWN_ENABLED=0`, el scheduler ni siquiera mira los
temporizadores vencidos. Estos son los pedidos afectados:

```bash
docker exec casamable-agent npm run db:health -- --full   # confirma que la base responde
```

Para verlos y sacarlos: en el panel, la insignia **DESPACHO RETENIDO** y el
botón **«Despachar ahora»** de cada ficha **siguen funcionando con el flag
apagado** (esa ruta no consulta el flag). Es la vía correcta: reevalúa las
condiciones antes de enviar. Si son muchos, `npm run pending:review` los lista
con su antigüedad.

---

## Paso 2 · Volver el código (si apagar flags no basta)

La mecánica es la de `docs/deploy/ROLLBACK.md` §«Volver atrás» y no cambia:
imagen de rescate por su ID, override de compose, proyecto `repo-v3c`,
`up -d --no-build --force-recreate`. **Nunca** `docker compose down -v`.

Lo que sí cambia en v4.3 es lo que hay que saber ANTES de pulsar:

### El esquema no vuelve, y no pasa nada

La base habrá pasado de **15 a 29**. Ese salto **no se deshace** y no hay que
deshacerlo:

- Las migraciones 16→29 son **aditivas**: tablas nuevas y columnas nuevas. Las
  columnas añadidas a tablas existentes son *nullable* o llevan `DEFAULT`
  (`orders.ordered_at`, `orders.dispatch_notice_sent_at`,
  `dispatch_cooldowns.channel`, `order_status_history.status_axis`…), así que
  **el código antiguo puede seguir insertando** sin tocarlas.
- El código al que vuelves (`feat/casamable-control-center-v2`) declara
  `SCHEMA_VERSION = 15` y **no lleva la guarda `assertSchemaNotNewer`** (se
  añadió en esta release). Consecuencia práctica: **arrancará sin protestar**
  sobre una base en 29, ignorará las tablas que no conoce y **no bajará el
  `user_version`**. Es el comportamiento deseado, pero conviene saberlo: no
  esperes un error si algo va mal, espera silencio.
- Si más adelante vuelves a desplegar v4.3 sobre esa misma base, la migración
  no tiene nada que hacer (es idempotente) y el `user_version` ya está en 29.

### Lo que sí se pierde al volver el código

- **El login por usuario** (`npm run users:create`): la versión anterior no lo
  tiene. Necesitarás `DASHBOARD_PASSWORD` en el `.env` para entrar al panel
  mientras dure el rollback. Ya avisaba `ROLLBACK.md`.
- **El panel no enseñará** las insignias ALERTA DIRECCIÓN, DESPACHO RETENIDO ni
  CANCELADO POR IA, ni sus botones. Los datos siguen en la base; simplemente
  no hay interfaz. Si necesitas verlos, la vía es SQL sobre una copia.
- **Nada envía ya** los avisos nuevos, y el auto-despacho deja de existir: los
  pedidos confirmados vuelven al hook inmediato de Beeping de v4.2.

### Comprobación después del rollback

```bash
docker inspect --format='{{.Image}}' casamable-agent   # == la imagen de rescate
docker exec casamable-agent npm run db:health -- --full
docker exec casamable-agent npm run deploy:guard
docker logs --tail 200 casamable-agent
```

Y en el panel: los pedidos siguen ahí y WhatsApp **no pide QR**.

---

## Paso 3 · Restaurar la base (último recurso, con autorización)

Solo si `integrity_check` **no** da `ok` o falta información que existía antes.
Nunca «por si acaso»: perderías todo lo ocurrido desde el backup.

1. **Para el contenedor primero.** Copiar o restaurar en caliente sobre una
   base en WAL da una copia a medias.
2. Los backups los hace `npm run backup`, que usa la **API de backup online de
   SQLite**, no un `cp`: produce un fichero coherente aunque el bot esté
   escribiendo. Viven en `BACKUP_DIR` (por defecto `./backups`), con retención
   de `BACKUP_RETENTION_DAYS` días.
3. Antes de sustituir nada, **verifica el backup sobre una copia**:

   ```bash
   npm run migration:verify -- --db <ruta-del-backup>
   ```

   Debe terminar con integridad `ok` y sin recuentos que cambien.
4. Sustituye `data/messages.db` con el contenedor parado y **borra también los
   ficheros `-wal` y `-shm`** que hubiera junto al antiguo: un WAL huérfano
   apuntando a otra base es una forma segura de corromper la nueva.
5. Arranca y comprueba: `npm run db:health -- --full` y que el panel enseñe los
   pedidos.

La carpeta `/volume1/docker/CasamableAgent` es la que hay que preservar:
`auth/` (sesión de WhatsApp), `data/` (SQLite) y `backups/`.

---

## Qué NO hacer, con nombre y apellidos

- **Nunca** `docker compose down -v`. Borra los volúmenes y con ellos los datos.
- **Bajar el `user_version` a mano** para «volver el esquema»: las tablas
  seguirían ahí y la siguiente migración se confundiría. No hay ningún caso en
  que ayude.
- **Restaurar la base porque el código falla**: el código y los datos son
  independientes aquí. Primero flags, luego imagen, y solo con integridad rota
  se toca la base.
- **Copiar `messages.db` en caliente** para diagnosticar: usa `npm run backup`.
- **Encender de nuevo un flag «a ver si ya va»** sin saber qué pasó. Cada flag
  tiene su evento en el registro de integraciones; míralo primero.

---

## Antes de volver a intentarlo

```bash
npm run predeploy:check -- --db <copia real> --commit <sha>
```

Si el semáforo no sale sin fallos, el despliegue anterior falló por algo que
ese comando ya sabe detectar (`docs/deploy/PREDESPLIEGUE.md`).
