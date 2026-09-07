# Cómo responde el bot — reglas vigentes (05-09-2026)

Documento **versionado**. Describe lo que el bot hace de verdad ante un
mensaje del cliente, tras los tres arreglos del 05-09. Si el código y esto
se contradicen, manda el código y hay que corregir este archivo.

La idea que gobierna todo: **ante la duda, una persona.** El bot solo actúa
cuando entiende sin ambigüedad. Con un ticket de ~37 € y un rehusado que
cuesta ~9,37 €, equivocarse sale más caro que molestar a alguien.

---

## 1 · No se confirma un COD contra una dirección basura

Antes de confirmar, la dirección pasa un examen **mínimo y deliberado**: no
valida direcciones postales, solo detecta basura evidente (vacía, demasiado
corta, sin ninguna palabra de vía, sin número).

Si huele mal: **la confirmación se bloquea**, el pedido queda marcado y va a
una persona con el motivo (`empty` / `too_short` / `no_address_signal` /
`no_locator`). No se confirma "por si acaso": un COD confirmado a una
dirección inexistente es un rehusado con portes pagados.

## 2 · El primer mensaje por Cloud API es SIEMPRE la plantilla aprobada

Se eliminó el texto de respaldo que podía salir en lugar de la plantilla. En
la Cloud API la primera confirmación usa la plantilla aprobada por Meta y
nada más; lo que enseña el panel es una representación legible, **no** un
mensaje enviable. Así no puede repetirse una divergencia tipo 132001.

## 3 · Lo que no entendemos va a una persona, a la primera

Antes: aclaración → segunda ambigüedad → `needs_call`. Es decir, el cliente
tenía que fallar dos veces para que alguien le atendiera, y en la
conversación real que originó esto el bot llegó a repetir el mismo selector
**cinco veces** sin resolver nada.

Ahora, un texto que no encaja en ningún flujo determinista se responde con
«lo he pasado al equipo» y abre una tarea en la bandeja de atención.

**El selector multi-pedido sigue existiendo** para el caso en que sí
entendemos la intención pero no sabemos a qué pedido se refiere («todo
correcto» con dos pedidos abiertos). Ahí se pregunta cuál — y **nunca en
bucle**: a la tercera, persona.

## 4 · Cancelar: se registra, jamás se ejecuta

| Situación | Qué hace |
|---|---|
| **Un** pedido y el cliente pide anular | Registra la solicitud y lo pasa a una persona |
| **Varios** pedidos y no dice cuál | Los pasa todos a una persona y **no marca ninguno** |
| «CANCELAR 4096» (verbo + número) | Registra la solicitud de **ese** pedido; el otro sigue su curso |

En los tres casos: **nada se cancela solo** y el bot **jamás** dice que un
pedido está cancelado cuando no lo está. La decisión final es siempre humana.

Se quitó el paso intermedio de pedir «escribe CANCELAR 4201»: con un único
pedido no hay ninguna ambigüedad sobre cuál, y hacer que el cliente acierte
un formato solo servía para perder su petición.

## 5 · Duplicados: la pista vale aunque llegue tarde

«Solo he pedido uno» + pedidos que parecen el mismo → se marcan como
posible duplicado, van a revisión y se le explica al cliente. Con productos
**distintos** no se marca nada: dos pedidos diferentes no son un duplicado.

Esa comprobación se hace **también cuando el pedido ya está en manos
humanas**. En la conversación real que originó el caso, la pista («yo solo
he pedido el limpiador») llegó en el **tercer** mensaje, después de que la
conversación se hubiera derivado — es el dato que resuelve el caso y
perderlo por haber escalado antes sería tirar justo lo útil.

## 6 · Audios, imágenes y documentos no se quedan mudos

No podemos oír un audio ni leer una foto. Antes el flujo seguía a ciegas;
ahora se responde al cliente y lo revisa una persona.

Si `META_WHATSAPP_MEDIA_DOWNLOAD_ENABLED` no está a `0`, el fichero se
descarga de Meta y se ve en el panel (se guarda en `DATA_DIR/media`).

## 7 · Después de confirmar

| Llega | Qué pasa |
|---|---|
| `1` otra vez (doble pulsación, botón reenviado) | **Nada**: es inerte. No reabre el pedido ni molesta a nadie |
| Una duda de verdad («¿cuándo llega?») | Se responde y lo ve una persona |
| Una petición de cancelar | Se registra y lo ve una persona |

Que un `1` repetido fuera inerte no es un detalle: si cada doble pulsación
abriera una tarea, la bandeja de atención dejaría de servir para nada.

**Preguntar algo NO des-confirma un pedido.** La escalada se señala poniendo
la conversación en modo humano y abriendo una tarea, nunca degradando el
estado del pedido.

## 8 · Consecuencia operativa que hay que vigilar

Todo esto manda **más conversaciones a la bandeja de atención** que antes. Es
deliberado —es más barato que un rehusado— pero conviene mirar el volumen la
primera semana. Si la bandeja se llena de casos que el bot podría haber
resuelto, el ajuste está en qué se considera "texto que no entendemos"
(`src/lib/orders/free-text-intent.ts`), no en volver a los bucles.
