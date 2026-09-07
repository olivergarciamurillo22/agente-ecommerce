# Estado de producción — Casamable™

Documento vivo: **lo que corre de verdad en el NAS**. Se actualiza en cada
sesión de operación. El detalle de cómo se llegó a cada estado vive en
`docs/archive/` — este es el snapshot, no el historial.

**Última actualización: 07-09-2026** (estado del NAS sin cambios desde el 05-09; lo que cambia es el candidato).

---

## 1 · Qué corre hoy

| | |
|---|---|
| Rama desplegada | `feat/casamable-control-center-v2` |
| Commit desplegado | **INCÓGNITA (07-09).** Los docs dicen `67f05c7` (02-09) y el runbook del 05-09 preparaba `fdad99e`; ninguno está confirmado. Cómo confirmarlo: `docs/deploy/NAS-PRODUCTION.md` § PRODUCTION_COMMIT. Desde el próximo despliegue, `/api/health/live` devuelve `build` |
| Esquema SQLite | **15** |
| Contenedor | `casamable-agent`, healthy, `restart: unless-stopped` |
| NAS | UGREEN DXP2800, `192.168.2.109` |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | **Cloud API oficial de Meta** (`WHATSAPP_PROVIDER=cloud_api`), número `+34 641 308 254` |
| Modo | `APP_MODE=production` · `TEST_MODE=1` (solo allowlist) · `WHATSAPP_SEND_ENABLED=1` |
| Llamadas (Retell) | Instalado, **MANUAL-ONLY** (el scheduler no marca solo), kill switch cerrado |
| Dropea | read-only, `DROPEA_WRITE_ENABLED=0`, creación vía su app oficial |
| Dropi | sin API (solo diagnóstico), sincronización de su app desactivada |
| Beeping | **apagado** (sin credencial; todo fail-closed) |
| Meta Ads | read-only, funcionando (cuenta `act_1365655995103103`, EUR, Europe/Madrid) |

## 2 · Incidentes abiertos (02-09) y su estado en código

1. **WhatsApp 132001** — el primer mensaje enviaba un nombre de plantilla
   inexistente en la WABA. **Arreglado en la rama v3** (mapping lógico →
   `pedido` con verificación obligatoria vía `whatsapp:templates:doctor`);
   pendiente de desplegar y verificar en el NAS.
2. **Tracking claim-antes-del-gate** y placeholders "No disponible" —
   **arreglados en v3**; pendiente de desplegar.
3. **Retell "[password 1]"** — preflight de variables + versión de agente
   fijable (`RETELL_AGENT_VERSION`) + prompt versionado en
   `config/retell/casamable-agent-prompt.md`. Pendiente de: pegar prompt,
   publicar versión, doctor y llamada de prueba.

## 3 · Qué falta para mover producción

> **07-09-2026:** el candidato vigente pasa a ser **`release/casamable-v4.3`
> (esquema 24)**, que contiene íntegro el candidato de abajo (`v4.2` @
> `fdad99e`, merge de `origin/release/casamable-v4.2` @ `4e07ff5`) más el
> workspace, Hunter + Landing Studio (19), predictivo (20) y discovery (21).
> El salto de esquema desde producción (15) es **15 → 26** (22 = validación de direcciones, 23 = auto-despacho, 24 = canal de despacho, 25 = auto-cancelación IA, 26 = aviso de despacho; 07-09), todo aditivo y
> ensayado con el fixture realista (`scripts/test-migration-v43.ts`). Guía
> de release: `docs/deploy/RELEASE-v4.3.md`. Lo que corre en el NAS no se ha
> podido confirmar desde el repo: hace falta `PRODUCTION_COMMIT`.

**Candidato del 05-09 (integrado en v4.3): `release/casamable-v4.2` @ `fdad99e` (esquema 18).**
Contiene el hotfix de Retell/ops, la integración móvil, el espacio de
atención al cliente con roles y auditoría, y los tres arreglos de conducta
del bot en WhatsApp del 05-09 (`docs/CONVERSACION-REGLAS.md`).

Efecto operativo a vigilar la primera semana: esa conducta manda **más
conversaciones a la bandeja de atención** que antes. Es deliberado (sale más
barato que un rehusado), pero si se llena de casos resolubles el ajuste está
en `orders/free-text-intent.ts`, no en volver a los bucles.
Guía exacta: **`docs/deploy/PEDRO-WORKSPACE-05-09.md`** — lleva un **paso
nuevo obligatorio**: crear los usuarios con `npm run users:create`, sin el
cual nadie puede entrar al panel.

> (Párrafo del 05-09, superado: hoy el salto es 15 → 24, ver la nota de arriba.)

El salto de esquema era **15 → 18** (tres migraciones aditivas: versión de
agente en llamadas, atribución de marketing, workspace/auth). Ensayado el
05-09 sobre copias — `17 → 18` y la cadena completa `0 → 18` — idempotente,
`integrity_check ok` y sin perder una fila. Ninguna columna de `orders`,
`conversations` ni `messages` cambia: las cinco tablas nuevas son aparte, así
que una vuelta atrás de código las ignora sin estorbo.

### Qué está activo por defecto en v4.3 (07-09) con el `.env` actual del NAS

| Pieza | Estado con el `.env` de hoy | Cómo se activa |
|---|---|---|
| Validación de direcciones capa 1 (determinista) | **ACTIVA**: solo abre `ALERTA_DIRECCION` (visible en panel, retiene el mark-to-send automático); no bloquea la confirmación | siempre |
| Validación capa 2 (OpenAI) | apagada | `ADDRESS_AI_VALIDATION_ENABLED=1` + `OPENAI_API_KEY` (decisión de Pedro) |
| Cooldown de auto-despacho (6 h) | apagado: confirmar dispara el hook inmediato como en v4.2 | `AUTO_DISPATCH_COOLDOWN_ENABLED=1` + rellenar `dispatch_channels` (`npm run dispatch:channels`) |
| IA de intención post-confirmación | apagada: texto libre tras confirmar → persona | `POST_CONFIRMATION_AI_ENABLED=1` + `OPENAI_API_KEY` (FAQ ya aprobada el 07-09; incluye auto-cancelación ≥ 0,85) |
| Router de canal (`dispatch_channels`) | tabla vacía: ningún producto tiene canal | Pedro, producto a producto |
| Dropea escritura | `DROPEA_WRITE_ENABLED=0` (política): un producto en canal `dropea` quedaría RETENIDO | decisión de Pedro |
| Identidad de build | `/api/health/live` devuelve `build` = SHA de la imagen (`sin_confirmar` si no se pasó `GIT_SHA`) | `scripts/nas-verify-v43.sh` lo exige |

Antes del NAS: `npm run migration:verify -- --db <copia real de messages.db>` (un comando; `docs/deploy/MIGRATION-v4.3.md`). Pendiente: Pedro aún no ha facilitado una copia real.

Evidencia del piloto: `docs/REAL-PILOT-02-09.md` (matriz única — ambos
circuitos en BLOCKED hasta que Pedro pegue resultados).

Dos rojos heredados que **no** arregla este candidato y siguen bloqueando el
piloto: la plantilla de confirmación (`whatsapp:templates:doctor`, exige
credenciales de la WABA) y la firma de webhooks de Retell (exige la API key
con distintivo *webhook* en el `.env` del NAS).

### Acceso al panel: decisión pendiente de Pedro

`DASHBOARD_PASSWORD` **sigue dando acceso completo de propietario aunque ya
existan usuarios** (comprobado el 05-09). Es una llave compartida y anónima:
quien entra por ahí figura en la auditoría como «Propietario (Basic Auth)»,
sin persona detrás. Recomendado: crear el usuario `owner`, verificar el
acceso y **retirar la variable del `.env`**. Detalle y alternativas en
`docs/deploy/PEDRO-WORKSPACE-05-09.md` §5.

## 4 · Lo que no se toca

`DROPEA_WRITE_ENABLED=0` · `BEEPING_*=0` · defaults fail-closed ·
`EMERGENCY_STOP` semántica fail-closed · llamadas MANUAL-ONLY hasta piloto
verificado · franja de despliegue: nunca 10:00–21:00 (corta WhatsApp).
