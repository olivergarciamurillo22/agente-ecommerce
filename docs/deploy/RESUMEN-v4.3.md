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

---

## Continuación F17–F20

### Primero: números que Pedro debe revisar

Detalle y contexto completo en `docs/deploy/NUMEROS-SIN-FUENTE-v4.3.md`. Ningún valor fue modificado.

| Área | Valor actual | Decisión pendiente |
|---|---:|---|
| Primer recordatorio | 30 min | Confirmar/cambiar |
| Escalado a llamada | 120 min | Confirmar/cambiar |
| Selección de pedido | 45 min | Resolver contradicción con “media hora” |
| Selector repetido | 2 veces | Confirmar/cambiar |
| Duplicados | 48 h | Confirmar/cambiar |
| Pedidos visibles en selector | 5 | Confirmar/cambiar |
| Campaña de retrasos | 3 s entre envíos | Validar contra límites reales |
| Corte de campaña | 3 fallos | Confirmar/cambiar |
| Tope de llamadas | 30/día | Confirmar presupuesto/capacidad |
| Activación de llamada | 15 min | Confirmar/cambiar |
| Contactos por pedido | 5 | Confirmar política |
| Primer reintento de llamada | 120 min | Ratificar decisión del 24-08 |
| Horario de llamadas | 09–13 y 17–20, lun–sáb | Validar marco legal vigente |
| Fallos técnicos de llamada | 3 | Confirmar/cambiar |
| Llamada atascada | 10 min | Confirmar con latencia Retell |
| Espera de análisis | 30 min | Confirmar con SLA Retell |
| Fallback WhatsApp→llamada | 60 min | Confirmar interacción con escalado |
| Rellamada aceptable | −5 min / +30 días | Confirmar tolerancia/horizonte |
| Poll de pedidos | mín. 3 s; default 20 s | Ratificar en NAS |
| Backoff de tag Shopify | 10 min | Confirmar contra SLA/rate limit |
| Lote de pedidos | 20 acciones; scan 500 | Medir backlog y ratificar |
| Longitud de atribución | 250 caracteres | Ratificar para analítica |
| Texto de pedido | 300 / 500 caracteres | Ratificar truncamientos |
| Colas de llamadas | scan 500; due 500 | Medir backlog y ratificar |
| Poll de llamadas | mín. 15 s; default 60 s | Ratificar con SLA |
| Timeout de Retell | 15 s | Confirmar con SLA oficial |
| Búsqueda de hueco | 60 días | Mantener o documentar horizonte |

### Resultado de las fases

| Fase | Estado | Resultado |
|---|---|---|
| F17 | COMPLETA | `scripts/nas-verify-v43.sh` automatiza guardia, backups externos, build/recreate, doctor y smoke HTTP en orden fail-fast; exige `V43_BACKUP_ROOT` y conserva las confirmaciones humanas. |
| F18 | COMPLETA | `doctor:v43 -- --resumen` conserva PASS/WARN/FAIL, silencia detalle superfluo y muestra la salida íntegra de cada bloque FAIL. |
| F19 | COMPLETA | `MERGE-NOTAS-v4.3.md` compara solo con `origin/release/casamable-v4.2`, conserva los scripts base e inventaría los diez comandos añadidos. No se inspeccionó `feat/landing-ultima-milla`. |
| F20 | COMPLETA | Auditoría cerrada a pedidos, llamadas y configuración: 18 decisiones de negocio y 9 límites técnicos pendientes; ningún precio, margen, conversión, probabilidad o coste inventado. |

### Validación de esta continuación

- F17: 685 pruebas OK, 5 omitidas, 0 fallos; typecheck limpio; shell validado con `bash -n`.
- F18: 686 pruebas OK, 5 omitidas, 0 fallos; typecheck limpio.
- F19: 687 pruebas OK, 5 omitidas, 0 fallos; typecheck limpio.
- F20: 688 pruebas OK, 5 omitidas, 0 fallos; typecheck limpio.
- No hubo despliegue, llamadas, mensajes, escrituras externas, cambios de schema ni cambios de dependencias.
