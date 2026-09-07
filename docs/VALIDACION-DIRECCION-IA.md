# Validación de direcciones — determinista + IA (07-09-2026)

**Qué hace:** cuando entra un pedido, evalúa la calidad de la dirección en
dos capas. Si algo no cuadra, abre la incidencia **ALERTA_DIRECCION** y
retiene el envío automático a Beeping hasta que una persona la revise.
**La confirmación por WhatsApp se envía igual**: esto nunca añade fricción
al cliente ni bloquea la venta. La IA solo señala duda; jamás corrige ni toca
el dato del cliente.

Extiende el detector que ya existía (`src/lib/orders/address-assessment.ts`,
la versión de la tarde del 05-09 que sustituyó a `address-quality.ts`); no
hay un motor paralelo.

| Pieza | Fichero |
|---|---|
| Capa 1 (determinista) | `src/lib/orders/address-assessment.ts` → `assessOrderAddressLayer1`, `checkSpanishPostalCode`, `isFillerAddress` |
| Capa 2 (OpenAI) | `src/lib/orders/address-ai.ts` → `evaluateAddressWithAi` |
| Orquestación, caché, auditoría, alerta | `src/lib/orders/address-validation.ts` |
| Esquema (migración 22) | `address_validations`, `address_alerts` en `src/lib/db.ts` |
| Panel | insignia **ALERTA DIRECCIÓN** en la lista y bloque con botón «cerrar alerta» en la ficha (`OrdersPanel.tsx`) |
| API | `POST /api/orders/:id/action` `{ action: "resolve_address_alert", note? }` (propietario) |

## Lo que ya existía y lo que se añade

Ya existía (`assessShippingAddress`, hotfix del 05-09): forma mínima de
dirección — vacía, demasiado corta, sin señal de vía ni número, sin
localizador (acepta `s/n`, `km`, `nave`, `bloque`, `portal`). Bloquea la
confirmación automática y escala a persona.

Se añade:

- **Capa 1** — código postal español (5 dígitos, prefijo 01–52), coherencia
  CP ↔ provincia/ciudad, relleno de prueba (`asdasd`, `test`, `11111`,
  secuencias de teclado, solo números…).
- **Capa 2** — veredicto semántico con OpenAI: ¿la calle parece real y
  coherente con la ciudad?, ¿falta piso/puerta cuando el tipo de vía sugiere
  un edificio y no aplica un chalet/`km`?, ¿hay contradicciones internas?
- **ALERTA_DIRECCION**, bloqueo del mark-to-send automático, cierre manual y
  auditoría completa.

## Capa 1 — determinista (sin red, sin coste, siempre)

Corre en el webhook de Shopify al crear el pedido (`processOrdersCreateWebhook`)
y cuando cambia la dirección (nuevo hash). Resultado `correcta` |
`incorrecta` con la lista de problemas:

| Comprobación | Problema registrado | Efecto |
|---|---|---|
| CP no son 5 dígitos | `cp_formato_invalido` | incorrecta |
| Prefijo (2 primeros dígitos) fuera de 01–52 | `cp_prefijo_inexistente` | incorrecta |
| Provincia/ciudad indicada pertenece a OTRO prefijo | `cp_incoherente_con_provincia:<cp>-><provincia del CP>` | incorrecta |
| No hay provincia ni ciudad reconocible con la que comparar | `cp_coherencia_sin_confirmar` | se anota, no bloquea |
| Existencia exacta del CP | `cp_existencia_exacta_sin_confirmar` | **siempre** se anota (ver fuente) |
| Relleno de prueba | `direccion_relleno_de_prueba` | incorrecta |
| Sin forma de dirección (detector previo) | `direccion_sin_forma:<motivo>` | incorrecta |

**Fuente de datos y licencia.** La tabla `INE_PROVINCE_BY_CP_PREFIX` (52
entradas) es la relación de códigos de provincia del **INE** (Instituto
Nacional de Estadística, "Relación de provincias y sus códigos"): los dos
primeros dígitos del CP español coinciden con ese código. Es un dato público
sin restricción de uso y estable (no cambia desde 1995 salvo Ceuta/Melilla,
51/52, ya incluidos). **Correos no publica el fichero CP → localidad con
licencia abierta**, así que este sistema NO afirma que un CP concreto exista:
solo que su prefijo es válido. La existencia exacta se declara
`sin_confirmar` en todos los casos (regla fail-closed: declarar la
incertidumbre, no inventar). Si algún día Pedro licencia el fichero de
Correos, entra aquí sin cambiar nada más.

La coherencia CP↔ciudad solo se afirma cuando la ciudad coincide con un nombre
de provincia (capitales) o hay provincia explícita; una comunidad autónoma o
un municipio no capital no permiten deducir nada y se declara
`sin_confirmar`.

## Capa 2 — OpenAI (solo si la capa 1 no vio problema evidente)

- **Interruptor:** `ADDRESS_AI_VALIDATION_ENABLED=1` **y** `OPENAI_API_KEY`.
  Apagada por defecto. Apagada, la capa 2 se registra como `no_ejecutada`
  (`ia_desactivada`) y **no abre alertas**: no se inventa un veredicto.
- **Cuándo corre:** en el scheduler (`runSchedulerTick`, paso 5), en su propio
  carril, después de los envíos. Como mucho 5 pedidos por tick, pedidos de los
  últimos 3 días. **Nunca retrasa la confirmación.**
- **Una llamada por pedido y dirección:** caché en `address_validations` por
  `sha256(dirección|ciudad|provincia|cp)`. Si la dirección cambia (propuesta
  del cliente), se evalúa otra vez.
- **Salida estructurada** (`response_format: json_schema`, `strict`), esquema
  exacto de la spec:

```json
{ "veredicto": "correcta" | "dudosa" | "incorrecta", "problemas": ["…"], "confianza": 0.0 }
```

- **Timeout:** `ADDRESS_AI_TIMEOUT_MS`, default **8000 ms** (guarda propia
  además de la del cliente de OpenAI, +500 ms).
- **Fail-closed obligatorio:** fallo de red, timeout, JSON no válido o
  `confianza < 0,6` → `dudosa`, con el motivo en `problemas`
  (`sin_confirmar:fallo_llamada_ia`, `sin_confirmar:timeout_llamada_ia`,
  `sin_confirmar:respuesta_ia_invalida`, `sin_confirmar:confianza_baja_0.40`).
  Nunca `correcta` por defecto.
- **Modelo y coste:** `ADDRESS_AI_MODEL`, default `gpt-4o-mini`. El prompt
  son ~350 tokens de entrada y ~40 de salida por pedido: a los precios
  públicos de gpt-4o-mini (0,15 $/M entrada, 0,60 $/M salida) sale a
  **≈ 0,00008 $ por pedido**, es decir, menos de 0,01 € por cada 100 pedidos.
  Con `gpt-4o` sería ~30× más (≈ 0,0025 $/pedido); sigue siendo despreciable
  frente a un rehusado.

## ALERTA_DIRECCION — la incidencia

Se abre cuando cualquiera de las dos capas devuelve `dudosa` o `incorrecta`
(idempotente: una sola abierta por pedido). Consiste en:

1. Fila en `address_alerts` (capa que la detectó, veredicto, problemas).
2. Trabajo en la bandeja de atención (`work_items`, motivo
   `ALERTA_DIRECCION`) **sin** pasar la conversación a modo HUMAN: el cliente
   sigue pudiendo confirmar con el bot.
3. `integration_event` `address_alert_opened` (warning/critical).
4. Insignia **ALERTA DIRECCIÓN** en la lista de pedidos y bloque en la ficha.

**Efecto sobre el despacho.** Con la alerta abierta:

- `confirmOrder()` NO llama al mark-to-send automático de Beeping
  (`suppliers/beeping.ts`) aunque el cliente acabe de confirmar; deja el
  evento `mark_to_send_retenido_por_alerta_direccion`.
- El gate manual de liberación (`beeping/release.ts`,
  `evaluateLocalReleaseGate`) la lista como motivo bloqueante.

**La confirmación del cliente no anula la alerta**: el cliente puede no ver
que su dirección está incompleta.

### Cómo desbloquea una persona un pedido

Desde la ficha del pedido: bloque naranja «ALERTA DIRECCIÓN» → botón **«He
revisado la dirección: cerrar alerta»** (confirmación en pantalla). Solo el
propietario. Queda en `audit_log` (`resolve_address_alert`, con nombre y nota
opcional), en `address_alerts` (`resolved_by`, `resolution_note`,
`resolved_at`) y en `integration_events` (`address_alert_resolved`). Si el
pedido ya estaba confirmado y la integración automática de Beeping está
activa, en ese momento se dispara el mark-to-send que estaba retenido.
Cerrar una alerta ya cerrada devuelve 409. Por API:
`POST /api/orders/:id/action` con `{ "action": "resolve_address_alert", "note": "…" }`.

Si al revisar resulta que la dirección **no** es entregable, no se cierra la
alerta: se corrige la dirección con el cliente (flujo normal de
`needs_correction`/dirección propuesta) y, al cambiar, la validación vuelve
a correr con el hash nuevo.

## Auditoría

`address_validations` guarda **cada** veredicto: pedido, hash de dirección,
capa (1|2), veredicto, problemas, confianza, modelo y **respuesta cruda** del
modelo (o el error, si fue fail-closed), con fecha. `address_alerts` guarda
la incidencia y su resolución. Ambas se consultan con
`listAddressValidations(orderId)` / `listAddressAlerts(orderId)`.

## Variables

| Variable | Default | Uso |
|---|---|---|
| `ADDRESS_AI_VALIDATION_ENABLED` | `0` | 1 activa la capa 2 (`local-safe` exige 0) |
| `OPENAI_API_KEY` | — | clave de OpenAI (cuenta de Casamable; no es `OPENROUTER_API_KEY`) |
| `ADDRESS_AI_MODEL` | `gpt-4o-mini` | modelo |
| `ADDRESS_AI_TIMEOUT_MS` | `8000` | timeout (1000–60000) |

## Tests

`tests/run-tests.ts`, bloque «Validación de direcciones»: CP inválido (formato
y prefijo), CP válido pero incoherente con la ciudad, relleno de prueba,
fallo/timeout/basura/confianza baja de OpenAI → `dudosa`, dirección correcta
→ `correcta` sin alerta y con caché, IA desactivada → `no_ejecutada`,
confirmación sin fricción + mark-to-send retenido + cierre manual, webhook de
entrada, y cierre por API con auditoría. Todo sin red: el completer de OpenAI
se inyecta.

## Fuera de alcance (a propósito)

La IA no corrige ni "adivina" direcciones. No se retrasa ni bloquea la
confirmación. No se toca `platform-companies`.
