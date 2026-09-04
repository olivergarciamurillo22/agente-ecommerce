# Esqueleto de sección — leer antes de escribir la primera

Estructura canónica de cada `.liquid` generado. Sustituir `bloque` por el nombre del bloque en kebab-case. El código real va SIN comentarios; aquí los hay solo para explicar el patrón.

## Estructura del archivo

```liquid
{%- style -%}
  #shopify-section-{{ section.id }} .bloque{
    --ancho-contenido: {{ section.settings.ancho_contenido }}px !important;
    --color-fondo: {{ section.settings.color_fondo }} !important;
    --color-texto: {{ section.settings.color_texto }} !important;
    --color-acento: {{ section.settings.color_acento }} !important;
    padding-top: {{ section.settings.padding_superior_movil }}px !important;
    padding-bottom: {{ section.settings.padding_inferior_movil }}px !important;
    background: var(--color-fondo) !important;
    color: var(--color-texto) !important;
  }
  #shopify-section-{{ section.id }} .bloque :where(h1,h2,h3,h4,h5,p,a,ul,ol,li,b,s,em,strong,span,small,summary,blockquote,figcaption){ color: inherit !important; font-family: inherit !important; }
  #shopify-section-{{ section.id }} .bloque__contenido{
    max-width: var(--ancho-contenido) !important;
    margin-inline: auto !important;
    padding-inline: clamp(26px, 4vw, 77px) !important;
  }
  @media screen and (min-width: 750px){
    #shopify-section-{{ section.id }} .bloque{
      padding-top: {{ section.settings.padding_superior }}px !important;
      padding-bottom: {{ section.settings.padding_inferior }}px !important;
    }
  }
{%- endstyle -%}
```

Reglas de blindaje del CSS:

- **TODAS las declaraciones con `!important`** (variables incluidas), salvo dentro de `@keyframes` donde es inválido.
- **La regla escudo va SIEMPRE justo después de la regla raíz**: con `:where()` no interfiere con las reglas propias de la sección (van después y con clase) pero anula las reglas de elemento del tema (Dawn pone color a `h2`, `a`, `summary`...). Todo elemento que cambie de color o fuente lo declara explícitamente en su propia regla.

Continuación del esqueleto:

```liquid

<div class="bloque bloque-{{ section.id }}">
  <div class="bloque__contenido">
    ...markup con BEM: bloque__elemento--modificador...
  </div>
</div>

<script>
  (function(){
    var root = document.querySelector('.bloque-{{ section.id }}');
    if (!root || root.dataset.init) return;
    root.dataset.init = '1';
    ...
  })();
</script>

{% schema %}
{ ... }
{% endschema %}
```

Reglas del esqueleto:

- Naming BEM con el nombre del bloque como raíz (`hero__titulo`, `sabores__tarjeta--destacada`). Jerarquía de headings correcta: un solo `h2` por sección (el `h1` solo en el hero), `h3` para ítems.
- El JS (si existe) se scopea buscando `.bloque-{{ section.id }}` y usa guard `data-init` — la sección puede estar dos veces en la página.
- Iconos: los `<symbol>` que el bloque necesite se incluyen dentro de la propia sección con ids sufijados (`i-escudo-{{ section.id }}`) para no colisionar.

## Bloque de settings obligatorios (todas las secciones)

```json
{ "type": "header", "content": "Tipografía" },
{ "type": "range", "id": "tamano_titulo", "label": "Tamaño del título (escritorio)", "min": 20, "max": 80, "step": 2, "unit": "px", "default": 42 },
{ "type": "range", "id": "tamano_titulo_movil", "label": "Tamaño del título (móvil)", "min": 16, "max": 60, "step": 2, "unit": "px", "default": 28 },
{ "type": "range", "id": "tamano_texto", "label": "Tamaño del texto (escritorio)", "min": 12, "max": 24, "step": 1, "unit": "px", "default": 16 },
{ "type": "range", "id": "tamano_texto_movil", "label": "Tamaño del texto (móvil)", "min": 12, "max": 24, "step": 1, "unit": "px", "default": 15 },
{ "type": "range", "id": "tamano_boton", "label": "Tamaño del botón (escritorio)", "min": 12, "max": 22, "step": 1, "unit": "px", "default": 16 },
{ "type": "range", "id": "tamano_boton_movil", "label": "Tamaño del botón (móvil)", "min": 12, "max": 22, "step": 1, "unit": "px", "default": 14 },
{ "type": "header", "content": "Espaciado" },
{ "type": "range", "id": "padding_superior", "label": "Padding superior (escritorio)", "min": 0, "max": 120, "step": 4, "unit": "px", "default": 80 },
{ "type": "range", "id": "padding_inferior", "label": "Padding inferior (escritorio)", "min": 0, "max": 120, "step": 4, "unit": "px", "default": 80 },
{ "type": "range", "id": "padding_superior_movil", "label": "Padding superior (móvil)", "min": 0, "max": 120, "step": 4, "unit": "px", "default": 56 },
{ "type": "range", "id": "padding_inferior_movil", "label": "Padding inferior (móvil)", "min": 0, "max": 120, "step": 4, "unit": "px", "default": 56 },
{ "type": "header", "content": "Layout" },
{ "type": "range", "id": "ancho_contenido", "label": "Ancho máximo del contenido", "min": 1000, "max": 1800, "step": 40, "unit": "px", "default": 1280 }
```

- Los defaults de padding salen de los valores computados del HTML (`--space-2xl` escritorio, su override móvil).
- Los defaults tipográficos salen del HTML: en un `clamp()`, el mínimo → default móvil y el máximo → default escritorio. Si el bloque no tiene botón, omitir su par; los pares del título/texto se ajustan a lo que exista (un topbar solo necesita `tamano_texto`).
- Cualquier otro tamaño prominente del bloque (precio, iconos, gap de tarjetas, altura de logo...) añade su propio par `id`/`id_movil` con el mismo patrón.

## Patrón: conexión de settings duales (mobile-first, un solo punto de cambio)

```liquid
{%- style -%}
  #shopify-section-{{ section.id }} .bloque{
    --tamano-titulo: {{ section.settings.tamano_titulo_movil }}px !important;
    --tamano-texto: {{ section.settings.tamano_texto_movil }}px !important;
    --tamano-boton: {{ section.settings.tamano_boton_movil }}px !important;
    font-size: var(--tamano-texto) !important;
  }
  #shopify-section-{{ section.id }} .bloque__titulo{ font-size: var(--tamano-titulo) !important; }
  #shopify-section-{{ section.id }} .bloque__boton{ font-size: var(--tamano-boton) !important; padding: .8em 1.6em !important; }
  @media screen and (min-width: 750px){
    #shopify-section-{{ section.id }} .bloque{
      --tamano-titulo: {{ section.settings.tamano_titulo }}px !important;
      --tamano-texto: {{ section.settings.tamano_texto }}px !important;
      --tamano-boton: {{ section.settings.tamano_boton }}px !important;
    }
  }
{%- endstyle -%}
```

- Las variables se definen con el valor MÓVIL en la base y se reasignan en el media query — nunca duplicar las reglas que las consumen.
- El padding de botones en `em` sobre su propio `font-size`: al bajar el tamaño móvil, el botón se compacta solo.
- Igual para cualquier par extra (`--tamano-precio`, `--alto-logo`...).

## Patrón: CTA con permalink de checkout

```liquid
{%- if section.settings.url_boton != blank -%}
  {%- assign enlace = section.settings.url_boton -%}
{%- else -%}
  {%- assign enlace = routes.cart_url | append: '/' | append: section.settings.variant_id | append: ':1' -%}
{%- endif -%}
<a class="bloque__boton" href="{{ enlace }}">{{ section.settings.texto_boton }}</a>
```

Settings: `texto_boton` (text, default = texto del HTML con el precio), `variant_id` (text, info: "ID de la variante para checkout directo"), `url_boton` (url, info: "Si se rellena, sustituye al checkout directo"). En blocks, igual con `block.settings`.

## Patrón: imagen con placeholder de diseño

```liquid
{%- if section.settings.imagen != blank -%}
  {{ section.settings.imagen | image_url: width: 1500 | image_tag:
     widths: '400, 750, 1100, 1500',
     sizes: '(min-width: 990px) 45vw, 100vw',
     loading: 'lazy',
     class: 'bloque__imagen' }}
{%- else -%}
  <div class="bloque__ph"></div>
{%- endif -%}
```

- El placeholder va SIEMPRE VACÍO: sin texto dentro, sin setting `texto_placeholder`. Las etiquetas descriptivas del HTML de origen ("Aquí va la foto...", "Aquí va un vídeo...") se descartan al convertir.
- `.bloque__ph` replica el estilo discontinuo del HTML (borde `2px dashed`, fondo, radius) y garantiza sus dimensiones por CSS — `aspect-ratio` del original o altura explícita — para que la caja no colapse al estar vacía.
- Hero above-the-fold: `loading: 'eager', fetchpriority: 'high'` y sin lazy.
- Vídeo de fondo: setting `video` de Shopify; sin vídeo, placeholder oscuro vacío con las mismas garantías de dimensión.

## Patrón: carrusel con snap y barra propia (embajadores, expertos móvil)

- El track replica el full-bleed del HTML (`margin-inline: calc(50% - 50vw)` etc.) y `scrollbar-width: none`.
- Barra + pulgar como en el HTML de origen; el JS de sincronización/arrastre va scoped al `section.id` con el guard `data-init`.
- Cada tarjeta es un `block` del schema (imagen + nombre + rol + chip), `max_blocks` según el diseño (12 por defecto).

## Patrón: sticky add-to-cart (sección propia)

Al ser una sección independiente no puede observar el CTA del hero. Sustituir el IntersectionObserver por umbral de scroll:

```javascript
var umbral = parseFloat(root.dataset.umbral) * window.innerHeight;
var visible = false;
addEventListener('scroll', function(){
  var pasa = scrollY > umbral;
  if (pasa !== visible){ visible = pasa; barra.classList.toggle('mostrar', pasa); }
}, { passive: true });
```

- Setting `umbral` (range 0.5–3, step 0.1, default 1.2, unidad "× alto de pantalla") pasado por `data-umbral`.
- Mantener `visibility:hidden` sincronizada y `env(safe-area-inset-bottom)`.
- La sección solo se muestra `@media (max-width: 749px)` salvo checkbox "mostrar también en escritorio".

## Patrón: FAQ

- `<details>/<summary>` nativos; cada pregunta un `block` (settings `pregunta` text + `respuesta` richtext con default `<p>...</p>`).
- Checkbox "primera pregunta abierta" que añade `open` al primer bloque.

## Accesibilidad heredada del HTML

Conservar SIEMPRE al convertir: `aria-label` de precios tachados, `sr-only` de métodos de pago, `aria-hidden` en decorativos (barra del carrusel, marca de agua del footer), `:focus-visible` en todo lo interactivo, `tabindex="0"` en tracks scrolleables, y el bloque `prefers-reduced-motion` global de la sección.
