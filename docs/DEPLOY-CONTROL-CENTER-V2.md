# Desplegar el Control Center v2 en el NAS

**Estado:** el código está en GitHub, rama
`feat/casamable-control-center-v2`, commit `bf82bee`.
`npm run deploy:precheck` dice **SAFE TO DEPLOY CODE**.

**Lo que NO se ha hecho (a propósito):** nada se ha tocado en el NAS. El
despliegue es una acción física en la máquina de Pedro y no se puede
lanzar desde aquí (el NAS está en la LAN, sin git instalado; el flujo es
copiar el repo y reconstruir el contenedor).

---

## ⚠️ Antes de empezar: dos cosas

**1. La franja horaria.** Reiniciar el contenedor **corta WhatsApp**.
Evitar 10:00–21:00. Hacerlo a partir de las 21:00 o antes de las 10:00.

**2. Está pendiente el despliegue anterior.** El NAS todavía corre
`fix/hardening-casamable` (esquema 9/10). `main` (esquema 11) lleva
pendiente desde el 26-08 y su guía es `docs/PEDRO-DEPLOY-OPERACIONAL.md`.

Esta rama **incluye main y además el trabajo que estaba solo en el NAS**
(MANUAL-ONLY de llamadas, plantillas de Meta, aviso de retraso "Ultras",
`start-outbox`). Es decir: desplegar esta rama es también desplegar main,
sin perder nada de lo que hoy corre en producción.

---

## Qué cambia al desplegar

**En la base de datos:** el esquema pasa de 9/10 a **15**. Las
migraciones (v11 acciones, v12 Beeping, v13 Meta Ads, v14 histórico de
costes, v15 escenarios) son **aditivas e idempotentes**: añaden columnas y
tablas, no borran ni reescriben nada. Corren solas al arrancar.

**En el comportamiento:** nada, salvo que Pedro verá el panel nuevo. Todo
lo nuevo está fail-closed:

| Variable | Sin poner | Efecto |
|---|---|---|
| `BEEPING_BASIC_AUTH` | vacía | Beeping no hace nada |
| `BEEPING_ENABLED` | `0` | ni una llamada a Beeping |
| `BEEPING_WRITE_ENABLED` | `0` | ni una escritura, aunque hubiera credencial |
| `BEEPING_AUTO_RELEASE_CONFIRMED` | `0` | liberación siempre manual |
| `META_ADS_ACCESS_TOKEN` | vacía | Anuncios se ve vacío y lo explica |

WhatsApp, Shopify, Dropea, llamadas y `TEST_MODE` **siguen exactamente
igual**: esta rama no toca ninguno de sus interruptores.

---

## Pasos (los mismos de siempre)

```bash
# 0. BACKUP primero, siempre
cp /volume1/docker/CasamableAgent/data/messages.db \
   /volume1/docker/CasamableAgent/backups/messages-antes-v2.db

# 1. Traer el código (el NAS no tiene git: copiar el repo actualizado
#    desde el Mac, como en despliegues anteriores)

# 2. Reconstruir y levantar
cd /volume1/docker/CasamableAgent
docker compose up -d --build

# 3. Verificar
docker compose ps          # contenedor healthy
docker compose logs --tail=80
```

**Qué comprobar después (30 min de observación):**

1. El contenedor queda *healthy*.
2. **WhatsApp reconecta SIN pedir QR.**
3. En el panel → Ajustes → Sistema: versión de esquema **15**.
4. El outbox no se dispara solo (mismo número de pendientes que antes).
5. Ningún secreto en los logs.
6. La Home carga y el dock navega.

**Rollback:** volver al commit anterior y `docker compose up -d --build`.
El backup de la DB del paso 0 es la red de seguridad; las migraciones son
aditivas, así que el esquema 15 no rompe el código antiguo salvo por las
columnas nuevas que aquel simplemente ignora.

---

## Después del despliegue (opcional, cuando se quiera)

Para que Pedro vea **datos de Meta Ads** en el panel del NAS, pegar en su
`.env` (el bloque completo está en `ENV-NAS-PENDIENTE.local.txt`):

```
META_ADS_ACCESS_TOKEN=<el token con ads_read>
META_ADS_ACCOUNT_ID=1365655995103103
```

Para Beeping, primero generar la credencial en el Mac
(`npm run beeping:auth:init`) y validarla con `npm run beeping:doctor`
**antes** de ponerla en el NAS.
