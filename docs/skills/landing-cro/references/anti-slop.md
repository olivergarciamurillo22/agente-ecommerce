# Anti-slop — que no parezca hecho por IA

Puertas condensadas. Todas deben responder NO antes de entregar.

## Color y tokens

- Todos los colores en **OKLCH** declarados como custom properties en `:root`. Ni un solo hex/rgb/oklch suelto en medio del CSS: si necesitas un valor nuevo, súbelo al bloque de tokens con nombre y referéncialo (`var(--color-...)`).
- La paleta sale de la **DNA de la referencia**, no del morado-sobre-gradiente-azul por defecto de los LLM. Un acento dominante con footprint controlado; nada de arcoíris de acentos.
- Los fondos de color llevan **gradiente sutil** (dos paradas del mismo hue), no color plano.

## Tipografía

- **Dos familias**: display con carácter + cuerpo neutro. Declaradas como tokens (`--font-display`, `--font-body`).
- **Prohibido el itálico en headings** — es el tell de IA más fiable. El énfasis se lleva con peso o color de acento (`<span class="accent">`), nunca con `<em>` en un titular.
- Titulares del hero: ≤ 7 palabras / ≤ 50 caracteres a tamaño display; más largos, bajan un escalón.
- Etiquetas de sección numeradas ("01 · LA GIRA") apagadas por defecto; si se usan, van apiladas en vertical, nunca etiqueta-izquierda/título-derecha.
- `overflow-wrap:anywhere; min-width:0` en display para que las palabras largas no rompan el layout.

## Layout y estructura

- **Variedad estructural**: dos landings para dos referencias no comparten el mismo ritmo hero → 3-features → CTA. Las secciones alternan papel claro, banda de color, carrusel full-bleed, dos columnas.
- Grids con imágenes usan `minmax(0,1fr)`, nunca `1fr` a secas.
- `overflow-x:clip` en `html` y `body` (nunca `hidden`).
- **Prohibido el chrome redibujado**: nada de barras de navegador falsas con los tres puntitos, marcos de móvil dibujados, ni ventanas de código fake. Los placeholders de medios son bloques etiquetados, no mockups de dispositivo.

## Honestidad

- **Cero métricas inventadas** ("+47% conversión", "50.000 clientes"): o son datos reales de la referencia, o placeholder etiquetado, o esa sección no existe.
- Cero logos de clientes inventados, cero testimonios atribuidos a personas reales.

## Motion

- Solo `transform` y `opacity`. Nunca propiedades de layout, nunca `transition:all`.
- Máximo 2-3 microinteracciones en toda la página. Antes de añadir una animación, pregunta si quitarla pierde información; si no, fuera.
- Easings con nombre (`--ease-out: cubic-bezier(.22,.8,.35,1)`), nunca el `ease` del navegador, nunca rebotes.
- `prefers-reduced-motion: reduce` colapsa todo a ≤150ms y desactiva ripples y smooth-scroll.
- `:focus-visible` con anillo visible en TODO lo interactivo; el anillo aparece instantáneo, nunca animado.

## Iconos y medios

- **Iconos SVG de línea** (trazo 1.6-1.8, `currentColor`, esquinas redondeadas) definidos como `<symbol>` reutilizables. **Nunca emojis** como iconos.
- Placeholders de medios: bloque `2px dashed` con etiqueta literal ("Aquí va la foto de X" / "Aquí va un vídeo de fondo — descripción, en bucle"), variante clara y oscura, y comentario `<!-- Sustituir por <img ...> -->` con el snippet exacto encima. Vídeos con el bloque `<video autoplay muted loop playsinline>` comentado y listo.

## Detalles que delatan a la IA (evitar)

- Emojis como iconos de sección.
- Sombras enormes y radios de 24px+ en todo.
- Tres tarjetas idénticas centradas como única idea de layout.
- Bold spam y listas de bullets en el copy de la página.
- Botones sin estados (hover/active/focus/disabled).
- El mismo espaciado vertical entre todas las secciones (usar una escala 4pt con nombres y variar el ritmo).
