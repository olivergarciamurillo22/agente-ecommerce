# Deploy 02-09 — Guía EXACTA para Pedro

Rama: `feat/control-center-v3-operational-polish` (incluye TODO lo anterior).
El NAS corre hoy `feat/casamable-control-center-v2` @ `67f05c7`.

Este despliegue lleva DOS cosas separables:

| Bloque | Qué es | ¿Urgente? |
|---|---|---|
| **P0 operativos** | El primer WhatsApp por fin puede salir (132001), tracking sin consumir avisos ni mandar "No disponible", Retell sin basura de placeholders y con versión fijada | **SÍ** — producción está rota sin esto |
| **UI v3** | Nav rail con nombres, marca Casamable, header sin semántica de Baileys, pantallas pulidas | No — puede esperar |

Van juntos en la rama. Si hiciera falta desplegar SOLO los P0, se puede
hacer cherry-pick de los commits `fix(...)` — pero no es lo recomendado:
la UI no cambia comportamiento y separar da más trabajo que desplegar todo.

---

## PASO 0 · Cuándo

**Fuera de la franja 10:00–21:00** (reiniciar corta WhatsApp). Ideal: a
partir de las 21:00.

## PASO 1 · Backup (siempre)

```bash
cp /volume1/docker/CasamableAgent/data/messages.db \
   /volume1/docker/CasamableAgent/backups/messages-antes-v3-$(date +%Y%m%d).db
```

## PASO 2 · Código

Copiar el repo actualizado al NAS (rama
`feat/control-center-v3-operational-polish`) como en despliegues
anteriores, y:

```bash
cd /volume1/docker/CasamableAgent
docker compose up -d --build
```

El esquema migra solo de 15 a **16** (una columna nueva en llamadas;
aditiva e idempotente).

## PASO 3 · Una línea nueva en el `.env` del NAS

```
RETELL_AGENT_VERSION=19   # SOLO un número de versión publicada (ver docs/retell/PRODUCTION-VALIDATION.md)
```

(Mejor aún: el NÚMERO de la versión publicada del agente, se ve en el
dashboard de Retell. Sin esta línea, las llamadas quedan bloqueadas por el
preflight — a propósito: así fue el incidente "[password 1]".)

Nada más cambia en el `.env`. Todo lo demás sigue igual.

## PASO 4 · Los TRES comandos dentro del contenedor (en orden)

```bash
# 1. ¿Las 4 suscripciones de Shopify siguen vivas en la tienda?
npm run shopify:webhooks -- --ensure

# 2. DESBLOQUEA EL PRIMER WHATSAPP: verifica la plantilla real
#    'confirmacion_pedido_cod' contra Meta y cachea la verificación.
#    (mapping corregido el 02-09: apuntaba a 'pedido', la plantilla de
#    ejemplo de Meta — nunca una plantilla de Casamable). Hasta que esto
#    salga en verde, la confirmación inicial NO sale (bloqueada con
#    motivo, sin 404s).
npm run whatsapp:templates:doctor

# 3. Estado de Retell: agente, versión publicada, prompt EN VIVO validado.
npm run retell:doctor
```

**Si el doctor de plantillas dice que `confirmacion_pedido_cod` no encaja**
(variables distintas de 4 o botones distintos de 3): no forzar nada —
mandar la salida a Óliver y se ajusta el mapping en un minuto. El sistema
seguirá reteniendo los envíos con el motivo visible en el panel (Ajustes
→ WhatsApp).

## PASO 5 · Verificar (30 min de observación)

1. Contenedor *healthy*; panel carga con la marca **Casamable** y el rail
   con nombres.
2. Ajustes → WhatsApp: **AUTOMATIZACIÓN WHATSAPP: READY** (si corriste el
   doctor del paso 4 y salió verde).
3. Pedido de prueba (teléfono de la allowlist) → llega la plantilla
   `confirmacion_pedido_cod` → botón "Confirmar pedido" → el pedido pasa a
   CONFIRMADO en el panel.
4. Ajustes → Llamadas: versión del agente visible; "Prompt: Validado".
5. Esquema **16** en Ajustes → Sistema.
6. Ningún secreto en `docker compose logs`.

## PASO 6 · El prompt de Retell (una vez, a mano)

El prompt nuevo está en `config/retell/casamable-agent-prompt.md`:
pegarlo en el agente de Retell, **publicar versión**, y poner ese número
en `RETELL_AGENT_VERSION`. Después: `npm run retell:doctor` debe decir
que el prompt en vivo coincide con el del repo.

## Rollback

Volver al commit `67f05c7` y `docker compose up -d --build`. El backup
del paso 1 es la red de seguridad; el esquema 16 no rompe el código v2
(columna nueva que aquel ignora).

---

## Qué queda BLOQUEADO a propósito después de esto

- **WhatsApp automático a todos los clientes**: sigue en modo PILOTO
  (allowlist). Subir la rampa (25% → 50% → 100%) se hace desde
  Ajustes → WhatsApp cuando el piloto del paso 5.3 esté verificado.
- **Llamadas automáticas**: siguen MANUAL-ONLY. Antes de plantear
  automatismo: `calls:validate-prompt` + `retell:doctor` +
  `calls:simulate` en verde, y UNA llamada de prueba al número autorizado
  escuchada entera.
