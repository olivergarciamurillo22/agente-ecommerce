# Meta Ads — integración READ-ONLY (01-09-2026)

**Verificada contra la cuenta real el 01-09-2026.**

---

## 1 · Alcance: solo Insights

`src/lib/meta-ads/` **no contiene una sola función de escritura**. No
gestiona campañas, no cambia presupuestos, no crea anuncios. Solo `GET`
sobre `/insights`, `/act_<id>` y `/me/permissions`.

El token es **independiente del de WhatsApp Cloud API**: aquel no tiene
por qué llevar `ads_read`, y mezclarlos hace que rotar uno rompa el otro.

---

## 2 · Versión de la API

**v26.0**, verificada contra el changelog oficial de Meta el 01-09-2026
(publicada el 29-07-2026; v25.0 salió en febrero). Centralizada en
`META_ADS_DEFAULT_API_VERSION` (`src/lib/meta-ads/config.ts`) y
sobreescribible con `META_ADS_API_VERSION`.

El doctor y la card de Ajustes **avisan si la versión configurada va por
detrás** de la vigente conocida, para no descubrir un sunset por sorpresa.

---

## 3 · Estado verificado hoy

```
Cuenta        act_1365655995103103 — "Casamable-ads"
Divisa        EUR
Huso          Europe/Madrid   (coincide con el día de negocio)
Permiso       ads_read concedido
Insights      OK — 30 días sincronizados, 19 con gasto
```

Sincronizado a los cuatro niveles: **19 filas de cuenta, 59 de campaña,
79 de adset, 162 de anuncio**.

---

## 4 · Qué se guarda

`meta_ads_daily(day, level, entity_id, …)` — snapshots diarios por
(día, nivel, entidad) con `spend, impressions, reach, clicks, ctr, cpc,
cpm, actions_json, currency`.

- `time_increment=1` (un día por fila) y paginación por cursor.
- `actions_json` guarda el array `actions` **crudo**: las métricas de
  compra se derivarán cuando se verifique su fiabilidad con datos reales,
  sin tener que re-pedir el histórico.
- Persistir snapshots protege de que Meta recorte ventanas y evita
  depender de que la API responda en cada carga del panel.

El **gasto de nivel cuenta** se vuelca a `daily_ad_spend` con
`source='meta_api'`, que es lo que consume Finanzas. Sustituye al manual
del mismo día (ver `docs/FINANCE-MODEL.md` §3).

Sync automática cada 6 h con lookback de 7 días (Meta ajusta cifras
retroactivamente los primeros días), más `npm run meta-ads:sync`.

---

## 5 · Atribución: lo que NO fingimos

La sección Anuncios relaciona **gasto total del periodo** con **pedidos
totales del periodo** (atribución temporal). El CPA y el ROAS son de la
cuenta, no de la campaña, y el panel lo dice con una nota fija.

**No existe** un vínculo pixel→pedido COD fiable en este sistema, así que
la tabla de campañas enseña solo lo que Meta reporta de verdad (gasto,
impresiones, clics, CTR, CPC, CPM). Inventar conversiones por campaña
sería peor que no darlas.

---

## 6 · Comandos

```bash
npm run meta-ads:doctor          # token, ads_read, cuenta, divisa/huso, insights
npm run meta-ads:sync            # últimos 7 días
npm run meta-ads:sync -- --days=30
```

El token nunca se imprime: viaja en la cabecera `Authorization` (jamás en
la URL, que acaba en logs) y el doctor solo dice *"configurado"*.
