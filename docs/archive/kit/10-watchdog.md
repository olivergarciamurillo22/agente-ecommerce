> **ARCHIVED — KIT ORIGINAL.** Documentación del kit genérico del que nació
> este repo. El proyecto real es el Casamable Control Center: fuente de
> verdad en `docs/README.md`. Conservado porque las skills /setup y
> /personaliza aún lo referencian.

# 10 · Watchdog (autovigilancia + avisos por WhatsApp)

El watchdog es un sistema que **vigila a tu agente y te avisa si algo va mal** —
antes de que pierdas ventas sin enterarte. Vive dentro del propio bot y usa su
conexión para escribirte a TU móvil. Es **opcional**: si no lo configuras, el
agente funciona igual.

## Qué hace (tres niveles)

**Nivel 1 · Vigilante en tiempo real (cada 5 min)**
- **Bot mudo:** si algún lead lleva sin respuesta entre 3 min y 2 h, te avisa con
  quién. (Habría cazado al instante cualquier fallo que deje al agente callado.)
- **Saldo bajo:** si tu saldo de OpenRouter baja del umbral, te avisa para recargar.
- **Respuestas de emergencia en bucle:** si el agente empieza a soltar su mensaje de
  emergencia ("se me cruzó un cable…") de forma repetida (3+ veces en 15 min), te
  avisa. Es la señal de que el agente "responde" pero está roto por dentro (modelo
  devolviendo vacío, sin saldo, una herramienta fallando) — algo que el detector de
  "bot mudo" NO ve, porque técnicamente sí está contestando.
- Con anti-spam: no repite el mismo aviso antes de 30 minutos.

**Nivel 2 · Parte diario con IA**
Una vez al día, un modelo lee las conversaciones de 24 h y te manda un resumen:
leads a rescatar (interesados que se fueron sin dejar el email), fallos del agente,
cosas raras.

**Nivel 3 · Sugerencias**
El mismo parte propone mejoras concretas del guion — para que TÚ las apruebes.
Nunca las aplica solo.

## Cómo activarlo

Pon tu móvil (con prefijo de país, solo dígitos) en `.env.local` y en el panel del
servidor:

```
ALERT_WHATSAPP=34600112233
```

Debe ser un número **distinto** al del agente (tu móvil personal). Si lo dejas
vacío, el watchdog corre igual pero solo registra en el log, no envía avisos.

## El caso extremo: que el servidor entero se caiga

Si el contenedor se muere, WhatsApp no puede avisarte (el bot está caído). Para eso
existe **`GET /api/health`**: devuelve `200` si todo va y `503` si el bot está
desconectado. Conecta un monitor externo gratuito (UptimeRobot, BetterStack…) que
haga ping a esa URL cada pocos minutos y te avise por email/SMS si no responde.
Así queda cubierto el 100% de los casos.

## Ajustar los umbrales

En `src/lib/watchdog.ts` (arriba del todo): cada cuánto vigila, el umbral de saldo,
cada cuánto el parte diario, y el umbral de avisos de emergencia (`FALLBACK_THRESHOLD`
en `FALLBACK_WINDOW_SEC`). Los valores por defecto son razonables; si quieres
cambiarlos, pídeselo a Claude.
