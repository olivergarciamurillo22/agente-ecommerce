# CASAMABLE V3 — Operational + Design Closure Report (02-09-2026)

Rama `feat/control-center-v3-operational-polish` (sobre la v2 desplegada).
Guía de despliegue para Pedro: `docs/DEPLOY-HOTFIX-02-09.md`.

---

## A · WHATSAPP

**1. Causa del 132001.** `confirmationTemplate()` enviaba el nombre del
BORRADOR local (`order_confirmation_request`) y la WABA real tiene
aprobados otros nombres. Meta respondía 404/132001 y el scheduler lo
reintentaba cada tick **en silencio** — sin evento, sin panel, sin fin.

**2-5. Plantilla real.** El catálogo separa ahora clave LÓGICA de nombre
del PROVEEDOR (`provider_mappings`): `order_confirmation_request` →
**`confirmacion_pedido_cod`** (es), variables `nombre, numero_pedido,
producto, importe` (4 — {{2}} es el número de pedido, ej. `#1042`), 3
botones. Corregido el 02-09 contra el inventario real de la WABA
(`docs/CONTEXTO-2026-09-01.md` §5): el mapping anterior apuntaba a
**`pedido`**, que resultó ser la plantilla de ejemplo de Meta sin
adaptar — nunca una plantilla de Casamable — y era la causa de que la
verificación no pudiera encajar nunca. **Sigue sin verificar contra Meta**
(el token local no ve la WABA), así que `npm run whatsapp:templates:doctor`
debe correr donde estén `META_WHATSAPP_ACCESS_TOKEN` + `BUSINESS_ACCOUNT_ID`
(el NAS). El doctor comprueba nombre + idioma + APPROVED + aridad ({{n}}
del cuerpo real) + botones, y cachea la verificación que DESBLOQUEA el
envío. Hasta entonces: bloqueado con `FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED`
visible (evento + Ajustes), el pedido NO se consume, y al verificar sale
solo en el siguiente tick. Si `confirmacion_pedido_cod` no encaja
(aridad/botones) al verificar de verdad, el mapping se ajusta en el JSON
sin tocar código.

**6. Flujo del piloto.** Pedido → elegible → cloud → fuera de ventana →
plantilla VERIFICADA → provider_message_id → sent/delivered/read → botón
→ máquina determinista. Dentro de ventana sigue saliendo el interactivo
aunque la plantilla no esté verificada.

**7. Rollout.** `whatsapp_rollout_percent` en settings (Ajustes →
WhatsApp): PILOTO (default, solo allowlist) → 25 → 50 → 100. Bucket
determinista FNV-1a por teléfono, monotónico (subir AÑADE, nunca cambia a
los que ya estaban). TEST_MODE no se toca desde código.

## B · TRACKING

**8-9. El bug del claim.** El orden era claim → gate: un bloqueo
deliberado consumía el sello y el aviso moría para siempre. Ahora:
elegibilidad → **gate** → **completitud** → claim atómico → encolar.

**10. Idempotencia.** Gate bloqueado NO consume (y al abrirse, el aviso
sale); dos workers → exactamente un envío; fallo o carrera al encolar →
`releaseTrackingNotification` devuelve el sello; enviado una vez = jamás
reenviado.

**11. Datos incompletos.** "No disponible" y "el transportista" han
muerto. `pedido_confirmado_casamable` exige transportista + número + URL
válida; `reparto_hoy` exige transportista. Si falta algo: sin envío,
sello intacto, `tracking_payload_incomplete` en Acciones.

## C · SHOPIFY

**12-16.** Verificado en HEAD: `orders/create` + `orders-events`
(cancelled/fulfilled/updated) con HMAC doble-secreto, dedupe por
webhook-id y protección de orden cronológico (suite E2). Test nuevo de la
CADENA §13: cancelado → jamás WhatsApp, jamás cola de llamadas (aunque
todas las llaves estén abiertas), jamás liberación a Beeping. Backfills
siguen dry-run + salvaguarda T6 (sin WhatsApp transitivo). La única
"ceguera" posible no es de código: verificar las suscripciones EN LA
TIENDA con `npm run shopify:webhooks -- --ensure` (token solo en NAS).

## D · RETELL

**17. Causa "[password 1]".** Las llamadas usan la última versión
GUARDADA del agente; una edición del dashboard (con residuo de
autorrelleno en el prompt) cambió producción al instante, y nada
inspeccionaba variables ni prompt antes de marcar.

**18-20. Payload y versión.** Las 11 variables verificadas en
`payload.ts` → `retell_llm_dynamic_variables` (contrato oficial).
`RETELL_AGENT_VERSION` → `override_agent_version` (número publicado o
`latest_published`; verificado en docs.retellai.com — jamás draft), y la
versión que Retell usó DE VERDAD se persiste por intento (v16) y se ve en
salud.

**21-23. Prompt nuevo.** `config/retell/casamable-agent-prompt.md`
versionado en el repo: ~40% más corto, arquitectura
IDENTIDAD/OBJETIVO/VARIABLES/REGLAS/FLUJO/RAMAS/TOOLS/SALIDA, el guion
objetivo (<90 s, espera tras cada pregunta), y cancelación HONESTA:
"dejo solicitada la cancelación" (el backend registra `cancel_request`,
no cancela).

**24-26. Tools y resultados.** El prompt referencia exactamente
`extraer_datos_llamada` y `finalizarllamada`; el doctor audita las tools
REALES del agente en vivo. Un único contrato de resultados: los 12 enums
de `CALL_RESULTS` aparecen literales en el prompt y `parseCallResult` es
estricto. Test `retell-never-speaks-template-garbage`: nombre
"[password 1]" → **CALL BLOCKED** (`unsafe_dynamic_variable`), y ninguna
variable sale con corchetes/llaves/password.

**27-28. Preflight.** `npm run retell:doctor` (agente, versión publicada,
prompt EN VIVO validado y comparado con el del repo, tools, número,
webhook) y `npm run calls:simulate` (CALL PREFLIGHT sin red → SAFE TO
DIAL / NOT SAFE, PII enmascarada). Llamadas siguen MANUAL-ONLY.

## E · UI (v3)

**29-32.** Marca real: 'Tu Agente' eliminado; wordmark Casamable +
CONTROL CENTER con slot para el logo oficial. Nav rail desktop con LABELS
visibles (224px, colapsable a 72px con preferencia recordada), Ajustes y
salud del sistema abajo. Móvil: 5 entradas icono+label y sheet "Más".

**33-41.** Home = briefing ("Buenos días, Pedro" + resumen en una frase,
HOY como superficie agrupada, atención, rentabilidad, ESTADO DEL NEGOCIO
en filas humanas). Pedidos: búsqueda, KPIs agrupados, drawer lateral con
secciones planas y CTA sticky. Chats como inbox serio con búsqueda.
Agente presenta a Lucía (estado, versión, prompt, llamadas del día) antes
que internals. Envíos/Anuncios/Finanzas/Calculadora conservan su
funcionalidad con el lenguaje visual nuevo.

**42. Integration health.** Filas humanas ("● Operativo · Último mensaje
hace 4 min"), detalles técnicos plegados, prueba de conexión read-only.
Readiness §57 visible: AUTOMATIZACIÓN WHATSAPP / LLAMADAS →
READY/BLOCKED con los bloqueantes exactos, nunca escondidos.

**43-45.** Header provider-aware (§47): con cloud_api no hay QR ni
"Desconectar" (vive en Ajustes → WhatsApp, solo Baileys). ⌘K. Fondo
"demo de IA" (palmeras/brasas) eliminado. Tokens: oro solo como acento,
transiciones 150 ms, verde=éxito ámbar=aviso rojo=crítico.

## F · VERIFICACIÓN

**46-51.** Tests: 542 → **548+** (0 fallos) — ver cifra final en el
último commit. Typecheck limpio · build OK · `casamable:simulate` 10/10 ·
`readiness` LOCAL READY (con el working tree commiteado) ·
`calls:validate-prompt` ✓ · `whatsapp:templates:doctor` y `retell:doctor`
en REAL CREDENTIAL VALIDATION PENDING (correcto: las credenciales viven
en el NAS). Esquema **16** (v16: agent_id/agent_version en llamadas).

## G · GIT

**52-55.** Commits por dominio (fix whatsapp/tracking/shopify/retell +
feat ui + test). Rama empujada a
`origin/feat/control-center-v3-operational-polish`. Ficheros clave:
`whatsapp/templates.ts` (mapping+verificación), `tracking/notifications.ts`
(gate→claim), `calls/payload.ts` (preflight), `calls/retell.ts` (versión),
`config/retell/casamable-agent-prompt.md`, `NavRail/Dashboard/Header/Logo`,
scripts `whatsapp-templates-doctor` / `retell-doctor` / `calls-simulate`.

## H · PRODUCCIÓN

**56. Desplegable ya:** toda la rama (P0s + UI). Pasos exactos en
`docs/DEPLOY-HOTFIX-02-09.md` (backup → build → RETELL_AGENT_VERSION →
3 doctors → verificación 30 min).

**57. Necesita piloto:** (a) WhatsApp: doctor de plantillas en el NAS →
pedido de prueba con botón → confirmado en DB; (b) Retell: UNA llamada al
número autorizado tras doctor+simulate en verde, escuchada entera.

**58. Sigue bloqueado (a propósito):** confirmación inicial hasta que el
doctor verifique `pedido`; llamadas automáticas (MANUAL-ONLY); rampa en
PILOTO; Beeping apagado.

**59-60. Piloto y rollback:** en la guía de despliegue. Rollback =
`67f05c7` + backup del paso 1; el esquema 16 no rompe la v2.

---

## LAS TRES RESPUESTAS

**¿PUEDE PEDRO DEJAR WHATSAPP AUTOMÁTICO? — NO todavía (SÍ tras dos
pasos concretos).** El código está listo y el bloqueo es deliberado: (1)
correr `whatsapp:templates:doctor` en el NAS para verificar que `pedido`
encaja (aridad/botones) — sin eso, enviar sería repetir el 132001 a
ciegas; (2) un pedido de prueba de la allowlist confirmado con el botón.
Con ambos en verde: subir la rampa desde Ajustes (25 → 50 → 100) es un
clic, sin desplegar.

**¿PUEDE PEDRO DEJAR RETELL AUTOMÁTICO? — NO.** El preflight nuevo está
en verde en local, pero: el prompt nuevo hay que pegarlo y PUBLICAR
versión en Retell, fijar `RETELL_AGENT_VERSION`, pasar `retell:doctor`
contra el agente real (tools incluidas) y hacer UNA llamada de prueba
escuchada entera. Hasta entonces, MANUAL-ONLY — que es exactamente lo que
impide otro "[password 1]" en un cliente real.

**¿ESTÁ LA UI A NIVEL DE PRODUCTO COMERCIAL? — SÍ, con un matiz honesto.**
Navegación con nombres, marca real, jerarquía, header sin acciones
obsoletas, salud en cristiano, móvil usable y cero componentes "demo de
IA" — cumple los criterios §53 verificados por test. El matiz: la
revisión fue de código y criterios, no con un navegador en 5 anchos
(§56 permitía aplazarlo); la pasada visual real con Pedro delante es el
último 10%.
