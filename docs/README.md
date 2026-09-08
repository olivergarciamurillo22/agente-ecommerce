# Documentación — índice y jerarquía

Si un documento contradice a otro, manda el de SOURCE OF TRUTH; si dos de
esa lista chocan, manda `ESTADO-PRODUCCION.md` y hay que corregir el otro.
**Nunca trabajar desde `docs/archive/`.**

## SOURCE OF TRUTH

| Documento | Qué es |
|---|---|
| [ESTADO-PRODUCCION.md](ESTADO-PRODUCCION.md) | Lo que corre DE VERDAD en el NAS, hoy |
| [ARCHITECTURE.md](ARCHITECTURE.md) | El sistema entero en 2 páginas |
| [GOLDEN-PATH.md](GOLDEN-PATH.md) + [ACCEPTANCE-CRITERIA.md](ACCEPTANCE-CRITERIA.md) | El contrato operativo del flujo COD |
| [MODELO-ESTADOS.md](MODELO-ESTADOS.md) | Los 4 ejes de estado del pedido |
| [ENV-REFERENCE.md](ENV-REFERENCE.md) | Variables de entorno (fuente en código: `env-schema.ts`) |
| [PEDRO-RUNBOOK.md](PEDRO-RUNBOOK.md) / [OLIVER-RUNBOOK.md](OLIVER-RUNBOOK.md) | Qué hace cada uno en el día a día |
| [CONTROL-CENTER-V3.md](CONTROL-CENTER-V3.md) | Informe del cierre operativo+visual vigente |

## INTEGRATIONS

- WhatsApp: [META-WHATSAPP-MIGRATION.md](META-WHATSAPP-MIGRATION.md) · [META-CONTINGENCY-NO-ROLLBACK.md](META-CONTINGENCY-NO-ROLLBACK.md)
- Llamadas (Retell): [RETELL-LLAMADAS.md](RETELL-LLAMADAS.md) · [RUNBOOK-LLAMADAS.md](RUNBOOK-LLAMADAS.md) · prompt vigente: `config/retell/casamable-agent-prompt.md`
- Shopify: contrato dentro de `src/lib/shopify/` + [GOLDEN-PATH.md](GOLDEN-PATH.md)
- Beeping: [BEEPING-INTEGRATION.md](BEEPING-INTEGRATION.md) · [BEEPING-API-CONTRACT.md](BEEPING-API-CONTRACT.md)
- Dropea: [DROPEA-SETUP.md](DROPEA-SETUP.md) · [DROPEA-API-CONTRACT.md](DROPEA-API-CONTRACT.md)
- Dropi: [DROPI-API-CONTRACT.md](DROPI-API-CONTRACT.md) — **Dropi NO tiene API pública; no implementar writes sin evidencia nueva**
- Meta Ads: [META-ADS-INTEGRATION.md](META-ADS-INTEGRATION.md)
- Finanzas/Calculadora: [FINANCE-MODEL.md](FINANCE-MODEL.md) · [BUSINESS-METRICS.md](BUSINESS-METRICS.md)
- Cazador/Landing: estado del backend interno (08-09-2026, listo para revisión): [PRODUCT-HUNTER-BACKEND-ESTADO.md](PRODUCT-HUNTER-BACKEND-ESTADO.md) · **backend interno del Cazador (`PRODUCT_HUNTER_SOURCE=internal`, catálogo Dropea, hechos manuales, cruce Dropea × Ad Library): [PRODUCT-HUNTER-BACKEND-USO.md](PRODUCT-HUNTER-BACKEND-USO.md)** · plan e inventario: [PRODUCT-HUNTER-BACKEND-PLAN.md](PRODUCT-HUNTER-BACKEND-PLAN.md) · contrato: [PRODUCT-HUNTER-CONTRACT.md](PRODUCT-HUNTER-CONTRACT.md) · **buscador de competencia por una palabra: [HUNTER-BUSCADOR.md](HUNTER-BUSCADOR.md)** · **auditor de tiendas ganadoras (URL → catálogo + anuncios + ángulos citados; nicho → candidatas en cadena): [HUNTER-AUDITOR.md](HUNTER-AUDITOR.md)** · auditoría de bugs del discovery: [HUNTER-DISCOVERY-AUDITORIA.md](HUNTER-DISCOVERY-AUDITORIA.md) · [HUNTER-SPEC.md](HUNTER-SPEC.md) (pesos 40/35/0/10/10/5 y constantes con fuente) · evaluación del PI Engine de `hunter-end-to-end-v1` (solo análisis, 4 piezas a portar): [HUNTER-PI-ENGINE-EVALUACION-07-09.md](HUNTER-PI-ENGINE-EVALUACION-07-09.md) · [LANDING-STUDIO.md](LANDING-STUDIO.md)

## OPERATIONS

- **Deploy vigente: [deploy/RELEASE-v4.3.md](deploy/RELEASE-v4.3.md)** (canónica v4.3, esquema 15→29) · pasos del espacio de atención (crear usuarios): [deploy/PEDRO-WORKSPACE-05-09.md](deploy/PEDRO-WORKSPACE-05-09.md)
- **Informe del despliegue de v4.3 en el NAS (07-09-2026, commit `22f8013`, esquema 17→30, incidente de plantilla resuelto): [deploy/DEPLOY-REPORT-v4.3-2026-09-07.md](deploy/DEPLOY-REPORT-v4.3-2026-09-07.md)**
- **Semáforo pre-despliegue (un solo comando): [deploy/PREDESPLIEGUE.md](deploy/PREDESPLIEGUE.md)** · resumen de incidencias abiertas: [deploy/RESUMEN-OPERATIVO.md](deploy/RESUMEN-OPERATIVO.md) · Migración v4.3 (ensayo sintético + `migration:verify` sobre copia): [deploy/MIGRATION-v4.3.md](deploy/MIGRATION-v4.3.md) · identidad de build y `PRODUCTION_COMMIT`: [deploy/NAS-PRODUCTION.md](deploy/NAS-PRODUCTION.md)
- Auditoría de números sin fuente (incluye el código del 07-09): [deploy/NUMEROS-SIN-FUENTE-v4.3.md](deploy/NUMEROS-SIN-FUENTE-v4.3.md) · hallazgos de casos borde: [deploy/HALLAZGOS-BORDES-07-09.md](deploy/HALLAZGOS-BORDES-07-09.md)
- **Rollback de v4.3 (apagar flags primero, volver el codigo despues): [deploy/ROLLBACK-v4.3.md](deploy/ROLLBACK-v4.3.md)** · mecánica general: [deploy/ROLLBACK.md](deploy/ROLLBACK.md)
- Deploy anterior: [DEPLOY-HOTFIX-02-09.md](DEPLOY-HOTFIX-02-09.md) (incluye rollback)
- Piloto en curso: [REAL-PILOT-02-09.md](REAL-PILOT-02-09.md) (matriz única de evidencia)
- NAS: [UGREEN-DXP2800-DEPLOY.md](UGREEN-DXP2800-DEPLOY.md)
- Local: [LOCAL-ENV-SETUP.md](LOCAL-ENV-SETUP.md)
- Panel Sistema: [SYSTEM-CONTROL-CENTER.md](SYSTEM-CONTROL-CENTER.md)
- Atención al cliente (roles/acceso): [WORKSPACE-ACCESO.md](WORKSPACE-ACCESO.md)
- **Cómo responde el bot (reglas de conversación): [CONVERSACION-REGLAS.md](CONVERSACION-REGLAS.md)**
- Validación de direcciones (determinista + IA, ALERTA_DIRECCION): [VALIDACION-DIRECCION-IA.md](VALIDACION-DIRECCION-IA.md) · coste y tope diario de las llamadas a OpenAI: [COSTE-IA.md](COSTE-IA.md)
- Auto-despacho tras cooldown + IA de intención (apagado por defecto; FAQ aprobada 07-09; auto-cancelación por IA): [AUTO-DESPACHO-COOLDOWN.md](AUTO-DESPACHO-COOLDOWN.md)
- Retención/PII: [DATA-RETENTION.md](DATA-RETENTION.md) · Errores: [ERROR-MODEL.md](ERROR-MODEL.md)
- Colaboración git: [COLLABORATION.md](COLLABORATION.md)
- QA visual pendiente: [UI-V3-VISUAL-QA.md](UI-V3-VISUAL-QA.md)

## CONTEXTOS DE SESIÓN (el más reciente manda sobre los anteriores; ninguno manda sobre SOURCE OF TRUTH)

- [CONTEXTO-2026-09-06.md](CONTEXTO-2026-09-06.md) — consolidación de ramas en `release/casamable-v4.3`, constantes del Hunter, aislamiento de `platform-companies`, bloqueadores de despliegue y cola de tareas
- Los contextos del 01-09 y del 03-09 viven en las ramas `docs/contexto-2026-09-01` y `docs/contexto-2026-09-03` de `origin`, sin mergear en la canónica

## ARCHIVE

- [archive/sesiones-2026-08/](archive/sesiones-2026-08/) — contextos, planes e informes de agosto (superados; solo auditoría)
- [archive/kit/](archive/kit/) — documentación del kit genérico original
