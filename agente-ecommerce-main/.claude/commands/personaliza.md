---
description: Adapta el agente al negocio del usuario mediante 9 preguntas conversacionales. Rellena la plantilla de prompts/negocio.md y actualiza los filtros de seguridad de .env.local.
---

# /personaliza — Adapta el agente a tu negocio

Vas a hacer 9 preguntas al usuario en orden, una a una. Después de la última vas a RELLENAR la plantilla `prompts/negocio.md` con sus respuestas (conservando sus secciones fijas de seguridad) y a actualizar los filtros de seguridad (`ALLOWED_PRICES` y `ALLOWED_HOSTS`) en `.env.local`. Aplica el patrón conversacional: una sola pregunta visible cada vez. No las saques todas a la vez.

## Antes de empezar — Verificaciones

1. Comprueba que existe `prompts/negocio.md`. Viene incluido en el kit como plantilla con `[CORCHETES]`. Si no existe (alguien lo borró), créalo copiando `prompts/negocio.example.md`; si tampoco existe ese, avisa al usuario y para
2. Lee `prompts/negocio.md` y decide por su CONTENIDO si ya está personalizado. Que el archivo exista NO significa que el usuario personalizara antes: se distribuye ya creado. Sigue siendo la plantilla sin rellenar si cumple cualquiera de estas señales:
   - el frontmatter dice `generado: PLANTILLA`
   - contiene `[NOMBRE DEL NEGOCIO]` u otros `[CORCHETES]` de plantilla sin sustituir
   - contiene el texto `CANARIO-KIT-CAMBIAME`

   Si es plantilla → continúa directo al saludo del punto 4
3. Solo si NO queda ninguna señal de plantilla (el usuario personalizó de verdad):
   > "Veo que ya personalizaste antes. ¿Qué quieres hacer?
   >
   > 1. Volver a empezar de cero (sobrescribir)
   > 2. Solo cambiar 1-2 cosas (te pregunto qué)
   > 3. Cancelar"
   - Si elige 2: ofrece editar puntualmente las secciones (nombre, catálogo y precios, enlaces, tono, etc.) y aplica igualmente los pasos 4-6 de "Después de las 9 preguntas" (validación y filtros de seguridad)
   - Si elige 1: continúa con las 9 preguntas
4. Saluda:
   > "Vamos a adaptar el agente a tu negocio. Te haré 9 preguntas. Responde en lenguaje natural, sin formato — yo me encargo de estructurarlo."

## Las 9 preguntas (una a una, en orden)

### Pregunta 1 · Nombre del negocio y qué vendes

> "1/9 — ¿Cómo se llama tu negocio y qué vende, en una frase?
>
> (Ejemplo: 'Estudio Lumen — sesiones de fotografía de producto para tiendas online')"

Espera respuesta. Guárdala como `nombre` (el nombre) y `actividad` (la frase de qué vende).

### Pregunta 2 · Tu cliente ideal

> "2/9 — ¿Quién es la persona que te escribe por WhatsApp? Cuéntame su perfil, el problema que le resuelves y qué le frena a comprar.
>
> (Ejemplo: 'Dueños de tiendas online que pierden ventas por fotos malas. Les frena pensar que una sesión profesional es cara y lenta')"

Espera respuesta. Guárdala como `cliente_ideal`.

### Pregunta 3 · El nombre de tu agente

> "3/9 — ¿Qué nombre propio le ponemos a tu agente? Se presentará con él al saludar; da cercanía.
>
> (Ejemplo: 'Leo', 'Ana', 'Max')"

Espera respuesta. Guárdala como `nombre_agente`.

### Pregunta 4 · Qué ofreces y a qué precio

> "4/9 — ¿Qué productos, servicios o planes vendes, qué incluye cada uno y cuánto cuesta? Importante: los precios que me des aquí serán los ÚNICOS que el agente podrá decir.
>
> (Ejemplo: 'Sesión básica: 10 fotos, 250 euros. Sesión completa: 30 fotos y un vídeo, 600 euros')"

Espera respuesta. Guárdala como `catalogo`. Si algún producto viene sin precio, pídeselo.

### Pregunta 5 · Pago y garantía

> "5/9 — ¿Cómo se paga y qué garantía o política de devoluciones ofreces?
>
> (Ejemplo: '50% al reservar por transferencia y el resto al entregar. Si no te gustan las fotos, repetimos la sesión gratis')"

Espera respuesta. Guárdala como `pago_garantia`.

### Pregunta 6 · Cómo calificar al lead

> "6/9 — ¿Qué debería preguntar el agente a un lead nuevo para saber si te interesa (2-4 preguntas), y qué señales separan un lead bueno de uno malo?
>
> (Ejemplo: 'Preguntas: ¿qué vendes? ¿cuántos pedidos haces al mes? BUENO: tienda activa con ventas y prisa por mejorar. MALO: solo curiosea o busca algo gratis')"

Espera respuesta. Guárdala como `calificacion`. Si da menos de 2 preguntas, pídele al menos otra más.

### Pregunta 7 · Cierre cuando el lead encaja

> "7/9 — Cuando el lead encaja y quiere avanzar, ¿cómo se cierra?
>
> 1. Le mando el enlace de compra o de reserva
> 2. Le mando un enlace para agendar una llamada (Cal.com, Calendly o similar)
> 3. Otra cosa (descríbeme)"

Espera respuesta. Guárdala como `cierre`. Si elige 2, pídele el enlace de agendar: irá a la sección de Enlaces de `prompts/negocio.md`, y el agente se lo enviará al lead calificado como cualquier otro enlace permitido.

Si el usuario pide "que lo derive a un humano" o "que me lo pase a mí", explícale cómo funciona de verdad este kit: el agente no transfiere el chat a nadie — cierra la conversación de principio a fin. Lo que sí puede hacer es AVISARLE al momento por WhatsApp cuando haya un lead caliente o un problema, con la autovigilancia del kit (variable `ALERT_WHATSAPP`, explicada en `docs/10-watchdog.md`). Ofrécele configurarla al terminar y guarda como `cierre` la alternativa que elija (enlace de compra, agenda u otra).

### Pregunta 8 · Enlaces oficiales

> "8/9 — Dime los enlaces oficiales de tu negocio: el de compra o reserva, tu web y alguno más si lo usas. El agente SOLO podrá enviar estos enlaces; cualquier otro se bloquea.
>
> (Ejemplo: 'https://estudiolumen.com y https://estudiolumen.com/reservar')"

Espera respuesta. Guárdala como `enlaces` (añade el enlace de agendar de la pregunta 7 si lo dio).

### Pregunta 9 · Tono

> "9/9 — ¿Cómo quieres que suene tu agente? Dime el estilo (cercano y directo, formal y elegante, divertido...) y, si puedes, una frase que SÍ diría y una que NO diría.
>
> (Ejemplo: 'Cercano y directo. SÍ diría: te lo dejo listo esta semana. NO diría: estimado cliente, le informamos de que...')"

Espera respuesta. Guárdala como `tono`.

## Después de las 9 preguntas

1. **Borradores de preguntas frecuentes y objeciones**: redacta tú, a partir de lo que te ha contado (catálogo, precios, pago, garantía, cliente ideal), 3-4 preguntas frecuentes con su respuesta y 2-3 objeciones típicas con su contestación. Fíjate en `prompts/ejemplos/` para el nivel de detalle

2. **Resumen y confirmación**: muéstrale las 9 respuestas formateadas MÁS tus borradores. Pregunta:
   > "¿Está todo correcto? He redactado también las preguntas frecuentes y las objeciones a partir de lo que me contaste — revísalas.
   >
   > 1. Sí, guarda
   > 2. Corregir algo (¿qué?)"

3. **Rellena `prompts/negocio.md`**: NO escribas un archivo nuevo con otra estructura — rellena la plantilla existente sección a sección, sustituyendo cada `[CORCHETE]` y conservando todo lo demás (títulos, reglas fijas y notas). Mapa de respuestas → secciones:

   | Sección de la plantilla | Con qué se rellena |
   |---|---|
   | Frontmatter (`nombre`, `actividad`, `generado`) | pregunta 1 + fecha ISO actual en `generado` |
   | Nombre y qué vendes | pregunta 1 |
   | A quién le hablas | pregunta 2 |
   | Quién eres: el agente | pregunta 3 (solo los corchetes; las reglas de identidad se quedan tal cual) |
   | Qué ofreces | pregunta 4 |
   | Precio, pago y garantía | preguntas 4 y 5 |
   | Preguntas frecuentes | tus borradores confirmados |
   | Objeciones frecuentes | tus borradores confirmados |
   | Flujo de conversación | conserva los 6 pasos; ajusta el Paso 2 con las preguntas de calificación y las señales de lead bueno/malo (pregunta 6) y el Paso 5 con el cierre elegido (pregunta 7) |
   | CÓMO SE GUARDA UN LEAD | se conserva tal cual |
   | Blindaje | se conserva tal cual; rellena solo `[TU IDIOMA]` |
   | Tono y estilo | pregunta 9 (las reglas fijas de la sección se quedan) |
   | Enlaces | preguntas 7 y 8 |
   | Línea final del código de auditoría (canario) | se conserva; la sincronizas en el paso 5 |

4. **Validación**: lee el archivo recién escrito y verifica que todas las secciones de la plantilla siguen presentes, que no queda ningún `[CORCHETE]` sin sustituir y que la línea final del código de auditoría sigue ahí. Si algo falta → reinténtalo

5. **Filtros de seguridad en `.env.local`** (no te lo saltes: sin esto los guardrails quedan permisivos):
   - `ALLOWED_PRICES`: todas las cifras de precio de la pregunta 4, separadas por comas y sin símbolo de moneda (ejemplo: `250,600`). **Añade también las cifras derivadas** que el agente pueda necesitar decir: si hay un plan anual, calcula e incluye su equivalente mensual redondeado (497 al año → añade `41`); si hay pago fraccionado, incluye el importe de cada cuota. Cualquier cifra de dinero que no esté en la lista BLOQUEA la respuesta entera y el lead no recibe nada — por eso es mejor listar de más que de menos. Al terminar, dile al usuario en una línea qué cifras quedaron autorizadas
   - `ALLOWED_HOSTS`: los dominios de los enlaces de las preguntas 7 y 8, sin `https://` ni rutas, separados por comas (ejemplo: `estudiolumen.com,cal.com`)
   - Canario: lee `SECURITY_CANARY` de `.env.local`. Si ya tiene valor, escribe ese MISMO valor en la línea final del canario de `prompts/negocio.md` (sustituyendo `CANARIO-KIT-CAMBIAME`). Si está vacío, genera uno aleatorio con `node -e "console.log('CANARIO-'+require('crypto').randomBytes(8).toString('hex'))"` y escríbelo en los DOS sitios: `SECURITY_CANARY` de `.env.local` y la línea final de `negocio.md`. Tienen que ser idénticos — si el modelo filtra su prompt, esa cadena delata la fuga y la respuesta se bloquea
   - Si `.env.local` no existe todavía, guarda igualmente `negocio.md` y dile al usuario que falta la instalación: `/setup` (al terminarla, vuelve a este paso)

6. **NO reinicies el bot**: el agente relee `prompts/negocio.md` en cada mensaje, así que el guion nuevo se aplica solo en la siguiente respuesta. No mates procesos ni arranques nada

7. **Test final**:
   > "✓ Listo. He personalizado el agente con los datos de **<nombre>** y he actualizado los filtros de seguridad (precios y enlaces permitidos). No hace falta reiniciar nada: el guion nuevo se aplica solo. Para probarlo: desde otro WhatsApp, escríbele 'hola' a tu número conectado. Ahora debería responder con personalidad propia.
   >
   > Si quieres ajustar algo más, vuelve a ejecutar `/personaliza`.
   >
   > Cuando estés listo para desplegar 24/7 → `/deploy`."

## Reglas

- Una pregunta a la vez. NUNCA enseñes las 9 a la vez
- Si el usuario responde algo muy corto/genérico, pídele más detalle ("¿puedes ser más concreto? por ejemplo...")
- NUNCA borres ni reescribas las secciones fijas de seguridad de la plantilla (reglas de identidad del agente, Blindaje, la nota de precios únicos, la línea del canario): de ellas dependen los filtros de seguridad. Rellena sus corchetes y deja el resto intacto
- NUNCA prometas que el agente "deriva a un humano" ni que "agenda por ti": el agente cierra por chat, envía los enlaces permitidos (incluido el de agendar, si lo hay) y los avisos al dueño van por la autovigilancia (`ALERT_WHATSAPP`)
- NUNCA modifiques `src/lib/system-prompt.ts`. El system prompt lee `prompts/negocio.md` automáticamente
- Si el usuario no sabe responder a una pregunta, sugiérele que mire `prompts/ejemplos/` (hay 3 casos completos: agencia-ia, ecommerce, infoproducto) para inspirarse
- Si el usuario se atasca y no sabe cómo definir su negocio → derívale a la comunidad donde consiguió el kit: "Esto lo trabajamos contigo, sin presión. Pregúntalo en la comunidad donde conseguiste el kit"
