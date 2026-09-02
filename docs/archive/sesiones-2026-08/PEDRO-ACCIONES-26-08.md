> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

# Pedro — acciones al 26-08-2026 (1 página)

## AHORA

1. **Retell: método de pago.** Sin él, las llamadas pararán en seco al
   agotarse el crédito de prueba. (El panel no puede ver tu saldo: lo dice
   como "comprobación manual".)
2. **BORRAR EL ENDPOINT PÚBLICO DE WEBHOOK.SITE.** Sigue vivo y es público.
   Entra en webhook.site y elimínalo. (Del repo ya no lo referencia nada.)
3. **Probar el prompt v6 ANTES en frío:** pégalo en un fichero y pasa
   `docker compose exec casamable-agent npm run calls:validate-prompt -- fichero.txt`
   — caza los marcadores rotos que hicieron fallar la v5. Luego una llamada
   de prueba: allowlist con tu móvil (ya está), kill switch ON desde el
   panel, pedido de prueba SIN contestar el WhatsApp → a los 15 min el
   orquestador programa la llamada. **No hay botón de llamar a propósito.**
4. **Reconciliación Shopify** (webhooks perdidos durante el bug del HMAC):
   `npm run shopify:backfill` (dry-run) → revisar desglose → `-- --apply`.
   Después `npm run orders:investigate-skipped-backfill` si algo no cuadra.
5. **Dropi:** `npm run dropi:diagnose` — te dice qué productos tienen el
   vendor mal (la causa del parón del 23-08) y qué variantes van sin SKU.
   Se corrige desde el panel de Dropi (Importar productos), nunca a mano.
6. **Backfill de `ordered_at`** (fecha real de compra):
   `npm run orders:backfill-ordered-at` (dry-run) → `-- --apply`.

## DESPUÉS (en este orden)

1. **Piloto Cloud API** — `docs/META-PILOT-CHECKLIST.md`, media hora. El
   primer mensaje sale como PLANTILLA (es lo esperado, no un fallo).
2. **Coexistence** — SOLO con el piloto limpio. Es el paso que puede tirar
   la sesión de Baileys.
3. **Vendors de Dropi de productos con anuncios pausados** — corregir con
   calma los que diga el diagnóstico.

## NO TOCAR

- **Coexistence antes del piloto** (te puede dejar sin canal).
- **Productos de Dropi con tráfico activo** (el vínculo no se ve desde
  Shopify: no "arreglar" lo que parece mal sin un pedido de prueba).
- **`auth/` de Baileys** (es el rollback).
- **`CALLS_ALLOWLIST`**: ya no hace falta miedo — con TEST_MODE=1, vacía
  ahora BLOQUEA a todos (fail-closed nuevo). Pero mantén tu móvil en ella.
- Cualquier escritura a proveedores que no exista ya.
