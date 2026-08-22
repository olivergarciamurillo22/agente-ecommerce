# Cómo colaboramos en este repositorio

Guía para trabajar los dos sobre el mismo código sin pisarnos ni romper
producción. Cada uno usa **su propia cuenta de GitHub y sus propias
credenciales**: aquí no se comparten tokens ni contraseñas nunca.

> ⚠️ Este sistema está **en producción real** atendiendo a clientes de
> Casamable™. Lee la sección "Qué puede romper producción" antes de tu primer
> cambio.

---

## 1 · Primera vez: clonar

```bash
git clone https://github.com/olivergarciamurillo22/agente-ecommerce.git
cd agente-ecommerce
npm install
cp .env.example .env.local
```

Rellena `.env.local` con **tus propias** credenciales de prueba. Ese fichero
está en `.gitignore` y no se sube jamás.

Comprueba que todo funciona antes de tocar nada:

```bash
npm test          # deben pasar los 83
npm run typecheck
npm run build
```

Para levantarlo en local:

```bash
npm run dev:all   # bot + dashboard → http://localhost:3000
```

El panel pide contraseña si pones `DASHBOARD_PASSWORD`: el **usuario da
igual**, solo cuenta la contraseña.

> 🔒 Con la configuración por defecto el sistema **no puede enviar nada**:
> arranca en `APP_MODE=safe` con `EMERGENCY_STOP=1`. Para pruebas locales usa
> siempre tu propio número en `TEST_PHONE_ALLOWLIST`. Nunca desarrolles con
> `TEST_MODE=0`.

## 2 · Ramas

`main` está **siempre estable y desplegable**. Nadie desarrolla directamente
sobre ella.

| Prefijo | Para qué | Ejemplo |
|---|---|---|
| `feat/` | Funcionalidad nueva | `feat/dropi-dropea` |
| `fix/` | Corrección de un fallo | `fix/whatsapp-retry` |
| `infra/` | Infraestructura, despliegue, CI | `infra/nas-deploy` |
| `docs/` | Solo documentación | `docs/manual-pedro` |

## 3 · El ciclo de trabajo

**Antes de empezar** — parte siempre de un `main` recién actualizado:

```bash
git checkout main
git pull origin main
git checkout -b feat/nombre-corto
```

**Mientras trabajas** — commits pequeños y frecuentes, en español y
explicando el *porqué*, no el *qué*:

```bash
git add .
git commit -m "Reintentar el envío cuando Baileys cae a mitad"
```

**Antes de subir** — esto no es opcional:

```bash
npm test           # 83 tests en verde
npm run typecheck
npm run build
git status         # ¿se te cuela algún fichero que no toca?
git push -u origin feat/nombre-corto
```

**Para integrar** — abre un Pull Request en GitHub hacia `main`, describe qué
cambia y por qué, y espera revisión del otro. No se hace merge de un PR
propio sin que el otro lo haya visto.

## 4 · Mantener tu rama al día (evitar conflictos)

Si tu rama lleva días abierta, trae los cambios de `main` a menudo:

```bash
git checkout main
git pull origin main
git checkout feat/tu-rama
git merge main            # resuelve conflictos aquí, en tu rama
```

Usamos `merge`, **no `rebase`**, sobre ramas ya publicadas: reescribir
historial compartido rompe el trabajo del otro.

**Reglas de oro:**

- ❌ **Nunca** `git push --force` a `main` (ni a una rama del otro).
- ❌ **Nunca** reescribir historial ya subido (`rebase`, `commit --amend`, `reset --hard`).
- ✅ Ramas cortas: cuanto antes se fusione, menos conflictos.
- ✅ Si dos vais a tocar el mismo archivo, avisad antes por WhatsApp.

## 5 · Zonas críticas: avisa antes de fusionar

No están prohibidas, pero un error aquí llega a clientes reales. **Coordínalo
con el otro antes de hacer merge a `main`:**

| Zona | Por qué es delicada |
|---|---|
| `src/lib/safety.ts` | Los *safety gates*. Un fallo aquí manda WhatsApps a quien no debe |
| `src/lib/orders/` | Máquina de estados, scheduler y mensajes de los pedidos |
| `src/lib/shopify/` | Verificación HMAC y la única mutación que hacemos en Shopify |
| `src/lib/baileys/` | Conexión de WhatsApp y cola de envío |
| `Dockerfile`, `docker-compose.yml` | Un fallo tumba el contenedor del NAS |
| `.env*` | Nunca se suben; cambiar `.env.example` obliga a actualizar el NAS |
| `docs/UGREEN-DXP2800-DEPLOY.md` | Es el procedimiento que se sigue en producción |

Los tests son la red de seguridad de todo esto: si tocas una de estas zonas y
los 83 siguen en verde, vas bien encaminado. Si tienes que **modificar un test
existente** para que pase, para y coméntalo — probablemente estés cambiando
una garantía a propósito sin querer.

## 6 · Qué puede romper producción

**Hacer push NO despliega nada.** Auditado: no hay GitHub Actions, ni
Watchtower, ni webhooks de despliegue, ni pull automático en Portainer. El
NAS solo cambia cuando alguien entra y ejecuta el despliegue a mano.

Sí puede romper producción, en cambio:

- Cambiar `.env.example` sin avisar → el `.env` del NAS se queda incompleto.
- Renombrar variables de entorno o rutas de la API sin actualizar la guía del NAS.
- Cambiar el esquema de la base de datos sin migración → el NAS arranca contra
  una base existente con datos reales.
- Tocar el `Dockerfile` sin construir la imagen en local antes.

## 7 · Desplegar (solo tras aprobar el PR)

El despliegue es **manual y consciente**. En el NAS:

```bash
cd /volume1/docker/CasamableAgent/repo
docker compose exec casamable-agent npm run backup   # 1. backup ANTES
git pull origin main                                  # 2. traer cambios
docker compose up -d --build                          # 3. reconstruir
docker compose ps                                     # 4. esperar "healthy"
docker compose logs --tail 40 casamable-agent         # 5. ¿reconectó WhatsApp?
```

Comprueba después: dashboard accesible, WhatsApp conectado y pedidos intactos.
El procedimiento completo, el rollback y la parada de emergencia están en
[UGREEN-DXP2800-DEPLOY.md](UGREEN-DXP2800-DEPLOY.md).

## 8 · Qué NO se sube nunca

Ya está todo en `.gitignore`, pero conviene tenerlo claro:

- `.env`, `.env.local`, `.env.nas` — credenciales de Shopify y contraseñas
- `auth/` — la sesión de WhatsApp (quien la tenga puede suplantar el número)
- `data/` — la base de datos con **teléfonos y direcciones de clientes reales**
- `backups/` — copias de esa misma base de datos
- Claves de WireGuard, tokens de Cloudflare, tokens de Shopify

**El repositorio es público.** Antes de subir un archivo nuevo, pregúntate si
contiene datos de un cliente. Los tests usan teléfonos y nombres ficticios a
propósito: mantenlo así.

Si alguna vez se cuela un secreto, no basta con borrarlo en un commit nuevo:
queda en el historial. Avisa enseguida, **rota la credencial** y lo limpiamos.

## 9 · Reparto de trabajo

Para no chocar, cada uno trabaja sobre áreas distintas siempre que se pueda:

- **Óliver** — arquitectura, integraciones (Shopify, Dropi/Dropea) e infraestructura.
- **Pedro** — operativa, dashboard, mensajes y lo que sale del uso diario real.

La próxima funcionalidad grande (`feat/dropi-dropea`) la lleva Óliver. Si te
toca algo que roce esa rama, coméntalo antes de empezar.
