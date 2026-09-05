# Reporte de contexto — cambios de las últimas 24 horas

**Fecha del informe:** 5 de septiembre de 2026  
**Periodo revisado:** desde el 4 de septiembre de 2026 a las 12:49 hasta el 5 de septiembre de 2026.  
**Alcance:** commits, ramas, worktrees y referencias remotas disponibles en el repositorio.

## Resumen ejecutivo

Durante el periodo se trabajó en cinco bloques principales:

1. Correcciones de WhatsApp.
2. Integración Beeping para marcar pedidos como listos para enviar.
3. Hunter predictivo con estimaciones y scraping público.
4. Hunter Discovery mediante Meta Ad Library.
5. Preparación del workspace de atención y del tren de release v4.3.

Situación general al cierre:

- No se desplegó ningún cambio en producción.
- Beeping es la única rama funcional nueva confirmada como publicada en `origin`.
- WhatsApp, Hunter predictivo y Hunter Discovery continúan en ramas locales.
- Conviven evoluciones del esquema 17, 18, 19, 20 y 21.
- `release/casamable-v4.3` no contiene las dos últimas correcciones del workspace.
- El despliegue al NAS se intentó iniciar, pero `192.168.2.109:22` no respondió por red o SSH.

## 1. Correcciones de WhatsApp

**Rama:** `fix/whatsapp-confirmacion-bugs`  
**Commit actual:** `3f44987`  
**Estado:** worktree limpio, rama local sin upstream publicado detectado.

Cambios realizados:

- Bloqueo de confirmaciones cuando la dirección parece sospechosa o insuficiente.
- Uso obligatorio de la plantilla aprobada de WhatsApp para confirmar.
- Escalado a atención humana de cancelaciones expresadas en texto libre.
- Consulta para recuperar el último pedido del cliente por teléfono.
- Documentación específica del hotfix.
- Ampliación de pruebas de confirmación, direcciones y mensajes interactivos.

Magnitud: 9 archivos modificados, 304 inserciones y 81 eliminaciones.

Validación registrada:

- 662 pruebas correctas.
- TypeScript correcto.
- El esquema permanece en versión 17.

Aunque se modificó `src/lib/db.ts`, fue para añadir una consulta de lectura. No contiene migraciones, DDL ni incremento de `SCHEMA_VERSION`.

También existe el commit independiente `36deb875`, relacionado con el enrutamiento a una persona después de una cancelación.

## 2. Integración Beeping

**Rama:** `feat/beeping-mark-to-send`  
**Commit:** `1207b90`  
**Estado:** worktree limpio y rama publicada en `origin/feat/beeping-mark-to-send`.

Cambios realizados:

- Nuevo adaptador de Beeping.
- Marcado automático como listo para enviar después de confirmar válidamente un pedido.
- Los errores 404, 500 o timeout no revierten la confirmación.
- Integración desactivada por defecto mediante `BEEPING_INTEGRATION_ENABLED=0`.
- Configuración mediante URL, email y contraseña.
- Runbook y pruebas específicas.

Magnitud: 5 archivos modificados y 188 inserciones.

Validación registrada:

- 666 pruebas correctas.
- TypeScript correcto.
- El esquema permanece en versión 17.
- No hay migraciones ni cambios de schema.

Pendientes antes de activarla:

- Incorporar credenciales reales de Beeping.
- Confirmar la responsabilidad del estado posterior en Dropea o Beeping.
- Mantener el flag apagado hasta completar una prueba controlada.

La rama no se ha fusionado en ninguna release.

## 3. Hunter predictivo

**Rama:** `feat/hunter-predictivo`  
**Commit actual:** `491709d`  
**Estado:** worktree limpio y rama local sin publicación detectada en `origin`.

### Estimación predictiva

El commit `96285e8` incorporó:

- Estimaciones de coste y PVP.
- Rangos logísticos y de viabilidad.
- Persistencia con caducidad de 30 días.
- Separación estricta entre estimaciones y score real.
- Promoción únicamente mediante `--promover`.
- CLI, repositorio, documentación y pruebas.

### Scraping público

El commit `491709d` incorporó:

- Proveedor configurable `scraping_publico`.
- Búsquedas independientes en AliExpress, 1688 y Alibaba.
- Timeout corto y un único reintento.
- Registro de las URLs exactas utilizadas.
- Fuentes bloqueadas marcadas como `no_disponible`.
- Media calculada exclusivamente con fuentes que aportan datos.
- Confianza baja cuando solo responde una fuente.
- Prohibición de asignar confianza alta a estos datos.
- Conservación de `sin_acceso_a_busqueda: true` si fallan todas las fuentes.

Resultado de la comprobación real:

- AliExpress respondió, pero no presentó precios EUR aprovechables en el HTML visible.
- 1688 devolvió contenido vacío o no utilizable.
- Alibaba presentó captcha.
- El sistema falló de forma segura y no inventó precios.

Magnitud acumulada: 11 archivos modificados, 650 inserciones y 9 eliminaciones.

El esquema alcanza la versión 20 mediante la tabla `hunter_predictive_estimates`.

Los parsers son inherentemente frágiles: las páginas usan renderizado dinámico y medidas antibot, por lo que un cambio del HTML puede inutilizar una fuente sin previo aviso.

## 4. Hunter Discovery

**Rama:** `feat/hunter-discovery`  
**Commit actual:** `4d834d5`  
**Estado:** worktree limpio y rama local sin publicación detectada.

Commits principales:

- `e121eb5`: integración con Meta Ad Library.
- `4d834d5`: mapa de pain points del nicho de abuelos y ampliación de búsquedas.

Cambios realizados:

- Cliente de `/ads_archive` en modo lectura.
- Paginación mediante cursor.
- Captura de límites de uso.
- Pruebas independientes de campos disponibles.
- Agrupación por página y similitud Jaccard.
- Filtros de ruido.
- Momentum basado en una segunda captura, evitando inferencias con una sola muestra.
- CLI principal y herramienta de diagnóstico.
- Configuración ampliada de 8 a 26 términos de búsqueda.
- Documento sobre problemas cotidianos del nicho de mayores de 60 años.

Prueba real de Meta:

- El token local había caducado el 2 de septiembre.
- Los 14 campos comprobados devolvieron HTTP 401, código Graph 190.
- Ningún campo se marcó falsamente como válido.

Magnitud: 15 archivos modificados, 474 inserciones y 8 eliminaciones.

Validación registrada:

- 684 pruebas correctas.
- TypeScript correcto.
- El esquema alcanza la versión 21.

Tablas incorporadas:

- `adlib_queries`
- `adlib_candidates`
- `adlib_candidate_snapshots`

## 5. Workspace de atención al cliente

**Candidato publicado:** `dd15a445`  
**Referencias remotas:** `origin/release/casamable-v4.2` y `origin/feat/workspace-atencion-cliente`.

Cambios finales:

- Corrección del proxy para clasificar correctamente a staff y propietario.
- La autorización definitiva queda en manos de cada handler.
- Actualización del runbook de despliegue.
- Actualización de la fuente de verdad sobre el estado de producción.
- Protección de endpoints de conversaciones, pedidos, Beeping, costes, mappings y eventos.

Últimos commits:

- `7fd8014`: corrección de autorización en el proxy.
- `dd15a44`: documentación de despliegue y estado.

El worktree local `feat/workspace-atencion-cliente` está dos commits por detrás de su propia referencia remota. El candidato correcto es `dd15a445`, no el checkout local atrasado.

El esquema de esta línea es la versión 18.

### Estado del despliegue

El despliegue fue autorizado sin restricción horaria, pero el NAS configurado como `192.168.2.109:22` no respondió:

- No hubo conectividad útil.
- SSH no estuvo disponible.
- No se modificó producción.
- No se ejecutaron migraciones remotas.
- No hubo cambios en Shopify ni en otros servicios externos.

## 6. Tren de release v4.3

**Rama:** `release/casamable-v4.3`  
**Commit actual:** `6b09797`  
**Estado:** worktree limpio, rama local sin upstream propio; aparece 44 commits por delante y 2 por detrás de `origin/release/casamable-v4.2`.

La rama contiene 17 fases recientes de preparación, entre ellas:

- Registro de bloqueos de rampa.
- Documentación del saldo de Retell.
- Rango de fechas de Meta Ads.
- Prueba realista de migración a schema 19.
- Aceptación del workspace de agentes.
- Smoke de Docker documentado.
- Runbook para NAS.
- Doctor de release.
- Trazabilidad redactada de pedidos.
- Fixture de pedido.
- Protección contra uso accidental de clientes reales.
- Verificación automática del NAS.
- Inventario de scripts y merges.
- Control de números sin fuente.
- Cierre documental de la release.

Magnitud desde su punto de divergencia: 86 archivos modificados, 2.838 inserciones y 89 eliminaciones.

La rama está dos commits por detrás de la release v4.2 publicada. Le faltan:

- `7fd8014`: corrección de autorización.
- `dd15a44`: runbook y fuente de verdad.

Por ello, `release/casamable-v4.3` no debe desplegarse sin reconciliar antes estos commits.

El esquema de esta rama es la versión 19.

## 7. Mapa de versiones de schema

| Línea de trabajo | Schema |
| --- | ---: |
| WhatsApp hotfix | 17 |
| Beeping | 17 |
| Workspace publicado | 18 |
| Hunter Landing Studio | 19 |
| Release v4.3 | 19 |
| Hunter predictivo | 20 |
| Hunter Discovery | 21 |

Las ramas no deben fusionarse en un orden arbitrario. La evolución lógica observada es:

`17 → 18 → 19 → 20 → 21`

Antes de integrar Hunter predictivo o Hunter Discovery en una release se debe verificar que sus migraciones conserven las incorporadas por workspace y Landing Studio.

## 8. Estado de ramas y worktrees

| Rama | Commit | Publicación | Estado |
| --- | --- | --- | --- |
| `feat/beeping-mark-to-send` | `1207b90` | Publicada | Limpia |
| `fix/whatsapp-confirmacion-bugs` | `3f44987` | Solo local | Limpia |
| `feat/hunter-predictivo` | `491709d` | Solo local | Limpia |
| `feat/hunter-discovery` | `4d834d5` | Solo local | Limpia |
| `release/casamable-v4.3` | `6b09797` | Sin upstream propio | Limpia; divergente 44/2 |
| `feat/workspace-atencion-cliente` | `dbc16cf` local | Remoto en `dd15a445` | Checkout local atrasado 2 commits |

El checkout principal muestra entradas modificadas o no seguidas bajo `.worktrees/`. Son artefactos de los worktrees anidados y deben mantenerse fuera de cualquier commit funcional.

## 9. Riesgos y siguiente paso recomendado

Riesgos principales:

- Divergencia entre las ramas de release y workspace.
- Convivencia de migraciones de schema 18 a 21.
- Fragilidad natural del scraping público.
- Token de Meta Ad Library caducado.
- NAS inaccesible, lo que impide verificar o ejecutar el despliegue.

Siguiente secuencia segura:

1. Incorporar en `release/casamable-v4.3` los dos commits finales del workspace.
2. Ejecutar la suite completa y las comprobaciones de autorización.
3. Integrar las líneas funcionales una a una y respetando el orden de schema.
4. Ejecutar pruebas y validar las migraciones después de cada integración.
5. Recuperar conectividad con el NAS.
6. Ejecutar el doctor y el procedimiento de despliegue documentado antes de tocar producción.

## Conclusión

El trabajo de las últimas 24 horas está implementado y probado por bloques, pero todavía distribuido en ramas divergentes. Beeping y el workspace actualizado tienen referencias remotas; WhatsApp, Hunter predictivo y Hunter Discovery continúan locales. Producción permanece sin cambios y el principal requisito antes de desplegar es reconciliar las ramas y validar ordenadamente los schemas 18 a 21.
