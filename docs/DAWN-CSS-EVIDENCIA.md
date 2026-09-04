# Evidencia CSS de Dawn

Auditoría sobre Shopify Dawn 15.5.0, commit `83d5e6b`, archivo
[`assets/base.css`](https://github.com/Shopify/dawn/blob/83d5e6b/assets/base.css).

| Selector exacto | Especificidad | Colisión posible |
|---|---:|---|
| `h1, h2, h3, h4, h5, .h0, .h1, .h2, .h3, .h4, .h5` | 0-0-1 / 0-1-0 | familia, peso, color y línea (252–270) |
| `h2, .h2` | 0-0-1 / 0-1-0 | tamaño (308–317) |
| `.link, .customer a` | 0-1-0 / 0-1-1 | color, fuente y decoración (477–489) |
| `summary` | 0-0-1 | cursor, lista y posición (637–641) |
| `details > *` | 0-0-2 | `box-sizing` (551–553) |
| `.hidden` | 0-1-0 | `display:none !important` (198–200) |
| `.visually-hidden` | 0-1-0 | posición y `word-wrap !important` (202–212) |
| `.focus-none` | 0-1-0 | outline y shadow `!important` (734–737) |
| `.small-hide`, `.medium-hide`, `.large-up-hide` | 0-1-0 | `display:none !important` (425–439) |
| `.motion-reduce` | 0-1-0 | animación `!important` (562–566) |

No hay selectores de ID en `base.css`. Las reglas importantes son utilidades
que el conversor no emite. Por ello cada selector generado empieza por
`#shopify-section-{{ section.id }}` (especificidad mínima 1-0-0), se elimina la
regla escudo y no se necesita `!important`. Una excepción futura deberá citar
`DAWN: <selector>` en la misma línea y aportar un fixture reproducible.

Los estilos inline ganarían a una hoja normal, pero Dawn no los añade a los
elementos generados. Una app que los inyecte se tratará como otra integración.
