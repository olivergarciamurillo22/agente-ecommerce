# Beeping — integración (01-09-2026)

Implementada contra el **contrato público** documentado en
`docs/BEEPING-API-CONTRACT.md`. **Nada verificado todavía contra la API
real**: Casamable aún no tiene credencial cargada. Todo lo que sigue
funciona en local con fixtures y queda fail-closed hasta el piloto.

---

## 1 · La estrategia: OBSERVA · CONFIRMA · LIBERA · RECONCILIA

Casamable **NO crea pedidos en Beeping**. Los crea la app oficial de
Beeping para Shopify, configurada en modo **"None / Manual order
marking"**, que los deja retenidos en **status 6 (To be confirmed)**.

```
Shopify → app de Beeping → pedido importado (status 6, RETENIDO)
                                    ↓
                     Casamable confirma con el cliente (WhatsApp)
                                    ↓
                     Pedro pulsa "Enviar a Beeping"
                                    ↓
                     PUT /api/order/mark-to-send/{external_id}
                                    ↓
                     Beeping prepara → envía → tracking
                                    ↓
                     Casamable reconcilia (polling read-only)
```

**Por qué no `POST /api/order/`:** con la app de Shopify instalada,
crear el pedido por API lo **duplicaría**. La función no existe en
`src/lib/beeping/client.ts` — no está "desactivada", no está escrita.
Es la misma decisión que con `createOrder` de Dropea, aplicada antes de
que pueda morder.

**El valor operativo:** un pedido no confirmado nunca llega a picking, así
que no se incurre en el coste de preparación ni en los ~9,37 € de un
rehusado. La confirmación por WhatsApp deja de ser un filtro y pasa a ser
una puerta física en el almacén.

---

## 2 · Los dos estados que NUNCA se confunden

| | Columna | Significado |
|---|---|---|
| **Confirmado por el cliente** | `orders.status = 'confirmed'` | El cliente dijo que sí por WhatsApp o llamada |
| **Liberado a Beeping** | `orders.beeping_sync_status = 'released'` | Pedro autorizó el paso a preparación |

El panel lo dice literalmente: *"Confirmado · Pendiente de enviar a
Beeping"*. Son dos decisiones distintas y el modo acordado hoy es
**LIBERACIÓN MANUAL**.

### Máquina de liberación (`src/lib/beeping/repo.ts`)

```
not_released ──claim──▶ releasing ──ok──────▶ released       (terminal)
     ▲                      │
     │                      ├──error────────▶ release_failed ──claim──▶ …
     └──resolver────────────┴──timeout──────▶ release_unknown
```

- El **claim es un UPDATE condicional**: de dos dobles clics simultáneos,
  exactamente uno gana.
- `release_unknown` (Beeping no respondió) **jamás se reintenta a ciegas**:
  se resuelve consultando `get_orders` por `external_id`. Si salió de 6, la
  escritura llegó; si sigue en 6, no llegó.
- Toda transición queda en `order_status_history` con eje propio
  (`status_axis = 'beeping_release'`), actor y motivo.

---

## 3 · El gate de liberación (14 condiciones)

`evaluateLocalReleaseGate` + `evaluateRemoteReleaseGate` en
`src/lib/beeping/release.ts`. Si falla una, no se envía nada y Pedro ve
**exactamente cuál** en la ficha:

1. Pedido confirmado por el cliente
2. Sin solicitud de cancelación pendiente
3. No cancelado en Shopify
4. No cerrado (delivered/refused)
5. Sin duplicado sin resolver
6. Dirección completa (calle + localidad válida + CP)
7. Teléfono presente
8. Al menos una línea de producto físico legible
9. Todas las líneas físicas con SKU
10. `BEEPING_ENABLED=1`
11. `BEEPING_WRITE_ENABLED=1`
12. `EMERGENCY_STOP=0`
13. El pedido existe en Beeping
14. Su status remoto es **6** (o ya liberado → se adopta idempotente)

**Sobre el SKU (condición 9):** fail-closed a propósito. La documentación
de Beeping no aclara con qué identificador resuelve el producto
(`sga_product_id` / `sku` / `barcode`) — está en las preguntas abiertas.
Liberar una línea sin SKU podría preparar el producto equivocado.

---

## 4 · Mapeo de estados (`mapper.ts`)

El **estado logístico manda** sobre el del pedido cuando existe (>1),
igual que el `sub_status` de Dropea.

| Beeping | Nuestro eje logístico | Cierre | Revisión |
|---|---|---|---|
| 0 Cancelled / stage 7 | `cancelled` | `cancelled` | — |
| 1 Pending | `created` | `in_progress` | — |
| 2 Pending Stock | `processing` | `in_progress` | **sí** |
| 3 In Preparation | `processing` | `in_progress` | — |
| 4 Shipped | `shipped` | `in_progress` | — |
| 5 Returned / stage 6 | `returned` | **ninguno** | **sí** |
| 6 To be confirmed | `unknown` | ninguno | — |
| stage 2 In Transit | `in_transit` | `in_progress` | — |
| stage 3 Out for Delivery | `out_for_delivery` | `in_progress` | — |
| stage 4 Pickup Point | `at_pickup_point` | `in_progress` | — |
| stage 5 Delivered | `delivered` | **`delivered`** | — |
| stage 8 Damaged | `incident` | ninguno | **sí** |

**Decisiones deliberadas, no "pendientes de pulir":**

- **Returned ≠ refused.** Un paquete que vuelve puede ser un rehúse del
  cliente (cuesta ~9,37 €) o un problema logístico. El eje de cierre
  **no se estampa solo**: va a revisión humana. Se mantiene la distinción
  `returned` / `refused` / `lost` / `damaged`.
- **Damaged** nunca genera un mensaje al cliente: incidencia + revisión.
- Solo `delivered` y `cancelled` escriben el cierre automáticamente.
- El `raw` **nunca se pierde**: `supplier_status_raw` guarda
  `"shipped/in_transit"` tal cual.

---

## 5 · Reconciliación (polling, sin webhooks)

Beeping **no documenta webhooks**. `src/lib/beeping/sync.ts` hace polling
incremental con `from_date` sobre `date_tracking_update`:

- Checkpoint en `settings.beeping_sync_checkpoint` con **margen de 2 días**
  (relojes y actualizaciones tardías). Reanudable.
- `closure_at` **siempre** con la fecha de la fuente. Si la fecha no es
  legible, **no se estampa el cierre** y queda un evento de aviso: mejor un
  hueco visible que una métrica de tiempos corrompida.
- Los pedidos enrutados a Dropea/Dropi **no se tocan**: dos fuentes
  escribiendo el mismo eje logístico es exactamente el lío que evitamos.
- Mientras `BEEPING_NOTIFICATIONS_ENABLED=0`, la sync **no encola ningún
  WhatsApp** (`suppressNotifications`), capa extra sobre los safety gates.
- Scheduler propio con lease (`src/lib/beeping/scheduler.ts`), cada 10 min.

---

## 6 · Cancelación y edición

**Cancelar** (`cancel.ts`): siempre decisión humana. El cliente pidiendo
cancelar genera un elemento en Acciones; Pedro decide. Antes de escribir
se consulta el estado remoto y solo se permite en 1, 2 o 6. El botón se
llama *"Gestionar cancelación"*, no es un botón rojo que cancele solo.

**Editar dirección** (`canUpdateBeepingOrder`): la doc dice que
`PUT /api/order/{external_id}` solo admite estados 1 y 2. Hay una
inconsistencia aparente con el flujo de 6. **No se adivina**: en estado 6
devuelve `needs_manual_validation` y se corrige a mano en el panel de
Beeping hasta confirmar el contrato.

---

## 7 · Nota de expedición: INTERNA

`orders.dispatch_note`. La API pública de Beeping **no documenta ningún
campo de notas**. Hasta que respondan:

- Se guarda y se muestra en la ficha con la etiqueta literal
  **"Nota interna — todavía no se envía a Beeping"**.
- Editable hasta liberar; congelada después.
- `mapDispatchNote()` existe como adapter y devuelve `unsupported` con su
  motivo. Cuando Beeping confirme campo y semántica, solo hay que
  rellenar esa función.

---

## 8 · Hora de corte

Lunes **14:00**, martes a viernes **15:30** (Europe/Madrid). Fin de semana
sin preparación. Se pinta en la Home, en Envíos y en la ficha
(*"Sale hoy · quedan 42 min para el corte"*). Es un **indicador para
Pedro**, no una promesa al cliente: ningún mensaje automático compromete
fechas con esto.

---

## 9 · Credencial y comandos

```bash
npm run beeping:auth:init   # pide email+contraseña EN LOCAL, sin eco
npm run beeping:doctor      # solo lectura: credencial, tiendas, pedidos, corte
npm run beeping:sync        # DRY-RUN: qué haría la reconciliación
```

`BEEPING_BASIC_AUTH` es la credencial Basic **ya codificada**. Base64 **no
es cifrado**: ese valor equivale a la contraseña de la cuenta de Beeping.
Nunca en logs, ni en la UI, ni en un error, ni en un test, ni en git. El
doctor solo dice *"configurada"* / *"falta"*.

**La tienda no se configura**: `get_shops` la autodetecta si solo hay una y
la cachea en `settings`. Con varias, selector en Ajustes. Nunca se adivina.

---

## 10 · Preguntas abiertas para Beeping

1. ¿`PUT /api/order/{external_id}` admite `status = 6` (To be confirmed)?
2. ¿Existe campo de **nota / instrucciones de entrega** en el pedido?
3. ¿Hay **webhooks** de cambio de estado o de tracking?
4. ¿Hay API de **incidencias**?
5. ¿Hay API de **wallet / facturación** del COD cobrado?
6. ¿Hay **tienda de pruebas / sandbox**?

Adicionales del contrato (ya en `BEEPING-API-CONTRACT.md` §7): qué
`payment_method_id` es contrareembolso, y con qué identificador resuelven
el producto en `lines[]`.
