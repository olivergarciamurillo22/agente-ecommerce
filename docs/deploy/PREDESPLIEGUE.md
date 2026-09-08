# Semáforo pre-despliegue — un solo comando (07-09-2026)

Antes, la comprobación previa a un despliegue eran pasos sueltos que había que
recordar: confirmar el commit, correr la migración sobre una copia, mirar si
`dispatch_channels` está rellena, repasar el `.env`, compilar y pasar la suite.
Ahora es **un comando que devuelve un semáforo**.

```
npm run predeploy:check -- --db C:\ruta\copia\messages.db --commit <sha-que-vas-a-desplegar>
```

## Qué toca y qué no

- **La base que le pasas no se abre nunca en escritura**, ni con `--apply`. La
  migración se ensaya sobre una **copia** en el temporal del sistema
  (`scripts/migration-verify.ts`), y esa copia se borra al terminar.
- `--apply` **no escribe en tus datos**: solo conserva la copia migrada y los
  informes para que puedas inspeccionarlos. Por defecto (dry-run) se borran.
- `npm run build` escribe en `.next/` y la suite en su propio `DATA_DIR`
  temporal. Ambos fuera de tus datos.
- **Antes de copiar `messages.db` del NAS**: para el contenedor o haz
  `wal_checkpoint(TRUNCATE)`. La base corre en WAL y una copia en caliente
  puede no llevar las últimas escrituras: el semáforo saldría verde sobre
  datos incompletos.

## Códigos de salida

En el repo conviven tres convenciones para el `2`; este script fija la suya:

| Código | Significado |
|---|---|
| 0 | ningún FALLO (puede haber avisos que hay que leer) |
| 1 | al menos un FALLO crítico: no desplegar |
| 2 | uso incorrecto del comando |

## Qué comprueba, en orden

1. **Identidad del commit.** `PRODUCTION_COMMIT` (variable de entorno) o
   `--commit` debe coincidir con el `HEAD` del checkout. Sin declararlo, FALLA
   y no sigue: comprobar sin decir qué commit despliegas no prueba nada.
   Acepta prefijos de 7 caracteres. **Ojo con el nombre**: aquí
   `PRODUCTION_COMMIT` significa «el commit que voy a desplegar»; en
   `docs/ESTADO-PRODUCCION.md` el mismo nombre se usa para «el que corre hoy
   en el NAS», que es otro dato y sigue sin confirmar.
2. **Árbol de trabajo.** Ficheros sin commitear → AVISO. No viajan al NAS
   (allí se hace `git checkout <SHA>`), pero lo que pruebas en local no es
   exactamente ese commit.
3. **Migración sobre la copia.** Delega en `npm run migration:verify` en un
   **proceso hijo** (obligatorio: `src/lib/db.ts` congela `DATA_DIR` al
   importarse, así que la ruta de producción solo funciona en un proceso
   recién nacido). Informe antes/después: `user_version`, `integrity_check`,
   tablas nuevas y recuentos por tabla. Producción está en el **esquema 30** desde el 07-09-2026
   (antes de ese despliegue estaba en 17, no en 15 como decía este doc): el script no exige un valor de
   partida, exige que el «después» sea el que espera el código y que ninguna
   fila cambie.
4. **Cobertura del router de canal.** Sobre la **copia ya migrada**, enumera
   los productos realmente vendidos (`orders.raw_payload` → `line_items`, 90
   días por defecto, `--dias` para cambiarlo) y comprueba que cada uno casa
   con una fila de `dispatch_channels`, usando `matchLineToChannel` tal cual
   (misma prioridad variante > SKU > producto). Las líneas de servicio (el
   seguro de envío de Releasit, sin SKU ni IDs) se excluyen. Si falta alguno,
   **los lista por nombre** y falla: con el cooldown encendido esos pedidos
   quedarían RETENIDOS uno a uno.
   Disponible también suelto: `npm run dispatch:coverage`.
5. **Coherencia entre flags y entorno** (`src/lib/system/predeploy.ts`). No es
   la auditoría variable a variable de `npm run env:doctor`, sino las
   combinaciones que rompen la operativa:

   | Regla | Si no se cumple |
   |---|---|
   | `ADDRESS_AI_VALIDATION_ENABLED=1` exige `OPENAI_API_KEY` real | FALLO: el flag mentiría, la capa 2 nunca correría |
   | `POST_CONFIRMATION_AI_ENABLED=1` exige clave, FAQ aprobada y `ALERT_WHATSAPP` | FALLO: con la IA encendida un pedido puede cancelarse solo y el aviso no empujaría a nadie |
   | `AUTO_DISPATCH_COOLDOWN_ENABLED=1` exige `dispatch_channels` no vacía | FALLO: ningún pedido se despacharía |
   | Producto en canal `dropea` exige `DROPEA_WRITE_ENABLED=1` | FALLO: retención permanente (`write_disabled`) |
   | `DISPATCH_NOTICE_WHATSAPP_ENABLED=1` exige el mapping habilitado | FALLO: hoy está deshabilitado a propósito |
   | `EMERGENCY_STOP=1`, `APP_MODE≠production` o `WHATSAPP_SEND_ENABLED≠1` | AVISO: no saldrá nada real |

6. **`npm run build`** y **`npm test`**, lanzados sin pasar por `npm` (en
   Windows `npm`/`npx` no son ejecutables y `spawnSync` falla con EINVAL: se
   invoca `node` directamente, patrón de `scripts/doctor-v43.ts`). La suite con
   tests omitidos sale como AVISO: los omitidos son los que exigen `npx` con
   registro y en Windows salen siempre.

## Modo humo, sin copia real

```
npm run predeploy:check -- --fixture --commit <sha>
```

Comprueba la **mecánica** con datos sintéticos. El bloque de migración sale
como AVISO a propósito (nunca verde) y la cobertura de canales queda **sin
evaluar**: sin copia real no hay catálogo que comprobar. No sustituye la
prueba con la copia del NAS.

## Ejemplo de salida real

Corrido el 07-09 contra un fixture de demostración con 77 pedidos, tres SKUs y
**un solo canal configurado a propósito**:

```
════════ SEMÁFORO PRE-DESPLIEGUE · Casamable v4.3 ════════

  HEAD local        : c0d8d402a6238334b0129ec991408764cffddf5a
  Commit declarado  : c0d8d402a6238334b0129ec991408764cffddf5a
  Esquema           : 22 → 26 (el código espera 26)
  Modo              : dry-run (la copia migrada se borra al terminar)

  COMPROBACIÓN                       ESTADO
  --------------------------------------------------------------------------------
  ✓ Identidad del commit             PASS  HEAD c0d8d402a623 coincide con el commit declarado
  ! Árbol de trabajo                 WARN  5 fichero(s) sin commitear
  ✓ Migración sobre copia            PASS  user_version 22 → 26 · integridad ok → ok · 2 tabla(s) nueva(s) · sin cambios de filas · 21.61 ms
  ✗ Cobertura de canales             FAIL  SIN CANAL: ORG-ROPA-02, LAMP-LED-03
  ✓ Direcciones · capa 2 (IA)        PASS  apagada
  ✓ Intención post-confirmación (IA) PASS  apagada
  ✓ Auto-despacho tras cooldown      PASS  apagado
  ✓ Horas de cooldown                PASS  6 h
  ✓ Canal Dropea                     PASS  sin productos en Dropea y escritura cerrada
  ✓ Aviso de despacho (WhatsApp)     PASS  apagado

  --------------------------------------------------------------------------------
  RESULTADO: NO DESPLEGAR — 1 fallo(s) crítico(s), 4 aviso(s)

  QUÉ FALTA:
   ✗ Cobertura de canales: 2 producto(s) activo(s) sin canal en dispatch_channels: ORG-ROPA-02, LAMP-LED-03
```

Eso es exactamente lo que verá Pedro: qué está listo, qué falta y por qué, sin
tener que interpretar la salida de seis comandos distintos.

## Lo que este semáforo NO puede decirte

- Si el NAS aceptará la imagen: eso lo comprueba `bash scripts/nas-verify-v43.sh` allí.
- Si las plantillas de WhatsApp están APPROVED: exige credenciales de la WABA
  (`npm run whatsapp:templates:doctor` en el NAS).
- Qué commit corre **hoy** en producción: sigue sin confirmar.
