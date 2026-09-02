# 03 · Personalizar el agente para tu negocio

El agente recién instalado responde usando la plantilla de `prompts/negocio.md` tal cual viene, con los huecos `[ENTRE CORCHETES]` sin rellenar — suena a asistente amable, pero no sabe nada de tu negocio. Para que entienda **TU** negocio, hay que rellenar ese archivo.

## Cómo funciona

El archivo `src/lib/system-prompt.ts` lee `prompts/negocio.md` **en cada mensaje** que entra y lo inyecta en el system prompt del modelo de IA. **No tocas código** — solo escribes en lenguaje natural en un archivo Markdown. Como se relee cada vez, cualquier cambio se aplica en la siguiente respuesta: no hay que reiniciar nada.

## Opción 1 · Con Claude Code (recomendado, 5 min)

En VS Code, abre Claude Code y escribe:

```
/personaliza
```

Te hará 9 preguntas en orden, una a una:

1. Nombre del negocio y qué vende
2. Tu cliente ideal (perfil, problema que le resuelves, qué le frena)
3. El nombre propio de tu agente
4. Qué ofreces y a qué precio (los únicos precios que podrá decir)
5. Cómo se paga y qué garantía ofreces
6. Qué preguntar para calificar al lead y qué separa uno bueno de uno malo
7. Cómo se cierra cuando el lead encaja
8. Tus enlaces oficiales (los únicos que podrá enviar)
9. El tono con el que quieres que hable

Responde en lenguaje natural. Claude escribe el archivo por ti, redacta además las preguntas frecuentes y las objeciones a partir de lo que le cuentes, y sincroniza los filtros de seguridad de `.env.local` (`ALLOWED_PRICES` y `ALLOWED_HOSTS`) con tus precios y enlaces.

## Opción 2 · Manual (15 min)

1. Copia un ejemplo que se parezca a tu caso:
   - `prompts/ejemplos/agencia-ia.md` — servicios B2B
   - `prompts/ejemplos/ecommerce.md` — venta online
   - `prompts/ejemplos/infoproducto.md` — cursos/formaciones
2. Pégalo como `prompts/negocio.md`
3. Edita las secciones para que reflejen tu negocio real, sin borrar las de seguridad (reglas de identidad del agente, Blindaje, la nota de precios únicos y la línea final del código de auditoría)

## Opción 3 · Desde cero (avanzado)

1. Copia `prompts/negocio.example.md` a `prompts/negocio.md`
2. Rellena los `[CORCHETES]` a mano, sección por sección

> Si personalizas a mano, acuérdate de poner tus precios en `ALLOWED_PRICES` y tus dominios en `ALLOWED_HOSTS` (en `.env.local`). Si no, los filtros de seguridad quedan permisivos. `/personaliza` lo hace por ti.

## Después de personalizar

**No hace falta reiniciar nada.** El agente relee `prompts/negocio.md` en cada mensaje, así que el guion nuevo se aplica en la siguiente respuesta.

(Excepción: si has tocado `ALLOWED_PRICES` o `ALLOWED_HOSTS` en `.env.local`, esas dos SÍ se leen al arrancar — ahí sí toca reiniciar el bot.)

Ahora prueba enviando un mensaje desde otro WhatsApp. Debería responder con la personalidad de tu negocio.

## Tips para escribir un buen `negocio.md`

- **Sé concreto**. En vez de "ayudamos a empresas", di "ayudamos a agencias de marketing de 5-20 empleados a automatizar reportes mensuales"
- **2-4 preguntas máximo** para calificar. Más es interrogatorio
- **Define con claridad** qué hace que un lead encaje. Si no, el agente intentará venderle a todo el mundo
- **Sé honesto** con los criterios de NO encaje. El agente debe responder cordialmente sin agendar si no califica

## Iterar

Si después de probar ves que el agente:

- **Pregunta cosas innecesarias** → simplifica las preguntas en negocio.md
- **No engancha** → mejora la propuesta de valor (más concreta, beneficio claro)
- **Es demasiado vendedor** → añade en el archivo "Tono: conversacional, sin presión, sin urgencia falsa"
- **No frena cuando el lead no encaja** → especifica más casos en "criterios de lead malo"

Puedes iterar en caliente: cualquier cambio en `negocio.md` entra en la siguiente respuesta, sin reiniciar el bot. Escribe, guarda y prueba desde otro móvil.

## Siguiente paso

Sigue a [04-configurar-tools.md](04-configurar-tools.md) para conectar tu CRM de Airtable.
