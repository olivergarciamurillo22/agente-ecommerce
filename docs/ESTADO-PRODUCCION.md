# Estado de producción — Casamable™

Documento vivo: **lo que corre de verdad en el NAS**. Se actualiza en cada
sesión de operación. El detalle de cómo se llegó a cada estado vive en
`docs/archive/` — este es el snapshot, no el historial.

**Última actualización: 03-09-2026.**

---

## 1 · Qué corre hoy

| | |
|---|---|
| Rama desplegada | `feat/casamable-control-center-v2` |
| Commit desplegado | `67f05c7` (según Pedro, 02-09) — pendiente de confirmar con `PRODUCTION_COMMIT=` |
| Esquema SQLite | **15** |
| Contenedor | `casamable-agent`, healthy, `restart: unless-stopped` |
| NAS | UGREEN DXP2800, `192.168.2.109` |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | **Cloud API oficial de Meta** (`WHATSAPP_PROVIDER=cloud_api`), número `+34 641 308 254` |
| Modo | `APP_MODE=production` · `TEST_MODE=1` (solo allowlist) · `WHATSAPP_SEND_ENABLED=1` |
| Llamadas (Retell) | Instalado, **MANUAL-ONLY** (el scheduler no marca solo), kill switch cerrado |
| Dropea | read-only, `DROPEA_WRITE_ENABLED=0`, creación vía su app oficial |
| Dropi | sin API (solo diagnóstico), sincronización de su app desactivada |
| Beeping | **apagado** (sin credencial; todo fail-closed) |
| Meta Ads | read-only, funcionando (cuenta `act_1365655995103103`, EUR, Europe/Madrid) |

## 2 · Incidentes abiertos (02-09) y su estado en código

1. **WhatsApp 132001** — el primer mensaje enviaba un nombre de plantilla
   inexistente en la WABA. **Arreglado en la rama v3** (mapping lógico →
   `pedido` con verificación obligatoria vía `whatsapp:templates:doctor`);
   pendiente de desplegar y verificar en el NAS.
2. **Tracking claim-antes-del-gate** y placeholders "No disponible" —
   **arreglados en v3**; pendiente de desplegar.
3. **Retell "[password 1]"** — preflight de variables + versión de agente
   fijable (`RETELL_AGENT_VERSION`) + prompt versionado en
   `config/retell/casamable-agent-prompt.md`. Pendiente de: pegar prompt,
   publicar versión, doctor y llamada de prueba.

## 3 · Qué falta para mover producción

Rama candidata: `feat/control-center-v3-operational-polish` (esquema 17;
migraciones aditivas). Guía exacta: `docs/DEPLOY-HOTFIX-02-09.md`.
Evidencia del piloto: `docs/REAL-PILOT-02-09.md` (matriz única — ambos
circuitos en BLOCKED hasta que Pedro pegue resultados).

## 4 · Lo que no se toca

`DROPEA_WRITE_ENABLED=0` · `BEEPING_*=0` · defaults fail-closed ·
`EMERGENCY_STOP` semántica fail-closed · llamadas MANUAL-ONLY hasta piloto
verificado · franja de despliegue: nunca 10:00–21:00 (corta WhatsApp).
