# Pedro — desplegar el espacio de atención al cliente (05-09-2026)

Rama a desplegar: **`release/casamable-v4.2`** (código en `fdad99e`)
Esquema: **15 → 18** (producción está hoy en 15)

Este despliegue añade una cosa nueva: **una persona de atención al cliente
puede entrar en el panel con su propio usuario**, ver solo las conversaciones
que necesitan una persona, responderlas y resolverlas — **sin** poder tocar
Sistema, Ajustes, llamadas ni nada que mueva dinero.

**Y cambia cómo responde el bot en WhatsApp** (tres arreglos del 05-09).
Resumen en una línea cada uno — el detalle, en `docs/CONVERSACION-REGLAS.md`:

1. **No se confirma un COD contra una dirección basura.** Si la dirección
   está vacía, es absurdamente corta o no tiene número, la confirmación se
   bloquea y lo revisa una persona. Un COD confirmado a una dirección
   inexistente es un rehusado con portes pagados (~9,37 €).
2. **El primer mensaje por Cloud API es siempre la plantilla aprobada.** Se
   quitó el texto de respaldo que podía salir en su lugar.
3. **Lo que el bot no entiende va a una persona a la primera**, en vez de
   dar vueltas. Antes llegó a repetir el mismo menú cinco veces sin
   resolver nada.

Nada más se toca: ni las llamadas, ni los proveedores, ni ningún guardarraíl.

> **Lo que vas a notar:** llegan **más conversaciones a la bandeja** de
> atención que antes. Es a propósito — sale más barato que un rehusado —,
> pero mira el volumen la primera semana y dime si se llena de cosas que el
> bot debería haber resuelto solo.

---

## Antes de empezar

**Ventana: fuera de 10:00–21:00.** Reiniciar corta WhatsApp.

Hay **un paso nuevo** que no estaba en despliegues anteriores: después de
desplegar hay que **crear los usuarios** (paso 5). Si no lo haces, nadie puede
entrar en el panel — ni tú. Reserva 5 minutos extra.

---

## 1 · Comprobar que hay un solo bot

Esto se ejecuta **en el NAS**, no dentro del contenedor.

```bash
cd <carpeta del repo en el NAS>
npm run deploy:guard -- --data-dir /volume1/docker/CasamableAgent/data
```

Si dice **PELIGRO**, hay dos contenedores sobre la misma base: para uno y
repite. **No se despliega con dos vivos.**

## 2 · Foto del estado actual

```bash
docker exec casamable-agent npm run db:health
docker exec casamable-agent npm run readiness:runtime
```

Apunta el número de esquema que diga (debería ser **15**).

## 3 · Copia de seguridad — este paso no se salta

El salto de esquema es de tres versiones (15 → 16 → 17 → 18). Ensayado sobre
copias el 05-09 sin perder una sola fila, pero la copia es la red.

```bash
docker exec casamable-agent npm run backup
ls -lt /volume1/docker/CasamableAgent/backups | head -3
```

**No sigas si no ves una copia de hoy.**

## 4 · Desplegar

```bash
cd <carpeta del repo en el NAS>
git fetch origin
git checkout release/casamable-v4.2
git pull --ff-only
git rev-parse --short HEAD  # apúntalo y pásamelo: así sé qué corre exactamente

docker compose build casamable-agent
docker compose up -d --no-build casamable-agent
```

Nunca `docker compose down -v`: eso borra volúmenes.

## 5 · Crear los usuarios ← PASO NUEVO

Sin esto el panel no deja entrar a nadie.

```bash
docker exec -it casamable-agent npm run users:create
```

Te preguntará **correo, nombre, rol y contraseña** (mínimo 12 caracteres). Es
interactivo a propósito: las contraseñas no se pasan por argumento, para que
no queden en el historial del terminal.

Créate **dos usuarios**:

| Rol | Para quién | Qué puede hacer |
|---|---|---|
| `owner` | tú | todo, como hasta ahora |
| `agent` | la persona de atención | solo `/trabajo` |

Repite el comando una vez por usuario. **No compartas un usuario entre dos
personas**: la auditoría deja de servir si no se sabe quién hizo qué.

### La contraseña antigua sigue abriendo la puerta — decide qué haces con ella

Comprobado el 05-09: `DASHBOARD_PASSWORD` **sigue dando acceso completo de
propietario aunque ya existan usuarios**. No es un puente temporal, es una
puerta paralela permanente mientras esa variable esté en el `.env` del NAS.

Tiene dos pegas:

- Es **compartida**: quien la sepa, entra como propietario.
- Es **anónima**: quien entra por ahí aparece en la auditoría como
  «Propietario (Basic Auth)», sin persona detrás. Si la usas tú, tus acciones
  no quedan a tu nombre.

Dos opciones, y la eliges tú:

| | Cómo | Consecuencia |
|---|---|---|
| **Recomendado** | Crea tu usuario `owner`, comprueba que entras, y **quita `DASHBOARD_PASSWORD` del `.env`** y reinicia | Todo queda a nombre de una persona. Si pierdes la contraseña, se crea otro usuario con `users:create` desde el NAS |
| Conservadora | Déjala como acceso de emergencia | Sigues teniendo una llave maestra anónima. Cámbiala por una larga y no la compartas |

Lo que **no** conviene es dejarla puesta y olvidada creyendo que se desactivó
sola al crear los usuarios: no se desactiva.

## 6 · Comprobar que ha ido bien

```bash
docker ps --filter name=casamable-agent            # Up + healthy
docker exec casamable-agent npm run db:health      # esquema 18, integridad ok
docker exec casamable-agent npm run readiness:runtime
docker logs --tail 100 casamable-agent
```

Esperado:

- contenedor **healthy**
- **WhatsApp reconecta sin pedir QR**
- **esquema 18**, integridad `ok`
- ningún secreto en los logs

Y a mano, en el navegador, sobre `https://agente.casamable.es`:

1. Entra con tu usuario `owner` → debe llevarte al panel de siempre.
2. Entra con el usuario `agent` (ventana de incógnito) → debe llevarte a
   `/trabajo` y **no** debe dejarte abrir Sistema ni Ajustes.

## 7 · Qué decirle a la persona de atención

- Entra por **`https://agente.casamable.es`** con su correo y contraseña.
- Verá **solo** las conversaciones que necesitan una persona, la que más
  tiempo lleva esperando primero.
- Puede: responder, pasar la conversación de la IA a modo humano, corregir la
  dirección, dejar una nota, resolver o escalarte algo a ti.
- No verá el correo del cliente ni datos internos de proveedor o marketing:
  la ficha que se le sirve es una lista blanca de campos.
- Todo lo que haga queda firmado con su nombre en la auditoría
  (`/sistema` → auditoría, solo tú).

**Importante:** tiene que entrar por `https://agente.casamable.es`. Por
`http://192.168.2.109:3000` **el login no funciona** — la cookie de sesión es
`Secure` y no viaja por HTTP sin cifrar, así que parece que entra y vuelve al
login. No es un fallo: es la cookie protegiendo la sesión. Si algún día hace
falta acceso por la red local, se monta con HTTPS, **no** bajando esa
protección.

## 8 · Dos rojos conocidos que NO bloquean este despliegue

Vienen de antes y no los arregla este commit:

1. **Plantilla de confirmación** — `readiness:runtime` seguirá en rojo con
   `FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED` hasta que corras, con las
   credenciales de la WABA delante:

   ```bash
   docker exec casamable-agent npm run whatsapp:templates:doctor
   ```

   La confirmación inicial sigue bloqueada hasta que eso pase.

2. **Firma de webhooks de Retell** — mientras `RETELL_API_KEY` no sea la que
   lleva el distintivo **webhook** en el panel de Retell, **todos** los
   webhooks reales se rechazan. El código ya está bien; falta la clave
   correcta en el `.env` del NAS. Detalle en
   `docs/retell/PRODUCTION-VALIDATION.md`.

## 8 bis · Una variable nueva, opcional

`META_WHATSAPP_MEDIA_DOWNLOAD_ENABLED` decide si las fotos y audios que
manda el cliente se descargan de Meta para verlos en el panel.

**Viene ACTIVADA sin tocar nada.** Si no quieres que se descarguen (son
llamadas a Meta y ficheros en `data/media`), añade al `.env` del NAS:

```
META_WHATSAPP_MEDIA_DOWNLOAD_ENABLED=0
```

Mi recomendación: déjala activada. Si un cliente manda una foto de la
dirección o del portal, verla es justo lo que resuelve el caso.

## 9 · Si algo va mal

`docs/deploy/ROLLBACK.md`.

El esquema 18 **no estorba a una vuelta atrás de código**: las tablas nuevas
(`users`, `sessions`, `audit_log`, `work_items`, `confirmation_resends`) son
tablas aparte; ninguna columna de `orders`, `conversations` ni `messages` se
ha tocado. Una versión anterior del código simplemente las ignora.

---

## Lo que este despliegue NO cambia

- No toca WhatsApp ni sus plantillas.
- No toca las llamadas: siguen **MANUAL-ONLY**, kill switch como estaba.
- No toca Dropea, Dropi, Beeping ni Meta Ads.
- No relaja ningún guardarraíl (`safety.ts` y `calls/gates.ts` intactos).
- No cambia los webhooks: `/api/webhooks/*` y `/api/health` siguen públicos y
  autenticándose por firma, exactamente igual que antes.
