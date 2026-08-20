# 04 · Configurar las tools (CRM de Airtable)

El agente trae 2 tools (acciones que puede ejecutar): `guardarLead` y `calificar`. Funciona sin configurarlas, pero el CRM se desbloquea cuando conectas Airtable.

## Antes de las tools · Modelo de IA

Antes de activar tools, asegúrate de que el modelo elegido en `OPENROUTER_MODEL` (en `.env.local`) **soporta tool calling**. Estas son las opciones recomendadas. Los precios son **orden de magnitud** para comparar entre modelos; el precio vigente está siempre en https://openrouter.ai/models:

| Modelo | Input $/M tokens | Output $/M tokens | Contexto | Cuándo |
|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | ~$1.00 | ~$5.00 | 200K | **Recomendado — el que trae el kit por defecto**. Buen español, aguanta prompts largos y hace tool calling fiable |
| `openai/gpt-4o-mini` | ~$0.15 | ~$0.60 | 128K | Alternativa más barata si tienes mucho volumen de mensajes |
| `google/gemini-2.5-flash` | ~$0.30 | ~$2.50 | 1M | Si necesitas contexto largo (historial muy extenso) |

**Los modelos `:free`** existen pero tienen rate limit estricto (50 req/día sin créditos, 1.000 req/día con $10+ cargados). Sirven para probar el kit pero **no para clientes reales** — se saturan en cuanto hay 2-3 conversaciones simultáneas.

Para cambiar el modelo: edita `OPENROUTER_MODEL` en `.env.local`, reinicia el bot.

---

## Las 2 tools

| Tool | Qué hace | Configuración necesaria |
|---|---|---|
| `guardarLead` | Guarda el lead en Airtable (tu CRM) | Las variables `AIRTABLE_*` de `.env.local` |
| `calificar` | Calcula un score 1-10 del lead | Ninguna — funciona de serie |

### ¿Y agendar citas o derivar a un humano?

No hay tools separadas para eso, y no hacen falta:

- **Agendar**: pon tu enlace de Cal.com o Calendly en la sección **Enlaces** de `prompts/negocio.md`. El agente lo envía él mismo cuando el lead califica. Si has rellenado `ALLOWED_HOSTS` en `.env.local` (los guardrails), añade también ese dominio (por ejemplo `cal.com`) para que no se bloquee el enlace.
- **Derivar a un humano**: el agente está diseñado para cerrar la conversación por chat, sin pasarle el marrón a nadie. Si algo requiere tu atención (el bot se queda mudo, se acaba el saldo), el watchdog te avisa por WhatsApp al número que pongas en `ALERT_WHATSAPP` — ver [10-watchdog.md](10-watchdog.md). Y desde el dashboard puedes intervenir tú en cualquier conversación cuando quieras.

## Configurar `guardarLead` con Airtable

Sin configurar, el agente funciona igual pero no guarda leads en ningún CRM. Con Airtable conectado, cada lead con **nombre y email** confirmados se registra (o se actualiza, sin duplicados) automáticamente en tu tabla de leads.

### Paso 1 · Preparar la tabla en Airtable

1. Crea cuenta gratuita en https://airtable.com si no tienes
2. Crea una base con una tabla de leads (o usa la que ya tengas)
3. La tabla necesita estos campos (el nombre debe coincidir EXACTAMENTE, emoji incluido):
   - `Contacto` (texto) — el teléfono del chat; el agente lo usa para localizar el lead y no duplicarlo
   - `Lead` (texto) — el nombre del lead
   - `Email` (email o texto)
   - `📝 Notas Agente IA` (tipo Long text) — el resumen que escribe el agente (objetivo, situación, temperatura)

### Paso 2 · Crear el token de acceso

1. Ve a https://airtable.com/create/tokens
2. Crea un token con los scopes `data.records:read` y `data.records:write`
3. Dale acceso a la base donde está tu tabla de leads
4. Copia el token (empieza por `pat...`)

### Paso 3 · Copiar los IDs de la base y la tabla

Abre tu tabla en el navegador. La URL tiene esta forma:

```
https://airtable.com/appXXXXXXXXXXXXXX/tblXXXXXXXXXXXXXX/...
```

- El ID de la base es el que empieza por `app`
- El ID de la tabla es el que empieza por `tbl`

### Paso 4 · Rellenar `.env.local`

Abre `.env.local` y rellena estas variables:

```
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
AIRTABLE_LEADS_TABLE=tblXXXXXXXXXXXXXX
```

Opcional: si usas UTMs para la atribución en tu CRM, pon en `AIRTABLE_AGENT_UTM` el record (`rec...`) de la UTM que quieras enlazar a los leads del agente. Si no lo usas, déjalo como viene.

Reinicia el bot (`Ctrl + C` y `npm run start:all`).

### Paso 5 · Validar la conexión

Ejecuta el test incluido en el kit:

```
npx tsx scripts/test-airtable.mts
```

Crea un lead de PRUEBA en tu tabla, comprueba que todo encaja (permisos de escritura, campos, UTM) y borra el registro de prueba al terminar. Si falta el campo `📝 Notas Agente IA`, te lo dice y te explica cómo crearlo.

### Probar en real

Desde otro WhatsApp, escribe al agente y dale conversación hasta darle un nombre y un email. En cuanto tenga los dos, verás la fila nueva en tu tabla de Airtable. Hasta tener nombre Y email, el agente solo toma nota internamente — no ensucia el CRM con leads a medias.

## `calificar` · sin configuración

La lógica de scoring está en `src/lib/tools/calificar.ts`. Calcula un score 1-10 y una temperatura (Caliente / Templado / Frío) que el agente usa para decidir cuánto empujar, y que se guarda como nota del lead. Puedes ajustar los pesos editando ese archivo.

## Tools custom (avanzado)

Si quieres añadir una tool nueva (consultar stock, mandar email, lo que sea):

1. Crea `src/lib/tools/mi-tool.ts` siguiendo el patrón de las existentes
2. Regístrala en `src/lib/tools/index.ts` (`toolDefinitions` y `handlers`)
3. Reinicia el bot

Si no sabes hacerlo, pide ayuda en Claude Code: "añádeme una tool que consulte stock de un Google Sheet" — te lo monta.

## Siguiente paso

Sigue a [05-cloudflare-access.md](05-cloudflare-access.md) para proteger el dashboard con login antes de desplegar a producción.
