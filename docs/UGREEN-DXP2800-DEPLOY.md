# Despliegue en el NAS UGREEN DXP2800 (UGOS Pro + Docker)

Guía para dejar Casamable™ funcionando 24/7 en el NAS de Pedro. Empieza con
el NAS encendido y termina con un pedido Releasit real confirmado por WhatsApp.

**Antes de empezar, ten a mano:**

- El NAS encendido y accesible desde UGOS Pro.
- El móvil con el **WhatsApp Business de Casamable** (`34641308254`).
- Las credenciales de Shopify (secret del webhook + client id/secret).
- Un ordenador en la **misma red** que el NAS.

> ⚠️ Durante todo el despliegue mantenemos **`TEST_MODE=1`**: solo vuestros
> teléfonos de prueba pueden recibir mensajes. Ningún cliente real se ve
> afectado hasta que decidáis lo contrario.

---

## 1 · Preparar Docker en UGOS Pro

1. Enciende el NAS y entra en **UGOS Pro** desde el navegador.
2. Abre el **App Center** e instala **Docker** si no está instalado.
3. Abre la app **Docker**. Verás pestañas de *Contenedores*, *Imágenes* y
   *Proyectos* (o *Compose*, según versión).
4. Activa **SSH** temporalmente: *Panel de control → Terminal y SNMP →
   Habilitar servicio SSH*. Es la vía más cómoda para el primer despliegue.
   **Apágalo cuando termines** (ver sección 12).

## 2 · Crear las carpetas persistentes

Aquí vive lo que NO se puede perder. Desde **File Station** (o por SSH),
crea esta estructura dentro de una carpeta compartida:

```text
CasamableAgent/
├── auth/       ← sesión de WhatsApp (evita reescanear el QR)
├── data/       ← base de datos SQLite (pedidos y estados)
├── backups/    ← copias diarias de la base de datos
└── repo/       ← el código
```

**Apunta la ruta real completa.** En UGOS Pro suele ser algo como
`/volume1/docker/CasamableAgent` o `/volume2/…`. Para verla exactamente,
por SSH:

```bash
ls -d /volume*/docker 2>/dev/null || ls -d /volume*
```

Esa ruta es la que irá en `PERSIST_DIR`. **No la inventes**: si apuntas a una
carpeta que no existe, Docker creará uno vacío y perderás la sesión de
WhatsApp en cada recreación del contenedor.

## 3 · Traer el código

Conéctate por SSH al NAS (usuario admin de UGOS):

```bash
ssh TU_USUARIO@IP_DEL_NAS
cd /volume1/docker/CasamableAgent        # ← tu ruta real
```

**UGOS Pro no trae `git`.** En vez de instalar nada en el host, se clona con
un contenedor desechable (probado en el despliegue real):

```bash
docker run --rm -v /volume1/docker/CasamableAgent:/repo \
  alpine/git clone https://github.com/olivergarciamurillo22/agente-ecommerce.git /repo/repo
```

> ⚠️ **Permisos: este paso falla si te lo saltas.** El clonado deja los
> ficheros como `root` con permisos `700`, y el contenedor final corre como
> usuario `node` (no root) → `EACCES` al construir o al arrancar. Se arregla
> solo desde el host, sin tocar el Dockerfile:
>
> ```bash
> sudo chmod -R u+rwX,go+rX /volume1/docker/CasamableAgent/repo
> ```

Alternativa sin línea de comandos: descarga el ZIP del repositorio desde
GitHub y descomprímelo en `CasamableAgent/repo` con File Station (revisando
igualmente los permisos).

## 4 · Crear el `.env` de producción

```bash
cp .env.nas.example .env
nano .env        # o edítalo desde File Station
```

Rellena **obligatoriamente** los campos marcados con ⬅ en el fichero:

| Variable | Qué poner |
|---|---|
| `PERSIST_DIR` | La ruta real del paso 2, p.ej. `/volume1/docker/CasamableAgent` |
| `DASHBOARD_PASSWORD` | Una contraseña fuerte. **Sin ella el contenedor no arranca** |
| `TEST_PHONE_ALLOWLIST` | Vuestros móviles de prueba, con prefijo: `34600111222,34600333444` |
| `SHOPIFY_WEBHOOK_SECRET` | Clave de firma del webhook de Shopify |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Credenciales del Dev Dashboard |
| `ALERT_WHATSAPP` | Móvil de Pedro para avisos técnicos |

Deja `TEST_MODE=1` y `APP_MODE=production`.

## 5 · Construir y levantar

```bash
docker compose up -d --build
```

La primera construcción tarda unos minutos. Comprueba que arrancó bien:

```bash
docker compose ps                    # debe decir "healthy" tras ~1-2 min
docker compose logs -f casamable-agent
```

En los logs debes ver el bloque de seguridad y el QR:

```text
CASAMABLE SAFETY STATUS
APP_MODE: PRODUCTION
TEST_MODE: ON
...
[bot] QR generado
```

Alternativa desde la interfaz: en la app Docker de UGOS Pro, pestaña
**Proyectos → Crear**, selecciona la carpeta `repo` y su `docker-compose.yml`.

## 6 · Abrir el dashboard en la red local

1. Averigua la IP del NAS: en UGOS Pro, *Panel de control → Red*, o mirando
   la lista de dispositivos del router. Suele ser `192.168.1.X`.
2. Desde cualquier equipo de la misma red, abre:

   ```text
   http://IP_DEL_NAS:3000
   ```

3. El navegador pedirá usuario y contraseña: **el usuario da igual**, la
   contraseña es tu `DASHBOARD_PASSWORD`.
4. Verás la pantalla del código QR.

Si no carga, comprueba que el puerto no esté ocupado por otra app del NAS;
si lo está, cambia `HOST_PORT` en el `.env` (por ejemplo a `3100`) y repite
`docker compose up -d`.

## 7 · Conectar el WhatsApp Business

1. En el móvil con la línea de Casamable: **WhatsApp Business → Ajustes →
   Dispositivos vinculados → Vincular un dispositivo**.
2. Escanea el QR del dashboard.
3. El panel pasa a **Conectado +34641308254**.
4. Comprueba en los logs que **no** aparece el aviso de número equivocado:

   ```bash
   docker compose logs casamable-agent | grep -i "conectado como"
   ```

La sesión queda guardada en `CasamableAgent/auth/`. **No borres esa carpeta**
o habrá que reescanear.

## 8 · Prueba de reinicio (obligatoria)

No sigas sin pasar esta prueba:

```bash
docker compose restart casamable-agent
docker compose logs -f casamable-agent
```

Debes ver `✓ conectado como 34641308254` **sin QR nuevo**. Después:

```bash
docker compose down          # destruye el contenedor
docker compose up -d         # lo recrea
```

Vuelve a comprobar: sesión conservada, pedidos intactos en el dashboard. Si
tras esto pidiera QR otra vez, los volúmenes están mal montados — revisa
`PERSIST_DIR` antes de continuar.

## 9 · Acceso externo

Shopify necesita una URL HTTPS pública y **estable**. Hay dos caminos válidos.
Prueba la **Opción A** si tu dominio te deja delegar los DNS a Cloudflare; si
no, la **Opción B** es la que se usó en el despliegue real de Casamable.

En ambos casos el NAS **no recibe ninguna conexión entrante de internet**:
siempre es él quien abre la conexión hacia fuera.

### Opción A · Cloudflare Tunnel

Sin abrir puertos del router y sin exponer el NAS.

> ⚠️ **Requiere delegar el dominio (o el subdominio) a los NS de Cloudflare.**
> Algunos registradores no lo permiten en dominios `.es` empaquetados con
> hosting — con Strato, el NS del dominio raíz es intocable —, y el plan
> gratuito de Cloudflare no da de alta un subdominio como zona propia
> ("Subdomain setup" exige plan Business/Enterprise). Si te topas con eso, ve
> directo a la Opción B.

**En el panel de Cloudflare** (pasos manuales, una sola vez):

1. Añade tu dominio (`casamable.es`) a Cloudflare si no está.
2. Entra en **Zero Trust → Networks → Tunnels → Create a tunnel**.
3. Tipo **Cloudflared**, nombre `casamable-nas`.
4. Copia el **token** del túnel.
5. En *Public Hostnames*, añade:
   - Subdominio: `agente` · Dominio: `casamable.es`
   - Servicio: `HTTP` → `casamable-agent:3000`

**En el NAS:**

```bash
nano .env      # pega el token en CLOUDFLARE_TUNNEL_TOKEN
docker compose --profile tunnel up -d
docker compose logs -f cloudflared      # debe decir "Registered tunnel connection"
```

Comprueba desde fuera de tu red (por ejemplo, con datos móviles):

```text
https://agente.casamable.es
```

> El token del túnel **nunca** va a Git: vive solo en el `.env` del NAS.

### Opción B · VPS puente (WireGuard + Caddy)

**Ésta es la configuración que corre hoy en producción**, tras descartar la
Opción A por las restricciones de DNS descritas arriba. Un VPS mínimo hace de
proxy HTTPS público y un túnel WireGuard privado lo une con el NAS.

```text
Internet → Caddy (VPS, HTTPS) → WireGuard (túnel privado) → NAS (casamable-agent:3000)
```

**1. VPS.** Cualquier proveedor sirve; con ~5-7 €/mes sobra (en producción:
Hetzner CX23, Ubuntu LTS). Anota su IP pública.

**2. Firewall del VPS** — solo estos cuatro puertos:

```bash
apt install -y ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 51820/udp
ufw enable
```

**3. Túnel WireGuard.** En cada máquina, genera su par de claves:

```bash
apt install -y wireguard
wg genkey | tee privatekey | wg pubkey > publickey
```

`/etc/wireguard/wg0.conf` en el **VPS**:

```ini
[Interface]
Address = 10.10.10.1/24
ListenPort = 51820
PrivateKey = <clave PRIVADA del VPS>

[Peer]
PublicKey = <clave PÚBLICA del NAS>
AllowedIPs = 10.10.10.2/32
```

`/etc/wireguard/wg0.conf` en el **NAS**:

```ini
[Interface]
Address = 10.10.10.2/24
PrivateKey = <clave PRIVADA del NAS>

[Peer]
PublicKey = <clave PÚBLICA del VPS>
Endpoint = IP_PUBLICA_DEL_VPS:51820
AllowedIPs = 10.10.10.1/32
PersistentKeepalive = 25
```

> 🔐 Las claves **privadas** no salen nunca de su máquina: no se copian por
> chat, ni al repositorio, ni a un gestor de notas. Solo se intercambian las
> **públicas**. Si una privada se expone, regenera el par en ambos extremos.

En las dos máquinas:

```bash
wg-quick up wg0
systemctl enable wg-quick@wg0      # que sobreviva a un reinicio
wg show                            # debe aparecer "latest handshake" en ~25s
```

**4. Caddy en el VPS**, apuntando a la **IP del túnel**, no al nombre del
servicio Docker (`casamable-agent` no se resuelve: Caddy vive en otra máquina):

```bash
apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```text
agente.casamable.es {
    reverse_proxy 10.10.10.2:3000
}
```

```bash
systemctl restart caddy
```

Caddy pide y renueva el certificado de Let's Encrypt solo, en cuanto resuelva
el DNS del paso siguiente.

**5. DNS.** En el panel de tu proveedor, crea un **registro A** de
`agente.casamable.es` → IP pública del VPS. Si ese subdominio tuviera NS
delegados a Cloudflare de un intento previo de la Opción A, revierte primero a
los NS por defecto del proveedor: mientras estén delegados no te dejará
gestionar el registro A.

Comprueba desde fuera de tu red (con datos móviles):

```text
https://agente.casamable.es
```

**6. Prueba de resiliencia.** Reinicia el VPS y el NAS **por separado** (no a
la vez) y confirma que WireGuard, Caddy y Docker vuelven solos y el túnel
rehace el handshake sin tocar nada — puede tardar hasta un minuto por el
`PersistentKeepalive`. Es la prueba de que el puente sobrevive a un corte de
luz o a un mantenimiento.

## 10 · Apuntar el webhook de Shopify

Este paso es **manual** (no lo cambiamos por API):

1. Shopify Admin → **Configuración → Notificaciones → Webhooks**.
2. Edita el webhook de *Creación de pedidos* y pon:

   ```text
   https://agente.casamable.es/api/webhooks/shopify/orders-create
   ```

3. Verifica que el `SHOPIFY_WEBHOOK_SECRET` del `.env` sigue siendo el de esa
   página. Si cambia, actualiza el `.env` y reinicia el contenedor.
4. Pulsa **Enviar prueba** y comprueba en los logs que llega.

## 11 · Pedido de prueba de punta a punta

1. Con `TEST_MODE=1` y vuestros móviles en la allowlist, haz un pedido COD
   real con el formulario Releasit usando **uno de vuestros teléfonos**.
2. En los logs debes ver:

   ```text
   [SHOPIFY] Order #XXXX received
   [ORDER] COD detected #XXXX
   [WHATSAPP] Confirmation sent #XXXX
   ```

3. Te llega el WhatsApp desde el número de Casamable. Responde `1`.
4. El dashboard muestra **CONFIRMADO**.
5. En Shopify, el pedido tiene el tag `WA_CONFIRMED` junto a los que ya tenía.

Con esto, el NAS está sirviendo el sistema completo.

## 12 · Cerrar el NAS

Cuando termines la instalación:

- **Desactiva SSH** en UGOS Pro (*Panel de control → Terminal y SNMP*).
- **No abras puertos en el router.** Ninguna de las dos opciones lo necesita:
  con Cloudflare Tunnel y con el puente VPS, el NAS solo abre conexiones
  *hacia fuera*, nunca al revés. Nunca expongas a internet la interfaz de
  UGOS, SMB, SSH ni el socket de Docker.
- Lo único accesible desde fuera debe ser `https://agente.casamable.es`.
- Usa una **contraseña fuerte** en `DASHBOARD_PASSWORD`: en cuanto el panel
  es accesible desde internet, protege datos de clientes reales.

---

## Operación diaria

### Backups

Copia consistente de la base de datos (usa la API de backup de SQLite, segura
aunque el bot esté escribiendo):

```bash
docker compose exec casamable-agent npm run backup
```

Quedan en `CasamableAgent/backups/`, con retención de 7 días.

**Para automatizarlo a diario** hay dos vías; en producción se usó el cron
nativo del NAS:

```bash
# crontab -e  (en el NAS) → una copia cada día a las 04:00
0 4 * * * docker exec casamable-agent npm run backup
```

El contenedor va en `Europe/Madrid`, así que la hora del cron es la local: no
hay que convertir nada a UTC. Alternativa por interfaz: *Panel de control →
Programador de tareas → Crear → Script programado*, con ese mismo comando.

**Restaurar** una copia: para el contenedor, sustituye
`data/messages.db` por el fichero de backup (renombrándolo a `messages.db`) y
borra los `messages.db-wal` y `-shm` que hubiera. Luego arranca de nuevo.

### Actualizar el código

```bash
cd /volume1/docker/CasamableAgent/repo
docker compose exec casamable-agent npm run backup   # 1. backup ANTES
git pull                                             # 2. traer cambios
docker compose up -d --build                         # 3. reconstruir
docker compose ps                                    # 4. esperar "healthy"
docker compose logs --tail 40 casamable-agent        # 5. ver que reconecta
```

Después comprueba: dashboard accesible, WhatsApp conectado, pedidos intactos.

### Rollback

Si una actualización sale mal:

```bash
cd /volume1/docker/CasamableAgent/repo
git log --oneline -5          # localiza el commit anterior
git checkout <commit-anterior>
docker compose up -d --build
```

Los datos no se tocan en ningún momento (viven en los volúmenes). Si además
la base de datos quedó dañada, restaura el backup previo como se indica arriba.

### Parada de emergencia

Para cortar **todo envío** al instante sin apagar el panel:

```bash
nano .env                     # EMERGENCY_STOP=1
docker compose restart casamable-agent
```

O directamente `docker compose stop casamable-agent`.

### Comprobar el estado

```bash
curl -s http://localhost:3000/api/health/live    # app + base de datos
curl -s http://localhost:3000/api/health         # incluye estado de WhatsApp
docker compose ps                                # healthy / unhealthy
docker stats --no-stream casamable-agent         # CPU y memoria
```

---

## Notas técnicas

**Healthcheck**: Docker usa `/api/health/live`, que responde 200 mientras la
app y la base de datos funcionen, **aunque WhatsApp esté desconectado**. Es
deliberado: Baileys reconecta solo y reiniciar el contenedor cortaría esa
reconexión, provocando un bucle. `/api/health` sí devuelve 503 con WhatsApp
caído, y sirve para monitores externos.

**Zona horaria**: el contenedor va con `TZ=Europe/Madrid`. Es importante:
SQLite calcula los contadores "de hoy" en hora local, y la ventana horaria de
envío (09:00–21:00) depende de ello.

**Recursos**: límite de 1,5 GB de RAM y 2 CPUs; reserva de 384 MB y 0,25 CPU.
En reposo el conjunto consume bastante menos. De los 8 GB del NAS queda de
sobra para UGOS y el resto de apps.

**Disco**: la base de datos crece despacio, pero con `STORE_RAW_PAYLOAD=1` se
guarda el payload completo de cada pedido (hasta ~200 KB). Con mucho volumen,
ponlo a `0` para reducirlo drásticamente.

**Logs**: rotación configurada a 3 ficheros de 10 MB (30 MB máximo). El NAS
no se llenará.
