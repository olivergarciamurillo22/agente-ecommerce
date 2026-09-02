> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

# HOTFIX DE LLAMADAS — despliegue en el NAS, paso a paso

> **Solo este hotfix. NO es el deploy de main.** Rama
> `hotfix/calls-pilot-switch` = `c6cc226` (lo que ya corre) + el interruptor
> de llamadas + este runbook. **Sin migraciones: el esquema sigue en 10.**
> `calls_pilot_mode` es una fila de settings, no una columna — el rollback ni
> siquiera la ve.
>
> Prohibido en toda la operación: `down -v` · tocar Cloud API/Coexistence ·
> tocar Shopify/Dropi/Dropea · borrar `auth/` · cambiar secretos, prompt,
> número o trunk.

Todo se ejecuta en `/volume1/docker/CasamableAgent` (el host no tiene git ni
npm: git va en contenedor `alpine/git`, los scripts DENTRO del contenedor).

## FASE 0 · Retell payment (humano, antes de abrir producción)

Pedro entra en el panel de Retell y confirma: **método de pago añadido y
capacidad de seguir llamando al agotarse el crédito de prueba**.
Anota: `RETELL_PAYMENT_READY = SI / NO`.
Con NO: el hotfix se despliega igual, pero **quedarse en FASE 7 (piloto)** —
no abrir producción.

## FASE 1 · Baseline (solo lectura)

```bash
cd /volume1/docker/CasamableAgent
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo rev-parse HEAD
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo status --porcelain
docker compose ps
docker compose exec casamable-agent npm run db:health
curl -s http://localhost:3000/api/health/live
```

Esperado: HEAD `c6cc226…` · status VACÍO (si no: PARA y avisa) · contenedor
healthy · esquema 10 (esperada 10) · `"provider":"baileys","whatsapp":"connected"`.
**Apunta el HEAD: es tu commit de rollback.**

## FASE 2 · Backup

```bash
docker compose exec casamable-agent npm run backup
ls -lh backups/ | tail -2
docker compose exec casamable-agent npm run db:health   # sección Backups: última hace 0 min, integridad ok
ls repo/auth > /dev/null && echo "auth/ intacto"
```

## FASE 3 · Traer y VERIFICAR el hotfix (no seguir si algo no cuadra)

```bash
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo fetch origin
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo log --oneline c6cc226..origin/hotfix/calls-pilot-switch
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo diff --name-only c6cc226 origin/hotfix/calls-pilot-switch
```

Esperado EXACTO — 2 commits (`f08cd87` interruptor + 1 de docs/.env.example)
y SOLO estos archivos:

```
.env.example
docs/HOTFIX-LLAMADAS-NAS.md
package.json
scripts/calls-mode.ts
src/lib/calls/config.ts
src/lib/system/health-integrations.ts
tests/run-tests.ts
```

**Cualquier otro archivo o commit → PARA y avisa a Óliver.**

## FASE 4 · Checkout (sin reset destructivo)

```bash
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo checkout hotfix/calls-pilot-switch
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo rev-parse HEAD
ls repo/.env   # trampa conocida: el .env tiene que seguir ahí
```

## FASE 5 · Build + recreate (jamás down -v)

```bash
docker compose build casamable-agent
docker compose up -d --force-recreate casamable-agent
sleep 60
docker compose ps                                        # healthy, 0 restarts
curl -s http://localhost:3000/api/health/live            # provider baileys, connected, SIN QR
docker compose exec casamable-agent npm run db:health    # esquema 10 (esperada 10), integridad ok
```

WhatsApp debe reconectar solo. Si pide QR una vez, escanéalo; si lo pide en
bucle → FASE R (rollback).

## FASE 6 · Estado de llamadas tras el deploy

```bash
docker compose exec casamable-agent npm run calls:mode
```

Esperado recién desplegado (con vuestros settings del 26-08):

```
Kill switch : ABIERTO (ai_calls_enabled=1)
Shadow      : off
Modo        : PILOTO (fail-closed)          ← el default del código nuevo
Allowlist   : vacía
→ Se llamará a : NADIE (piloto + allowlist vacía = fail-closed)
```

Es decir: **nada puede llamar todavía.** Correcto y a propósito.

## FASE 7 · Piloto primero (allowlist = SOLO el móvil de Pedro)

Allowlist desde el panel (pestaña Llamadas) con el móvil de Pedro, o:

```bash
docker compose exec casamable-agent npx tsx -e 'require("/app/scripts/env-loader"); const db=require("/app/src/lib/db"); db.setSetting("calls_allowlist","34XXXXXXXXX"); console.log("allowlist: solo Pedro")'
docker compose exec casamable-agent npm run calls:mode -- pilot
docker compose exec casamable-agent npm run calls:mode        # → PILOTO · allowlist 1 número · "solo la allowlist"
```

**Llamada de prueba** (el método manual documentado el 26-08; la franja es
9:00–13:00 / 17:00–20:00, así que si es de noche sonará a las 9:00):
crea un pedido de prueba en needs_call con el móvil de Pedro, con datos
realistas para validar las 11 variables:

```bash
docker compose exec casamable-agent npx tsx -e '
require("/app/scripts/env-loader");
const db=require("/app/src/lib/db");
const r=db.insertOrderIfNew({shopify_order_id:"TEST-CALL-2708",shopify_order_number:"9990",
 customer_name:"Pedro Prueba",phone:"34XXXXXXXXX",email:null,
 product_summary:"Cortaúñas Eléctrico 3 en 1",total_price:"36.90",currency:"EUR",
 address_line1:"Calle Ejemplo 12",address_line2:null,city:"Almería",province:"Almería",
 postal_code:"04001",country:"España",status:"pending_send"});
db.markOrderNeedsCall(r.order.id); console.log("pedido de prueba #9990 en needs_call, id",r.order.id)'
```

Con PILOTO + allowlist de 1 número, **aunque haya clientes reales en
needs_call, solo puede sonar el móvil de Pedro.**

Al recibirla, validar: nombre · producto · unidades · importe en palabras ·
dirección · localidad · CP · teléfono · fecha · número de pedido · y que NO
se oye ninguna llave/corchete/placeholder. **Si algo suena mal: quedarse en
piloto y avisar** (no pasar a FASE 8). Después, cerrar el pedido de prueba:

```bash
docker compose exec casamable-agent npx tsx -e 'require("/app/scripts/env-loader"); const db=require("/app/src/lib/db"); const o=db.getOrderByShopifyId("TEST-CALL-2708"); db.systemDbHandle().prepare("UPDATE orders SET status=?, needs_call_at=NULL WHERE id=?").run("cancelled",o.id); console.log("pedido de prueba cerrado")'
```

*(Atajo legítimo: el v6 ya se validó el 26-08 con llamada real. Si Pedro da
esa validación por buena, esta fase puede reducirse a comprobar la
allowlist y saltar la llamada de prueba.)*

## FASE 8 · Abrir producción (SOLO con FASE 0 = SI y FASE 7 correcta)

Combinación final EXACTA que se va a dejar escrita — leedla antes:

| Llave | Valor | Efecto |
|---|---|---|
| `calls_pilot_mode` | `0` | producción de llamadas, decisión explícita |
| `ai_calls_enabled` | `1` (ya está; **verificar con calls:mode, no escribir a ciegas**) | kill switch abierto |
| `calls_allowlist` | vacía | sin restricción — **solo** significa eso porque pilot_mode=0 |
| `calls_daily_cap` | `10` | tope diario intacto |

```bash
docker compose exec casamable-agent npx tsx -e 'require("/app/scripts/env-loader"); const db=require("/app/src/lib/db"); db.setSetting("calls_allowlist",""); console.log("allowlist vaciada (producción)")'
docker compose exec casamable-agent npm run calls:mode -- production
docker compose exec casamable-agent npm run calls:mode
```

Esperado: `Modo: PRODUCCIÓN (calls_pilot_mode=0)` · `→ Se llamará a:
cualquier pedido elegible (producción, con cap y franja delante)`.

## FASE 9 · Safety check final

- `calls:mode` muestra cap 10 · franja 9–13/17–20 en código (no ha cambiado).
- `curl -s http://localhost:3000/api/health/live` → baileys, connected (WhatsApp intacto).
- Pestaña Sistema: Shopify sin rechazos nuevos; Dropea/Dropi como estaban.
- No se ha tocado `.env`, ni EMERGENCY_STOP, ni provider, ni supplier writes.

## FASE 10 · Observación 10–15 min (+ mañana 9:00–9:30)

`docker compose ps` (0 restarts) · panel Sistema en verde · outbox bajando ·
integration_events sin errores nuevos · SQLite healthy. Y mañana entre 9:00
y 9:30, vigilar las primeras llamadas reales: cap y franja respetados,
resultados escribiéndose.

## FASE R · Rollback (si algo va mal en cualquier fase)

```bash
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo checkout c6cc226
docker compose up -d --build --force-recreate casamable-agent
```

DB intacta (el hotfix no migra nada). La fila `calls_pilot_mode` queda en
settings y el código viejo simplemente la ignora. Jamás `down -v`.

---

## CALLS HOTFIX NAS REPORT — plantilla (rellenar y devolver)

```
1.  commit antes            : c6cc226 (confirmar con rev-parse)
2.  commit después          : ________ (HEAD de hotfix/calls-pilot-switch)
3.  backup                  : fichero ________ · integridad OK sí/no
4.  container health        : healthy sí/no · restarts ____
5.  WhatsApp                : connected sin QR sí/no
6.  DB                      : esquema 10/10 · integridad ok sí/no
7.  calls mode antes        : (código viejo: sin calls:mode; settings 26-08: enabled=1, shadow=0, cap=10, allowlist vacía)
8.  calls mode después      : PILOTO/PRODUCCIÓN · salida de calls:mode pegada
9.  RETELL_PAYMENT_READY    : SI / NO
10. piloto realizado        : sí/no (o "validación del 26-08 dada por buena")
11. prompt v6 correcto      : sí/no (11 variables, sin placeholders)
12. ai_calls_enabled        : ____
13. allowlist efectiva      : vacía / N números
14. daily cap               : ____
15. errores                 : ninguno / detalle
16. rollback necesario      : sí/no
17. estable para llamadas mañana : sí/no
```
