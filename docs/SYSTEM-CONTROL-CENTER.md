# Control Center — la pestaña "Sistema" del panel

El estado de todo el sistema en una pantalla: WhatsApp, Shopify, Dropea,
Dropi, la base de datos, las copias de seguridad, la cola de envíos, los
relojes internos y los envíos en curso. Pensado para responder en cinco
segundos a la pregunta "¿está todo bien?" — y cuando no lo está, a "¿qué
exactamente y desde cuándo?".

**Es de solo lectura.** Desde el Control Center no se reinicia nada, no se
borra nada, no se envía nada y no se repara nada. Medir y actuar son cosas
distintas a propósito: actuar exige el `.env`, la terminal o una decisión
humana.

---

## Los cinco estados

| Estado | Significa | ¿Arrastra el estado global? |
|---|---|---|
| `healthy` | Funcionando y con señales recientes | — |
| `warning` | Funciona, pero algo pide atención | Sí, a WARNING |
| `critical` | Roto o en riesgo real | Sí, a CRITICAL |
| `disabled` | Apagado **a propósito** (p. ej. Dropea sin API key) | No |
| `unknown` | Sin datos suficientes; jamás se inventa un estado | No |

Que `disabled`/`unknown` no arrastren el global es deliberado: tener Dropea
apagada no significa que el sistema esté mal. La excepción es **SQLite: si
la base de datos está en `critical`, todo el sistema está en `critical`**,
porque el resto de estados salen de ella y ya no serían fiables.

---

## Qué mide cada tarjeta (y de dónde sale)

| Tarjeta | Fuente de verdad | Qué NO mide |
|---|---|---|
| WhatsApp | `connection_state` (Baileys la escribe), `outbox`, `messages` | El contenido de los chats |
| Shopify | `orders` (último webhook = último pedido), `service_health` (la API al escribir el tag) | El estado de la tienda en sí |
| Dropea | `service_health` (cada llamada del cliente HTTP), `supplier_webhook_events`, contadores del feed | Nada que no hayamos llamado nosotros: sin llamadas → `unknown` |
| Dropi | Flags del `.env` + eventos | Nunca `healthy` mientras su autenticación siga sin confirmar |
| Base de datos | PRAGMAs de SQLite (`quick_check`, `journal_mode`, tamaños, `user_version`) | No ejecuta `VACUUM` ni repara |
| Backups | La carpeta `BACKUP_DIR` del disco (fichero más reciente + `quick_check` de la copia) | No restaura |
| Cola de envíos | Tabla `outbox` (pendientes, retenidos, `sent_at`) | No reenvía ni borra |
| Tareas | `service_health` (latidos) + `scheduler_runs` | — |
| Envíos | Columnas de tracking de `orders` | — |

La regla general: **si una integración nunca ha dado señales, se enseña
`unknown`/"nunca"** — el panel no rellena huecos con datos inventados.

---

## Las tres tablas nuevas de SQLite

Creadas igual que el resto del esquema (idempotente, sin tocar datos
existentes). Con esta fase la base estampa `PRAGMA user_version = 2`.

### `service_health` — una fila por servicio

`service` (PK), `status`, `last_success_at`, `last_error_at`,
`last_error_message`, `last_checked_at`, `metadata_json`.

La escriben los **puntos de paso** que ya existían: el cliente HTTP de
Dropea, el admin de Shopify (la única mutación del sistema), el loop del
outbox y los latidos de los schedulers. Cuando el estado de un servicio
**empeora**, se deja además una alerta en el feed de eventos; cuando se
recupera, otra. Eso es lo que alimenta "Últimos problemas" del Resumen.

### `scheduler_runs` — ejecuciones con contenido

`scheduler_name`, `started_at`, `finished_at`, `status`, `processed_count`,
`error_count`, `last_error`.

Los ticks **sin trabajo no generan filas** (el outbox corre cada 2
segundos y llenaría la tabla); su "sigo vivo" va a `service_health` con un
throttle de 60 s. Se conservan 7 días.

### `integration_events` — el feed técnico

`integration`, `event_type`, `severity` (`info`/`warning`/`critical`),
`order_ref`, `message`, `created_at`. Se conservan las últimas 5000.

Eventos que hoy se registran: cambios de estado de servicios, tag
`WA_CONFIRMED` escrito, webhook con firma inválida (Shopify y Dropea),
webhook duplicado ignorado, pedido adoptado de la app oficial, updates de
tracking, 429 de Dropea, estados de Dropi sin mapear, backup verificado.

**Todo lo que entra pasa por el sanitizador** (`src/lib/system/sanitize.ts`):
teléfonos enmascarados (`34XXXXXXX95`), emails fuera, cualquier cosa con
pinta de token/JWT/HMAC fuera, longitud acotada a 300 caracteres. La regla
es borrar, no confiar: estas tablas se enseñan en pantalla y pueden acabar
en un pantallazo.

---

## Umbrales (configurables por `.env`, con defaults seguros)

```env
SYSTEM_HEALTH_ENABLED=1     # 0 apaga la instrumentación (las lecturas siguen)
TRACKING_STALE_HOURS=12     # envío activo sin noticias en más de X h → aviso
BACKUP_WARNING_HOURS=24     # última copia más vieja que esto → warning
BACKUP_CRITICAL_HOURS=48    # … que esto → critical
OUTBOX_STALE_MINUTES=15     # pendiente sin salir en X min → "¿corre el bot?"
```

Reglas fijas que conviene conocer:

- **Outbox retenidos**: un mensaje pendiente que supera
  `OUTBOX_MAX_AGE_MINUTES` (60 por defecto) **no saldrá solo jamás** (es la
  protección anti-restos). El panel lo marca en warning con la instrucción
  de revisarlo (`npm run outbox:inspect`); más de 10 retenidos, o uno de
  más de 24 h, es critical.
- **Schedulers**: latido atrasado más de 3× su intervalo → warning; más de
  10× → critical; sin latido nunca → `unknown` (en local con el bot parado
  es lo normal). **Ojo con el arranque en frío**: cada scheduler solo puede
  dar su primer latido después de esperar su propio intervalo completo, así
  que `tracking` y `watchdog` (cada 5 min) se muestran como *"nunca ha dado
  señales"* durante los primeros 5 minutos tras un despliegue o reinicio —
  no es un fallo, es el tiempo normal de espera hasta el primer tick.
  Confirmado en el [smoke test 2026-08-22](SMOKE-TEST-NAS-2026-08-22.md):
  contenedor arriba a las 20:02:42, primeros latidos de `tracking`/`watchdog`
  a las 20:07:42/43, al segundo exacto.
- **Backups**: además de la edad, se comprueba la **integridad de la última
  copia** (`quick_check` sobre el fichero, cacheado): una copia corrupta es
  critical aunque sea de hace cinco minutos.
- **WAL hinchado**: si el `-wal` supera 2 MB y 4× el tamaño de la DB, se
  avisa (checkpoint atrasado, pasa con conexiones siempre abiertas). Se
  compacta solo al reiniciar el contenedor; no es urgente y el panel no
  intenta "arreglarlo".
  **Detectado en el NAS** ([smoke test 2026-08-22](SMOKE-TEST-NAS-2026-08-22.md)):
  un WAL de 3.9 MB sobre una DB de 264 KB no disparó el aviso, porque el
  piso absoluto vigente en ese momento era de 4 MB y el WAL se quedó justo
  por debajo. El piso se bajó a los 2 MB actuales ese mismo día
  precisamente por este hallazgo. También se confirmó que **reiniciar el
  contenedor no compacta el WAL** (el fichero se reutiliza, no se trunca
  salvo `journal_size_limit`); lo que sí funciona es el *checkpoint*, que
  vuelca datos del WAL al `.db` principal sin reducir el tamaño reservado
  del WAL.

---

## La CLI: `npm run db:health`

Para el NAS, donde el contenedor **no trae `sqlite3`**. Da todo lo que se
sacaría con él, sanitizado y sin tocar nada:

```bash
docker compose exec casamable-agent npm run db:health           # rápido
docker compose exec casamable-agent npm run db:health -- --full # integrity_check completo
```

Sale: integridad, modo journal, tamaños DB/WAL (con el aviso de WAL
hinchado si aplica), versión de esquema, filas por tabla, estado del
outbox, de las copias y de los schedulers. Código de salida 1 si hay algo
crítico (útil para scripts).

---

## Seguridad

- Las rutas (`/api/system`, `/api/system/events`) quedan **detrás del Basic
  Auth del panel** (no están en la lista pública del proxy, que solo exime
  webhooks y healthchecks).
- No existe: descarga del `.db`, SQL arbitrario, acceso a shell o Docker,
  reinicios, lectura del `.env` ni de `auth/`, payloads crudos de webhooks.
- El número del negocio aparece **siempre enmascarado**; el JSON completo
  del overview está cubierto por un test que verifica que ni el token de
  Shopify, ni la API key de Dropea, ni el signing secret, ni un teléfono
  completo pueden aparecer en él.
- `SYSTEM_HEALTH_ENABLED=0` apaga las escrituras de instrumentación por
  completo (por si alguna vez estorbara); el panel sigue leyendo lo que
  haya.

---

## Local vs NAS

Todo degrada sin romperse fuera del NAS:

| Situación local | Qué enseña |
|---|---|
| Carpeta `backups/` inexistente | Backups: `unknown` ("normal fuera del NAS") |
| Bot parado (VS Code cerrado) | WhatsApp: `critical` (es la verdad); schedulers: `unknown`/atrasados con nota "¿el bot corre?" |
| Dropea/Dropi sin credenciales | `disabled`, no error |
| Sin ningún pedido | Contadores a cero, fechas "nunca" |

Ninguna ruta del NAS está hardcodeada: `DATA_DIR` y `BACKUP_DIR` vienen del
entorno, como siempre.

---

## Cómo probarlo

```bash
npm test              # 183 tests, 25 del Control Center
npm run db:health     # la CLI contra tu DB local
npm run dev           # panel → pestaña "Sistema"
```

En local lo esperable es: SQLite healthy, backups unknown/viejos, WhatsApp
critical si el bot está parado, Dropea/Dropi disabled, schedulers unknown.
Eso **es** el comportamiento correcto: el panel dice la verdad del entorno
en el que corre.

## Cómo interpretar los estados sin volverse loco

1. **Overall CRITICAL** → mira las tarjetas en rojo. Solo hay tres causas
   posibles de verdad: WhatsApp caído, SQLite roto, o backups muy viejos.
2. **Overall WARNING** → el sistema funciona; hay algo que revisar con
   calma (un retenido en la cola, un envío sin noticias, una copia vieja).
3. **Una integración `disabled`** → está apagada a propósito. No es un
   problema; es una decisión.
4. **`unknown` por todas partes en local** → normal. El estado real vive
   en el NAS, que es la fuente de verdad operativa.
