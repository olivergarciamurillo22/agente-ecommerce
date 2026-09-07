# Hallazgos de casos borde (Bloque 5 · 07-09-2026)

Se añadieron cuatro tests de borde a `tests/run-tests.ts` (bloque «Casos borde: codificación, dobles, vacíos y fallos a mitad de lote») **sin cambiar ningún comportamiento**. Todo lo que sigue se observó al sondear el código real; lo que no es un fallo de la semana se anota igualmente para que Pedro decida.

## Cubierto por los nuevos tests (comportamiento correcto, ahora blindado)

| Caso | Resultado observado |
|---|---|
| Direcciones con acentos mal codificados («AlcalÃ¡», «NÃºÃ±ez»), zero-width, NUL, comillas asiáticas, emojis decorativos, «n°», «2.º» | Capa 1 → `correcta`, sin alerta. Solo bloquea basura evidente, como está documentado |
| Dirección solo emoji, solo espacios o solo invisibles | Capa 1 → `incorrecta` + alerta; la capa 2 no gasta llamada |
| CP con espacios alrededor o salto de línea | Se recorta y es coherente |
| Provincia en mayúsculas, con espacios, «La Coruña»/«A Coruña» | Coherente. Una provincia ilegible («MadrÃ­d») no se declara incoherente |
| Hash de caché de la capa 2 | Ignora mayúsculas y espacios repetidos; cambia con el número de portal |
| Doble confirmación con cooldown activo (segundo «1», «1️⃣», «ok», «confirmo», segundo botón) | Inerte: una sola fila de cooldown, misma `due_at`, un solo evento, nadie escalado, cero llamadas a la IA |
| Texto vacío / solo espacios / solo emoji tras confirmar, con IA encendida | Nunca auto-responde; el texto llega al modelo tal cual; fail-closed a persona; cooldown retenido. Con IA apagada → persona de inmediato |
| OpenAI falla a mitad de lote (excepción síncrona y promesa rechazada) en `runPendingAddressAiValidations` | El pedido fallido queda `dudosa` + alerta; los siguientes se evalúan; el tick siguiente no repite ninguno (caché por dirección) |

## Observaciones que NO eran fallos del código nuevo (todas resueltas, ver más abajo)

1. **CP con espacio interior («28 001») abre ALERTA_DIRECCION.** `checkSpanishPostalCode` exige `^\d{5}$` tras recortar extremos. Es un error humano plausible al teclear en el formulario COD. Consecuencia: alerta visible y despacho automático retenido (no bloquea la confirmación). Opción si Pedro quiere: quitar espacios interiores antes de validar. Sin decidir, se queda como está (fail-closed).
2. **Respuestas cortas legítimas al mensaje inicial van a persona.** Con el pedido aún activo (antes de confirmar), `classifyOrderReply` solo acepta frases exactas: «sí, confirmo», «ok gracias», «Gracias!», «👍», «👌» → `unknown` → escalada a persona. «sí», «ok», «vale», «perfecto», «1️⃣», «confirmo» sí confirman. No es de esta semana (línea del 05-09) y no rompe nada, pero llena la bandeja con confirmaciones cortas. Opción: añadir «si confirmo», «ok gracias», «gracias» al conjunto de confirmación y un pequeño listado de emojis de asentimiento. Requiere que Pedro decida si un «👍» suelto vale como confirmación de un COD.
3. **«1 y 2» confirma.** La regla `^1\b` toma el primer número. Un cliente que quiera confirmar y cambiar la dirección en el mismo mensaje queda confirmado con la dirección original. Muy raro; se anota, sin cambio.
4. **Tras confirmar, un «👍» o «🙏» acaba en persona** (con o sin IA). El flujo del 05-09 escala todo lo desconocido tras confirmar para que «una duda no caiga al silencio». Un agradecimiento no es una duda. Opción: lista corta de acuses (gracias, 👍, 🙏, ok) que se registren sin escalar. Decisión de Pedro; hoy el coste es una entrada de más en la bandeja, nunca un pedido perdido.
5. **Con IA encendida, un mensaje vacío o solo emoji sí gasta una llamada** (~0,0001 $) que acaba en persona. Coste despreciable; se anota por completitud. Un filtro previo (texto sin letras ni dígitos → persona directa) evitaría la llamada; no se implementa sin decisión.

## Ningún fallo real encontrado en el código de la semana

Ni la validación de direcciones, ni el cooldown, ni la IA de intención, ni el router de canal produjeron un resultado incorrecto, una doble acción o una llamada de red no esperada en ninguno de los bordes probados.

---

## Cerrados el 07-09-2026 (noche): los cinco pasaron de «observación» a arreglo

Pedro decidió los cuatro primeros; el quinto se resolvió solo al hacerlo. Antes
de tocar nada se comprobó el estado real de cada uno en el código: **ninguno
estaba implementado** (dos no existían y dos estaban a medias).

### 1 · El código postal con espacio interior ya vale

`checkSpanishPostalCode` compacta ahora cualquier espacio interior —incluidos
los invisibles que llegan al copiar y pegar— antes de validar. «28 001» pasa a
`prefijo_valido` y coherente con Madrid. El informe conserva el valor tal y como
lo escribió el cliente. Cuatro dígitos siguen sin ser un CP.

**Por qué se cambió:** un espacio de más al teclear no es un error del cliente,
y abría una `ALERTA_DIRECCION` que retenía el despacho automático de ese pedido.

### 2 · El asentimiento confirma

`classifyOrderReply` acepta ahora, además de las frases de siempre:

- **Emojis de asentimiento** sueltos (👍 👌 👏 ✅ ✔️ 🆗 👊). Antes desaparecían:
  la normalización borra todo lo que no sea letra o número, así que un pulgar
  llegaba como cadena vacía y acababa en la bandeja. Se traducen a «sí» **antes**
  de normalizar.
- **Afirmaciones compuestas**: «sí, confirmo», «ok gracias», «correcto gracias»,
  «vale perfecto». La regla es que todas las palabras sean de asentimiento o de
  cortesía, y que al menos una afirme de verdad.

**Lo que sigue SIN confirmar, a propósito:** «gracias» o «muchas gracias» a
secas (cortesía sin afirmar nada), 🙏 (vale igual por «gracias» que por «por
favor»), y cualquier frase con una palabra que no sea ni afirmación ni
cortesía. Confirmar es despachar un contra reembolso: donde no hay afirmación,
no se adivina.

### 3 · Un acuse trivial tras confirmar no gasta nada

`isTrivialAcknowledgement` corta antes de llamar a la IA de intención: un
«gracias», un pulgar, unas manos juntas o un mensaje vacío se registran como
`post_confirmation_trivial` y ahí acaba. **Ni llamada a OpenAI, ni incidencia,
ni retención del despacho.** Antes gastaban cuota y, con la IA apagada, abrían
un elemento en la bandeja que nadie necesitaba.

Un mensaje que solo *empieza* por cortesía sigue su curso normal: «gracias,
pero cambiadme la dirección» va a la IA y de ahí a una persona.

### 4 · «1 y 2» ya no confirma el primero en silencio

`mentionsSeveralOptions` detecta que el mensaje nombra dos opciones distintas
del selector. En ese caso el clasificador devuelve «no entendido» y, con varios
pedidos activos, el flujo **escala a una persona con el motivo escrito**
(«Selección ambigua: menciona varios pedidos»).

Lo importante es dónde: la comprobación va **antes** de la rama del pedido ya
seleccionado, que era el agujero real. Con una selección viva, «1 y 2»
confirmaba el seleccionado y limpiaba el contexto sin preguntar. Quien escribe
«1 y 2» casi siempre quiere los dos, y eso lo decide una persona.

### 5 · Con la IA encendida, un mensaje vacío ya no gasta llamada

Era la quinta observación de esta lista y se resolvió sola con el punto 3: el
filtro de trivialidad corta antes de que la clasificación llegue a pedir nada.
