# Sistema de diseño v4.1 — dirección de arte del Control Center

**Estado:** implementado en `feat/control-center-v4-apple-redesign` (02-09-2026). Sin desplegar.
**Galería viva:** `/design-system` (solo con `NODE_ENV !== production`; en producción responde 404).

## Intención

Herramienta profesional para gestionar dinero, pedidos y clientes reales:
precisa, silenciosa, densa donde hace falta y diseñada deliberadamente.
Referencias conceptuales (no copiadas): Apple Business Manager, Stripe
Dashboard, Linear. Lo que NO es: un dashboard genérico de píldoras.

## Tokens (`src/app/globals.css`, `@theme`)

| Token | Valor | Uso |
|---|---|---|
| `brand-bg` | `#f5f5f7` | fondo de app |
| `brand-surface` / `brand-surface-subtle` / `brand-surface-2` | `#fff` / `#fafafa` / `#f4f4f6` | superficies, cabeceras de tabla, hover |
| `brand-border` / `brand-border-strong` | `#e3e3e7` / `#d3d3d8` | hairlines, foco de inputs |
| `brand-text` / `brand-muted` / `brand-tertiary` | `#18181b` / `#65656d` / `#92929b` | tres niveles de texto |
| `brand-gold` (legado) | `#1d1d1f` | **selección y acción principal = carbón** |
| `brand-accent` | `#d5aa14` | dorado de marca: logotipo y detalles mínimos |
| `emerald/amber/red/sky-500…700` | `#248a3d` / `#b66a00` / `#d92d20` / `#1769e0` | semánticos, SOLO cuando comunican un estado real |

El nombre `brand-gold` se conserva por compatibilidad con ~30 componentes:
hoy significa "acción principal", no un color. El morado no existe
(`violet-*` está remapeado a gris para que ningún resto lo resucite).

Radios: contenedores 12 px (`rounded-2xl`), controles 8–10 px
(`rounded-lg`/`rounded-xl`), filas 0–8 px. `rounded-full` queda reservado a
badges de estado, puntos de estado y avatares.

Tipografía: stack de sistema (`-apple-system, BlinkMacSystemFont, "SF Pro
Display", "SF Pro Text", Inter, "Segoe UI"`). Título de página 26/30 px · 600;
métrica 26 px · 600 tabular; encabezado de sección 13 px · 500 (secundario);
navegación 14 · 500; operativo 14; secundario 13; label 12 · 500.

## Primitivas (`src/components/ui.tsx`)

- `PageHeader` — título + contexto + acción principal, una sola jerarquía.
- `TabBar` — pestañas con indicador inferior. **Distintas de los filtros.**
- `Chip` — filtro compacto: texto + contador, activo carbón/blanco. No es píldora.
- `Toolbar`, `SearchInput`, `SelectInput`, `INPUT_CLASS` — controles de 36 px, radio 8.
- `MetricGroup` + `MetricCell` — resumen operativo en UNA superficie con divisores (máx. 4–5).
- `Badge` — la única píldora: estado breve con punto.
- `PrimaryButton` (carbón) · `GhostButton` · `TextButton`.
- `Drawer` — detalle lateral: cabecera fija, cuerpo con scroll, pie de acciones, Escape cierra.
- `EmptyState` · `ErrorState` · `Skeleton` · `ModalShell` (bottom sheet en móvil).

## Shell

- **Sidebar** 240 px: marca (emblema + Casamable / Control Center), activo en
  carbón con texto blanco, contadores neutros (el rojo se reserva a errores).
- **Cabecera** 60 px: buscador global a la izquierda (⌘K), estado del canal
  como indicador compacto a la derecha. Sin breadcrumb repetido.
- **Barra de entorno** 36 px (`SafetyBanner.tsx`): "Entorno de prueba ·
  Envíos desactivados · N teléfonos autorizados" + "Ver estado" (popover con
  ventana horaria, envíos, escrituras Shopify, parada de emergencia,
  allowlist). En producción real la barra pasa a rojo suave.
- **Móvil**: barra inferior de 4 áreas + "Más"; filtros en bottom sheet;
  tarjetas operativas de 12 px.

## Seguimiento (patrón de referencia para listas operativas)

Cabecera → resumen (4 métricas, clicables como filtro) → toolbar (búsqueda,
antigüedad, orden, Limpiar) → fila compacta de estados → lista ordenada por
urgencia con columnas `Pedido/cliente · Producto · Estado · Última actividad ·
Importe · Acción` (≥1280 px; por debajo, producto y actividad se pliegan bajo
el cliente) → drawer con línea temporal. La antigüedad se comunica como
frase ("Sin resolver · 12 días"), no con un punto rojo; la acción siguiente
es permanente si la fila es urgente y aparece al hover si no.

## Tests que lo protegen (`tests/run-tests.ts`, bloque V4/V4.1)

Tokens y radios, Chip sin píldora, TabBar/Badge/Drawer como primitivas,
barra de entorno sin morado y con popover, pestañas de Seguimiento, lista
con columnas + frase de antigüedad + sheet móvil, `/design-system` 404 en
producción, nav con selección carbón.
