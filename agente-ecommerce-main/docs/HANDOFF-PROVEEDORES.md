# Handoff de proveedores: qué necesitamos de Dropea y Dropi PRO

Este documento es el encargo para Pedro. El sistema de Casamable ya tiene
lista toda la maquinaria para crear pedidos en el proveedor, seguir el envío
y avisar al cliente por WhatsApp. **Falta un dato que solo se puede sacar de
las plataformas: cómo hablar con sus APIs.**

Mientras no esté, la integración está bloqueada a propósito: preferimos que
no haga nada antes que inventarnos endpoints y mandar pedidos mal.

> 🔐 **Los secretos NO se mandan por chat, ni por WhatsApp, ni por correo.**
> Se pegan directamente en el fichero `.env` del NAS. Aquí solo hace falta
> decir *qué* dato es y *dónde* está.

---

## Parte 1 · Dropea

### 1.1 Webhooks (esto ya lo tienes localizado)

En Dropea, en la pantalla **Webhooks for "Casamable"**, aparece:

> *Subscribing to webhooks delivers HMAC-signed POSTs whenever events happen
> in your account.*

Y estos eventos disponibles:

```text
ISSUE_CREATED
ISSUE_RESOLVED
ISSUE_STATUS_CHANGED
ORDER_CANCELLED
ORDER_CREATED
ORDER_STATUS_CHANGED
```

**Lo que necesitamos de ahí:**

1. **Abre el enlace "View full documentation"** de esa misma pantalla y
   pásanos el enlace o un PDF/captura de la documentación completa. Es lo más
   valioso de todo: ahí estará casi todo lo demás.
2. **El secreto de firma HMAC** de los webhooks. Cópialo directamente al
   `.env` del NAS, en `DROPEA_WEBHOOK_SECRET`.
3. De la documentación, confirma tres cosas de la firma:
   - **Nombre exacto de la cabecera** donde viaja la firma
     (¿`X-Signature`, `X-Hub-Signature-256`, otra?).
   - **Codificación**: ¿hexadecimal o base64?
   - **Qué se firma**: ¿el cuerpo entero tal cual, o algo más (timestamp+cuerpo)?
4. **Un ejemplo real del cuerpo (JSON) de cada evento**, sobre todo de
   `ORDER_STATUS_CHANGED`. Con un ejemplo completo nos vale. Puedes tacharlo
   con datos falsos si aparece un cliente real, pero **respeta los nombres de
   los campos**: es justo lo que necesitamos ver.

**Todavía NO suscribas el webhook.** Cuando tengamos el secreto configurado te
diremos que lo hagas, con esta URL de destino:

```text
https://agente.casamable.es/api/webhooks/dropea
```

### 1.2 API para crear pedidos

Busca en esa documentación (o pregunta a su soporte) y respóndenos:

1. **URL base de la API** (y si hay entorno de pruebas/sandbox).
2. **Cómo se autentica**: ¿cabecera `Authorization: Bearer ...`, `X-Api-Key`,
   una firma por petición? La credencial va al `.env` (`DROPEA_API_KEY`); aquí
   solo hace falta saber *el método*.
3. **El endpoint para crear un pedido** y un **ejemplo del JSON** que espera.
   Nombres exactos de los campos de: cliente, teléfono, dirección, localidad,
   código postal, provincia, productos e importe a cobrar contra reembolso.
4. **Cómo identifica los productos**: ¿por el SKU nuestro (p. ej.
   `LIMPIADOR-ULTRA-CASAMABLE`), o por un id de su catálogo? Si es lo segundo,
   necesitamos **la lista de sus ids con el producto correspondiente**.
5. **¿Acepta una referencia nuestra?** Buscamos un campo tipo
   `external_reference`, `merchant_reference` o `idempotency_key` para mandar
   nuestro número de pedido. **Es importante**: es lo que evita que un
   reintento cree el pedido dos veces.
6. **Endpoints para consultar** el estado de un pedido y su número de
   seguimiento.
7. **La lista COMPLETA de estados** que puede devolver un pedido, con su
   significado (por ejemplo: `EN_BODEGA`, `GUIA_GENERADA`, `EN_REPARTO`...).
   Sin esto no sabemos cuándo avisar al cliente de que su pedido sale a
   reparto.
8. **¿Se puede anular un pedido** por API, y hasta qué momento?
9. **¿Hay límite de peticiones** (rate limit)? Si lo hay, cuántas por minuto.

### 1.3 La pregunta más importante de todas ⚠️

Los pedidos reales de Casamable ya llegan a Shopify con estos tags:

```text
releasit_cod_form
dropea_error
🚫 Sync ERROR - Dropi PRO
```

Eso significa que **ya hay algo conectando Shopify con Dropea/Dropi**, por su
cuenta, y que además está dando errores de sincronización.

Necesitamos saber:

1. ¿Qué es exactamente lo que está sincronizando ahora? ¿Una app de Shopify,
   una integración de Dropea, algo montado antes?
2. **¿Por qué falla?** ¿Qué dice ese error de sincronización?
3. Cuando conectemos lo nuestro, **¿esa integración se apaga o convive?**

Esto es crítico: si las dos crean pedidos, **cada compra se enviaría dos veces
al cliente**. Antes de activar nada tenemos que tenerlo claro.

---

## Parte 2 · Dropi PRO

Exactamente lo mismo que la parte 1.2, para Dropi:

1. URL base de la API (y sandbox si existe).
2. Método de autenticación.
3. Endpoint de creación de pedido + ejemplo del JSON.
4. Cómo identifica los productos (SKU nuestro o id suyo + listado).
5. Si admite una referencia externa / clave de idempotencia.
6. Endpoints de estado y de seguimiento.
7. Lista completa de estados y su significado.
8. Si permite anular pedidos.
9. Límite de peticiones.
10. **¿Tiene webhooks?** Si los tiene: eventos, secreto de firma y ejemplo del
    cuerpo. Nuestra URL sería
    `https://agente.casamable.es/api/webhooks/dropi`.

---

## Parte 3 · Qué producto va a qué proveedor

Ahora mismo **el sistema no enruta ningún pedido solo**: manda todo a revisión
manual, a propósito, porque adivinarlo significaría enviar un pedido al
proveedor equivocado.

Necesitamos la lista de productos con su proveedor. Por ejemplo:

```text
Cortaúñas y Pulidor Eléctrico 3 en 1  (SKU 10428)                 → ¿dropea o dropi?
Limpiador Ultrasónico Multiusos (SKU LIMPIADOR-ULTRA-CASAMABLE)   → ¿dropea o dropi?
Suplemento Intelecto Forte                                        → ?
Cepillo de Vapor Antipelo                                         → ?
Espejo Retrovisor con Cámara HD                                   → ?
Seguro de Envío                                                   → (¿se manda al proveedor o es solo nuestro?)
```

Con eso configuramos el enrutado y dejamos de mandar todo a revisión.

---

## Parte 4 · Un arreglo urgente que no depende de nadie más

En los pedidos reales, el formulario de Releasit está mandando la **localidad
vacía o con un guion**:

```text
shippingAddress.city = "-"
```

Ningún transportista puede entregar así, y nuestro sistema bloquea esos
pedidos a propósito (aparecen como *BLOQUEADO DIRECCIÓN*). Mientras siga
ocurriendo, **todos los pedidos acabarán en revisión manual** por bueno que
sea el resto de la integración.

**Qué hacer:** entrar en la configuración del formulario COD de Releasit y
poner el campo de **ciudad/localidad como obligatorio** (y a poder ser
validar el código postal). Es probablemente la mejora que más trabajo manual
ahorra de toda la lista.

---

## Resumen: lo que hay que conseguir

| # | Qué | Dónde |
|---|---|---|
| 1 | Documentación completa de la API de Dropea | Enlace "View full documentation" |
| 2 | Secreto HMAC de webhooks de Dropea | Pegar en `.env` del NAS |
| 3 | Cabecera, codificación y ejemplo de cuerpo del webhook | Documentación |
| 4 | Endpoint + JSON de creación de pedido (Dropea) | Documentación |
| 5 | Catálogo/SKUs y lista de estados (Dropea) | Documentación o soporte |
| 6 | Todo lo anterior para Dropi PRO | Panel de Dropi |
| 7 | Qué producto va a qué proveedor | Pedro lo sabe |
| 8 | Qué es y por qué falla la sincronización actual | Investigar ⚠️ |
| 9 | Hacer obligatoria la localidad en Releasit | Ajustes de Releasit |

Con los puntos 1-6 podemos escribir los clientes de las APIs. Con el 7,
activar el enrutado. El 8 hay que resolverlo **antes** de activar nada, y el
9 se puede hacer hoy mismo.
