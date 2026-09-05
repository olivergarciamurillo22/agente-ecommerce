# Resumen de release Casamable v4.3

## Integración

La rama `release/casamable-v4.3` nació de `origin/release/casamable-v4.2`. Se integraron:

- workspace de atención al cliente, commit de merge `2d8dfbd`;
- Hunter + Landing Studio, commit de merge `c4b83bd`.

No hubo conflictos textuales ni resoluciones manuales fichero a fichero. El solapamiento relevante fue `src/lib/db.ts`: el resultado conserva primero workspace/auth en schema 18 y después candidatos Hunter en schema 19. `package.json` y `tests/run-tests.ts` acumularon ambas funcionalidades sin perder scripts ni pruebas. `src/proxy.ts` quedó con el contrato público original comprobado por test; Hunter no lo modificó.

## Estado por fase

| Fase | Estado | Resultado |
|---|---|---|
| F4 | COMPLETA | Ayuda tras cancelación deriva a HUMAN y crea `CANCEL_HELP`, sin respuesta automática. |
| F5 | COMPLETA | Bloqueos de rampa observables e idempotentes; la decisión de rollout no cambió. |
| F6 | PARCIAL | Retell no publica una API documentada de saldo: doctor/readiness dicen `UNAVAILABLE_API`; queda comprobación manual. |
| F7 | COMPLETA | Meta Ads acepta rango ISO explícito en CLI/API/UI, inclusivo y limitado a 90 días; default 7 días. |
| F8 | COMPLETA | Fixture schema 17 con 2.408 filas, migración 18/19 repetida, recuentos intactos e integridad OK. |
| F9 | COMPLETA | Aceptación HTTP del workspace: flujo de agente, privacidad, 403 y auditoría exacta. |
| F10 | BLOQUEADA | Docker no existe en el host de preparación; smoke documentado pero no ejecutado. |
| F11 | COMPLETA | Runbook NAS con doble-bot guard, backups externos, `repo-v3c`, verificación y rollback. |
| F12 | COMPLETA | `doctor:v43` unifica seis bloques y devuelve 1 ante cualquier FAIL. |
| F13 | COMPLETA | `trace -- --pedido` cruza la historia local con PII redactada por defecto. |
| F14 | COMPLETA | `fixture:pedido` normaliza como Shopify, usa `999xxx`, exige allowlist y registra origen sintético. |
| F15 | COMPLETA | Frontera anti-cliente-real sin env de bypass en WhatsApp, llamadas, schedulers y scripts. |
| F16 | COMPLETA | Este documento consolida estado, deuda, decisiones y omisiones. |

## Deuda del 03-09

Cerrada:

- economics de Hunter ya no inventa PVP ni peso volumétrico;
- cancelación con ayuda deja trabajo humano;
- bloqueos de rollout dejan rastro sin abrir la rampa;
- Meta Ads permite backfill acotado;
- migración 17→19 y workspace de agente tienen aceptación reproducible;
- doctor de release, trazabilidad y fixture evitan diagnósticos manuales propensos a errores;
- la autorización puntual ya no salta la allowlist estricta en TEST_MODE;
- despliegue y rollback declaran el proyecto Compose y la irreversibilidad de la migración.

No cerrada por falta de evidencia externa:

- saldo monetario de Retell: no hay endpoint oficial documentado;
- firma real de webhook Retell y configuración viva requieren credenciales/NAS;
- aprobación real 7 PASS / 1 DISABLED / 0 FAIL de plantillas WhatsApp requiere consultar la WABA;
- smoke Docker y despliegue NAS no pudieron ejecutarse en este PC.

## Decisiones que necesita Pedro

1. Autorizar y fijar el SHA/ventana del despliegue NAS. Desbloquea la ejecución de `RELEASE-v4.3.md`.
2. Ejecutar el smoke en un host con Docker. Desbloquea F10 y acredita imagen, health, login y webhook 401.
3. Confirmar en el NAS las plantillas WhatsApp 7/1/0 y la firma real de Retell. Desbloquea el verde operativo de `doctor:v43`.
4. Revisar saldo Retell manualmente en Billing y decidir el umbral operativo humano. No se automatizará sin API/contrato oficial.
5. Aportar PVP real por candidato y, si se quiere volumétrico, el divisor contractual del transportista. Desbloquea economics completos sin supuestos.
6. Decidir en un commit futuro si se retira TEST_MODE. Mientras siga activo, solo la allowlist estricta puede recibir envíos o llamadas; ni rampa ni autorización puntual la saltan.

## Ensayo de migración

El ensayo aislado medido en este host tardó **47,6 ms**. Dentro de la suite varió aproximadamente entre 61 y 75 ms. Conservó exactamente 116 pedidos, 63 conversaciones, 349 mensajes, 180 outbox y 1.700 eventos; schema final 19 e `integrity_check=ok`.

## Trabajo no ejecutado

- No se construyó ni arrancó Docker porque el binario no está instalado.
- No se hicieron llamadas, envíos WhatsApp, escrituras Shopify ni activaciones de rampa.
- No se probaron endpoints Retell inventados ni se afirmó un saldo desconocido.
- No se desplegó al NAS ni se tocaron sus datos, auth o contenedores.
- Las cinco omisiones de la suite corresponden a preflights aislados que no pueden resolver `npx/tsx` sin registry en este Windows; el doctor real cubre esos comandos en el entorno de despliegue.

## Validación de build

El build de producción con Next.js 16.3.1 y webpack compiló correctamente, ejecutó TypeScript, generó 11 páginas estáticas y enumeró todas las rutas dinámicas. El intento Turbopack no pudo resolver `next/package.json` porque este worktree reutiliza `node_modules` del checkout padre; no se instaló una segunda copia ni se alteraron dependencias para ocultar esa limitación del entorno.
