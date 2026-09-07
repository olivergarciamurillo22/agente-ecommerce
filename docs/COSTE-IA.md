# Coste de las llamadas a OpenAI y su tope diario (07-09-2026)

Dos capas del flujo COD llaman a OpenAI. Sin techo, un pico de mensajes o un
bucle por error convierte un coste de céntimos en una factura. Desde el
07-09 hay un **tope diario por tipo de llamada** que, al alcanzarse, hace que
esa capa **deje de llamar a la API**.

No cuenta aquí el agente conversacional del kit (`src/lib/openrouter.ts`): usa
OpenRouter, otra cuenta y otra clave, y no forma parte del flujo COD.

## Coste por llamada

Ambas capas usan `gpt-4o-mini` con salida estructurada. Tarifa pública de
OpenAI: **0,15 $/M** tokens de entrada y **0,60 $/M** de salida.

| Capa | Qué manda | Entrada aprox. | Salida aprox. | Coste por llamada |
|---|---|---:|---:|---:|
| Validación de direcciones, capa 2 | dirección, ciudad, provincia, CP y la provincia deducida del CP | ~400 tokens | ~60 tokens | ~0,0001 $ |
| Intención post-confirmación | el mensaje del cliente + el catálogo de la FAQ (7 entradas con sus disparadores) | ~500 tokens | ~50 tokens | ~0,0001 $ |

La cifra de referencia que usa el código es **0,0001 € por llamada**
(`AI_COST_PER_CALL_EUR`). Es una estimación de tarifa, no un dato medido: la
factura real la manda OpenAI.

## Cuántas llamadas hace de verdad

- **Direcciones**: como mucho **una por pedido y por dirección** (la caché es
  por contenido: si la dirección no cambia, no se vuelve a llamar), y el
  scheduler procesa **5 por tick** como máximo.
- **Intención**: una por mensaje de texto libre que llegue **después** de
  confirmar y que el flujo determinista no entienda. Solo una fracción de los
  clientes escribe tras confirmar.

Con el volumen actual (del orden de 100 pedidos en la muestra histórica), el
gasto real esperado está muy por debajo de un euro al mes.

## El tope

| Variable | Default | Qué acota |
|---|---:|---|
| `OPENAI_DAILY_CALL_LIMIT` | `500` | tope por tipo, si no hay uno específico |
| `OPENAI_DAILY_CALL_LIMIT_ADDRESS` | *(vacío)* | solo la capa 2 de direcciones |
| `OPENAI_DAILY_CALL_LIMIT_INTENT` | *(vacío)* | solo la clasificación de intención |
| `OPENAI_LIMIT_ADDRESS_FALLBACK` | `dudosa` | qué hace direcciones al agotarse |

**Techo de gasto con los defaults**: 500 llamadas de direcciones + 500 de
intención = 1.000 × 0,0001 € = **0,10 € al día**, unos **3 € al mes** en el
peor caso absoluto. Ese peor caso exige ~10× el volumen actual, así que el
tope no estorba a la operación normal: está para que un bug no cueste dinero.

`0` o negativo desactiva el tope. La clave equivalente en `settings`
(`openai_daily_call_limit_address` / `_intent`) **gana** a la variable de
entorno, así que un día de pico se sube desde la base sin desplegar.

## Cómo se cuenta (y por qué así)

Una fila por **intento** en la tabla `ai_call_log` (migración 27), y el tope es
un `COUNT(*)` desde la **medianoche de Madrid** (`startOfBusinessDay`, el mismo
«hoy» que usan todas las métricas). Es el patrón que el repo ya usa para el
tope diario de llamadas de teléfono.

Dos decisiones que importan:

- **Tabla-log, no contador en `settings`.** El bot y el panel son procesos
  distintos sobre la misma SQLite: un leer-sumar-escribir se pisaría entre
  procesos y el tope se superaría en silencio.
- **Se cuenta el intento, no el éxito.** Un timeout o un 500 también gastan, y
  contar solo los éxitos dejaría pasar justo el caso malo: un fallo que se
  repite en bucle.

## Qué pasa al agotarse

**Intención** → escalada a persona con motivo `limite_diario_ia`, exactamente
igual que cualquier otro fail-closed de esa capa (JSON inválido, timeout, fallo
de red). El cliente recibe el mensaje de siempre: «te paso con el equipo».

**Direcciones** → depende de `OPENAI_LIMIT_ADDRESS_FALLBACK`:

| Modo | Qué hace | Consecuencia |
|---|---|---|
| `dudosa` (default, decisión de Pedro) | veredicto `dudosa` con el problema `sin_confirmar:limite_diario_ia`, se abre `ALERTA_DIRECCION` | fail-closed estricto: nunca se da por buena una dirección sin validar. **Contrapartida: esos pedidos quedan con el auto-despacho RETENIDO** hasta que alguien cierre la alerta, así que agotar la cuota se nota en la bandeja |
| `omitir` | la capa 2 declara `no_ejecutada` y manda el veredicto determinista de la capa 1 | no abre alertas ni retiene despachos; el pedido se reevalúa cuando la cuota vuelva. Es el comportamiento que ya tiene producción hoy, donde la capa 2 está apagada |

**El modo por defecto es el que pidió Pedro.** La alternativa existe porque, con
el cooldown encendido y la cuota agotada, `dudosa` puede convertir un ahorro de
céntimos en una parada operativa: todos los pedidos de ese día quedarían
retenidos esperando revisión humana. Con el tope en 500 haría falta un pico de
diez veces el volumen actual para llegar ahí, pero conviene saber cuál es el
botón si pasa.

En ambos casos queda el evento `ai_daily_limit_reached` en el registro de
integraciones, con el tipo, el consumo y el modo aplicado.

## Si no se puede contar

Si la base no se deja leer, **se permite la llamada**. El tope es una
protección de coste, no de seguridad: bloquear el flujo de un pedido por no
poder contar sería peor que el gasto que evita.
