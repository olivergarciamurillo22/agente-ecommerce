# Retell en producción — contrato validado con evidencia real

Documento **versionado**. Recoge lo observado en producción el 03-09-2026,
no lo que suponíamos.

## Estado validado

| Cosa | Estado |
|---|---|
| Agente publicado | **V19** |
| Pin de versión | `RETELL_AGENT_VERSION` **numérica**, activa |
| Prompt publicado | idéntico al del repo (`config/retell/casamable-agent-prompt.md`) |
| `call_analysis` real | **observado** (ver contrato abajo) |
| Firma de webhooks reales | **PENDIENTE** — ver "Firma" |

## Política de versión: SOLO número

`RETELL_AGENT_VERSION` admite **únicamente un número de versión publicada**
(`19`, no `latest_published` ni un tag de entorno). El código lo exige
(`agentVersionPinIssue`) y sin número **no sale ninguna llamada**, ni
manual. Un tag o `latest*` se mueve solo cuando alguien publica, y entonces
los clientes oyen otra cosa sin que nadie haya tocado el `.env` — que es el
incidente que originó el pin.

Si Retell resuelve una versión distinta de la fijada, el sistema **bloquea
las llamadas siguientes** y lo dice en el panel. Se levanta con
`npm run retell:doctor -- --unblock` **después** de arreglar la causa.

## Contrato REAL del análisis post-llamada (observado)

Lo que Retell entrega de verdad es **plano**, sin contenedor:

```json
{
  "resultado_llamada": "confirmado_con_correccion",
  "codigo_postal_corregido": "04007",
  "telefono_alternativo": "",
  "pidio_no_llamar": true
}
```

Campos del contrato vigente (todos planos):

| Campo | Tipo | Notas |
|---|---|---|
| `resultado_llamada` | selector | uno de los 12 valores del backend |
| `direccion_corregida` | texto | vacío = no toca la dirección |
| `localidad_corregida` | texto | |
| `codigo_postal_corregido` | texto | **se conserva como texto**: el `04007` no puede perder el cero |
| `telefono_alternativo` | texto | **vacío se ignora**: no pisa el teléfono bueno |
| `pidio_no_llamar` | booleano | independiente del resultado |
| `momento_rellamada` | texto | solo con `rellamar` |

**`datos_corregidos` NO aparece.** El backend sigue aceptándolo por
compatibilidad (si algún día vuelve, no rompe), pero **el contrato preferido
y documentado es el plano**.

Alias aceptados para el resultado, por orden: `resultado_llamada` (el real)
→ `resultado` → `result` (histórico).

## Caso real cubierto: corrección + no volver a llamar

`resultado_llamada = confirmado_con_correccion` **y** `pidio_no_llamar = true`
a la vez debe producir, exactamente una vez:

1. el resultado aplicado (pedido confirmado con corrección),
2. el CP `04007` guardado tal cual,
3. el teléfono **intacto** (el `telefono_alternativo` vacío se ignora),
4. el teléfono en la lista **NO LLAMAR** (global, también para pedidos futuros).

Está fijado por tests en `tests/run-tests.ts`.

## Firma de los webhooks

La documentación oficial de Retell dice: *«Only the API key that has a
webhook badge next to it can be used to verify the webhook»*. Una cuenta
puede tener varias API keys y **solo la marcada con el distintivo
"webhook"** firma los webhooks salientes.

Síntoma cuando la key configurada no es esa: el algoritmo es correcto, una
firma construida en local pasa, y **todas las firmas reales se rechazan con
401**. En los eventos del panel aparece
`call_webhook_bad_signature (digest_mismatch)` con la forma de la cabecera
(nunca el digest ni la clave).

**Qué hacer (Pedro):** en el panel de Retell → API keys, usar la que tiene
el distintivo *webhook* como `RETELL_API_KEY` en el `.env` del NAS y
reiniciar el contenedor fuera de 10:00–21:00.

**Cómo se sabe que ya está bien:** a la primera firma REAL verificada, el
sistema deja constancia y `npm run retell:doctor` pasa de
`RETELL_REAL_WEBHOOK_SIGNATURE: UNVERIFIED_EXTERNAL` a `PASS` con la fecha.
Hasta entonces **no se declara validado**, aunque la API responda bien:
`RETELL_API_AUTH: PASS` solo dice que la key sirve para *crear llamadas*.

## Reconciliar una llamada ya ocurrida

```bash
docker exec casamable-agent npm run retell:reconcile-call -- --call-id call_xxx
```

Por defecto **DRY RUN**: consulta la llamada, enseña su forma (redactada),
la correlaciona con el intento y el pedido y **no aplica nada**. Con
`--apply` aplica el resultado. Nunca crea una segunda llamada.

## Comandos

| Comando | Para qué |
|---|---|
| `npm run retell:doctor` | contrato local, estado, agente en vivo, veredicto |
| `npm run retell:doctor -- --unblock` | levantar el bloqueo tras arreglar la causa |
| `npm run retell:pilot -- --order <id>` | ensayo en seco de una llamada manual |
| `npm run retell:reconcile-call -- --call-id <id>` | reconciliar una llamada real |
| `npm run calls:simulate` | preflight sin red |
| `npm run calls:validate-prompt` | validar el prompt versionado |
