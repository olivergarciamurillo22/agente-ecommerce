# Desarrollo local — el mapa completo

> Complementa `LOCAL-ENV-SETUP.md` (entorno) con TODO lo ejecutable en el Mac
> sin credenciales reales y sin tocar el NAS.

## Sin ninguna credencial (perfil local-safe)

```bash
npm test                      # 476 tests, DB temporal propia
npm run local:doctor          # entorno + DB + rutas + git
npm run local:seed -- --yes   # 7 pedidos demo (duplicado, rehusado, PIDE CANCELAR…)
npm run dev:all               # panel vivo en localhost:3000 con esos datos
npm run local:reset -- --yes  # borrar la DB local y empezar de cero
```

## Simuladores de piloto (sin red, credenciales falsas)

```bash
npm run meta:pilot:simulate       # el flujo del piloto de Meta entero, 12 pasos
npm run calls:pilot:simulate      # payload, guardas y franjas de llamadas
npm run calls:validate-prompt -- prompt.txt   # marcadores del prompt de Retell
```

## Doctores (solo lectura; los de red piden credenciales del perfil)

```bash
npm run env:doctor [-- --profile X]   # qué falta para cada perfil
npm run shopify:doctor                # auth + webhooks + vendor/SKU (GET)
npm run dropea:doctor                 # auth + tienda + catálogo + webhooks (GET)
npm run dropi:diagnose                # vendor Dropi + sku=null (GET + DB local)
```

## Reglas del Mac

- Los efectos reales están apagados por perfil (`local-safe`): envíos, writes,
  Cloud API y llamadas. `TEST_MODE=1` siempre.
- La DB local es `./data` — los scripts destructivos se NIEGAN sobre rutas de
  NAS y sobre producción real.
- Los secretos viven SOLO en `.env.local` (ignorado por Git, con test).
