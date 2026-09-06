# Hotfix WhatsApp · 05-09-2026

Rama `fix/whatsapp-confirmacion-bugs`, creada desde el commit de producción `92cfd3e`. Evidencia operativa: pedidos `#35011404` y `#35011394`. No se incluyen nombres, teléfonos ni direcciones reales.

## Bug 1 · confirmación con dirección inválida

### Causa raíz

`src/lib/orders/confirmation.ts` ejecutaba `markOrderConfirmed` y después intentaba añadir `WA_CONFIRMED` sin validar `address_line1`. El flujo era idéntico para texto y para `confirm_order`, porque el botón se traduce a `"1"`.

### Corrección

`assessOrderAddress` bloquea la confirmación automática cuando la dirección está vacía, tiene menos de 6 caracteres o no contiene ningún dígito. Seis admite una dirección corta como `C X 1A`; la regla no pretende certificar una dirección postal. Un valor de dos palabras capitalizadas sin dígitos ni vocabulario de vía se registra específicamente como `parece_nombre`.

El pedido pasa a `needs_correction`, el cliente recibe la petición de dirección completa y se crea `integration_events.direccion_sospechosa`. La confirmación manual del panel se conserva porque ya implica revisión humana. No hay aplicación retroactiva ni cambio de esquema.

El valor real de `#35011404` no vive en el repositorio y no se consultó producción. La prueba usa el patrón anonimizado `Nombre Apellido` para no incorporar PII.

## Bug 2 · mensaje distinto de la plantilla aprobada

### Causa raíz

Había dos constructores activos. `buildConfirmationOutbound` elegía un mensaje `interactive_buttons` propio cuando detectaba una ventana abierta y solo usaba `confirmacion_pedido_cod` fuera de ella. Además, con Baileys el scheduler llamaba directamente a `buildConfirmationMessage`. El texto recibido coincidía literalmente con el primer constructor: era código vivo, no un mock.

### Corrección

En Cloud API la confirmación inicial usa siempre la clave lógica `order_confirmation_request`, resuelta a `confirmacion_pedido_cod`: nombre, número de pedido, producto e importe, más `confirm_order`, `change_address` y `delivery_note` como quick replies. La ventana de 24 horas ya no selecciona otra versión.

Sin verificación `APPROVED`, aridad correcta y tres botones, la construcción lanza `TemplateNotReadyError`; el scheduler no consume el pedido ni encola un sustituto y registra `template_not_ready`. Los reenvíos manuales solo devuelven el pedido al mismo scheduler. El literal retirado quedó eliminado de `src` y `config`.

Baileys no puede enviar plantillas oficiales de Meta. Su rollback conserva una vista textual fiel, pero la garantía de plantilla y botones reales corresponde a `WHATSAPP_PROVIDER=cloud_api`; no se inventa soporte que Baileys no ofrece.

## Bug 3 · cancelación archivada como nota o texto mudo

### Causa raíz

`captureNote` guardaba cualquier texto no clasificable como `delivery_note`. Después de confirmar, el pedido desaparecía de `getActiveOrdersByPhone`, por lo que `handleOrderReply` devolvía `handled:false`; con la IA apagada el mensaje quedaba almacenado sin escalado.

### Corrección

Antes de guardar una nota se detectan, sin IA y normalizadas sin tildes, estas señales: `cancelar`, `cancele`, `anular`, `no lo quiero`, `sin mi permiso`, `devolver`, `devolución`, `equivocación` y `error en el pedido`. El caso real anonimizado está cubierto literalmente por prueba.

Las frases de alto riesgo pasan inmediatamente a `conversations.mode=HUMAN`, intentan mover el pedido vivo a `needs_call` y crean `posible_cancelacion_texto_libre` con severidad `critical`. Nunca cancelan Shopify ni generan una respuesta automática. Los comandos breves y explícitos de cancelación que ya tenían flujo seguro se conservan.

Además, todo texto libre no reconocido en un pedido activo pasa a HUMAN por defecto. Tras una confirmación, un texto no reconocido también escala usando el pedido reciente; respuestas deterministas como un segundo `1` siguen siendo inertes. Dirección y nota esperadas continúan sus flujos normales.

## Visibilidad y trabajo manual

El escalado es visible en la conversación HUMAN, en Seguimiento/Acciones cuando el estado admite `needs_call`, y como evento crítico del Control Center. Esta base no dispone de email o push independiente para estos eventos; Pedro debe decidir si necesita ese canal adicional.

No se consultó la base real de producción. Por tanto, desde este entorno no puede afirmarse cuántos pedidos ya confirmados comparten el patrón de dirección sospechosa. Antes de desplegar, Pedro debe revisar manualmente:

- pedidos confirmados con `address_line1` vacío, sin dígitos o con aspecto de nombre;
- conversaciones AI con texto libre posterior a `confirmed_at`;
- notas recientes que contengan las señales de cancelación anteriores.

La revisión debe ser de solo lectura y no debe cancelar ni reetiquetar pedidos automáticamente.
