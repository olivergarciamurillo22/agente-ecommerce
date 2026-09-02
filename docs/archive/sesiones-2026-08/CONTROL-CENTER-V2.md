> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

# Control Center v2 — informe (01-09-2026)

Rama: `feat/casamable-control-center-v2` · último commit `a978419` ·
**523 tests OK · typecheck limpio · build OK** · **NADA desplegado**.

---

## A · ESTADO BASE

**1. Rama base.** La auditoría encontró **dos linajes divergidos**:
`main` (v11, cierre operativo) y el linaje que corre en producción
(`hardening` → `hotfix/calls-pilot-switch` → `recover/nas-uncommitted-30-08`
→ `notify-delay-ultras-v2`). El NAS llevaba código **nunca commiteado**
(git no está instalado allí), rescatado el 01-09 desde un tarball.

**2. Divergencia.** 5 commits de producción fuera de main: MANUAL-ONLY de
llamadas (el scheduler ya no encola ni marca solo), 6 plantillas de Meta
aprobadas, aviso de retraso "Ultras", `start-outbox.ts`,
`requestConfirmedOrderCancellation`. Y 21 commits de main que producción
no tiene.

**3. Resolución: rama de INTEGRACIÓN, sin reset.** Merge explícito con 6
conflictos resueltos uno a uno (la llave de llamadas estaba implementada
dos veces; se conservó la de main, más completa). Se conservan **las dos
suites de tests**. Además se arregló el flaky conocido "E7 crash al
marcar", que anclaba `updated_at` al reloj real mientras el tick corre con
fecha fixture: caducaba solo con el paso del tiempo.

**4. Riesgos de deploy.** El despliegue de `main` al NAS **sigue
pendiente y es de Pedro**. Esta rama NO se ha desplegado, no toca Docker,
ni el NAS, ni clientes. Todo lo nuevo entra **fail-closed**: instalar el
código sin tocar el `.env` no cambia un solo comportamiento.

---

## B · BEEPING

**5-8. Cliente + auth + tienda + sync.** `src/lib/beeping/` contra el
contrato público. Basic Auth generada **en local** (`beeping:auth:init`,
sin eco, sin salir a la red). La tienda se **autodetecta** con
`get_shops`; con varias, selector en Ajustes. Reconciliación por polling
incremental con checkpoint reanudable.

**9-10. Estados y tracking.** Los dos catálogos documentados mapeados; el
logístico manda sobre el del pedido. `raw` nunca se pierde.

**11-13. mark-to-send, idempotencia, cancelación.** Gate de 14
condiciones con motivos en cristiano; claim atómico (doble clic = una
liberación); `release_unknown` que **jamás se reintenta a ciegas**.
Cancelar es siempre decisión humana, consultando estado antes.

**14-16. Dirección, nota, corte.** `canUpdateBeepingOrder` no adivina en
estado 6. `dispatch_note` es **interna** con etiqueta visible.
Corte L 14:00 / M-V 15:30 Madrid como indicador, nunca promesa.

**17-18. Doctor y madurez.** `beeping:doctor` y `beeping:sync` (dry-run).
**Piloto: NO listo** — falta credencial y una prueba real. Detalle
completo en `docs/BEEPING-INTEGRATION.md`.

---

## C · PRODUCTO / UI

**19. Navegación.** Dock de 9 secciones: vertical flotante en desktop,
inferior con targets táctiles en móvil, badges de atención, sección en el
hash de la URL.

**20-27.** Home como control room (HOY · REQUIERE TU ATENCIÓN · FLUJO ·
RENTABILIDAD), Acciones integrado, Pedidos v2 con estado unificado y
ficha de 4 bloques con CTA contextual, Chats como inbox con contexto de
pedido, Agente como copiloto determinista (qué pasa / qué falta / qué
recomiendo), Envíos con tabs y corte, Ajustes con 9 cards de
integraciones y prueba de conexión read-only. Todo con primitivas
compartidas (`ui.tsx`) y sin un solo `window.confirm/prompt/alert`.

---

## D · META ADS — **VERIFICADO CONTRA LA CUENTA REAL**

**28-33.** Cliente solo-GET (v26.0, verificada contra el changelog
oficial hoy), `ads_read` confirmado, cuenta `act_1365655995103103`
(Casamable-ads, EUR, Europe/Madrid). **30 días sincronizados**: 19 filas
de cuenta, 59 de campaña, 79 de adset, 162 de anuncio; 19 días con gasto
volcados a Finanzas. Sección Anuncios sin métricas de vanidad y con la
nota honesta de atribución temporal. Ver `docs/META-ADS-INTEGRATION.md`.

---

## E · FINANZAS

**34-42.** Regla contable intacta (ingreso solo de entregados REALES,
costes asumidos al enviar), ROAS bruto y neto separados, waterfall,
beneficio por día, tasa de entrega, rendimiento por producto y por
transportista, gasto manual como fallback, alertas económicas nuevas
(confirmado sin despachar >6 h, desviación de coste por entregado >15%,
y entrega contra break-even **calculado**). Wallet de Beeping: fase 2 por
importador CSV/XLSX, nunca scraping. Ver `docs/FINANCE-MODEL.md`.

---

## F · CALIDAD

| | Antes | Después |
|---|---|---|
| Tests | 493 (main) / 503 (producción) | **523, 0 fallos** |
| Typecheck | limpio | limpio |
| Build | OK | OK |
| Esquema | 11 | **15** (v12 Beeping · v13 Meta Ads · v14 histórico de costes · v15 escenarios) |

Migraciones aditivas e idempotentes, cada una en su función exportada.
Seguridad: ningún secreto en logs/UI/tests/docs/git; escrituras externas
con doble cerrojo (flag + EMERGENCY_STOP) comprobado también en la capa
HTTP; salvaguarda T6 ampliada al nuevo script de datos.

---

## G · CIERRE

**51-53.** 8 commits por dominio, último `a978419`, **empujado** a
`origin/feat/casamable-control-center-v2`. **Sin merge, sin deploy.**

**54. Qué falta de Beeping:** credencial real y respuesta a las 6
preguntas abiertas (editar en estado 6, campo de notas, webhooks,
incidencias, wallet, sandbox).

**55. Qué falta de Meta:** nada técnico. Las métricas de compra por
campaña seguirán sin darse hasta poder verificar su fiabilidad.

**56. Las líneas EXACTAS que faltan por rellenar** (en `.env.local` del
Mac y en el `.env` del NAS cuando toque):

```
BEEPING_BASIC_AUTH=        ← generar con: npm run beeping:auth:init
META_ADS_ACCESS_TOKEN=     ← YA PUESTO Y VERIFICADO en el Mac
META_ADS_ACCOUNT_ID=       ← YA PUESTO: 1365655995103103
```

Es decir: **queda UNA sola**, `BEEPING_BASIC_AUTH`. No hay cuarta
credencial. El bloque listo para pegar en el NAS está en
`ENV-NAS-PENDIENTE.local.txt` y en `.env.nas` (ambos fuera de git).

**57. Qué falta probar en el NAS:** nada de esta rama todavía. Antes va
el despliegue pendiente de `main` (`docs/PEDRO-DEPLOY-OPERACIONAL.md`).

**58. Qué NO debe desplegarse todavía:** esta rama. Es código local,
verificado en local, sin un solo efecto externo ejecutado salvo las
lecturas de Meta Ads.

**59. Bloqueadores reales:** (a) la credencial de Beeping; (b) las 6
preguntas de contrato; (c) el despliegue pendiente de `main` al NAS.

**60. Siguiente paso:** generar `BEEPING_BASIC_AUTH` y correr
`npm run beeping:doctor` — con eso se valida el contrato entero contra la
API real sin escribir nada.

---

## H · CALCULADORA COD

**61-63. Excel y paridad.** Fórmulas originales migradas literalmente y
verificadas: el fixture PELUCHE reproduce **exactamente** CPA real
7,94 € · gastos envío 7,34 € · profit 12,75 € · margen 31,88% · ROI
196,15% · sin IRPF 10,20 € (test `cod-calculator-excel-parity`).

**64-65. Dos modelos separados.** `calculatePedroModel` (réplica, con sus
rarezas anotadas: IVA sobre el coste, posible doble probabilidad, ×0,8) y
`calculateRealCODModel` (por evento, 100 creados → enviados → entregados,
recuperación de producto explícita, fiscalidad declarada pendiente).
Ficheros distintos, tests distintos, sin condicionales compartidos.

**66-69. Inputs y datos automáticos.** Básico/Avanzado, cada campo con su
origen y denominador; entrega y envío reales de 30 días, CPA de Meta,
productos de `product_costs`. Beeping mejorará las tasas cuando conecte,
pero **la calculadora nunca depende de él**.

**70-76. Accionables.** Break-even resuelto por bisección sobre el modelo
activo (verificado sustituyendo), objetivos de margen, matriz de
sensibilidad, simuladores, proyecciones con su advertencia, comparador de
productos, escenarios guardados que **no tocan ni un dato real**.

**77-80. Integración y calidad.** Alimenta la alerta de break-even de la
Home; Finanzas responde "qué pasó" y la calculadora "qué pasaría si";
móvil con inputs grandes y tablas con scroll propio; 19 tests nuevos,
incluidos los que garantizan que ni un NaN ni un Infinity llegan a la UI
(donde el Excel pinta `#DIV/0!`, la web pinta `—`).

### ¿Qué del Excel ya se sustituye por datos reales?

- **AUTOMÁTICO YA:** % entrega, % envío, CPA/R, precio de venta, coste de
  producto, y las tasas por producto y transportista.
- **CUANDO BEEPING CONECTE:** costes reales de envío/COD/devolución,
  tasas por courier de su propia red, y estados de entrega más finos.
- **CUANDO META ADS CONECTE:** ya está — CPA y gasto vienen de la API.
- **SIGUE SIENDO MANUAL:** IVA/IRPF (sin modelo fiscal especificado) y la
  conciliación del cobro COD (fase 2, importador de movimientos).
