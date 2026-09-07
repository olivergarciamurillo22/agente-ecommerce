# Saldo de Retell: hueco confirmado

Revisión realizada el 5 de septiembre de 2026 sobre la documentación oficial.

- El índice completo de API (`https://docs.retellai.com/llms.txt`) no publica ningún endpoint de saldo, créditos o wallet.
- `GET /get-concurrency` devuelve capacidad simultánea y límites, no dinero disponible.
- `GET /v2/get-call/{call_id}` expone el coste de una llamada terminada, no el saldo de la cuenta.
- La documentación de Billing sitúa pagos, cargos y uso en la pestaña del panel; no ofrece una ruta API equivalente.

No se probaron rutas inventadas como `/balance` o `/billing`: no están en el contrato público y este entorno no dispone de `RETELL_API_KEY`. Por tanto `retell:doctor` y `readiness:runtime` muestran `UNAVAILABLE_API` y exigen comprobación manual. No se aplican los umbrales de 10 €/5 € porque no existe un dato verificable al que aplicarlos.

Para cerrar esta deuda Retell debe proporcionar un endpoint documentado de balance o una exportación soportada. En ese momento se podrán añadir `RETELL_BALANCE_WARN_EUR` y `RETELL_BALANCE_CRITICAL_EUR`, sin valores económicos simulados.
