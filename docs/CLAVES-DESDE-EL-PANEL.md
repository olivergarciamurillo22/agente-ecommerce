# Claves de conexión desde el panel

**Qué resuelve.** Con una instalación por cliente, cambiar una clave no puede
exigir entrar por SSH. El dueño de cada instalación pone y renueva las suyas
desde **Ajustes → Integraciones → Claves de conexión**, sin depender de
nosotros. La que más se va a renovar es el token de la biblioteca de anuncios:
caduca cada 60 días.

**Estado:** esquema 33 (aditivo). Sin `SECRETS_MASTER_KEY` el módulo se apaga
entero y el panel lo explica; todo sigue saliendo del `.env` como siempre.

---

## Puesta en marcha (una vez por instalación)

```bash
npm run secrets:key      # imprime la línea; se pega en el .env y se reinicia
```

Esa llave **no se guarda en la base a propósito**. La copia de seguridad de la
base viaja entre máquinas (ver el runbook de despliegue): si el valor fuera en
claro, cada backup sería una filtración de credenciales. Guárdala también fuera
del servidor. **Si se pierde, hay que volver a pegar las claves desde el
panel**; no se recupera de ningún sitio, y ese es justamente el objetivo.

---

## Cómo funciona

| Decisión | Por qué |
|---|---|
| Valor cifrado con AES-256-GCM en `app_secrets` | Un backup robado no lleva credenciales usables |
| La llave maestra vive solo en el `.env` | Separar el dato del secreto que lo abre |
| El valor **nunca** vuelve al navegador | La API devuelve los cuatro últimos caracteres, quién la puso y cuándo. Se escribe, no se lee |
| La base **manda** sobre el `.env` | Mismo criterio que el tope diario de IA (`system/ai-budget.ts`): lo que pone el cliente gana |
| Solo rol `owner` | Un `agent` (atención al cliente) recibe 403: las claves de la empresa no son cosa suya |
| Se prueba antes de guardar | Es la única protección real contra pegar mal una clave crítica |
| Cada cambio queda en `audit_log` | Qué clave, quién, cuándo y cómo fue la prueba. **Nunca el valor** |

**Propagación entre procesos.** El panel y el bot son dos procesos sobre la
misma SQLite. Cada uno vuelca las claves de la base a `process.env` al
arrancar, así los ~60 puntos que ya leen `process.env.X` siguen funcionando sin
tocarlos. Un contador de versión permite al bot darse cuenta de un cambio
hecho desde el panel y recargar solo, sin reiniciar (revisa cada 20 segundos).

- Panel: `src/instrumentation.ts` (`register()`, una vez por arranque)
- Bot: `scripts/start-bot.ts` (al arrancar y cada 20 s)

---

## Verificación antes de guardar

Cada clave se prueba contra su proveedor con una llamada de **solo lectura**.
Si falla, **no se guarda**, y se explica qué respondió. El cliente puede
forzarla con un clic aparte, y eso queda en auditoría.

| Clave | Cómo se comprueba |
|---|---|
| Shopify · token de la Admin API | `GET /admin/api/{v}/shop.json` contra la tienda del entorno |
| WhatsApp · token permanente | `GET graph.facebook.com/{v}/{phone_number_id}`; el código 190 de Meta se traduce al aviso del token de 24 h |
| Biblioteca de anuncios y Meta Ads | `GET /me`. **A propósito no contra `/ads_archive`**: esa búsqueda gasta cuota y está bajo `EMERGENCY_STOP`. La comprobación completa sigue siendo `hunter:discovery:doctor` |
| OpenRouter | `GET /api/v1/key`. `/models` es público y responde 200 con cualquier cosa: no vale para validar |
| OpenAI | `GET /v1/models` |
| Retell | `GET /list-agents` |
| Dropea | `GET /products?limit=1` |
| Los secretos de **firma** (webhook de Shopify, app secret y verify token de Meta, webhooks de proveedor) | **No verificables**: el proveedor los usa para firmar lo que nos manda, no hay a quién preguntar. Se declara así en vez de fingir un «ok». Se confirman cuando entre un webhook de prueba y no sea rechazado |

---

## Riesgo asumido, y lo que lo compensa

Se decidió dejar editables **las 17 claves**, incluidas las que tumban
producción si se pegan mal (el secreto del webhook de Shopify, el app secret
de Meta). Lo que compensa esa decisión:

1. La prueba contra el proveedor antes de guardar, con las verificables.
2. Las críticas van marcadas en la pantalla, con qué se rompe si fallan.
3. Forzar tras un fallo exige un segundo clic explícito.
4. Se ve siempre de dónde sale la que está en uso: la del panel o la del servidor.
5. **«Borrar la del panel» devuelve el mando al `.env`**: es la vuelta atrás
   cuando el cliente se equivoca y no sabe por qué dejó de funcionar.

**Lo que sigue sin cubrir:** cambiar el verify token de Meta obliga a volver a
verificar el webhook en el panel de Meta, y eso el sistema no lo puede hacer
por el cliente. El panel lo avisa al guardar.

---

## Ficheros

| Pieza | Fichero |
|---|---|
| Almacén, cifrado, volcado | `src/lib/config/secrets.ts` |
| Verificación por proveedor | `src/lib/config/secrets-verify.ts` |
| API (owner) | `src/app/api/secrets/route.ts` |
| Pantalla | `src/components/SecretsPanel.tsx` |
| Tabla (migración 33) | `migrateAppSecrets` en `src/lib/db.ts` |
| Generador de la llave | `scripts/secrets-key.ts` (`npm run secrets:key`) |

Tests: cuatro bloques «CLAVES DEL PANEL» en `tests/run-tests.ts` (cifrado y
manipulación, almacén y precedencia sobre el `.env`, verificación con red
inyectada, migración).
