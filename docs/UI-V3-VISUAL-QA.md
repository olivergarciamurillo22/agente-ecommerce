# UI v3 — QA visual (02-09-2026)

**Método y límites, sin fingir:** en esta máquina no hay navegador
automatizable (Playwright no está instalado y su MCP no conectó), así que
esta pasada fue (a) **smoke funcional REAL** con `next dev` — los 14
endpoints del panel respondieron 200 con datos reales y los contratos
nuevos verificados a mano — y (b) **QA de código** contra la checklist
§4.1-4.9, con arreglos aplicados. **Todo lo que exige VER píxeles queda
NEEDS REAL REVIEW** — la pasada con navegador en 1440/1280/1024/768/390
sigue pendiente y es el primer paso cuando haya browser (o con Pedro
delante).

| Ancho | Estado |
|---|---|
| 1440 / 1280 / 1024 / 768 / 390 | **NEEDS REAL REVIEW** (sin navegador en esta sesión) |

---

## Smoke funcional (server real, datos reales) — PASS

`/api/home · orders · finance (+preset) · ads (+days) · shipments ·
integrations · agent · cod-calculator · action-center · system · beeping ·
connection/status · calls` → **14/14 HTTP 200**. Verificado en payload:
`automation.whatsapp {ready:false, mode:pilot, blocker plantilla}` ·
`automation.calls {blocker RETELL_AGENT_VERSION}` · `connection.provider`
correcto · `campaignEconomics` con cobertura 0% DECLARADA y cubo «Sin
atribución» (los pedidos locales no traen UTM: correcto) · `codModel` con
su missingReason honesto.

## Por pantalla (QA de código)

**4.1 Navigation rail — PASS (código) / NEEDS REAL REVIEW (píxeles).**
Labels visibles por defecto, 224px, iconos 19-20px, fila h-10, colapsable
con preferencia, marca arriba, Ajustes + salud abajo, activo con acento
lateral + fondo. **FIXED en esta pasada:** el badge del modo colapsado
usaba `absolute` sin `relative` en el botón (se anclaba al contenedor).

**4.2 Logo — PASS.** "Tu Agente" y la estrella genérica no existen; test
de aceptación lo vigila. Wordmark Casamable + CONTROL CENTER; slot
documentado para `public/brand/casamable.svg`.

**4.3 Home — PASS (código).** Responde las 4 preguntas en orden: saludo +
resumen (qué ha pasado), HOY (cifras), Requiere tu atención, Rentabilidad
(ganando/perdiendo), Estado del negocio (¿funciona?).

**4.4 Pedidos — PASS (código).** Búsqueda, chips, estados del §21
distinguibles por badge con punto de color, drawer lateral con CTA fijo.
Densidad/di stancias: NEEDS REAL REVIEW.

**4.5 Chats — PASS (código).** 3 columnas, búsqueda, énfasis <1 h,
contexto de pedido agrupado, drill-down móvil. Scroll: NEEDS REAL REVIEW.

**4.6 Agente — PASS.** Lucía primero (estado/Retell/prompt/versión/
llamadas hoy), luego trabajo pendiente, luego últimas llamadas.

**4.7 Finanzas — PASS (código).** Sub-pestañas Resumen/Calculadora/Costes;
profit y margen dominan los KPIs; nueva tabla por campaña con cobertura
declarada en Anuncios.

**4.8 Ajustes — PASS.** Mini-nav General/WhatsApp/Llamadas/Integraciones/
Costes/Sistema; salud en palabras (Operativo/Con avisos/Error/Sin
configurar) con detalles técnicos plegados; banners READY/BLOCKED.

**4.9 Mobile — PASS (código).** 5 entradas icono+label + sheet "Más";
targets 56px. Comportamiento táctil real: NEEDS REAL REVIEW.

## Accesibilidad (§8) — FIXED parcial

- **FIXED:** `ModalShell` cierra con Escape (todos los modales lo heredan).
- **FIXED:** ActionCenter ya no usa `window.prompt` — modal propio con
  autofocus y Enter. Era el último diálogo nativo del panel.
- PASS: focus-visible rings en primitivas; aria-label en botones de icono
  del rail/paleta; contraste muted-sobre-surface ≈ 5,9:1.
- NEEDS REAL REVIEW: focus trap completo en drawer/modales (hoy Escape +
  backdrop; el ciclo de tabulación no está confinado) y navegación
  completa por teclado pantalla a pantalla.

## Performance (§7) — sin refactor

Los tres grandes (SystemPanel 1.4k, OrdersPanel ~1k, CodCalculatorPanel)
funcionan con polling acotado y cálculo client-side barato; dividirlos hoy
no mejora rendering medible y sí añade riesgo en la rama que Pedro está
validando. Anotado como candidato post-piloto, no hecho — a propósito.
