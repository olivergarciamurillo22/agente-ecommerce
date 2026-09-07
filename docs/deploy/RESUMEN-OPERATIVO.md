# Resumen operativo — qué espera a una persona (07-09-2026)

Con la validación de direcciones, la auto-cancelación por IA y el auto-despacho
en marcha, aparecen incidencias que **solo se ven entrando al panel** y mirando
en tres sitios distintos. Este resumen las junta con **su antigüedad**, que es
el dato que convierte «hay incidencias» en «esta lleva tres días sin tocar».

```
npm run pending:review                       # texto, listo para leer o pegar
npm run pending:review -- --json informe.json
GET /api/pending-review                      # JSON (propietario)
GET /api/pending-review?formato=texto        # el mismo texto que el CLI
```

Es **solo lectura**: no envía nada, no resuelve nada, no escribe.

## Qué lista, y por qué esas cuatro

| Tipo | Fuente | Abierta mientras… | Qué hace una persona |
|---|---|---|---|
| `ALERTA_DIRECCION` | `address_alerts` | `resolved_at IS NULL` | revisa la dirección y pulsa «Cerrar alerta» (eso libera el despacho retenido) |
| `CANCELACION_IA` | `ai_cancellations` + su `work_item` | no revertida y con el aviso sin resolver | confirma la cancelación o pulsa «Revertir cancelación» |
| `DESPACHO_RETENIDO` | `dispatch_cooldowns` | `status = 'blocked'` | resuelve la causa y pulsa «Despachar ahora» |
| `ESCALADA_SOLO_PROPIETARIO` | `work_items` con `owner_only = 1` | `resolved_at IS NULL` | la resuelve desde la ficha |

La cuarta es la importante y la menos obvia: **la bandeja `/trabajo` filtra las
escaladas `owner_only`, pero el auto-despacho SÍ las lee y retiene el pedido**.
Es decir, es exactamente la incidencia que puede dejar un pedido parado sin que
nadie la vea. Por eso entra aquí.

No duplica lo que ya existe: ni `action-center.ts` ni `business-alerts.ts` leen
`address_alerts`, `ai_cancellations` ni `dispatch_cooldowns`.

## El reloj

Todos los sellos de esas tablas son `unixepoch()` en UTC. La antigüedad se mide
en **tiempo transcurrido** (segundos entre el sello y ahora), no en días
naturales, así que no depende de la zona horaria ni del cambio de hora. Un ítem
con `ageHours = 50` lleva 50 horas abierto, se mire desde donde se mire.

## Punto ciego conocido

La retención (`src/lib/system/retention.ts`) **no purga** ninguna de estas
cuatro tablas. Una incidencia antigua del backfill puede aparecer con una
antigüedad enorme y no significa que nadie esté trabajando: significa que nunca
se cerró. Por eso el resumen trae `staleDays` (la más vieja) y avisa cuando pasa
de tres días.

## Cómo se engancharía a un envío, el día que se decida

Nada de esto está activo: **el resumen no envía**. Cuando se quiera, hay dos
caminos ya construidos en el repo, y ambos toman el texto de
`renderPendingReview()` tal cual:

1. **WhatsApp al dueño**, igual que los avisos del watchdog y el de
   auto-cancelación: `sendWhatsAppMessage(ALERT_WHATSAPP, texto, …)`. Pasa por
   los safety gates (`canSendRealWhatsApp`), así que en SAFE MODE queda en el
   log y no se envía nada. Exige `ALERT_WHATSAPP` en el `.env` del NAS.
2. **Correo o cron externo**: `npm run pending:review` ya imprime el texto y
   devuelve 0; un cron del NAS puede canalizarlo a donde haga falta sin tocar
   el código. Que haya incidencias **no** es un fallo del script, así que el
   exit code no sirve como señal de alarma: la señal es el texto.

Antes de activar el envío hay que decidir dos cosas que no puede decidir el
código: **cada cuánto** se manda (una vez al día por la mañana es lo razonable)
y **qué umbral** merece interrumpir (por ejemplo, solo si hay algo con más de
24 h). Ambos son un `if` sobre `olderThan24h` y `staleDays`, que ya vienen
calculados.

## Ejemplo

```
Casamable · 4 incidencia(s) esperando a una persona (2 con más de 24 h):
  · alerta direccion: 1
  · cancelacion ia: 1
  · despacho retenido: 1
  · escalada solo propietario: 1

  [   2 d] ALERTA_DIRECCION           #P9001 Cliente 1 — dirección dudosa: falta piso o puerta
  [  34 h] DESPACHO_RETENIDO          #P9003 Cliente 3 — hay una solicitud de cancelación del cliente sin resolver (canal beeping)
  [   5 h] ESCALADA_SOLO_PROPIETARIO  #P9004 Cliente 4 — Escalado a Pedro: revisar importe — no aparece en la bandeja de atención, pero retiene el despacho
  [   0 h] CANCELACION_IA             #P9002 Cliente 2 — la IA canceló el pedido sola (confianza 0.93) por: «cancelad el pedido»
```

Sin incidencias, dice exactamente eso: `Casamable · sin incidencias pendientes
de revisión humana.`
