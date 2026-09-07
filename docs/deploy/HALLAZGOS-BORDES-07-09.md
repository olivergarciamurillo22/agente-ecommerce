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

## Observaciones que NO son fallos del código nuevo (decisión de Pedro, sin cambio)

1. **CP con espacio interior («28 001») abre ALERTA_DIRECCION.** `checkSpanishPostalCode` exige `^\d{5}$` tras recortar extremos. Es un error humano plausible al teclear en el formulario COD. Consecuencia: alerta visible y despacho automático retenido (no bloquea la confirmación). Opción si Pedro quiere: quitar espacios interiores antes de validar. Sin decidir, se queda como está (fail-closed).
2. **Respuestas cortas legítimas al mensaje inicial van a persona.** Con el pedido aún activo (antes de confirmar), `classifyOrderReply` solo acepta frases exactas: «sí, confirmo», «ok gracias», «Gracias!», «👍», «👌» → `unknown` → escalada a persona. «sí», «ok», «vale», «perfecto», «1️⃣», «confirmo» sí confirman. No es de esta semana (línea del 05-09) y no rompe nada, pero llena la bandeja con confirmaciones cortas. Opción: añadir «si confirmo», «ok gracias», «gracias» al conjunto de confirmación y un pequeño listado de emojis de asentimiento. Requiere que Pedro decida si un «👍» suelto vale como confirmación de un COD.
3. **«1 y 2» confirma.** La regla `^1\b` toma el primer número. Un cliente que quiera confirmar y cambiar la dirección en el mismo mensaje queda confirmado con la dirección original. Muy raro; se anota, sin cambio.
4. **Tras confirmar, un «👍» o «🙏» acaba en persona** (con o sin IA). El flujo del 05-09 escala todo lo desconocido tras confirmar para que «una duda no caiga al silencio». Un agradecimiento no es una duda. Opción: lista corta de acuses (gracias, 👍, 🙏, ok) que se registren sin escalar. Decisión de Pedro; hoy el coste es una entrada de más en la bandeja, nunca un pedido perdido.
5. **Con IA encendida, un mensaje vacío o solo emoji sí gasta una llamada** (~0,0001 $) que acaba en persona. Coste despreciable; se anota por completitud. Un filtro previo (texto sin letras ni dígitos → persona directa) evitaría la llamada; no se implementa sin decisión.

## Ningún fallo real encontrado en el código de la semana

Ni la validación de direcciones, ni el cooldown, ni la IA de intención, ni el router de canal produjeron un resultado incorrecto, una doble acción o una llamada de red no esperada en ninguno de los bordes probados.
