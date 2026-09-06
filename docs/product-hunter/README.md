# Winner Radar

Busca **productos**, no anuncios. Un ganador se manifiesta como 50 anuncios de
8 marcas: mirar anuncios sueltos es mirar el humo en vez del fuego. La entidad
principal es `ProductOpportunity`.

Es **lo que abre el Cazador**. El pipeline de decisión heredado
(`src/lib/product-hunter/`) sigue donde estaba, en «Mis candidatos», y solo
aparece si tiene backend configurado.

## Cómo funciona, de una punta a otra

1. **Escribes** lo que buscas en lenguaje normal. Debajo aparece una FRASE con
   lo que se va a buscar —construida con código, no con IA— y unos chips
   editables. Los filtros completos existen detrás de «Ajustar búsqueda» y se
   pueden ignorar enteros.
2. **Pulsas buscar** y ves trabajar al sistema: seis etapas con nombre,
   contadores reales y tiempo restante. Se puede minimizar; la búsqueda vive
   en el servidor y no se cancela al cambiar de pantalla.
3. **Recibes un informe**: qué haría hoy, el podio, el resto, y qué no cuadra.
   Cada producto lleva un verbo (TESTEAR · VIGILAR · DESCARTAR) antes que un
   número, y el número se puede abrir para ver de dónde sale.

## De dónde salen los datos

**Biblioteca de Anuncios de Meta**, que es gratuita y son los anuncios reales
de las marcas con su fecha de arranque. WinningHunter sigue soportado pero es
**opcional** y está apagado por defecto: depender de un agregador de pago
significa que el día que cambia de precio o cierra, el radar deja de existir.
Se elige con `WINNER_RADAR_PROVIDER` (`meta` · `wh` · `all`).

La **trampa que hay que conocer**: `ad_type=ALL` solo devuelve anuncios
COMERCIALES en la UE y Reino Unido —lo obliga la DSA—. En cualquier otro país
la misma llamada responde 200 con anuncios POLÍTICOS, sin error y sin aviso.
El radar bloquea esas consultas a propósito. Es la misma clase de trampa que
`read_all_orders` en Shopify.

## Documentos

| Documento | Qué es |
|---|---|
| [PEDRO-API-KEYS.md](PEDRO-API-KEYS.md) | **Qué credenciales pedir.** Empieza por aquí |
| [PROVIDERS.md](PROVIDERS.md) | Fuentes, documentación verificada y lo que no lo está |
| [SCORING.md](SCORING.md) | Cómo se puntúa y por qué cada peso |
| [DATA-SOURCES.md](DATA-SOURCES.md) | Qué campo sale de dónde |
| [SETUP.md](SETUP.md) | Puesta en marcha |
| [OPERATIONS.md](OPERATIONS.md) | Día a día, créditos y mantenimiento |

## Lo que este módulo promete no hacer

- **No llama "ganador" a nada como hecho cierto.** Cada métrica lleva su
  origen: observado, estimado por terceros, dato propio, inferido por IA o
  calculado.
- **No inventa un número cuando no lo sabe.** `null` y un motivo, nunca 0.
- **No muestra ventas ni ROAS de competidores como hechos.** Cuando un
  proveedor los estima, se dice que los estima.
- **No manda datos de clientes a ningún modelo.** Un cortafuegos lanza antes
  de enviar si detecta un teléfono, un correo o una dirección.
- **No escribe en ningún proveedor.** Solo lee.
- **No enseña datos de ejemplo en producción.** Si falta una fuente, lo dice.

## Comandos

```bash
npm run hunter:doctor           # ¿está listo? qué falta
npm run hunter:providers:test   # prueba real y mínima de cada fuente
```
