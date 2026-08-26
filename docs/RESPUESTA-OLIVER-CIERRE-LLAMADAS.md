# Respuesta de Óliver — decisión del fail-closed de llamadas (26-08, noche)

## Decisión (a vuestras dos preguntas)

**Sí al interruptor propio. Ya está implementado, testeado y pusheado** — no
cuelga de `TEST_MODE` en ninguna dirección:

- Nueva llave: **`calls_pilot_mode`** (settings, cambiable sin desplegar) con
  fallback `CALLS_PILOT_MODE` (.env). Semántica fail-closed del repo:
  - `1` **o sin definir** = PILOTO: allowlist vacía = **NADIE**.
  - `0` **explícito** = PRODUCCIÓN de llamadas: vacía = sin restricción,
    con kill switch, cap diario y franja horaria **siempre** delante.
- `TEST_MODE` deja de pintar nada en el gate de llamadas (test dedicado en
  ambas direcciones). Sigue gobernando WhatsApp/Shopify/elegibilidad, como
  hasta ahora.
- Nuevo comando para no abrir sqlite a mano:
  `npm run calls:mode -- production | pilot | status` (imprime además "a
  quién se llamará" con el estado completo).

## Cómo desbloquear las llamadas antes de las 9:00 — dos vías, elegid una

**Vía A (recomendada) — hotfix mínimo sobre vuestra rama.**
Rama `hotfix/calls-pilot-switch` = `c6cc226` (lo que ya corre) **+ 1 commit**
(`f08cd87`): el interruptor, su test y `calls:mode`. 464 tests OK, typecheck
y build verdes. En el NAS:

```bash
docker compose exec casamable-agent npm run backup
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo fetch origin
docker run --rm -v "$PWD/repo:/repo" alpine/git -c safe.directory=/repo -C /repo checkout f08cd87
docker compose up -d --build --force-recreate casamable-agent
docker compose exec casamable-agent npm run calls:mode -- production
docker compose exec casamable-agent npm run calls:mode    # verificar
```

Diff mínimo, misma rama, rollback = volver a `c6cc226`.

**Vía B — desplegar `main` completo** (el cierre operativo: Action Center,
duplicados a la entrada, watchdog, esquema 11). Ya incluye el interruptor.
Guía paso a paso en `docs/PEDRO-DEPLOY-OPERACIONAL.md` (incluye el paso
`calls:mode -- production` antes de las 9:00). Es más cambio: si la hacéis,
mejor mañana temprano con la media hora de observación, no a las 8:55.

**Si no da tiempo a ninguna:** no se rompe nada permanente — los pedidos
`needs_call` **esperan en cola**, no se pierden; se llaman al desbloquear.
El coste es solo el retraso de ese día.

## Tres cosas más de vuestro informe

1. **Método de pago de Retell**: de acuerdo, es lo más urgente de la lista.
   Con llamadas en producción y crédito de prueba, el agotamiento es un corte
   silencioso. El panel ya avisa con 3 fallos seguidos, pero el saldo no se
   puede leer por API: ponedle pago esta semana.
2. **`subscribed_apps` (hallazgo 3.2)**: gran caza. Lo añado al checklist del
   piloto; cuando toque Coexistence, comprobación obligatoria post-alta.
3. **Higiene de secretos**: en el último intercambio viajó un `.env` completo
   con valores reales (firma de webhook, client secret, token, contraseña del
   panel). Dadlos por **expuestos y rotadlos** cuando haya hueco tranquilo —
   ahora con el doble HMAC desplegado, rotar el webhook secret es seguro
   (se cambia en Shopify y en el .env, y el client secret cubre el hueco).
   Y como norma: los `.env` no se pegan en chats, ni siquiera entre nosotros.

## Estado de Git tras esta noche

- `main` = cierre operativo + interruptor de llamadas (`70680b5`), 493 tests.
- `hotfix/calls-pilot-switch` = `c6cc226` + interruptor (`f08cd87`), 464 tests.
- `fix/hardening-casamable` intacta (no se ha movido lo que corre el NAS).
