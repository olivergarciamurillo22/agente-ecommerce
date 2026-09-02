> **ARCHIVED / SUPERSEDED (03-09-2026).** Documento histórico conservado
> por auditabilidad. NO trabajar desde aquí: la fuente de verdad vigente
> está indexada en `docs/README.md` (estado real: `ESTADO-PRODUCCION.md`).

> ⚠️ **SUPERSEDED — ver `docs/ESTADO-PRODUCCION.md`** (este documento quedó por detrás de la realidad y se conserva como histórico).

# Casamable — Brief de objetivos para la siguiente fase

Contexto y especificación funcional para el desarrollo. Escrito tras el despliegue del Control Center (22-08-2026), la auditoría completa de proveedores y el cierre del modelo de unit economics con datos reales.

---

## 0 · Lo que ha cambiado desde tu último push

Tres cosas que invalidan supuestos anteriores del proyecto:

### 0.1 · El bug de la ciudad está RESUELTO
El formulario Releasit ya captura el campo **"Localidad"**. Los pedidos llegan con ciudad real (`Almería`, `Mérida`, `Mutxamel`). El `shippingAddress.city = "-"` que bloqueaba todo ya no ocurre.

**Consecuencia inmediata:** la app oficial de Dropea **empezó a crear pedidos automáticamente** la noche del 22-08. Se confirma con evidencia directa: los pedidos `#35010824` y `#35010814` llevan `STORE ORDER ID` poblado y email autogenerado `<telefono>@dropea.io`, mientras que los 23 anteriores tienen `STORE ORDER ID: -` y el email personal de Pedro (entrada manual).

→ **El candado `DROPEA_CREATE_MODE=external_app` era correcto y debe seguir cerrado.** Si se hubiera activado nuestro `createOrder`, esos dos pedidos se habrían duplicado.

### 0.2 · La regla de enrutado YA SE CONOCE
Era la incógnita de la auditoría. La respuesta no es una configuración, es una consecuencia del catálogo:

> **Un producto va a Dropea si existe en el catálogo de Dropea. Si no, va a Dropi PRO.**

En la práctica hoy: **solo el Cortaúñas Eléctrico 3 en 1 (SKU `10428`) existe en Dropea**, y es el único con el metafield `dropea.product_id = a3f618c76fb450ce890e7189`. Los otros 4 productos activos no lo tienen y deben ir por Dropi.

Evidencia: el pedido `#35010834` (Limpiador Ultrasónico) falló con el error literal de Dropea:
```
Order contains no line items with a Dropea association.
Products not linked to Dropea: Limpiador Ultrasónico Multiusos
```

→ Esto resuelve los logs `[SUPPLIER] #10XX routing → unknown | manual_review: sin reglas de enrutado configuradas`. **Ya se puede implementar el enrutado real:** presencia del metafield `dropea.product_id` en las líneas del pedido → Dropea; ausencia → Dropi PRO (y en el futuro, Beeping).

Nota secundaria: la línea `Seguro de Envío` (sin SKU ni variante) **no molesta a Dropea**, la ignora. No hay que filtrarla.

### 0.3 · La app de Dropi PRO está ROTA
La app **Dropify PRO** instalada en Shopify devuelve `Application Error` tanto en "Sincronizar pedidos pendientes" como en "Importar productos". Su casilla de sincronización automática está activada, pero nunca ha funcionado: de ahí el 94 % de pedidos con tag `🚫 Sync ERROR - Dropi PRO` y de ahí que Pedro los meta todos a mano.

Se ha escrito a soporte de Dropi pidiendo (a) que arreglen la app y (b) la documentación de su API REST, que **su panel no expone en ningún sitio**.

> ⚠️ **Riesgo a anticipar:** hay ~67 pedidos pendientes en Shopify. Si Dropi arregla la app y ésta procesa la cola acumulada, podría crear decenas de envíos reales de golpe, muchos duplicados de los que Pedro ya metió a mano. Se ha recomendado a Pedro desmarcar su sincronización automática mientras esté rota.

---

## 1 · El contexto de negocio que ordena todas las prioridades

Este es el bloque más importante del brief. Con la contabilidad real de agosto:

| Métrica | Valor real |
|---|---|
| Facturación (2 días) | 818 € |
| ROAS bruto | 4,39 |
| **ROAS sobre dinero cobrado** | **3,05** |
| Tasa de entrega | **69,58 %** |
| **Margen neto** | **6,24 %** |
| **Punto de equilibrio** | **62,9 % de entrega** |

**El negocio vive con 6,7 puntos de colchón sobre su break-even.**

Sensibilidad, con los mismos ingresos y el mismo gasto en ads:

| Tasa de entrega | Profit /24 pedidos | Margen |
|---|---|---|
| 62,9 % | 0 € | 0 % |
| 69,58 % (hoy) | 51 € | 6,2 % |
| 80 % | 140 € | 17,1 % |
| 85 % | 181 € | 22,1 % |

**Cada punto de tasa de entrega vale 0,34 € por pedido enviado.** A 360 pedidos/mes, cada punto son ~122 €/mes.

### Por qué esto define el roadmap

Todo lo que sube la tasa de entrega tiene un ROI superior a cualquier otra cosa que podamos construir. Comparado con el cambio a fulfillment propio (Beeping), que aporta ~6,9 puntos de margen y exige ~4.000 € de capital, **la tasa de entrega aporta ~9,8 puntos y no cuesta capital**.

Traducido a producto: **el sistema de confirmación por WhatsApp, los avisos de tracking y el agente de llamadas no son features de experiencia de usuario. Son la infraestructura de rentabilidad del negocio.**

Además, con fulfillment propio cada pedido rehusado pasa a costar **9,37 €** de bolsillo (picking ida 1,70 + envío 4,08 + retorno 3,19 + picking vuelta 0,40), frente al modelo actual donde el proveedor absorbe parte. La confirmación previa deja de ser opcional.

---

## 2 · Objetivos, en orden de prioridad

### PRIORIDAD 1 — Medición real de la tasa de entrega

**Problema.** Hoy la tasa de entrega es un número que Pedro escribe a mano en una hoja de cálculo (por eso "pedidos entregados" sale con decimales: es `enviados × tasa_supuesta`). **La métrica que decide la rentabilidad del negocio es actualmente una suposición**, y sin medirla no se puede saber si las mejoras funcionan.

**Qué hay que construir.**
- Persistir el estado de entrega **real** de cada pedido, derivado de los webhooks/polling de proveedor, no estimado.
- Estados mínimos a distinguir: `enviado`, `en_tránsito`, `en_reparto`, `entregado`, `rehusado`, `incidencia`, `devuelto`.
- Fechas de cada transición (para medir tiempos, no solo el resultado final).
- Agregación por **día, producto, proveedor y transportista**. Los cuatro cortes importan: si GLS entrega 8 puntos mejor que Correos Express, esa decisión vale más que cualquier optimización de ads.

**Ya existe base para esto.** `supplier_webhook_events` (dedupe por `event_id`), `integration_events` y el motor de tracking (`[TRACKING] polling cada 300s`). Falta el modelo de estados canónico y la capa de agregación.

**Dependencia:** los webhooks de Dropea funcionan y están documentados (HMAC-SHA256, header `X-Dropea-Signature`). Los de Dropi PRO están pendientes de que arreglen su app y de que confirmen cómo firman sus notificaciones — `DROPIPRO_WEBHOOK_ENABLED` sigue cerrado (fail-closed) hasta entonces, y así debe seguir.

---

### PRIORIDAD 2 — Avisos automáticos de tracking al cliente

**Objetivo.** Subir la tasa de entrega avisando al cliente en los momentos en que su presencia en casa decide si el paquete se entrega o se rehúsa.

**Momentos que importan** (por impacto real, no por completitud):
1. **Pedido enviado + número de seguimiento.** Reduce el "no recuerdo haber pedido nada" al llegar el repartidor.
2. **Sale a reparto hoy / llega mañana.** Es el aviso de mayor impacto: convierte al cliente en alguien que espera el paquete.
3. **Intento de entrega fallido.** Momento crítico: sin aviso, el segundo intento falla igual y el pedido se pierde. Con aviso, se recupera.
4. **Disponible en punto de recogida** (si aplica al transportista).
5. **Incidencia** (dirección incorrecta, ausente reiterado) → esto debería escalar al agente de llamadas, no quedarse en un mensaje.

**Requisitos técnicos.**
- **Idempotencia estricta.** Un mismo evento no puede generar dos mensajes. `supplier_webhook_events` ya deduplica por `event_id`; los avisos deben apoyarse en eso.
- **Anti-spam por pedido.** Límite máximo de mensajes por pedido, y ventana mínima entre mensajes. Un cliente que recibe 6 WhatsApps por un pedido de 35 € bloquea el número.
- **Ventana horaria.** Reutilizar la lógica ya existente (`insideSendWindow()`, 09:00-21:00 Europe/Madrid). Ningún aviso de madrugada.
- **Todo debe pasar por los safety gates existentes** (`canSendRealWhatsApp()`, `TEST_MODE`, allowlist, `EMERGENCY_STOP`). Sin excepciones, igual que el resto del sistema.
- **Mapeo estado proveedor → mensaje.** Debe ser una tabla de configuración, no lógica dispersa: cada proveedor tiene sus propios `status_id` y hay que poder mapearlos sin tocar código. Para Dropi PRO ese mapa **aún no lo tenemos** (pendiente de su soporte); hasta entonces, estado desconocido → no se envía nada y se registra un `integration_event` de tipo `unknown_status`.

---

### PRIORIDAD 3 — Migración a la API oficial de WhatsApp (Meta Cloud API)

**Por qué ahora y no después.** El sistema corre sobre **Baileys**, que es WhatsApp Web no oficial y está en zona gris de los términos de servicio. El riesgo de baneo del número crece con el volumen — exactamente cuando el negocio escale. Si tumban el `+34 641 308 254` con 400 pedidos/mes en la calle, se pierde de golpe el sistema de confirmación, y con él los 6,7 puntos de colchón sobre el break-even.

**Es un seguro barato sobre la única cosa que mantiene el negocio rentable. Debe hacerse ANTES de escalar, no después.**

**La buena noticia arquitectónica.** Ya existe `src/lib/whatsapp.ts` como capa de abstracción del envío. **La migración debería ser sustituir la implementación manteniendo el interfaz**, no reescribir el sistema. Ese fue un buen diseño y ahora se cobra.

**Lo que cambia de verdad al pasar a la API oficial:**

- **Ventana de 24 horas.** Fuera de ella solo se pueden enviar **plantillas aprobadas previamente por Meta**. Esto afecta directamente a los avisos de tracking: un pedido enviado hace 3 días está fuera de ventana, así que **el aviso de tracking tiene que ser una plantilla**, no texto libre.
- **Categorías de plantilla.** Los avisos de pedido son categoría **utility** (transaccional), no marketing. La categoría afecta al precio y a la probabilidad de aprobación.
- **Plantillas a dar de alta** (mínimo): confirmación de pedido, recordatorio de confirmación, pedido enviado con tracking, sale a reparto, intento fallido, incidencia.
- **Variables en plantilla.** Meta limita el formato: nada de saltos de línea arbitrarios ni emojis en ciertos campos. Las plantillas hay que diseñarlas pensando en eso desde el principio.
- **Respuestas del cliente.** Los botones de respuesta rápida (`1 confirmar / 2 corregir / 3 nota`) se pueden implementar como **quick reply buttons** nativos en vez de pedirle que escriba un número. Eso sube la tasa de respuesta de forma notable.
- **Verificación previa.** Requiere Meta Business verificada y el número dado de alta. El número actual está en la app de WhatsApp Business: hay que migrarlo (Meta soporta coexistencia en algunas configuraciones, conviene revisarlo antes para no perder el historial).
- **Coste.** Meta cambió su modelo de precios en 2025 hacia cobro por mensaje en plantillas utility. **Verificar la tarifa vigente para España antes de dimensionar** — el orden de magnitud sigue siendo bajo frente al valor de un punto de tasa de entrega.

**Requisito de diseño.** Mantener Baileys como implementación alternativa detrás del mismo interfaz durante la transición, seleccionable por variable de entorno (`WHATSAPP_PROVIDER=baileys|cloud_api`). Permite rollback inmediato si la migración da problemas.

---

### PRIORIDAD 4 — Agente de IA para llamadas de confirmación

**El disparador ya existe.** El scheduler tiene el estado `needs_call` (`NEEDS_CALL_MINUTES`, 120 min por defecto): un pedido que no responde por WhatsApp pasa a ese estado automáticamente. Hoy hay **6 pedidos en `needs_call`** esperando una acción que no existe. **La mitad del trabajo está hecha: falta la acción.**

**Qué debe hacer.**
- Llamar **solo** a los pedidos en `needs_call` — no a todos. Llamar a quien ya confirmó por WhatsApp es tirar dinero.
- **Priorizar por importe del pedido.** Un pedido de 47 € merece más reintentos que uno de 30 €.
- Objetivo de la llamada: confirmar el pedido, o corregir la dirección, o cancelarlo. Tres desenlaces útiles; un cuarto (no contesta) que dispara reintento.
- **Registrar el desenlace en la base de datos** y transicionar el estado del pedido igual que lo haría una respuesta de WhatsApp: `confirmed`, `address_correction`, `cancelled`, `no_answer`.
- Reintentos limitados y espaciados (p. ej. máximo 3, en franjas horarias distintas — quien no coge a las 11:00 puede coger a las 19:00).

**Consideraciones técnicas.**
- Arquitectura: telefonía (tipo Twilio o proveedor español) + capa de voz conversacional. Debe quedar **detrás de un interfaz propio**, igual que los proveedores de fulfillment, para poder cambiar de proveedor de voz sin tocar la lógica de negocio.
- **Los mismos safety gates que todo lo demás**: `TEST_MODE` + allowlist + `EMERGENCY_STOP`, y una variable propia `VOICE_AGENT_ENABLED` fail-closed. Una llamada es más intrusiva que un mensaje: el gate debe ser más estricto, no menos.
- **Ventana horaria más restrictiva que WhatsApp.** Nada de llamar a las 21:00. Sugerido 10:00-14:00 y 16:00-20:00.
- **Coste por llamada.** Debe registrarse por pedido, porque entra en el P&L: si recuperar un pedido de 35 € cuesta 1,20 € de llamadas, sigue siendo rentabilísimo, pero hay que poder medirlo.

**Marco legal (España).** Una llamada para confirmar un pedido que el cliente ya ha hecho es **transaccional**, no comercial, lo que la sitúa fuera de las restricciones de llamadas publicitarias. Aun así: si se graba la conversación hay que informarlo al inicio, y debe existir forma de que el cliente pida no ser llamado. Conviene revisarlo antes de producción.

---

### PRIORIDAD 5 — Módulo de contabilidad diaria en el dashboard

**Objetivo.** Sustituir la hoja de cálculo manual por una vista que se actualice sola, con los mismos conceptos pero con datos reales.

**Columnas del modelo actual de Pedro** (respetar su lógica, que es correcta):

```
FECHA · FACTURACIÓN · PEDIDOS ENTREGADOS · PEDIDOS ENVIADOS ·
GASTO TOTAL ADS · ENVÍO · PRODUCTO · ENTREGA(%) · ROAS · PROFIT · %PROFIT
```

**Regla contable que hay que respetar** (está escrita en su hoja y es correcta):
> El PROFIT descuenta el % de ENTREGA solo de la FACTURACIÓN, porque el cobro COD depende de que se entregue. ENVÍO y PRODUCTO se restan al 100 %: son costes ya asumidos al enviar el pedido, se entregue o no.

**Mejoras respecto a su hoja:**
- **`PEDIDOS ENTREGADOS` debe ser un recuento real**, no `enviados × tasa`. Es el punto débil actual y el motivo principal de construir esto.
- Añadir **ROAS neto** (sobre dinero cobrado) junto al ROAS bruto. Hoy son 3,05 vs 4,39 y esa diferencia es la que engaña al tomar decisiones de escalado.
- Añadir **tasa de entrega por transportista y por producto**.
- Añadir el **coste de retornos** como línea propia (con fulfillment propio serán 9,37 €/rehusado y hay que verlo).

**Fuentes de datos:**
| Dato | Origen |
|---|---|
| Facturación, pedidos enviados | Ya en la base local (`orders`) |
| Pedidos entregados (real) | Tracking / webhooks de proveedor → Prioridad 1 |
| Coste de producto | **Falta**: tabla de coste por SKU, editable desde el panel |
| Coste de envío | **Falta**: tarifa por proveedor/tramo de peso, configurable |
| Gasto en ads | Meta Marketing API, o entrada manual diaria como primera versión |

**Sugerencia de alcance.** La v1 puede tener entrada manual del gasto en ads y de los costes por SKU; lo que no puede ser manual es la tasa de entrega, que es justo lo que se quiere medir.

---

### PRIORIDAD 6 — Adaptador de Beeping Fulfillment (preparar ahora, activar después)

**Contexto de negocio.** Cuando los ads se estabilicen, Pedro pasará de dropshipping a fulfillment propio con **Beeping** (3PL español, tarifa STARTER: mínimo 250 €/mes, picking 1,70 €, envío 1 kg Correos Express 4,08 €, COD 0,70 €). Importará 600 unidades (~4.075 € de desembolso). Más adelante, si el volumen lo pide, evaluará **Lopi** (500 €/mes, especializado en contrareembolso).

**Lo que esto significa para la arquitectura.** Beeping es un **3PL, no un marketplace de dropshipping**:
- No tiene app propia en Shopify creando pedidos por su cuenta → **no existe el riesgo de duplicados que sí tenemos con Dropea**. Nuestro sistema sería la única fuente de despacho.
- Requiere **gestión de inventario propio**, que hoy no existe en el sistema: stock disponible, unidades comprometidas, punto de pedido, y el hecho de que **un pedido rehusado devuelve la unidad al stock** (a diferencia del dropshipping, donde se pierde).

**Qué hacer ahora.** No construir el adaptador de Beeping — todavía no tenemos su API ni la cuenta. Lo que sí conviene ahora, porque el coste marginal es casi cero y el de no hacerlo es reescribir:

> **Dejar la capa de proveedores con un interfaz genérico y estable**: `createOrder`, `getOrderStatus`, `getTracking`, `cancelOrder`, y un mapa de estados propio del proveedor → estados canónicos nuestros. Dropi, Dropea y Beeping deben ser tres implementaciones del mismo contrato.

`src/lib/suppliers/` ya va en esa dirección. Se trata de consolidarlo antes de que aparezca el tercer proveedor, no después.

**Cuando llegue el momento**, hará falta además: modelo de inventario, reserva de stock al confirmar, punto de pedido con aviso, y control de que un rehusado reingresa la unidad.

---

## 3 · Métricas y alertas a añadir al Control Center

El Control Center ya está desplegado y estable. Con el contexto de negocio anterior, estas métricas pasan a ser las importantes:

| Métrica | Umbral sugerido | Nivel |
|---|---|---|
| **Tasa de entrega (7 días móviles)** | < 70 % | WARNING |
| **Tasa de entrega (7 días móviles)** | < 65 % — cerca del break-even (62,9 %) | **CRITICAL** |
| Pedidos en `needs_call` sin atender | > 12 h | WARNING |
| Pedidos confirmados sin despachar | > 6 h | WARNING |
| Avisos de tracking fallidos | > 5 en 24 h | WARNING |
| Eventos de estado desconocido de proveedor | cualquiera | INFO (indica mapa de estados incompleto) |
| Coste por pedido entregado | desviación > 15 % sobre la media | WARNING |
| Stock disponible (cuando exista Beeping) | < 45 días de venta | WARNING |

La primera es la más importante del sistema: **es la única alerta que avisa de que el negocio está entrando en pérdidas**, y hoy no existe.

---

## 4 · Lo que NO hay que tocar

- **No activar `DROPEA_CREATE_MODE=our_api`.** La app oficial de Dropea crea los pedidos y funciona. Duplicaríamos envíos reales.
- **No activar `DROPIPRO_WEBHOOK_ENABLED`** hasta que Dropi confirme cómo firma sus notificaciones. El fail-closed actual es correcto.
- **No activar `LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=1`** mientras las apps nativas de Dropea y Dropi sigan instaladas y activas en Shopify.
- **No tocar los defaults fail-closed** de las variables de proveedor. Fueron la razón de que el despliegue del Control Center fuese seguro con un `.env` antiguo que no tenía ninguna de las variables nuevas.
- **No quitar los safety gates** de ninguna ruta nueva. Toda acción externa (WhatsApp, llamada, escritura en Shopify, escritura en proveedor) pasa por `src/lib/safety.ts`. El agente de llamadas incluido.

---

## 5 · Resumen de secuencia

| # | Objetivo | Depende de | Capital | Impacto en margen |
|---|---|---|---|---|
| 1 | Medición real de tasa de entrega | — | 0 € | Habilita todo lo demás |
| 2 | Avisos de tracking automáticos | 1 | 0 € | Alto |
| 3 | Migración a WhatsApp Cloud API | — | ~bajo/mes | Elimina riesgo existencial |
| 4 | Agente de llamadas (`needs_call`) | 3 recomendable | Medio | Alto |
| 5 | Contabilidad diaria en el panel | 1 | 0 € | Visibilidad |
| 6 | Interfaz genérico de proveedores | — | 0 € | Prepara Beeping |
| 7 | Adaptador Beeping + inventario | 6 + cuenta abierta | ~4.075 € | +6,9 puntos |

Los objetivos 1, 2, 5 y 6 **no requieren capital ni decisiones de negocio pendientes**. Se pueden abordar ya.

El 3 depende de trámites con Meta (verificación de empresa y alta del número), que conviene arrancar cuanto antes porque tienen tiempos de espera propios.

El 7 espera a que el ROAS se estabilice 3-4 semanas.

---

*Brief redactado el 22-08-2026 tras el despliegue y validación del Control Center en el NAS (commit `45c2bd9`), la auditoría de Dropi PRO y Dropea, y el cierre del modelo de unit economics con la contabilidad real de agosto.*
