# CRO — reglas de conversión

Leer entero antes de escribir el HTML.

## Densidad y copy de CTA

- **Un CTA de compra cada ~2 pantallas de scroll.** Cuenta las pantallas del resultado; si hay un hueco mayor (típico entre beneficios y garantía), inserta un CTA intermedio centrado con microcopy.
- **Precio en todos los botones**: "Comprar — 89 €", nunca "Comprar" a secas. Elimina la incertidumbre del click y cualifica el tráfico.
- **CTA específico por variante**: "Comprar Açaí — 89 €". Un botón que confirma la elección convierte más que uno genérico.
- **CTA secundario transaccional** en el hero: apunta a una micro-decisión de compra ("Elegir mi sabor" → #variantes), no a "saber más".
- **Verbos de identidad** en los CTA intermedios: "Empezar mi rutina", "Probarlo yo también" — conectan el click con el resultado, no con la transacción.

## Precio y anclaje

- Siempre como **oferta honesta**: precio actual grande + precio anterior tachado (con `aria-label="Precio anterior X euros"`) + chip de ahorro ("-15%" o "Ahorra 16 €").
- **Coste por día/uso** cuando el producto es consumible: "sale a 2,97 €/día". Reencuadra sin tocar el precio.
- En Shopify, la oferta debe coincidir con el `compare at price` real para que el checkout muestre lo mismo que la landing.

## Confianza pegada al botón

El momento de máxima duda es justo antes del click. Junto a CADA CTA (no en una sección lejana):

- Microcopy de riesgo: "Garantía de 90 días · Pago único · Envío gratis".
- Fila de métodos de pago bajo el CTA del hero y el final (texto o logos SVG, con comentario para sustituir).
- La FAQ es manejo de objeciones: garantía, ¿es suscripción?, ¿cuándo llega?, ¿es seguro?, compatibilidad. Una pregunta = una objeción.

## Fugas de conversión

- **Cabecera sin menú**: logo + botón de compra. Punto.
- **Footer mínimo**: legal + eco de marca. Sin columnas de enlaces, sin newsletter.
- Los enlaces internos solo mueven hacia la compra (anclas a variantes, reseñas) — nunca sacan de la página.

## Sticky add-to-cart (móvil)

- Barra fija inferior con precio (+ tachado pequeño) y botón, que **aparece solo al pasar el CTA del hero** (IntersectionObserver) con transición de `transform`.
- `visibility:hidden` sincronizada cuando está oculta (si no, sus enlaces atrapan el foco de teclado fuera de pantalla).
- `padding-bottom: env(safe-area-inset-bottom)` para iPhone.

## Checkout (Shopify por defecto)

- Todos los botones usan el permalink de carrito: `https://TIENDA/cart/VARIANT_ID:CANTIDAD` → añade y va directo al checkout.
- Cada botón lleva encima `<!-- CHECKOUT: sustituye VARIANT_ID -->`; con variantes, cada CTA apunta a la suya.
- La landing vive en una página (`/pages/...`), no en la ficha de producto.

## Prohibiciones

- **Cero urgencia fabricada**: sin countdowns falsos, sin escasez inventada, sin exit-intent. Queman la marca y pueden infringir normativa de consumo en la UE.
- **Cero datos inventados**: porcentajes, nº de reseñas y notas medias salen de la referencia real o van como placeholder ("dato por confirmar").
- **Cero testimonios de personas reales citadas textualmente**: nombres entre corchetes o reseñas genéricas de ejemplo, marcadas para sustituir.

## Checklist final

Verifica antes de entregar; corrige lo que falle:

1. ¿CTA cada ~2 pantallas, todos con precio?
2. ¿Microcopy de riesgo junto a cada CTA?
3. ¿Anclaje de precio completo (tachado + ahorro + coste/día si aplica)?
4. ¿Todos los enlaces de compra con permalink de checkout comentado?
5. ¿Cero urgencia fabricada y cero datos inventados?
6. ¿Todos los medios como placeholders VACÍOS (sin texto visible, descripción y snippet de sustitución en comentario HTML) con dimensiones por aspect-ratio o altura?
7. ¿Sticky bar móvil funcional y accesible?
8. ¿FAQ cubre las 5 objeciones básicas?
9. ¿Cabecera y footer sin fugas?
10. ¿Anclas con `scroll-padding-top`?
11. ¿Verificado a 320/375/414/768 sin scroll horizontal ni botones a dos líneas?
12. ¿HTML válido (tags balanceados, sin ids duplicados, sin enlaces `href="#"` muertos)?
