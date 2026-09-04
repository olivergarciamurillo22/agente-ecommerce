---
name: landing-a-secciones
description: "Convierte un archivo HTML de landing (como los generados por la skill landing-cro) en secciones .liquid independientes de Shopify Dawn, UNA POR CADA BLOQUE de la landing, de forma totalmente automatizada: mismo contenido visible como defaults del schema, responsive con prioridad móvil (móvil primero, escritorio igual de cuidado), traducible y listo para pegar en el tema. Usar SIEMPRE que el usuario suba o mencione un HTML de landing y quiera 'pasarlo a Shopify', 'convertirlo en secciones', 'hacer las secciones', 'pasarlo a liquid' o similar — aunque no nombre la skill."
metadata:
  version: "1.5.0"
---

# Landing → Secciones Dawn

Pipeline automatizado: recibe **un HTML de landing autocontenido** y entrega **un archivo `.liquid` por cada bloque** de la página, listos para crear la sección en el editor de código de Shopify (tema Dawn), pegar y usar. El usuario no configura nada: todo el contenido, colores y estructura salen del HTML.

Si la skill `dawn-section-init` está disponible en el entorno, sus reglas completas MANDAN sobre cualquier resumen de este documento. Este SKILL.md incorpora sus reglas obligatorias; las referencias de esta skill contienen el esqueleto y los patrones ya adaptados.

---

## Flujo (automatizado al máximo)

### 1. Input: solo el HTML

Lo único imprescindible es el archivo HTML. Si no está subido, pedir solo eso.

Del propio HTML se **infiere todo lo demás, sin preguntar**:

- **Nombre del proyecto** (prefijo de archivos, PascalCase): del `<title>`, el logo o el nombre del producto. Declarar la inferencia en una línea ("Uso `IM8` como prefijo") y seguir; solo preguntar si es imposible inferirlo.
- **Tokens de diseño**: leer el `:root` del HTML — colores, fuentes, radius, `--space-*`, ancho máximo. Son el sistema de diseño de TODAS las secciones.
- **Contenido**: cada texto visible del HTML se convierte en el `default` de un setting del schema. Nada se reescribe, nada se inventa: la sección recién añadida se ve EXACTAMENTE igual que el bloque del HTML.

### 2. Trocear la landing en bloques

Recorrer el `<body>` de arriba abajo. Cada hijo estructural de primer nivel es un bloque → una sección. Detección típica (ver tabla completa en [`references/mapa-bloques.md`](references/mapa-bloques.md)):

topbar de anuncio · cabecera · hero · franja de confianza · banda de datos/vídeo · beneficios · contiene-no contiene · pasos de uso · variantes/sabores · expertos · embajadores/carrusel · reseñas · garantía · FAQ · CTA final · footer · sticky add-to-cart móvil.

Reglas de troceo:

- Los `<svg><defs>` globales (símbolos de iconos) se **duplican dentro de cada sección que los use** (solo los símbolos que use, renombrados con sufijo del bloque) — una sección de Shopify debe ser autosuficiente.
- El sticky add-to-cart es su propia sección; como ya no puede observar el CTA del hero de otra sección, aparece al superar `1.2 * innerHeight` de scroll (con setting de umbral en el schema).
- CTAs intermedios sueltos pueden fusionarse con la sección anterior (setting `checkbox` para mostrarlos/ocultarlos).

### 3. Generar cada sección

Cada bloque → un archivo `NombreProyecto-NombreBloque.liquid` construido sobre el esqueleto de [`references/esqueleto.md`](references/esqueleto.md) (leerlo ANTES de escribir la primera sección). Resumen de las reglas heredadas de dawn-section-init, TODAS obligatorias:

- **Un solo .liquid**: `{%- style -%}` → markup → `<script>` (si hay) → `{% schema %}` con presets.
- **Scoping por `section.id`** en todas las clases/selectores (la sección puede añadirse dos veces). JS idempotente.
- **Blindaje contra el CSS del tema — `!important` en TODO**: cada declaración del `{%- style -%}` lleva `!important`, incluidas las variables CSS — EXCEPTO dentro de `@keyframes`, donde es inválido y rompe la animación. La cascada interna de la sección sigue funcionando (a igual importancia deciden especificidad y orden), así que hover/active/focus/media queries se escriben igual que siempre. Además, la herencia no basta contra el tema (Dawn colorea `h2`, `a`, `summary`... con reglas de elemento propias): justo después de la regla raíz, TODA sección incluye la regla escudo `#shopify-section-{{ section.id }} .bloque :where(h1,h2,h3,h4,h5,p,a,ul,ol,li,b,s,em,strong,span,small,summary,blockquote,figcaption){ color: inherit !important; font-family: inherit !important; }` — al usar `:where()` no compite con las reglas internas de la sección, que van después y con clase, pero sí gana a cualquier regla de elemento del tema. Verificación obligatoria en el testeo: cero declaraciones sin `!important` fuera de `@keyframes` y regla escudo presente en cada sección.
- **Código sin comentarios.**
- **Cero texto hardcodeado**: todo string visible sale de un setting (`text`, `inline_richtext`, `richtext`) con el contenido del HTML como `default`. Textos usados por JS → `data-*`.
- **Contenido repetible → `blocks`** (beneficios, variantes, reseñas, FAQs, expertos, embajadores, ítems de confianza, pasos...) con `max_blocks` y los ítems del HTML como bloques del preset.
- **Medios**: `image_picker` / `video` — nunca URLs hardcodeadas. Sin imagen seleccionada, la sección pinta el placeholder discontinuo VACÍO: solo la caja (borde dashed, fondo, radius) con sus dimensiones garantizadas por CSS (`aspect-ratio` o altura), SIN ningún texto dentro. PROHIBIDO escribir etiquetas tipo "Aquí va la foto..." o "Aquí va un vídeo..." en el markup, y prohibido el setting `texto_placeholder`: aunque el HTML de origen traiga esos textos, se descartan al convertir.
- **Checkout**: setting `variant_id` (text) por CTA → `href="{{ routes.cart_url }}/{{ ... }}:1"`, más un setting `url` opcional que, si se rellena, lo sobreescribe.
- **Espaciados**: 4 ranges SIEMPRE — padding superior/inferior escritorio y móvil (0–120, step 4). Móvil como base, escritorio desde 750px.
- **Colores/radius/tamaños**: settings con los valores del HTML como `default`.
- **PRIORIDAD MÓVIL — todo se diseña primero para móvil**: la mayoría del tráfico de una landing es móvil, así que móvil es la vista principal, no una adaptación. El CSS base de cada sección ES la versión móvil (tamaños, escala, layout compacto), y escritorio se construye encima con `min-width: 750px` y `990px` — nunca al revés. Cada decisión de layout se toma pensando en 375px primero; dicho esto, escritorio no es secundario en calidad: debe verse igual de perfecto, solo que se resuelve después. Los grids que en el HTML colapsan a carrusel con snap en móvil lo siguen haciendo. Targets ≥44px.
- **Tipografía a tamaño real — PROHIBIDO `rem`**: Dawn define `html { font-size: calc(var(--font-body-scale) * 62.5%) }`, así que 1rem ≈ 10px y cualquier tamaño en `rem` se ve ~37% más pequeño que en el HTML. Regla: convertir TODOS los valores `rem` del HTML a `px` (×16) — font-size, márgenes, gaps, paddings y dentro de `clamp()` — y declarar `font-size` base en px en el selector raíz de cada sección para que el texto sin tamaño explícito no herede la escala del tema. `em` solo sobre un `font-size` en px ya fijado (padding de botones). Verificación obligatoria en el testeo: `grep rem` sobre el CSS de cada sección debe dar cero.
- **Escala móvil propia — NUNCA los mismos tamaños que en escritorio**: móvil no es escritorio encogido, tiene su propia escala más pequeña y compacta. Si el HTML usa `clamp()`, el mínimo es el valor móvil y el máximo el de escritorio: se separan en dos valores fijos (los `clamp` se eliminan, sustituidos por el par móvil/escritorio). Si el HTML no distingue, derivar la escala móvil: titulares ≈ 60–70% del tamaño de escritorio, texto base 15px, botones compactos (font-size ~90% y padding vertical/horizontal reducidos), gaps, márgenes y alturas de componentes ≈ 70%. Aplica a TODO elemento dimensionado: títulos, textos, botones (el de la cabecera incluido), precios, iconos, tarjetas, gaps de grid. En el testeo, el render mental a 375px debe confirmar que nada conserva el tamaño de escritorio.
- **Settings duales escritorio/móvil para TODO tamaño — nunca un setting compartido entre vistas**: cada valor de tamaño o espaciado que la sección use expone un PAR de ranges en el schema, el de escritorio y su gemelo con sufijo `_movil`, cada uno con el default de su escala. Mínimo obligatorio por sección: los 4 paddings (ya existentes), `tamano_titulo`/`tamano_titulo_movil`, `tamano_texto`/`tamano_texto_movil` y, si hay botones, `tamano_boton`/`tamano_boton_movil`. Añadir el par correspondiente para cualquier otro tamaño prominente del bloque (precio, iconos, gap de tarjetas...). Conexión mobile-first con variables CSS: la raíz define `--tamano-x: {{ ..._movil }}px` y `@media (min-width: 750px)` las reasigna al valor de escritorio — un solo punto de cambio, sin duplicar reglas. En el schema, agrupados bajo un header "Tipografía" con labels "(escritorio)"/"(móvil)"; los ranges cumplen división exacta y ≤101 pasos como siempre.
- **El archivo de tipografías replica las fuentes del HTML, no las aproxima**: mismo snippet de Google Fonts (familias y pesos exactos que declara el HTML). Si el stack del HTML empieza por una fuente de pago (p. ej. "Right Grotesk"), el snippet no puede cargarla: incluir en el archivo un comentario que lo diga y que identifique cuál es el fallback gratuito que realmente se verá, con hueco para el `@font-face` si el usuario tiene la licencia. Sin este archivo pegado en `theme.liquid`, las secciones caen a `system-ui` — el comentario de cabecera del archivo debe avisarlo.
- **Ancho**: `--ancho-contenido` con el `--maxw` del HTML como default (setting range). Contenido alineado aunque la sección sea full-width; padding lateral `clamp()`.
- **Rendimiento**: CSS-first, `transform`/`opacity`, `loading="lazy"` bajo el fold (`eager` + `fetchpriority="high"` solo en el hero), `IntersectionObserver`, `prefers-reduced-motion`, sin librerías.
- **Límite Shopify: `name` de schema/presets/bloques ≤ 25 caracteres.** Contarlos.
- En cada `range`: `(max − min) / step` división exacta y ≤ 101 pasos. Los `default` de `richtext` envueltos en `<p>`.

### 4. Testeo obligatorio antes de entregar

NUNCA entregar el primer borrador. Por cada sección: validar el schema mentalmente (JSON, ranges, ids referenciados existen en ambos sentidos, nombres ≤25), cierres de Liquid, guards de JS contra null y doble inserción de la sección, edge cases (sin bloques, sin imagen), y render mental EMPEZANDO por móvil — 375 primero y con más detenimiento, luego 768 y 1440: ambas vistas deben quedar perfectas, pero móvil se revisa primero y manda ante cualquier conflicto. Después la autocrítica: "¿podría mejorar algo?" — si sí, aplicarlo, no sugerirlo.

### 5. Entrega

- Todos los `.liquid` a outputs y presentados juntos, hero primero.
- Adicionalmente, UN archivo `NombreProyecto-Tipografias.html` con el snippet de fuentes para `theme.liquid` (única instrucción de instalación permitida: "antes de `</head>`").
- Respuesta en el chat: 2–4 líneas + la lista ordenada de secciones tal y como van en la página. Sin tutoriales, sin "próximos pasos", sin explicar dónde pegar cada archivo — el usuario ya lo sabe.

---

## Lo que esta skill NO hace

- No rediseña ni "mejora" el HTML de entrada: lo traduce fielmente a secciones. Los cambios de diseño se piden a la skill de diseño y se re-convierte.
- No genera JSON templates ni modifica theme.liquid (salvo el snippet de tipografías como archivo aparte).
- No toca el carrito con JS de compra custom: los CTAs usan permalinks de checkout. Si el usuario pide añadir-al-carrito con drawer, aplicar el patrón canónico de `dawn-section-init` § 3 (leyendo sus references de carrito).
