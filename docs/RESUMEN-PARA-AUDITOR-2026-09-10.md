# Casamable™ — Resumen completo para auditoría externa

**Fecha del documento:** 10-09-2026
**Destinatario:** un auditor (humano o IA) que no ha visto el desarrollo y necesita entender, en una sola lectura, qué se ha construido, qué está funcionando de verdad, qué está construido pero no verificado, y qué queda.
**Rama de referencia:** `release/casamable-v4.3` @ `fc4770a` (último commit, 09-09-2026 18:14).

> **Cómo leer este documento.** Cada afirmación va marcada con su grado de
> evidencia:
> **[V]** verificado con una ejecución real y su salida;
> **[T]** cubierto por test automatizado con red inyectada (no prueba el
> comportamiento de terceros, prueba el nuestro);
> **[D]** declarado por Pedro (el dueño del negocio) y no verificable desde
> el repositorio;
> **[P]** pendiente de verificación en vivo.
> Nada en este documento es una estimación disfrazada de dato. Donde no hay
> número, se dice que no hay número.

---

## 1 · Qué es este sistema, en una frase

Casamable™ es una tienda de venta contra reembolso (COD) en España. Este
repositorio contiene **dos sistemas distintos que comparten base de datos y
panel**:

1. **El núcleo operativo (el negocio real, encendido):** recibe pedidos de
   Shopify por webhook, confirma cada pedido con el cliente por WhatsApp,
   gestiona correcciones de dirección, notas al repartidor, cancelaciones,
   y despacha al proveedor. Es determinista: no hay IA decidiendo si se
   envía un pedido.
2. **El Cazador de productos (herramienta interna de investigación, en
   rodaje):** busca en la biblioteca de anuncios de Meta qué productos se
   están vendiendo con éxito, los cruza con el catálogo del proveedor
   (Dropea), y produce informes de auditoría por producto y por tienda
   competidora para decidir qué vender a continuación. No toca el flujo de
   pedidos ni envía nada a clientes.

La distinción importa para auditar: **un fallo en el Cazador no puede
afectar a un cliente**; un fallo en el núcleo sí. Los controles de seguridad
del núcleo son más duros por eso.

---

## 2 · Cronología y esfuerzo real

| Dato | Valor | Evidencia |
|---|---|---|
| Primer commit del proyecto | **20-08-2026** (`1db499d`, «MVP Casamable: confirmación de pedidos COD por WhatsApp») | [V] `git log --reverse` |
| Último commit | **09-09-2026 18:14** (`fc4770a`) | [V] |
| Duración natural | **21 días** (20-08 → 09-09) | [V] |
| Días con commits | **14 días** | [V] |
| Commits totales en la rama | **319** | [V] `git rev-list --count HEAD` |
| Pico de actividad | 26-08 (50 commits), 07-09 (38), 05-09 (33) | [V] |
| Código TypeScript | **87.249 líneas** en **409 ficheros** (`src/`, `scripts/`, `tests/`) | [V] `wc -l` |
| Documentación | **61 documentos** en `docs/` + **17** en `docs/deploy/` | [V] |
| Esquema de base de datos | versión **32**, **55 tablas** | [V] `SCHEMA_VERSION`, `db.ts` |
| Suite de tests | **819 en verde, 5 omitidos, 0 fallos** (una sola suite, `npm test`) | [V] ejecutada el 09-09 |

**Lectura para el auditor:** son 21 días naturales, no 21 días-persona. El
ritmo (319 commits, 87k líneas) corresponde a desarrollo asistido por IA con
un único responsable de negocio validando. Eso tiene una consecuencia
auditable: **la cobertura de tests es alta en el código propio y nula en el
comportamiento de terceros** (Meta, Shopify de la competencia, Dropea). Todo
lo que dependa de un tercero está marcado [P] hasta que se ejecuta contra
ese tercero.

---

## 3 · Qué está en producción hoy

**Infraestructura** [V] según `docs/ESTADO-PRODUCCION.md` y los informes de
despliegue:

| | |
|---|---|
| Servidor | NAS UGREEN DXP2800 en local (`192.168.2.109`), contenedor Docker `casamable-agent`, `restart: unless-stopped` |
| Acceso público | `https://agente.casamable.es` (VPS Hetzner → Caddy → WireGuard → NAS:3000) |
| WhatsApp | **Cloud API oficial de Meta**, número dedicado `+34 641 308 254` |
| Modo | `APP_MODE=production`, `WHATSAPP_SEND_ENABLED=1` |
| Rollout | **Activo a clientes reales** [D] confirmado por Pedro el 08-09 |
| Volumen (08-09) | **136 pedidos · 80 conversaciones · 474 mensajes** [V] recuento en base |

**Historial de despliegues:**

| Fecha | Qué se desplegó | Esquema | Evidencia |
|---|---|---|---|
| 07-09 | `release/casamable-v4.3` (`22f8013`): workspace de atención, Hunter, Landing Studio, predictivo, discovery, hotfix de plantilla | 17 → 30 | `docs/deploy/DEPLOY-REPORT-v4.3-2026-09-07.md` |
| 08-09 ~23:40 | Dos fixes de seguridad (`f2af494`) | 30 (sin cambio) | `docs/deploy/DEPLOY-REPORT-fixes-2026-09-08.md` |
| 08-09 / 09-09 | Cazador interno (cruce Dropea × Ad Library), merge `a4b3766` | 30 → 31 | commit + runbook |
| 09-09 | Deep dive (nivel 2) y búsquedas 2 y 3 | 31 → 32 | [D] Pedro confirma que búsqueda 3 corre en producción |

**Incidente relevante para la auditoría (cerrado):** el 06-09 la plantilla
aprobada de WhatsApp pasó de 4 a 5 variables en el gestor de Meta y el
contrato local seguía en 4. El sistema **bloqueó los envíos en vez de
enviar un mensaje roto**: 3 fallos en la cola de salida, ningún cliente con
mensaje incorrecto, ningún pedido atascado. Corregido el 07-09. Es el
comportamiento deseado (fail-closed) y quedó documentado.

---

## 4 · El núcleo operativo: qué hace y qué lo protege

### 4.1 Flujo del pedido

1. Shopify manda el webhook de pedido creado (verificación HMAC obligatoria).
2. Se detecta que es contra reembolso por la etiqueta `releasit_cod_form`.
3. Se normaliza el pedido y se programa la confirmación por WhatsApp.
4. El cliente responde: **1** confirmar · **2** corregir dirección · **3**
   nota para el repartidor.
5. Máquina de estados: confirmado, esperando nota, dirección dudosa,
   cancelado, despachado.
6. Despacho al proveedor por canal según producto (`dispatch_channels`).

### 4.2 Controles de seguridad (esto es lo que un auditor debe verificar primero)

| Control | Qué hace | Dónde |
|---|---|---|
| `EMERGENCY_STOP` | Interruptor maestro. **Por defecto ACTIVADO**: solo `EMERGENCY_STOP=0` explícito lo desactiva. Con él puesto no sale ni un mensaje de WhatsApp, ni una escritura a Shopify, ni una búsqueda a Meta, ni una lectura de web ajena | `src/lib/safety.ts` |
| `canSendRealWhatsApp()` | Toda salida a WhatsApp pasa por aquí. No existe ninguna ruta alternativa | `safety.ts` |
| `canWriteToShopify()` / `canWriteToSupplier()` | Igual para escrituras en Shopify y en el proveedor | `safety.ts` |
| `TEST_MODE` + allowlist | En piloto, solo números en lista blanca; lista vacía = nadie | `safety.ts` |
| Tope diario de IA | Contador por tipo de llamada sobre tabla `ai_call_log`, no sobre un contador en memoria (dos procesos comparten SQLite) | `src/lib/system/ai-budget.ts` |
| Fail-closed en direcciones | Si la IA de validación falla o duda, el veredicto es «dudosa» y abre alerta; **nunca** «correcta» por defecto | `orders/address-ai.ts` |
| Guardrails de precios y enlaces | El bot no puede decir un precio que no esté en la lista autorizada | `guardrails.ts` |

**Verificado [T]:** hay tests que comprueban que una consulta que revienta no
devuelve un número plausible, que «sin datos» y «error» son estados
distintos, y que una métrica compuesta con una parte rota se degrada en vez
de borrarse. Esto es relevante: **el sistema está diseñado para no inventar
datos**, y eso está probado.

---

## 5 · El Cazador de productos: el trabajo de los últimos 3 días

Es la parte más nueva y la que más ha crecido (09-09 completo). Son **tres
búsquedas distintas** sobre la misma maquinaria.

### 5.1 Nivel 1 — el cruce (desplegado, con reservas)

`npm run hunter:cruce-dropea -- --limite 20`

Toma productos del catálogo local de Dropea, extrae 2-4 palabras clave del
nombre, busca cada una en la biblioteca de anuncios de Meta, y puntúa
(«Score de Oportunidad Validada», 0-100) según antigüedad del anuncio,
margen contra el coste del proveedor y confianza del match.

**⚠ Advertencia crítica para el auditor:** este Score tiene **seis defectos
conocidos y documentados (C1–C6)** en `docs/AUDITORIA-PROFESIONAL-2026-09-08.md`,
y **los seis siguen abiertos en el nivel 1** [V, comprobado en código el
10-09]. Solo uno (C2) queda neutralizado más adelante, en el nivel 2:

| Id | Defecto | Estado |
|---|---|---|
| C1 | La validación y el precio miden al **anunciante**, no al producto: si una página vende un cortaúñas y once lupas, el cortaúñas hereda la antigüedad y el precio de la lupa | **Abierto** |
| C2 | Match por subcadena: «cama» casa con «cámara», «gel» con «ángel» (`cruce.ts:121` sigue con `text.includes(k)`) | **Abierto en el nivel 1**; neutralizado en el nivel 2 por el gate de producto |
| C3 | La «confianza del match» es prácticamente una constante, no una señal | **Abierto** |
| C4 | Un producto cuya consulta a Meta falló se guarda como «no» y **se salta para siempre** | **Abierto** |
| C5 | El coste sale de una variante arbitraria del producto (colchón 89 € vs recambio 3 €) | **Abierto** |
| C6 | El precio puede ser el de otra cosa mencionada en el mismo anuncio | **Abierto** |

**Condición vigente, acordada con Pedro y respetada en todo el código:**
> **El Score del nivel 1 NO se usa como criterio de compra de stock hasta
> corregir C1–C6.** Sirve para priorizar qué mirar, no para decidir qué
> comprar.

Esta condición es la razón de ser del nivel 2.

### 5.2 Nivel 2 — el «deep dive» (el informe que sustituye a mirar el anuncio 20 minutos)

`npm run hunter:deep-dive -- --ids 12,45` · `--min-score 60 --limite 3`

Por candidato, en este orden, y **cada paso declara su motivo si no pudo
hacerse** (nunca se rellena con una estimación):

| Paso | Qué hace | Coste |
|---|---|---|
| 0a · Saturación | Repite la búsqueda por palabra: cuántas **otras** tiendas anuncian lo mismo ahora | 1 petición |
| 0c · España (solo búsqueda 2) | Comprobación **obligatoria** de competencia en España | 1 petición |
| 0b · Radiografía de cuenta | Todos los anuncios de la página (activos e inactivos): antigüedad real, volumen, ángulos ganadores con cita literal, avatar, ritmo de testeo | ≤ 5 peticiones |
| 1 · Dominio | Sale del texto declarado bajo el anuncio | 0 |
| 2 · Catálogo | Portada + `/products.json` de la tienda | 2-4 |
| 3 · Producto | Casa las palabras clave con el catálogo real | 0 |
| **3b · GATE** | **Corta aquí si no es el mismo producto** | 0 |
| 4 · Precio y margen | Precio real del catálogo, margen contra coste de Dropea, y **coherencia** con el precio que dice el propio anuncio (alerta si difieren) | 0 |
| 5 · Ángulos | Clasificación del texto con cita literal | 0 |
| 6 · Creatividad | Imagen (visión por Claude) y vídeo (guion transcrito por OpenAI, **solo audio**) | 1-3 |
| 7 · Veredicto | Reglas escritas, recomendación con motivo en una frase, enlace público del anuncio | 0 |

**El gate de producto (paso 3b) es el control de calidad más importante del
Cazador** y se construyó tras ver 20 auditorías reales que gastaron trabajo
caro en productos equivocados:

- «Peine piojos» casaba con «PEINE PUA ESPECIAL CARBONO» (margen −196 %)
- «Purificador de aire ozono» con «Detector de calidad del aire» (categoría distinta)
- «Botella reutilizable» con «Botella Soluto Champú» (margen −57 %)
- «Ventilador doble» con una cuenta de mini-PCs

Ahora el gate exige cobertura ≥ 60 % por raíz, que esté la palabra
principal, que coincidan ≥ 60 % de las palabras **específicas** (no cuentan
«aire», «digital», «plástico»), y que el tipo declarado no contradiga.
Cuando corta, el veredicto es `SKIP_NO_MATCH` (corte temprano por coste, no
un veredicto) y **ahorra entre 2 y 7 peticiones a Meta por candidato** [T].

**Vocabulario de veredictos** (para que el auditor sepa leer un informe):

- `ganador_probable` · `senal_debil` · `descartar` · `no_verificable` · `skip_no_match`
- Recomendación: `contactar_dropea_muestra` · `verificar_manual` · `descartar` · `skip_no_match`
- Sin proveedor: `senal_fuerte_sin_proveedor` · `senal_debil_sin_proveedor`
- Por tienda: `perfil_tienda_cod_generica` (sí/no) y diversidad `disperso` / `concentrado` / `empresa_estructurada` / `insuficiente`

### 5.3 Búsqueda 2 — validados fuera de España, sin competencia aquí

`npm run hunter:cruce-dropea -- --pais IT,PT,FR,DE` → `hunter:deep-dive --ids …`

Busca en otros mercados (traduciendo las palabras clave al idioma del país
con Claude si hay clave) y luego **comprueba España obligatoriamente**: si
hay 1 o más anuncios activos con match en España, el candidato se descarta
aunque el veredicto sea ganador. Si España no se pudo comprobar, **nunca**
recomienda contactar. Regla dura, no sugerencia [T].

**Límite honesto documentado:** fuera de la UE (México, EE. UU.) Meta solo
archiva anuncios políticos y sociales, así que un «0 anuncios» ahí no
significa nada. La lista fiable empieza por IT, PT, FR, DE.

### 5.4 Búsqueda 3 — caza directa de tiendas COD (la inversa)

`npm run hunter:busqueda-cod` (fase 1) · `-- --auditar --top 20` (fase 2)

Parte de Meta, no del catálogo: busca quien habla de pago contra reembolso
(13 frases), agrupa por tienda, prioriza barato y solo audita a fondo el
lote que decide Pedro. Captura ganadores cuyo nombre en el anuncio nunca
coincidiría con el de Dropea.

En fase 2, por cada producto de la tienda: si está en Dropea, corre el deep
dive completo; **si no está, no se descarta**: da un veredicto de fuerza de
la señal y dice «requiere sourcing alternativo», sin inventar un margen ni
recomendar contactar a un proveedor que no lo tiene.

**Dos criterios de tienda añadidos el 09-09:**

- `perfil_tienda_cod_generica`: catálogo no concentrado + ≥ 3 productos
  distintos + ≥ 14 días anunciando. Sube en el ranking **aunque ningún
  producto tenga 30 días**, porque el patrón de la tienda entera ya es la
  señal (referencia de Pedro: Venygo, LaCesta).
- `empresa_estructurada` (**solo en búsqueda 3**, no toca las búsquedas 1 y 2):
  catálogo disperso **pero** ≥ 2 señales de empresa real (equipo/fundadores,
  sede reivindicada, año de fundación, empleados, fábrica propia,
  certificaciones, marca paraguas). Baja la prioridad igual que una marca
  propia: no es replicable comprando en un proveedor. **No cuentan** el pie
  legal, «empresa española» a secas, la antigüedad, ni los testimonios de
  venta.

**Comprobado en real el 09-09** [V]:

```
venygo.com: ok · 10 productos · disperso · perfil COD: SÍ · 1 señal de empresa (no llega a 2)
   DuchaPura™ | Filtro Purificador para la Ducha · 29.99 € (antes 42.99 €, −30 %)
   LimpiaPro™ · 34.99 € (−44 %) · Sellafresh™ · 24.99 € (−55 %) · Otoscopio Pro™ · 34.99 € (−46 %)
lacesta.es: catálogo del sitio no accesible (fetch failed): usando texto minado del anuncio
```

### 5.5 Volumen del Cazador a día de hoy

- **183 tiendas** encontradas en el barrido de búsqueda 3 [D] Pedro, 09-09
- **~65 tiendas auditadas** en fase 2 [D] Pedro
- **20 candidatos** auditados con el deep dive el 09-09 [D] Pedro
- Tablas: `hunter_cruces`, `hunter_deep_dives`, `hunter_cod_sweeps`, `hunter_cod_stores`

---

## 6 · Hechos verificados contra terceros (lo que sabemos de verdad)

Esto es lo que se ha comprobado ejecutando contra el sistema real, no
asumido. Un auditor puede reproducirlo.

| Hecho | Cómo se supo | Consecuencia de diseño |
|---|---|---|
| La API de Meta **no devuelve la URL de destino** del anuncio | Documentación oficial + sonda real | No se intenta; el dominio sale del texto declarado bajo el anuncio |
| La ficha pública de la biblioteca de anuncios devuelve **HTTP 403 con desafío JavaScript** a cualquier petición automatizada | Sonda real, 09-09 | **No se esquiva** (decisión explícita de Pedro: nada de bypass). Queda documentado como límite |
| `render_ad` con token **sí** sirve la imagen del anuncio, sin sesión | Sonda real en el NAS | La visión se hace sobre esa imagen |
| `render_ad` **no** trae enlace de salida | Sonda real | Se descartó seguir la URL de destino |
| Meta rechaza `ad_delivery_date_min` anterior a **2018-05-07** | Bug real en producción el 09-09 (código 100, subcódigo 2334029) | Corregido y con test de regresión que falla si se revierte |
| Para `/ads_archive` **solo sirve un token de persona física verificada**; el de Usuario del Sistema NO funciona aunque tenga permisos y no caduque | Producción, 09-09 | Documentado en `docs/HUNTER-BUSCADOR.md`; el token actual es de 60 días y **hay que renovarlo** |
| La API de OpenAI **no acepta vídeo** como entrada de modelo (SDK 6.38.0); sí acepta el mp4 en transcripción de audio | Comprobado en el SDK instalado | El vídeo se transcribe (guion, gancho, ritmo); **lo visual no se analiza** y el informe lo dice siempre |
| `cloudcore.es` publica catálogo Shopify: cojín de gel a 34,99 € | Petición real | Ejemplo de referencia del pipeline |
| `venygo.com` publica 10 productos con descuentos del 17 % al 55 % | Petición real, 09-09 | Valida el extractor de catálogo |
| `lacesta.es` rechaza el puerto 443 y por http redirige a otro dominio | curl + DNS, 09-09 | Ejemplo real de degradación con fallback |

---

## 7 · Lo que está construido pero NO verificado en vivo

**Esta es la sección más importante para una auditoría honesta.** Todo lo de
abajo está implementado, con tests, y **nunca se ha ejecutado contra el
tercero real**. El motivo es siempre el mismo: el token de Meta y las claves
viven en el NAS, y quien despliega es Pedro.

| # | Qué falta verificar | Comando exacto | Riesgo si falla |
|---|---|---|---|
| 1 | Que `ad_reached_countries` con IT/PT/FR/DE devuelva lo mismo que con ES (mismos campos, sin bloqueos) | `npm run hunter:deep-dive:probe -- --termino "cuscino gel sedia" --comparar-paises ES,IT,PT,FR,DE,MX` | La búsqueda 2 entera queda sin base |
| 2 | Que fbcdn sirva el **vídeo** sin sesión (la imagen sí) y que OpenAI acepte ese mp4 | `npm run hunter:deep-dive:probe -- --termino "…" --max-render 6` | El análisis de guion cae a imagen + texto; el informe ya lo declara |
| 3 | Cuántas tiendas **nuevas** aporta la lista ampliada de 13 frases frente al barrido anterior | `npm run hunter:busqueda-cod -- --paginas 3` | Solo afecta a cobertura, no a corrección |
| 4 | Cuántas tiendas entran en el informe **solo por el perfil COD genérico** (sobre las ~65 ya auditadas) | `npm run hunter:busqueda-cod -- --informe --min-dias 20 --max-dias 90` | Es el número que justifica el criterio nuevo |
| 5 | Extracción de catálogo real sobre tiendas del barrido y cuántas caen en fallback | `npm run hunter:busqueda-cod -- --auditar --top 3` | Mide qué porcentaje del universo es legible |
| 6 | Cuántas tiendas quedan marcadas `empresa_estructurada` con datos reales | mismo comando | Ajuste de umbral (hoy 2 señales) |
| 7 | Un deep dive real por `--ids` sobre candidatos del lote de 300 | `npm run hunter:deep-dive -- --min-score 60 --limite 3` | Primera ejecución del modo `--ids` con datos |

**Además, pendiente de despliegue:** los tres últimos commits (`7e4f2e0`,
`09ffb7f`, `fc4770a`) no consta que estén en el NAS. El prompt de despliegue
está listo en `docs/DEPLOY-PROMPT-DEEP-DIVE-COMPLETO-2026-09-09.md` con
bloques numerados, comandos literales, criterios de aceptación y rollback.

---

## 8 · Deuda técnica y riesgos conocidos

### 8.1 Del Cazador

1. **C1–C6 abiertos** (sección 5.1). Mitigado por la condición de no usar el
   Score para comprar y por el nivel 2, que verifica precio y producto de
   verdad. **No resuelto.**
2. **Reglas de ángulos y avatar escritas en español.** En italiano o francés
   clasifican menos. La cita literal sigue siendo válida; la etiqueta puede
   faltar. Afecta a la búsqueda 2.
3. **El cruce no guarda los anuncios**, solo la clave y el score. Por eso el
   deep dive tiene que repetir la búsqueda (1 petición extra por candidato).
4. **Cuota de Meta compartida** entre búsquedas: nada impide lanzar dos
   procesos a la vez (C13 de la auditoría). Abierto.
5. **Token de Meta a 60 días**: caduca. Cuando caduca, la pestaña de
   competencia avisa y no encola nada (fail-closed correcto), pero el
   Cazador se para.

### 8.2 Del núcleo

1. **Valores reales del `.env` del NAS no volcados al repositorio**
   (`TEST_MODE`, allowlist, porcentaje de rollout, cuatro flags de v4.3).
   El documento de estado lo marca como pendiente. **Un auditor no puede
   verificar desde el repo en qué modo exacto está el sistema.**
2. **Beeping apagado** por falta de credenciales del proveedor. Es un
   bloqueo externo, no una decisión pendiente: el enrutado por producto ya
   existe.
3. **Llamadas (Retell) en manual**: el planificador no marca solo.
4. **Dropi sin API**, solo diagnóstico.

### 8.3 Riesgo de proceso (el más relevante para una due diligence)

**Un solo responsable de negocio valida todo y despliega a mano.** No hay
integración continua desplegando, ni segundo par de ojos humano en el
código. Los controles que compensan esto son: la suite de 819 tests que se
ejecuta antes de cada commit, las migraciones aditivas y ensayadas con un
fixture realista, el backup obligatorio antes de cada despliegue, y el
procedimiento de rollback escrito en cada runbook. **Está mitigado, no
eliminado.**

---

## 9 · Qué queda por hacer

### Inmediato (esta semana)

1. Desplegar `fc4770a` con el prompt ya escrito y ejecutar las siete
   verificaciones de la sección 7.
2. Renovar el token de Meta cuando toque (60 días desde el 09-09) y anotar
   el procedimiento: solo token de persona física.
3. Volcar al repositorio los valores reales de los flags del `.env` del NAS
   para que el estado sea auditable.

### Corto plazo (2-4 semanas)

4. **Corregir C1–C6** del Score del nivel 1 (estimación de la auditoría:
   2-3 días de trabajo más tests con fixtures adversariales). Hasta
   entonces, la condición de no comprar por Score sigue vigente.
5. Calibrar los umbrales del Cazador con datos reales: gate (hoy 60 %),
   perfil de tienda (3 productos, 14 días), empresa estructurada (2 señales),
   rango de madurez (20-90 días). Todos son parámetros, ninguno está
   incrustado en el código.
6. Cerrar el bucle: de «producto recomendado» a «producto en la tienda».
   Hoy el Cazador termina en una recomendación; la creación del producto en
   Shopify y la landing (Landing Studio, ya construido) son un paso manual.

### Medio plazo

7. Activar Beeping cuando el proveedor entregue credenciales.
8. Automatizar las llamadas de Retell (hoy manual).
9. Métricas de negocio del ciclo completo: cuántos productos recomendados se
   testearon, cuántos vendieron, y con qué margen real. **Hoy no existe ese
   dato**: el sistema recomienda, pero nadie mide el acierto de la
   recomendación a posteriori. Es la pieza que convertiría el Cazador en un
   sistema con retroalimentación.

---

## 10 · Cómo verificar este documento

Todo lo marcado [V] se puede reproducir. Desde la raíz de la rama:

```bash
# Cronología y tamaño
git log --reverse --format="%ad %h %s" --date=short | head -3
git rev-list --count HEAD
find src scripts tests -name "*.ts" | xargs wc -l | tail -1

# Calidad
npm run typecheck        # debe salir limpio
npm test                 # 819 OK, 5 omitidos, 0 fallos
npm run build            # compila

# Esquema
grep "export const SCHEMA_VERSION" src/lib/db.ts   # 32

# C2 sigue abierto (subcadena en el nivel 1)
sed -n 121p src/lib/product-hunter/internal/cruce.ts
```

En el NAS (solo Pedro):

```bash
sudo docker exec casamable-agent npm run db:health -- --full
sudo docker exec casamable-agent npm run doctor:v43
sudo docker exec casamable-agent npm run hunter:busqueda-cod -- --informe --min-dias 20 --max-dias 90
```

---

## 11 · Documentos de referencia por tema

| Tema | Documento |
|---|---|
| Estado real de producción | `docs/ESTADO-PRODUCCION.md` |
| Auditoría técnica previa (C1–C15) | `docs/AUDITORIA-PROFESIONAL-2026-09-08.md` |
| El Cazador nivel 2 y las tres búsquedas | `docs/HUNTER-DEEP-DIVE.md` |
| Cruce Dropea × Ad Library (nivel 1) | `docs/PRODUCT-HUNTER-BACKEND-USO.md` |
| Token de Meta y sus límites | `docs/HUNTER-BUSCADOR.md` |
| Campos que devuelve la API de anuncios | `docs/ADLIB-CAMPOS.md` |
| Despliegue pendiente | `docs/DEPLOY-PROMPT-DEEP-DIVE-COMPLETO-2026-09-09.md` |
| Runbooks de operación | `docs/PEDRO-RUNBOOK.md`, `docs/OLIVER-RUNBOOK.md` |
| Coste de la IA | `docs/COSTE-IA.md` |
| Arquitectura general | `docs/ARCHITECTURE.md` |

---

## 12 · Resumen en cinco líneas

1. **21 días, 319 commits, 87.000 líneas, 819 tests en verde.** Un núcleo de
   pedidos COD por WhatsApp **encendido y sirviendo a clientes reales** (136
   pedidos), y un Cazador de productos en rodaje.
2. **El sistema está diseñado para no inventar datos:** cuando no puede
   verificar algo, lo dice y corta; nunca rellena con una estimación. Eso
   está probado con tests.
3. **El Score del nivel 1 tiene seis defectos conocidos y abiertos**, y por
   eso hay una condición vigente: no se compra stock por Score.
4. **Lo construido en los últimos 3 días (el nivel 2) es lo que compensa
   eso:** verifica precio, producto, margen, competencia y madurez con datos
   reales, y declara cada carencia.
5. **Siete verificaciones en vivo quedan pendientes** porque dependen del
   token de Meta en el NAS, y los tres últimos commits están sin desplegar.
   Están listadas con su comando exacto en la sección 7.
