# PARA ÓLIVER — REVISIÓN Y DESPLIEGUE DEL ESPACIO DE ATENCIÓN AL CLIENTE

**Rama:** `feat/workspace-atencion-cliente` · **Commit:** `dbc16cf`
**Base:** `release/casamable-v4.2` @ `92cfd3e` (schema 17)
**Destino:** NAS UGREEN 192.168.2.109 · proyecto compose `repo-v3c`

---

## CONTEXTO EN 5 LÍNEAS

Vamos a contratar a una persona de atención al cliente. Hoy el panel de `agente.casamable.es` lo protege UNA contraseña compartida (Basic Auth en `src/proxy.ts`) y quien entra lo ve todo: gasto de Meta Ads, unit economics, kill switches, backups. Además no existe el concepto de "quién hizo esto": `integration_events` registra qué pasó, nunca quién.

Codex ha implementado el modelo de roles + el espacio `/trabajo`. **Yo ya lo he revisado y compila, pero NO está desplegado y NO está validado funcionalmente.** Necesito tu revisión externa antes de tocar producción, porque esta rama trae una **migración de schema 17 → 18** sobre una base con 116 pedidos, 63 conversaciones y 349 mensajes reales.

---

## LO QUE YO YA HE VERIFICADO (no lo repitas)

Build aislado `casamable-agent:ws-test`, puerto 3001, sin volúmenes:

```
PANEL=307   HEALTH=200   LOGIN=200   WEBHOOK=401
```

661 tests en verde, typecheck limpio, logs de arranque sin errores.

Eso demuestra que **compila y que las rutas responden sin sesión**. No demuestra nada de permisos reales.

---

## LO QUE TE PIDO (por orden, no te saltes ninguno)

### FASE 1 — Revisión de código (sin desplegar)

1. **`src/lib/auth/guard.ts`** — confirma que la comprobación de rol está en UN solo sitio y que es **fail-closed**: sesión sin rol reconocido → 403, nunca "por defecto owner".
2. **Recorre TODOS los route handlers** y dime si alguno escribe/lee sin invocar el guard. La UI no es control de acceso: si un botón está oculto pero el endpoint responde 200, es un fallo.
3. **`src/proxy.ts` → `PUBLIC_PREFIXES`** — verifica que `/api/webhooks/` y `/api/health` siguen intactos. Si esto se rompe, Meta y Retell dejan de entregar eventos y los pedidos dejan de confirmarse **en silencio**. Es el riesgo nº1 de esta rama.
4. **Migración 17 → 18** — confirma que es solo `CREATE TABLE`, idempotente, y que **no hay ningún `ALTER` sobre `orders`, `conversations` ni `messages`**.
5. **`password.ts`** — debe usar `scrypt` de `node:crypto`. Si Codex ha metido bcrypt o argon2 como dependencia nueva, rechaza.
6. **`audit_log`** — `user_name` tiene que estar desnormalizado a propósito (si se borra el usuario, el registro debe seguir diciendo quién fue).

### FASE 2 — Prueba funcional con un usuario `agent` real

Crea un usuario de prueba con `npm run users:create` y comprueba los **5 criterios de aceptación**. Si falla uno, la entrega no está lista:

1. Entra en `/trabajo`, ve la bandeja, abre una conversación.
2. La atiende (mode AI → HUMAN), responde, guarda una dirección corregida en `proposed_address`, la marca resuelta con nota.
3. Escribe a mano en la barra de direcciones `/sistema`, `/ajustes` y lanza `call_now` por API → **403 en los tres**.
4. **En el JSON crudo de la ficha de pedido NO aparece:** `email`, `raw_payload`, `supplier_*`, `beeping_*`, `marketing_*`, `landing_site`, `referring_site`.
   → Compruébalo con `curl` sobre la respuesta HTTP, **no** mirando la pantalla. El fallo clásico es que el dato viaja al navegador y solo está oculto por CSS.
5. Las 5 acciones aparecen en `/sistema/auditoria` con nombre y hora.

### FASE 3 — Despliegue (solo si FASE 1 y 2 pasan)

Orden obligatorio, sin atajos:

1. Backup de la DB **fuera del repo** + `PRAGMA integrity_check` → debe decir `ok`.
2. Backup de `auth/`.
3. Build con `-p repo-v3c` (si despliegas desde otro directorio sin ese flag se crea un contenedor paralelo sobre el mismo SQLite — ya nos pasó).
4. `up -d --no-build --force-recreate`.
5. `npm run db:health` → debe decir **esquema 18 (esperado 18)** e integridad ok.
6. `npm run readiness:runtime` → READY (o READY WITH WARNINGS documentado).
7. Repite los 5 criterios de aceptación **contra producción**.

---

## REGLAS ABSOLUTAS

- NUNCA `docker compose down -v`
- NUNCA borrar `auth/`, `data/`, `backups/`
- NUNCA restaurar DB automáticamente
- NUNCA tocar `src/lib/safety.ts` ni `src/lib/calls/gates.ts` — esta entrega no relaja ningún guardarraíl
- NUNCA tocar `PUBLIC_PREFIXES`
- NUNCA pegar API keys, tokens ni `.env` completo en el chat

---

## AVISO DE MERGE

Esta rama y `release/casamable-v4.3` (donde está Codex) van a chocar en `package.json` — ambas añaden scripts — y probablemente en `tests/run-tests.ts`. **Cuanto antes entre atención al cliente, más pequeño es ese merge.** Mi criterio: esta rama va primero, el hunter después.

---

## QUÉ NECESITO DE VUELTA

- FASE 1: veredicto por cada uno de los 6 puntos (OK / FALLO + fichero y línea)
- FASE 2: los 5 criterios con PASS/FAIL y, en el criterio 4, el JSON crudo con los campos sensibles ya redactados
- FASE 3: salida de `db:health` y `readiness:runtime` post-deploy
- Si algo falla: **para y dímelo**, no lo parchees por tu cuenta
