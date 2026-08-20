# Carpeta `prompts/`

Aquí vive la "personalidad" de tu agente. En vez de tocar código TypeScript, el agente lee este archivo Markdown en cada mensaje y lo inyecta en el system prompt del LLM.

## Archivos

| Archivo | Para qué |
|---|---|
| `negocio.md` | **EL TUYO.** Viene incluido en el kit como plantilla con `[CORCHETES]`; se rellena con `/personaliza` (o a mano) |
| `negocio.example.md` | Copia de referencia de la plantilla completa, por si quieres empezar de cero |
| `ejemplos/agencia-ia.md` | Ejemplo completo: agencia de IA que califica leads |
| `ejemplos/ecommerce.md` | Ejemplo completo: tienda online con consulta de stock |
| `ejemplos/infoproducto.md` | Ejemplo completo: vendedor de cursos online |

## Cómo rellenar/cambiar tu `negocio.md`

### Opción A · Con Claude Code (recomendado)

Escribe `/personaliza` en Claude Code. Te hará 9 preguntas (tu negocio, tu cliente ideal, el catálogo con precios, los enlaces, el tono...) y rellenará el archivo por ti. Además sincroniza los filtros de seguridad de `.env.local` (`ALLOWED_PRICES` y `ALLOWED_HOSTS`) con tus precios y enlaces.

### Opción B · Manual

1. Abre `negocio.md` (ya existe: es la plantilla) y sustituye cada `[CORCHETE]` por lo tuyo. Si quieres empezar de cero, copia `negocio.example.md` encima
2. Conserva las secciones fijas de seguridad (reglas de identidad del agente, Blindaje) y la línea final del código de auditoría
3. Revisa que `ALLOWED_PRICES` y `ALLOWED_HOSTS` en `.env.local` coinciden con tus precios y enlaces

### Opción C · Copia un ejemplo

1. Copia `ejemplos/agencia-ia.md` (o el que más se parezca a tu caso) a `negocio.md`
2. Cambia los datos para que encajen con TU negocio
3. Revisa igualmente `ALLOWED_PRICES` y `ALLOWED_HOSTS` en `.env.local`

## Cómo se usa el archivo

`src/lib/system-prompt.ts` lee `negocio.md` en cada mensaje y lo inyecta en el system prompt que se le pasa al LLM. Si cambias `negocio.md`, el agente usa la versión nueva en su siguiente respuesta — no hace falta reiniciar el bot. (Solo si borras el archivo por completo, el agente cae a un guion genérico de emergencia.)

## Reglas

- Escribe en **lenguaje natural**, no en código
- Sé **concreto**: en vez de "ayudo a empresas", di "ayudo a agencias de marketing de 5-20 empleados a automatizar reportes mensuales"
- Las preguntas de calificación deben ser **2-4 máximo**: el lead no quiere que le entrevisten
- Los precios y enlaces que escribas aquí son los **únicos** que el agente puede decir y enviar: mantenlos alineados con `ALLOWED_PRICES` y `ALLOWED_HOSTS` de `.env.local` (`/personaliza` lo hace por ti)
- No borres la línea final del código de auditoría (el "canario"): debe coincidir con `SECURITY_CANARY` de `.env.local` — es la trampa que detecta si el modelo filtra su prompt
- El agente no deriva el chat a un humano: cierra la conversación de principio a fin. Si quieres enterarte al momento de un lead caliente o de un problema, configura los avisos por WhatsApp del watchdog (`ALERT_WHATSAPP`, ver `docs/10-watchdog.md`)
