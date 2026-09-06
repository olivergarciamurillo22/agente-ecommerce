# Casamable · Informe 04-09-2026
## Qué llevamos hoy, qué queda para el Winning Hunter y el creador de páginas conectado a Shopify

---

## 1. RESUMEN EJECUTIVO

Hoy se ha cerrado el bloque de **producción/infraestructura**: v4.2 + hotfix `92cfd3e` desplegados en el NAS, el P1 de Retell resuelto y validado con una llamada real, watchdog revivido tras 6 días muerto y WhatsApp validado end-to-end con un pedido sintético.

El bloque de **crecimiento** (Winning Hunter + Landing Studio) NO está en producción. Existe código en dos ramas sin fusionar y depende de tres cadenas de bloqueo, dos de ellas **no técnicas** (una verificación de identidad en Meta y un email a proveedor pendiente desde hace 4 días).

Estado global: **infraestructura PASS · crecimiento BLOQUEADO por dependencias externas**.

---

## 2. LO QUE SE HA HECHO HOY (con evidencia)

### 2.1 Deploy v4.2 → hotfix `92cfd3e`

| Item | Evidencia |
|---|---|
| Imagen construida | `181a9e0d7839` |
| Proyecto compose | `repo-v3c` (correcto, sin contenedor paralelo) |
| Estado contenedor | `healthy` |
| Schema | `user_version = 17` (sin migración manual) |
| Backup previo | `messages-2026-09-03_1055.db` + `1057.db`, integrity `ok`, 115→116 pedidos |
| `.env` | permisos `600`, backup **fuera del repo** |

Decisión de Pedro registrada: *"deploy ahora, no estamos lanzando tráfico, por ende no va a entrar ningún pedido"*.

### 2.2 P1 — Webhooks de Retell rechazados (RESUELTO)

- **Síntoma:** 8/8 webhooks rechazados, `integration_events` 1702–1709, `call_webhook_bad_signature`.
- **Descartado:** algoritmo HMAC (coincide con la doc oficial), reloj del NAS, Basic Auth (`/api/webhooks/` ya estaba en `PUBLIC_PREFIXES`), alcanzabilidad. Una petición firmada por nosotros devolvía `200`.
- **Causa raíz:** Retell tiene **dos API keys**. `casamable-outbound` (…0346, sin badge) y `Secret Key` [Webhook] (…6ceb). El código usaba `RETELL_API_KEY` = …0346; **Retell firma con …6ceb**.
- **Fix:** commit `183617f` de Óliver + rotación de `RETELL_API_KEY` a la key con badge. Verificado que esa key también sirve para la API normal (`GET_AGENT_HTTP=200`).
- **Cierre empírico:** llamada entrante real → 3 eventos aceptados, 0 `bad_signature`. `RETELL_REAL_WEBHOOK_SIGNATURE : PASS` a `2026-09-03T19:07:00Z`.

### 2.3 P2 — Watchdog muerto 6 días (RESUELTO)

Commit `cace21e`. El heartbeat solo arrancaba dentro de Baileys, que nunca arranca bajo `cloud_api`. T0: 9.268 min sin latido → T1: `[watchdog] activo · vivo, sin trabajo pendiente`.

### 2.4 P3 — Marcado manual saltándose los gates (RESUELTO)

Commit `6259040`. Toda la política unificada en `src/lib/calls/gates.ts`, en orden: `emergency_stop` → `calls_blocked` → `aiCallsEnabled` → `callsShadowMode` → piloto/allowlist → elegibilidad → DNC → llamada activa → `outside_window` → `daily_cap`. Ahora aplica igual al botón manual y al scheduler.

### 2.5 P5 — Readiness en rojo falso (RESUELTO)

Commit `2a7771a`: se separa `readiness` (release) de `readiness:runtime` (producción). Estado final: **READY WITH WARNINGS**.

### 2.6 Retell V19 configurada y fijada

- Prompt **byte-idéntico** al repo (`config/retell/casamable-agent-prompt.md`, md5 `0148f5c4631199a0d7a2359fdcb58f50`, 4.569 bytes). Se escribió vía API tras fallar la UI por una línea en blanco.
- 7 campos de Post Call Extraction, 12 enums exactos de resultado.
- `RETELL_AGENT_VERSION=19` fijado en `.env`; versión **publicada**, no draft.

### 2.7 WhatsApp end-to-end (PASS)

Pedido sintético `#999003`: enviado 09:00:12 → botón pulsado → respuesta del bot → nota de entrega guardada → pedido a `confirmed` 09:31:16. Guardarraíl de ventana horaria demostrado en el mismo trazado.

Los dos errores del log (`tagsAdd rechazado: Order does not exist` y `SUPPLIER routing → manual_review`) son **comportamiento correcto** para un pedido que no existe en Shopify.

### 2.8 Cuatro rondas de Codex

| Rama | Resultado | Estado |
|---|---|---|
| Workspace atención cliente | 27 ficheros, 661 tests | Commit `dbc16cf`, revisado, build limpio (PANEL=307 · HEALTH=200 · LOGIN=200 · WEBHOOK=401) |
| `feat/hunter-landing-studio` | 11 commits, 664 tests | Sin fusionar |
| Segunda vuelta hunter | 675 tests, 14 secciones | Sin fusionar |
| `release/casamable-v4.3` | Parcial — cortado por límite de uso | **17 ficheros sin commitear** |

**Lección aprendida (dos veces hoy):** Codex deja trabajo sin commitear. Antes de revisar nada, `git add -A && git commit`.

### 2.9 Errores míos, declarados

1. **Falso P1 de normalización de teléfono.** Declaré un bug en producción por las conversaciones 62/63 (`+34…` vs `34…`). Al comprobarlo: **115 pedidos reales usan `34…` y solo mis dos INSERT sintéticos usaban `+34…`**. Retirado. Regla nueva: los pedidos sintéticos deben imitar exactamente el formato que produce el webhook de Shopify.
2. **Hipótesis errónea de Edge runtime** en `proxy.ts`. Refutada empíricamente con un contenedor efímero.
3. **`git clean -fd` borró `.env.bak-20260903-2046`** por instrucción mía. Declarado en el momento; la key antigua era recuperable del dashboard. Backups ahora fuera del repo.

---

## 3. LO QUE FALTA POR RESOLVER

### 3.1 Bloqueos técnicos (dentro de nuestro control)

| # | Bloqueo | Impacto | Prioridad |
|---|---|---|---|
| 1 | 17 ficheros de v4.3 sin commitear | Riesgo de pérdida de trabajo | **Crítica** |
| 2 | Codex debe retomar F4–F11 de `release/casamable-v4.3` | Bloquea el merge del hunter | **Crítica** |
| 3 | `feat/hunter-landing-studio` sin fusionar ni desplegar | El hunter no existe en producción | Alta |
| 4 | PI Engine y Hunter **no están unidos** | Descubrimiento y evaluación son dos piezas sueltas | Alta |
| 5 | `DASHBOARD_PASSWORD` sin rotar | Seguridad | Alta |
| 6 | Llamada saliente real con el código nuevo nunca hecha | Validación incompleta (falta ventana horaria) | Media |
| 7 | Bucle de aprendizaje (resultado real → reajuste del scoring) | No construido en absoluto | Media |

### 3.2 Bloqueos NO técnicos (fuera de nuestro control — son los que mandan)

| # | Bloqueo | Qué desbloquea | Estado |
|---|---|---|---|
| A | Meta `/ads_archive` sin autorizar — depende de un **cambio de nombre en Facebook** y verificación de identidad | **Todo el descubrimiento automático de winners** | Pendiente, sin fecha |
| B | Email a proveedor pidiendo dimensiones y peso de la unidad de venta | Unit economics reales → decisión de margen | Pendiente **4 días** |
| C | PVP del organizador **no existe en ningún documento** — el 36,90 € que apareció es **inventado** | Cualquier cálculo de margen o CPA objetivo | Sin dato |
| D | Sin evidencia de que Beeping facture por **peso volumétrico** | Coste logístico real | Sin confirmar |
| E | Saldo Retell 3,57 $ sin autorrecarga | Corte de servicio en llamadas | Pendiente |

> **Punto duro:** A, B, C y D no se resuelven programando. Mientras C siga sin dato, cualquier "score de winner" que produzca el sistema es aritmética sobre un número ficticio. Es el bloqueo de mayor impacto y el más barato de resolver.

---

## 4. EL ESTADO FINAL QUE PIDES

> *"que el winning hunter y el creador de páginas conectado sincronice directamente y exporte a Shopify, añada las páginas, y lo único que tenga que hacer sea las fotos de los productos"*

Eso son **cinco piezas encadenadas**. Hoy tenemos dos, a medias:

```
[1] DESCUBRIR        → PI Engine (existe, sin fusionar) · BLOQUEADO por Meta
        ↓
[2] EVALUAR          → Hunter evaluator (existe, sin fusionar) · BLOQUEADO por PVP real
        ↓
[3] GENERAR PÁGINA   → Landing Studio (existe, sin fusionar)
        ↓
[4] PUBLICAR SHOPIFY → NO CONSTRUIDO  ← la "última milla"
        ↓
[5] FOTOS            → tarea humana (Pedro)
```

### 4.1 La última milla (`feat/landing-ultima-milla`)

Spec ya entregada a Claude Code, sobre `release/casamable-v4.2` (**no** v4.3, donde trabaja Codex). Siete fases:

1. `landing:preview` — render local de la landing
2. `landing:shots` — capturas para revisión
3. `landing:audit` — 6 comprobaciones de render
4. `landing:assets` — normalización de imágenes (aquí entran tus fotos)
5. `landing:publish` — export a Shopify
6. `landing:verify` — verificación post-publicación
7. `landing:full` — la cadena completa

**Cuatro cerrojos de seguridad en `landing:publish`:**

- Flag propio `SHOPIFY_LANDING_PUBLISH_ENABLED=0` por defecto
- Dry-run por defecto
- `--theme-id` explícito obligatorio
- **Negativa absoluta a escribir en el tema con rol `main`**

Reglas anticolisión: no tocar `src/lib/db.ts`, `src/lib/safety.ts`, `src/lib/calls/*`, `src/proxy.ts`, `tests/run-tests.ts`, `config/whatsapp-templates.json`. Sin migraciones. Tests en fichero nuevo.

### 4.2 Lo que NO está construido en absoluto

1. **La unión PI Engine ↔ Hunter.** Hoy son dos programas que no se hablan.
2. **El bucle de aprendizaje.** Nada devuelve el resultado real de venta al scoring.
3. **La publicación a Shopify.** Es la fase 5 de arriba.
4. **El pipeline de imágenes.** Ni siquiera está definido qué formato/tamaño espera la landing de tus fotos.

---

## 5. CAMINO CRÍTICO ORDENADO

| # | Acción | Quién | Desbloquea |
|---|---|---|---|
| 1 | Commitear los 17 ficheros de v4.3 como WIP | Pedro (2 min) | Evita perder el trabajo |
| 2 | **Enviar/reclamar el email al proveedor** (dimensiones + peso unidad de venta) | Pedro (5 min) | Unit economics |
| 3 | **Fijar el PVP real del organizador** en un documento | Pedro (decisión) | Todo el scoring del hunter |
| 4 | Iniciar el cambio de nombre en Facebook + verificación | Pedro (días de espera) | Descubrimiento automático |
| 5 | Codex retoma F4–F11 de `release/casamable-v4.3` | Codex | Merge del hunter |
| 6 | Claude Code ejecuta `feat/landing-ultima-milla` | Claude Code | Publicación a Shopify |
| 7 | Merge `feat/hunter-landing-studio` → v4.3 | Óliver | Hunter en producción |
| 8 | Construir la unión PI Engine ↔ Hunter | Codex | Pipeline continuo |
| 9 | Definir spec de imágenes + primera landing real publicada en tema NO live | Pedro + sistema | El estado final |

**Los pasos 2, 3 y 4 son de Pedro y suman menos de 15 minutos de trabajo, pero bloquean los pasos 5–9.** Todo lo demás es ejecución que ya está especificada.

---

## 6. RIESGOS ABIERTOS

- **Saldo Retell (3,57 $).** Sin autorrecarga, la primera tanda de llamadas reales se corta a mitad. Coste de arreglarlo: un clic.
- **`DASHBOARD_PASSWORD` sin rotar** con el panel expuesto en `agente.casamable.es`.
- **Codex trabajando en v4.3 mientras Claude Code trabaja en la última milla.** Están en ramas distintas y con reglas anticolisión explícitas, pero el merge final necesita revisión manual de `package.json` (ambos añaden scripts).
- **El PVP inventado.** Si ese número se propaga a un documento y luego se usa para fijar CPA objetivo, el error se vuelve invisible. Marcarlo como `SIN DATO` hasta tenerlo.

---

**ESTADO: PASS (infraestructura) · STOP (crecimiento, bloqueado en dependencias externas)**

**SIGUIENTE ACCIÓN:** commitear los 17 ficheros de v4.3; enviar el email al proveedor; fijar el PVP real.

**QUÉ PEGARME:** salida de `git status --short` y `git log --oneline -3` en `release/casamable-v4.3`.
