# Modelo financiero de Casamable (01-09-2026)

Tres piezas que **no se pisan**:

| | Pregunta que responde | Dónde vive |
|---|---|---|
| **Finanzas** | ¿Qué ocurrió *realmente*? | `src/lib/system/finance.ts` |
| **Calculadora COD** | ¿Qué ocurriría *si…*? | `src/lib/cod-calculator/` |
| **Costes** | ¿Cuánto cuesta cada cosa, y desde cuándo? | `product_costs` + `product_cost_history` |

---

## 1 · La regla contable (se mantiene)

El cobro contrareembolso **depende de que se entregue**:

- **Ingreso** → solo pedidos con `closure_status = 'delivered'`. Dato
  REAL, contado uno a uno. **Nunca una tasa supuesta cuando hay dato.**
- **Coste de producto, envío y manipulación** → se asumen al **ENVIAR**,
  se entregue o no.
- **Comisión COD** → solo sobre lo entregado.

De ahí que **ROAS bruto y ROAS neto sean cosas distintas** y se enseñen
las dos:

```
ROAS bruto = facturación de pedidos ENVIADOS  / gasto en ads
ROAS neto  = facturación de pedidos ENTREGADOS / gasto en ads
```

`estimatedMargin = deliveredRevenue − producto − envío − manipulación − COD − ads`

Si falta cualquier componente, el margen es `null` y la pantalla dice
**qué falta**, con nombre y apellidos ("coste de producto del SKU 10428").
Un fallo nunca devuelve 0 €: un mes a cero y un mes sin datos no se pintan
igual.

---

## 2 · Costes versionados

`product_costs` es la foto **vigente**. Cada cambio cierra la fila abierta
en `product_cost_history` (`effective_to`) y abre otra. **Una fila
histórica nunca se sobrescribe** — es lo que permite un P&L por periodos
cuando los costes cambian a mitad de mes.

Campos: `product_cost`, `shipping_cost`, `cod_fee`, `handling_cost`
(manipulación del fulfillment, p.ej. Beeping; opcional, cuenta 0 si no
está configurada y **no** marca la ventana incompleta).

---

## 3 · Gasto en publicidad: dos fuentes, sin duplicar

`daily_ad_spend(day, amount, source)`:

- `source = 'meta_api'` — lo vuelca la sync de Meta Ads (nivel cuenta).
- `source = 'manual'` — lo escribe Pedro desde Finanzas.

**El dato de la API sustituye al manual del mismo día** (mismo `day`,
UPSERT). Finanzas enseña el desglose: *"12 días Meta · 3 manual · 2 sin
dato"*. Sin Meta conectado, Finanzas **sigue funcionando**.

---

## 4 · La Calculadora COD: DOS modelos separados

Implementaciones distintas, ficheros distintos, tests distintos. **No un
cálculo lleno de condicionales.**

### Modelo Pedro — `pedro-model.ts`

Réplica **exacta** del Excel. Existe para continuidad y para que Pedro
reconozca sus números.

```
vat                  = productCost × vatRate
realCPA              = rawCPA / (shippingRate × deliveryRate)
expectedShippingCost = outboundShipping + codFee×deliveryRate + (1−deliveryRate)×returnCost
profit               = (salePrice − productCost − vat − realCPA − expectedShippingCost) × deliveryRate
margin               = profit / salePrice
roi                  = profit / productCost
afterIrpf            = profit × 0,8
```

Fixture de paridad (PELUCHE, test `cod-calculator-excel-parity`):
39,99 € / 6,50 € / CPA 5 € / envío 90% / entrega 70% / 5,50 / 0,70 / 4,50
→ CPA real **7,94 €** · gastos envío **7,34 €** · profit **12,75 €** ·
margen **31,88%** · ROI **196,15%** · sin IRPF **10,20 €**.

**Rarezas conservadas a propósito** (marcadas, no corregidas en silencio):

1. El IVA se aplica **al coste del producto**, no al precio.
2. `realCPA` ya divide por `envío × entrega` y el profit **vuelve a
   multiplicar** por `entrega`. Puede haber doble aplicación de
   probabilidades según qué represente "profit". Es la razón de que exista
   el Modelo Real.
3. "SIN IRPF" es `profit × 0,8`. En la UI se llama **"Tras ajuste 20%
   (Excel original)"** con la nota *"Replica el cálculo original. No
   constituye cálculo fiscal."*

Donde el Excel daría `#DIV/0!`, el código devuelve `null` y la web pinta
`—`. **Nunca NaN ni Infinity.**

### Modelo Real — `real-model.ts`

Unit economics **por evento**, sin doble probabilidad. Escenario base de
**100 pedidos creados**:

```
100 creados → 90 enviados (90%) → 63 entregados (70%)   ·   27 no entregados

Ingresos    = 63 × precio            (COD: solo se cobra al entregar)
Ads         = 100 × CPA              (por pedido RECIBIDO)
Producto    = 90 × coste − recuperado en devoluciones
Envío ida   = 90 × coste de envío
COD         = 63 × comisión
Devoluciones= 27 × coste de devolución
Otros       = 100 × otros costes
─────────────────────────────────────────
Beneficio por 100 → /100 creado · /90 enviado · /63 entregado
```

- La **recuperación del producto devuelto es explícita**: 0% por defecto
  (pérdida completa). No se asume que el producto vuelve utilizable.
- **Fiscalidad**: el Modelo Real **no aplica IVA ni IRPF**. Declara
  *"Modelo fiscal pendiente de configurar: cifras antes de impuestos."*
  Introducir fiscalidad española real exige una especificación contable
  que todavía no tenemos.

### Los dos modelos dan cifras distintas

Con el fixture PELUCHE ambos son positivos, pero difieren. **No es que uno
esté roto**: es la diferencia de semántica descrita arriba. Hay un test
que lo afirma explícitamente.

---

## 5 · Break-even: resuelto, no despejado a mano

Un único solucionador por **bisección** (`break-even.ts`) busca el valor
que hace `profit = 0` (o `margen = objetivo`) sobre el **modelo real que
esté activo**. Ventajas: cambiar una fórmula no deja un despeje obsoleto,
y los tests verifican sustituyendo (el break-even devuelto da profit ≈ 0).

Devuelve: entrega de equilibrio, CPA máximo, precio mínimo, coste de
producto máximo, y entrega/CPA para el margen objetivo. **Si no existe
solución en el rango, `null`** — nunca una cifra inventada.

**El 62,9% no está hardcodeado en ninguna parte.** La alerta §36 compara la
entrega real contra el break-even *calculado con los costes actuales*:
WARNING por debajo de break-even + 5 puntos, CRITICAL en o bajo el
break-even, y `unknown` con muestra insuficiente (3 pedidos no deciden si
escalar o parar anuncios).

---

## 6 · Qué del Excel ya sale del sistema

| Dato del Excel | Estado hoy |
|---|---|
| % ENTREGA | **AUTOMÁTICO YA** — eje de cierre, 30 d, con denominador visible |
| % ENVÍO | **AUTOMÁTICO YA** — enviados / creados elegibles, 30 d |
| CPA/R | **AUTOMÁTICO YA** (Meta Ads conectado y verificado) — gasto / pedidos |
| P. VENTA | **AUTOMÁTICO YA** — del pedido más reciente con ese SKU |
| COSTE PRODUCTO | **AUTOMÁTICO YA** si está en `product_costs` |
| Tasa de entrega por producto / courier | **AUTOMÁTICO YA** (Finanzas) |
| ENVÍO, COD, DEVOLUCIÓN | **MANUAL** (settings) → automáticos cuando Beeping exponga costes reales |
| Cobro COD real (conciliación) | **MANUAL** — Beeping no documenta API de wallet; fase 2 = importador CSV/XLSX |
| IVA / IRPF | **MANUAL y sin modelo fiscal** — pendiente de especificación contable |

---

## 7 · Wallet de Beeping (fase 2)

Beeping gestiona el cobro del COD (reembolsos tras entrega, reflejo típico
24-48 h, movimientos exportables a Excel), pero **no hay API de wallet
documentada** en la categoría pública que tenemos.

- **Fase 1 (hoy):** el resultado sale de la entrega REAL + contabilidad
  interna.
- **Fase 2:** importador CSV/XLSX de movimientos con validación, vista
  previa y deduplicación. **Nunca scraping del panel.**
