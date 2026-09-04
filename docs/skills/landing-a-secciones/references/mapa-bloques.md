# Mapa de bloques — detección y schema por tipo

Cómo reconocer cada bloque en el HTML de entrada y qué estructura de schema le corresponde. Los `default` SIEMPRE son el contenido literal del HTML. Nombres de schema ≤ 25 caracteres (el prefijo del proyecto puede omitirse en el `name` si no cabe).

| Bloque en el HTML (señales) | Archivo | Settings principales | Blocks |
|---|---|---|---|
| Barra de anuncio (primer hijo del body, una línea) | `Proyecto-Topbar.liquid` | texto (inline_richtext), colores, tamaño | — |
| Cabecera (logo + botón, sticky) | `Proyecto-Cabecera.liquid` | logo (image_picker + texto fallback), texto botón, variant_id/url, sticky (checkbox), blur (checkbox) | — |
| Hero (primer section, split texto+media) | `Proyecto-Hero.liquid` | eyebrow, título, rating (texto + toggle), lead, precio + precio anterior + chip ahorro + nota, textos y destinos de los 2 CTAs, microcopy, toggle badges de pago, imagen (placeholder vacío sin texto) | checks de beneficio (icono select + texto) |
| Franja de confianza (3-4 ítems con icono en fila) | `Proyecto-Confianza.liquid` | colores, mostrar subtítulos en móvil (checkbox) | ítem: icono (select), título, subtítulo |
| Banda de datos / vídeo de fondo (sección oscura con números) | `Proyecto-Datos.liquid` | título, subtítulo, texto+destino del botón, vídeo (video, placeholder vacío sin texto), nota legal, color banda/dorado | estadística: título, número, descripción |
| Beneficios (grid de tarjetas icono+título+texto) | `Proyecto-Beneficios.liquid` | título (con span de acento vía inline_richtext), subtítulo, columnas escritorio (range 2–4) | beneficio: icono (select), título, texto |
| Contiene / No contiene (dos listas ✓/✕) | `Proyecto-ContieneNo.liquid` | títulos de ambas columnas | ítem: columna (select contiene/no), texto |
| Pasos de uso (numerados 1-2-3) | `Proyecto-Pasos.liquid` | título, CTA intermedio (toggle + textos + variant_id) | paso: título, texto |
| Variantes / sabores (tarjetas con CTA propio) | `Proyecto-Sabores.liquid` | título, subtítulo, microcopy común | variante: imagen + placeholder, badge (text, vacío = sin badge), nombre, descripción, texto botón, variant_id/url |
| Expertos (grid de tarjetas foto+nombre+cargo; carrusel en móvil) | `Proyecto-Expertos.liquid` | título, subtítulo | experto: imagen + placeholder, nombre, cargo |
| Embajadores (banda oscura + carrusel full-bleed + barra) | `Proyecto-Embajadores.liquid` | eyebrow, título (inline_richtext con span dorado), subtítulo, colores banda, mostrar barra (checkbox) | embajador: imagen + placeholder, nombre, rol, chip |
| Reseñas (estrellas + tarjetas con título/autor/texto) | `Proyecto-Resenas.liquid` | título, nota media, nº reseñas, CTA posterior (toggle + textos + variant_id), color estrellas | reseña: título, autor, fecha (text), texto |
| Garantía (banda de color con CTA) | `Proyecto-Garantia.liquid` | título, texto, textos CTA, variant_id/url, colores | — |
| FAQ (details/summary) | `Proyecto-Faq.liquid` | título, primera abierta (checkbox) | pregunta: pregunta, respuesta (richtext) |
| CTA final (banda oscura de cierre con precio) | `Proyecto-CtaFinal.liquid` | título, bloque de precio completo, textos CTA, variant_id/url, microcopy, toggle badges de pago, colores del gradiente | — |
| Footer (legal + marca de agua) | `Proyecto-Footer.liquid` | logo/texto, disclaimer (richtext), marca de agua (text + toggle + opacidad range), color fondo | enlace: texto, url |
| Sticky add-to-cart (barra fija inferior) | `Proyecto-BarraCompra.liquid` | precio, precio anterior, microcopy, textos CTA, variant_id/url, umbral de aparición (range), mostrar en escritorio (checkbox) | — |

## Iconos

Los `select` de icono ofrecen los símbolos presentes en el HTML de origen (escudo, camión, medalla, candado, ciclo, corazón, mancuerna, bombilla, gota...) con `label` en español. El `case` de Liquid pinta el `<symbol>` correspondiente, definido dentro de la sección con id sufijado por `section.id`.

## Badges de métodos de pago

Los cinco badges SVG (Visa, Mastercard, PayPal, Apple Pay, G Pay) viajan como snippet interno de las secciones que los usan (hero, CTA final, sticky), detrás de un checkbox `mostrar_pagos`, con el `sr-only` conservado.

## Orden de entrega

Presentar los archivos en el orden vertical de la página (hero primero en la lista de present_files por ser el más relevante) y cerrar la respuesta con la lista ordenada de secciones tal cual van en la página — nada más.
