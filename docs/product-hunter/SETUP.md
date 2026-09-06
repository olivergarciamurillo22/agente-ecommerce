# Puesta en marcha del AI Winner Radar

## 1 · Sin ninguna clave (desarrollo)

```bash
HUNTER_FIXTURE_MODE=1 npm run dev:all
```

Datos de ejemplo, con un cartel visible. **En producción esto se ignora**: si
falta una fuente se dice que falta, nunca se rellena con inventos.

## 2 · Con WinningHunter

Añadir `WINNINGHUNTER_API_KEY` al `.env` y comprobar:

```bash
npm run hunter:doctor
npm run hunter:providers:test
```

El segundo enseña **qué campos ha entendido** de la respuesta real. Si salen
todos a `null`, los nombres reales no coinciden con los candidatos y hay que
ajustar el mapeo en `src/lib/hunter/providers/` **antes** de fiarse de una
búsqueda. Hasta ese momento las capacidades quedan como `UNVERIFIED`.

## 3 · Esquema

La migración 19 es aditiva: 12 tablas `hunter_*` nuevas, ni una columna tocada
de `orders`, `conversations` o `messages`. Un rollback de código las ignora.

## 4 · Variables

Todas en `.env.example` y en `src/lib/config/env-schema.ts`. Detalle de qué
pedir a quién: [PEDRO-API-KEYS.md](PEDRO-API-KEYS.md).
