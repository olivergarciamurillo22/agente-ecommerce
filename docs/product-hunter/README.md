# AI Winner Radar

Busca **productos**, no anuncios. Un ganador se manifiesta como 50 anuncios de
8 marcas: mirar anuncios sueltos es mirar el humo en vez del fuego. La entidad
principal es `ProductOpportunity`.

Vive **dentro** del Cazador (pestaña "AI Winner Radar"), no como módulo
aparte: el pipeline de decisión de Pedro sigue donde estaba y esto lo alimenta.

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
