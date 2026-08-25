# Lo que solo se puede hacer en el NAS — checklist para Pedro

> Actualizado el 25-08-2026, tras el bloque de hardening.
> **Aquí SOLO hay cosas que no se pueden hacer desde el portátil.** Todo lo
> demás ya está hecho y probado en la rama `fix/hardening-casamable`.

## Antes de empezar

1. **Nunca despliegues entre las 10:00 y las 21:00.** Reiniciar corta WhatsApp.
2. Los scripts se ejecutan **dentro del contenedor**, no en el host:
   ```bash
   docker compose exec casamable-agent npm run <lo-que-sea>
   ```
   Fuera del contenedor no existen `tsx` ni `node_modules`, y el script
   abriría **otra** base de datos (vacía) dando números falsos sin avisar.
3. Todos los scripts de datos son **dry-run por defecto**. Escribir exige
   `-- --apply`.

---

## A · Cosas que ya deberías tener hechas (verificar)

### A1 · Desmarcar la sincronización automática de Dropify PRO
- **Dónde:** admin de Shopify → app Dropify PRO.
- **Escribe:** sí, en Shopify.
- **Riesgo si no se hace:** su app está rota y tiene ~67 pedidos en cola. Si
  alguien la arregla, los despacha todos de golpe → **pedidos duplicados**.
- **Copia:** nada. Solo dime hecho/no hecho.

### A2 · `DROPEA_WEBHOOK_SECRET` en el `.env` del NAS
- **Escribe:** sí, en el `.env`.
- **Verificar:** panel → Sistema → Resumen → "Cómo está configurado esto".
  Debe decir *"Avisos de Dropea: firma verificándose"*.
- **Desbloquea:** sin él, **todos** los avisos de Dropea se rechazan. No es un
  agujero de seguridad: es la integración parada.

### A3 · Scope `read_all_orders` en la app de Shopify
- **Desbloquea:** el histórico completo. Sin él la API devuelve solo los
  últimos 60 días **en silencio, sin error**.
- **Verificar:** lo dice el propio backfill en su sección "Cobertura".

---

## B · Despliegue de esta versión

### B1 · Copia de seguridad
```bash
docker compose exec casamable-agent npm run backup
```
- **Escribe:** crea un fichero **y borra los backups de más de 7 días**
  (`BACKUP_RETENTION_DAYS`). Si quieres conservar los antiguos, súbela antes.
- **Copia:** la línea con la ruta y el tamaño del backup.

### B2 · Actualizar y reconstruir
```bash
git pull --ff-only origin main
docker compose up -d --build
```
- **Escribe:** sí. La migración lleva el esquema de **5** a **9**:
  `status_axis` en el histórico (v6), tabla `scheduler_leases` (v7), el
  contexto de conversación multi-pedido + marcas de duplicado/cancelación
  (v8) y los estados de mensaje del outbox para la API oficial de Meta (v9).
  Es **aditiva**: no borra ni transforma ninguna fila existente.
- **Riesgo:** bajo, pero es el paso irreversible sin restaurar backup.

### B3 · Comprobar que todo arrancó
```bash
docker compose ps
docker compose exec casamable-agent npm run db:health
```
- **Escribe:** no.
- **Copia:** la salida entera de `db:health`.
- **Debe decir:** esquema **9**, integridad `ok`, contenedor *healthy*.
- **PARA SI:** WhatsApp pide QR, o el esquema no sube. No sigas.

### B4 · Mirar el panel
- Sistema → Resumen → **"Cómo está configurado esto"** (sección nueva).
- **Copia:** qué aparece en ámbar o rojo.
- Te dirá si el panel no tiene contraseña propia, si falta algún secreto de
  webhook, si la hora del servidor no es la de Madrid y si `TEST_MODE` sigue
  puesto.

---

## C · Los datos que Óliver necesita

### C1 · Backfill de Shopify — el desglose de fulfillment
```bash
docker compose exec casamable-agent npm run shopify:backfill
```
- **Escribe:** NO (dry-run).
- **Copia:** las secciones **"Mercancía: cómo se leyó cada pedido"**,
  **"Enlace con Dropea"** y **"Cobertura"**.
- **Por qué importa:** confirma o tumba la hipótesis del `Seguro de Envío`.
  Si la mayoría sale como **"por LÍNEA (fiable)"**, la corrección funciona.
  Si sale **"por fulfillment global"**, es que los pedidos no traen los datos
  por línea y hay que replantearlo.
- Solo si el desglose cuadra:
  ```bash
  docker compose exec casamable-agent npm run shopify:backfill -- --apply
  ```

### C2 · Reconciliación de Dropea — el desglose que falta desde el 24-08
```bash
docker compose exec casamable-agent npm run dropea:reconcile
```
- **Escribe:** NO sin `--apply`.
- **Copia:** el desglose completo (enlazados por cada clave, ambiguos,
  conflictos, cierres aplicados).
- **Desbloquea:** la tasa de entrega. Es el dato que sigue faltando.
- ⚠️ **Ojo:** si ya lo corriste con `--apply` el 24-08, puede que algún pedido
  quedara marcado como `refused` cuando en realidad era `REFUSED_LOST_DAMAGED`
  (paquete perdido, no rehúse del cliente). La regla vieja los confundía; la
  nueva no. **No se puede corregir solo** (son estados terminales). Mira en
  Sistema → Eventos si aparece `closure_needs_review` y dímelo.

### C3 · Qué significa `dropea_error`
- **Dónde:** admin de Shopify, abre un pedido que lleve ese tag (son 90 de 93).
- **Escribe:** no. **Solo mirar.**
- **Copia, anonimizando nombre y teléfono:** número de pedido, SKU, el texto
  **exacto** del error, y si aparece o no un id de pedido de Dropea.
- **Por qué:** Dropea SÍ está procesando esos pedidos, así que ese tag **no**
  significa "no se creó". Es la incógnita más barata de cerrar y cambia cómo
  se lee todo lo demás.

### C4 · Diagnóstico de Dropea
```bash
docker compose exec casamable-agent npm run dropea:doctor
```
- **Escribe:** no.
- **Copia:** la sección 5, "WEBHOOKS REGISTRADOS".
- **Nota:** antes decía *"(ninguno suscrito)"* con 6 activos — era un bug del
  script, ya corregido. Si ahora dijera *"respuesta con una forma que este
  script no reconoce"*, pégame la respuesta cruda que imprime.

### C4b · Insignias nuevas en la lista de pedidos
- **Dónde:** panel → Pedidos.
- Verás dos insignias nuevas cuando toquen:
  - **POSIBLE DUPLICADO** (ámbar): dos pedidos del mismo cliente con el mismo
    producto, importe y dirección. El bot NO cancela ninguno: lo marca y pasa
    los dos a "pendiente de llamada" para que decidas tú cuál va.
  - **PIDE CANCELAR** (rojo): el cliente pidió cancelar por WhatsApp y lo
    confirmó. Tampoco se toca nada en Shopify: el pedido queda en "pendiente
    de llamada" esperándote.
- **Copia:** si aparece alguna, el número de pedido y qué decides hacer.

### C5 · Mapping de productos
- **Dónde:** panel → Sistema → **Productos** (pestaña nueva).
- **Escribe:** solo si activas/desactivas algo.
- **Copia:** cuántas filas hay y si alguna sale en rojo o ámbar.
- **Si está vacía:** todos los pedidos van a revisión manual. Hace falta al
  menos SKU `10428` → Dropea (`variant_id` 15896).

---

## D · Opcional, cuando quieras

### D1 · Contraseña del panel
- Poner `DASHBOARD_PASSWORD` en el `.env` y reiniciar.
- **Hoy:** el panel no pide credenciales; toda la protección es Cloudflare
  Access. Quien llegue al NAS por la IP de la red local ve pedidos y
  conversaciones con clientes.

### D2 · Retención de datos (PII)
```bash
docker compose exec casamable-agent npm run retention
```
- **Escribe:** NO sin `--apply`.
- **Qué hace:** a los pedidos ya **cerrados** y con más de 90 días les quita
  del payload guardado el nombre, teléfono, email, dirección y notas del
  cliente, conservando las líneas del pedido. Borra mensajes de más de 180
  días y entregas de webhook de más de 30.
- **Nunca borra:** pedidos, cierres, histórico de estados, enlaces con
  proveedor ni contabilidad. Ver `docs/DATA-RETENTION.md`.

---

## D3 · WhatsApp oficial (cuando decidáis arrancarlo)

Todo el código está preparado y probado en local. Lo que falta es TU alta en
Meta: está paso a paso en **`docs/PEDRO-META-WHATSAPP-SETUP.md`** (hazlo con
Óliver a mano). Hasta entonces, nada cambia: `WHATSAPP_PROVIDER=baileys`.

## E · Bloqueado por terceros (nada que hacer, solo seguimiento)

| Qué | De quién depende | Qué desbloquea |
|---|---|---|
| Número español de Twilio | revisión regulatoria | Sin él E7 no puede llamar aunque se active |
| API de Dropi PRO: URL, auth, catálogo de estados y firma del webhook | soporte de Dropi | Todo el andamiaje está hecho: `client.ts`, `mapper.ts`, `status-map.ts` y el contrato. Solo falta rellenar |
| Arreglo de la app Dropify PRO | soporte de Dropi | Hoy los pedidos de Dropi se meten a mano |

---

## Qué mandarle a Óliver

Un mensaje con:

1. Salida de `db:health` (B3).
2. Lo que salga en ámbar o rojo en "Cómo está configurado esto" (B4).
3. Los tres desgloses del backfill (C1).
4. El desglose de la reconciliación de Dropea (C2).
5. El texto exacto de `dropea_error` (C3).
6. Cuántos mappings hay y su estado (C5).
7. **Lo que no hayas podido hacer y por qué.**

El punto 7 es tan útil como los otros seis.
