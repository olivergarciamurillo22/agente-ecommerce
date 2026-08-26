# Simulación del piloto de llamadas

`npm run calls:pilot:simulate [prompt.txt]` — sin llamar a Retell ni a nadie.

## Qué comprueba

1. **Las 11 variables del contrato** con un pedido sintético: se construyen,
   son EXACTAMENTE las de `payload.ts` (misma lista que el validador de
   prompt, sincronía garantizada por test), y se imprimen anonimizadas.
2. **La puerta de datos**: sin dirección → no se llama y dice qué falta.
3. **Allowlist fail-closed**: vacía con TEST_MODE activo (o sin definir) =
   NADIE. Solo los de la lista pasan.
4. **Franjas legales** (Madrid, en código): 9–13 y 17–20, ni siesta, ni
   noche, ni domingos.
5. **Precedencia**: `settings.ai_calls_enabled=0` del panel GANA a
   `AI_CALLS_ENABLED=1` del env — apagar desde el panel apaga de verdad.
6. Con un fichero de prompt: los marcadores contra el contrato
   (los fallos de la v5 se cazan aquí, no en una llamada real).

## Antes de la primera llamada real (con Pedro)

- Método de pago en Retell (el saldo NO se puede leer desde el panel).
- `npm run calls:validate-prompt -- v6.txt` en verde.
- Allowlist con el móvil de Pedro → kill switch desde el panel → pedido de
  prueba sin contestar el WhatsApp → el orquestador hace el resto.
