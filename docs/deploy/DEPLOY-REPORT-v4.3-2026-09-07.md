# CASAMABLE v4.3 — PRODUCTION DEPLOY REPORT (07-09-2026)

## Resumen

Despliegue de `release/casamable-v4.3` en el NAS UGREEN DXP2800, ejecutado
paso a paso por terminal SSH con Pedro, siguiendo el prompt de despliegue
(`RELEASE-v4.3.md` + semáforo `predeploy:check`). Incluyó un incidente
crítico preexistente descubierto y corregido en el mismo proceso: la
plantilla de confirmación de WhatsApp estaba bloqueada por un desajuste de
variables (ver §3).

**Desde este despliegue, `PRODUCTION_COMMIT` deja de ser una incógnita:
`/api/health/live` devuelve `build` y `schemaVersion`.**

## 1 · Datos del despliegue

| Campo | Valor |
|---|---|
| DEPLOYED_SHA | `22f8013e42e1bad2c8fedd76216f1ec92e12cf23` (hotfix sobre `ab5e3a8f33486f8182898369bb115f8a000f9c5f`) |
| PRE_DEPLOY_SCHEMA → POST_DEPLOY_SCHEMA | **17 → 30** (no 18 como decían los docs: el esquema real medido en el precheck era 17) |
| PRE_COUNTS (orders/conversations/messages) | 134 / 78 / 447 |
| POST_COUNTS | 134 / 78 / 447 (sin pérdida de datos) |
| PREDEPLOY_CHECK (fixture) | LISTO CON AVISOS, 0 fallos |
| BACKUP | fresco, fuera del repo: `/volume1/docker/CasamableAgent-release-backups/v4.3-predeploy/` (`messages.db` + sesión WhatsApp verificados) |
| DEPLOY_GUARD | un solo contenedor sobre los datos (`docker compose -p repo-v3c ps`) |
| HEALTH | healthy, 0 reinicios |
| HEALTH_LIVE_BUILD | `22f8013e42e1bad2c8fedd76216f1ec92e12cf23`, `schemaVersion: 30` |
| DOCTOR_V43 | OK salvo F9 (esperado: los tests no van en la imagen de producción, `/app/tests` no se copia) |
| WHATSAPP_DOCTOR | **8 PASS / 1 DISABLED / 0 FAIL** tras el hotfix (era 7 / 1 / 1 antes) |
| RETELL_DOCTOR | contrato OK; `RETELL_LIVE` FAIL esperado (sin `RETELL_AGENT_VERSION` fijada); auto-llamadas OFF |
| `/api/hunter/competencia` | viva (401 sin sesión, no 404): confirma el despliegue real del Cazador/Competencia y del auditor de tiendas (modos A y B van por este endpoint) |
| FLAGS (`ADDRESS_AI_VALIDATION_ENABLED` / `AUTO_DISPATCH_COOLDOWN_ENABLED` / `POST_CONFIRMATION_AI_ENABLED` / `DISPATCH_NOTICE_WHATSAPP_ENABLED`) | los cuatro en 0 |
| META_AD_LIBRARY_ACCESS_TOKEN | sin renovar (esperado; la pestaña Competencia muestra el aviso y no bloquea nada más) |
| OWNER_LOGIN | verificado por Pedro desde el móvil, OK |
| ROLLBACK_REQUIRED | No |
| FINAL_VERDICT | **DESPLEGADO Y VERIFICADO** |

## 2 · Qué corre ahora en producción

Todo lo acumulado en `release/casamable-v4.3` (ver `RESUMEN-v4.3.md` y el
prompt de despliegue): workspace de atención con roles, reglas de conducta
del bot en WhatsApp (FAQ, afirmativos/ambiguos, bordes del 07-09), tope
diario de OpenAI, endpoints nuevos de Retell, Cazador con buscador por
palabra y pestaña Competencia, auditor de tiendas ganadoras, semáforo de
predespliegue, `pending:review`, `doctor:v43`. Nada nuevo está activo: las
cuatro funciones con flag siguen apagadas y `dispatch_channels` nace vacía.

## 3 · Incidente paralelo: confirmación de pedidos bloqueada (RESUELTO)

**Causa raíz.** La plantilla aprobada `confirmacion_pedido_cod` en WhatsApp
Manager pasó de 4 a 5 variables (se añadió la línea «¿Nos puedes confirmar
si la dirección {{5}} es correcta?») en algún momento después del
01-09-2026. El contrato local (`config/whatsapp-templates.json`) se quedó en
4. El diseño fail-safe bloqueó el envío en vez de mandar mensajes mal
formados: cero clientes recibieron mensajes rotos, pero tampoco
confirmaciones automáticas mientras duró.

**No es una regresión de v4.3.** El commit que corría en producción justo
antes (`adb2be7`) ya tenía el mismo desajuste. El doctor de plantillas,
ejecutado en esta sesión, lo destapó.

**Alcance real** (consultado con better-sqlite3 sobre `messages.db` del NAS):

| Medida | Resultado |
|---|---|
| Eventos `confirmation_template_not_ready` | 0 |
| Fallos reales de Meta en outbox (error 132000 / parameter) | 3; el primero el **2026-09-06 15:13:22** |
| Pedidos pendientes sin WhatsApp enviado en el momento de la revisión | 0 (ningún pedido quedó atascado) |

**Fix** (commit `22f8013`, sobre `release/casamable-v4.3`):

- `config/whatsapp-templates.json`: `direccion` como 5º parámetro en el
  mapping de `order_confirmation_request` (y en `variables` de la spec);
  `draft_body` igual al cuerpo aprobado; `note` fechada citando el incidente.
- `src/lib/whatsapp/interactive.ts` (`confirmationTemplate`): añade la
  dirección real del pedido como 5º valor.
- `src/lib/orders/normalize.ts`: nueva `formatAddressForTemplate`. Misma
  dirección que `formatAddressForMessage`, en una línea sin saltos (Meta los
  rechaza en parámetros); usa la corrección del cliente si existe (criterio
  de la capa 1); sin dirección devuelve vacío y el builder bloquea con
  `TEMPLATE_PARAM_EMPTY` (fail-closed, nunca un hueco).
- Tests: contrato de 5 variables (aridad y orden), bloqueo con caché en 4,
  normalización, fail-closed sin dirección. 789 tests OK, build limpio.

## 4 · Notas operativas para la siguiente sesión de deploy en este NAS

- **UGOS no tiene `git` ni `sqlite3` nativos.** Se resolvió con contenedores
  efímeros: `alpine/git:latest` montando el repo como volumen para
  `git fetch/checkout/show`, y better-sqlite3 (ya presente en el contenedor
  `casamable-agent`) vía `node -e` para consultas SQL puntuales. Nada
  permanente instalado en el sistema.
- **El checkout real de producción es `/volume1/docker/CasamableAgent/repo-v3c`**
  (proyecto Compose `repo-v3c`), no la carpeta raíz `CasamableAgent`. Hay
  varias carpetas `repo-*` sueltas de intentos anteriores (`repo-v2`,
  `repo-v3`, `repo-v3b`, `repo-v4.2`, `repo-ws-test`): conviene limpiarlas
  para evitar confusión. Nunca levantar Compose desde ellas.
- **El remote de git del NAS solo trae por defecto la rama trackeada**
  (`fix/confirmation-provider-mapping`). Para otra rama:
  `git fetch origin <rama> -v` explícito.
- **El `.env` real vive en `repo-v3c/.env`** (permisos 600, root), cargado por
  `env_file` en `docker-compose.yml`. No está montado como volumen: se
  hornea en la imagen en build time. Cambiar un flag exige rebuild +
  recreate, no solo restart.
- El esquema previo real era **17**, no 18: los documentos que asumían 18
  estaban equivocados. Medir siempre con `db:health` antes de tocar nada.

## 5 · Pendiente después de este despliegue

- Renovar `META_AD_LIBRARY_ACCESS_TOKEN` y correr `hunter:discovery:doctor`
  en el NAS (desbloquea la pestaña Competencia y el auditor; confirma los 15
  campos y `search_page_ids`).
- Fijar `RETELL_AGENT_VERSION` cuando se publique la versión del agente
  (`RETELL_LIVE` pasará a PASS).
- Decidir, aparte y con `pending:review` limpio, si se enciende algún flag
  de IA (`OPENAI_API_KEY` necesaria).
- Limpiar las carpetas `repo-*` antiguas del NAS.
