# Estado de producción — Casamable™

Documento vivo: **lo que corre de verdad en el NAS**. Se actualiza en cada
sesión de operación. El detalle de cómo se llegó a cada estado vive en
`docs/archive/` — este es el snapshot, no el historial.

**Última actualización: 08-09-2026 (noche)** — el 07-09 se desplegó `release/casamable-v4.3` (`22f8013`, informe `docs/deploy/DEPLOY-REPORT-v4.3-2026-09-07.md`) y el 08-09 los dos fixes de seguridad de la auditoría (`f2af494`, informe `docs/deploy/DEPLOY-REPORT-fixes-2026-09-08.md`). Recuentos del 08-09: 136 pedidos / 80 conversaciones / 474 mensajes.

---

## 1 · Qué corre hoy

| | |
|---|---|
| Rama desplegada | `release/casamable-v4.3` (desplegada 07-09-2026 por la noche) |
| Commit desplegado | **`f2af4940639ec4a051404c3cb72868448d06bf8b`** (08-09-2026 ~23:40: fixes de seguridad `f427b9f` + `0228ad5` + docs, sobre `22f8013`). Confirmado por `/api/health/live` → `build`. Informe: `docs/deploy/DEPLOY-REPORT-fixes-2026-09-08.md` |
| Esquema SQLite | **30** (era 17 antes del despliegue, no 15 ni 18 como decían los docs) |
| Contenedor | `casamable-agent`, healthy, `restart: unless-stopped` |
| NAS | UGREEN DXP2800, `192.168.2.109` |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | **Cloud API oficial de Meta** (`WHATSAPP_PROVIDER=cloud_api`), número `+34 641 308 254` |
| Modo | `APP_MODE=production` · `WHATSAPP_SEND_ENABLED=1`. **Rollout ACTIVO a clientes reales (confirmado por Pedro el 08-09-2026).** La línea anterior de este doc («`TEST_MODE=1`, solo allowlist») estaba desactualizada y llevó a la auditoría del 08-09 a concluir que el negocio no estaba encendido. Los valores exactos de `TEST_MODE`, `TEST_PHONE_ALLOWLIST` y `whatsapp_rollout_percent` en el NAS **no están volcados en el repo**: pendiente de que Pedro los pegue aquí |
| Llamadas (Retell) | Instalado, **MANUAL-ONLY** (el scheduler no marca solo), kill switch cerrado |
| Dropea | read-only, `DROPEA_WRITE_ENABLED=0`, creación vía su app oficial |
| Dropi | sin API (solo diagnóstico), sincronización de su app desactivada |
| Beeping | **apagado** (sin credencial; todo fail-closed) |
| Meta Ads | read-only, funcionando (cuenta `act_1365655995103103`, EUR, Europe/Madrid) |
| Ad Library (Cazador) | desplegado; `META_AD_LIBRARY_ACCESS_TOKEN` caducado → la pestaña Competencia avisa y no encola nada |
| Flags v4.3 | El informe del despliegue del 07-09 los dejó a 0. **Pedro confirma el 08-09 que la IA y el detector de direcciones ya funcionan en real**, así que al menos `ADDRESS_AI_VALIDATION_ENABLED` está a 1; el valor real de los cuatro (`ADDRESS_AI_VALIDATION_ENABLED`, `AUTO_DISPATCH_COOLDOWN_ENABLED`, `POST_CONFIRMATION_AI_ENABLED`, `DISPATCH_NOTICE_WHATSAPP_ENABLED`) hay que leerlo del `.env` del NAS y pegarlo aquí |
| Plantillas WhatsApp | doctor 8 PASS / 1 DISABLED / 0 FAIL (07-09, tras el hotfix `22f8013`) |
| Fixes de seguridad 08-09 | `f427b9f` (mark-to-send de Beeping respeta `EMERGENCY_STOP` y allowlist) y `0228ad5` (el token de Meta ya no se persiste en `ad_snapshot_url`; purga ejecutada: 0 filas afectadas) **desplegados el 08-09 ~23:40**. Esquema sin cambio (30). Imagen de rollback `casamable-agent:pre-fixes-0809` |
| Dropea vs Beeping | **No es una decisión pendiente**: el enrutado ya es por producto (`dispatch_channels`). Lo que falta es que Beeping entregue la información de conexión (bloqueo externo) |

### Incidente cerrado el 07-09: confirmación bloqueada por la plantilla

La plantilla aprobada `confirmacion_pedido_cod` pasó de 4 a 5 variables en
WhatsApp Manager (línea de confirmación de dirección) después del 01-09 y
el contrato local seguía en 4. El fail-safe bloqueó los envíos: 3 fallos
reales en outbox desde el 06-09 15:13, ningún cliente con mensaje roto,
ningún pedido atascado. Ya existía en `adb2be7`; corregido en `22f8013`.
Detalle en `docs/deploy/DEPLOY-REPORT-v4.3-2026-09-07.md` §3.

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
> (esquema 30)**, que contiene íntegro el candidato de abajo (`v4.2` @
> `fdad99e`, merge de `origin/release/casamable-v4.2` @ `4e07ff5`) más el
> workspace, Hunter + Landing Studio (19), predictivo (20) y discovery (21).
> El salto de esquema desde producción (15) es **15 → 30** (22 = validacion de direcciones, 23 = auto-despacho, 24 = canal de despacho, 25 = auto-cancelacion IA, 26 = aviso de despacho, 27 = tope diario de IA, 28 = estado de corrida de discovery, 29 = cola de busquedas, 30 = tipos de trabajo de la cola: auditoria de tienda y cadena; 07-09), todo aditivo y
> ensayado con el fixture realista (`scripts/test-migration-v43.ts`). Guía
> de release: `docs/deploy/RELEASE-v4.3.md`.
>
> **08-09-2026: HECHO.** Desplegado el 07-09 (`22f8013`, esquema real 17 → 30,
> recuentos intactos). Esta sección queda como historial; lo pendiente ahora
> está en `DEPLOY-REPORT-v4.3-2026-09-07.md` §5.

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
