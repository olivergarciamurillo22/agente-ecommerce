# Pedro — validar la rama del Winner Radar

**Rama:** `feat/ai-winner-radar` · **Esquema:** 19 → 20

> No fijo aquí un SHA a propósito: se queda obsoleto en cuanto se comprueba
> algo y luego no cuadra con lo que te digo por mensaje. Usa siempre el HEAD
> de la rama y pásamelo tú.

**Esto NO es un despliegue.** No toques el NAS. Es probar en tu máquina y
decirme qué sale.

Reserva **30–40 minutos**. La mayor parte es esperar a que corran cosas.

---

## Qué trae esta rama

Una herramienta nueva —**Winner Radar**— que busca productos que ya se están
vendiendo bien, mirando los anuncios reales que las marcas tienen publicados
en Facebook e Instagram.

Funciona así: escribes lo que buscas en lenguaje normal («productos de
mascotas para España, contrareembolso, 25–50 €, no frágiles»), pulsas buscar,
y ves trabajar al sistema durante un par de minutos. Al terminar te da un
informe con qué harías hoy, los mejores candidatos y qué no cuadra.

Cada producto lleva un **verbo** antes que un número: TESTEAR, VIGILAR o
DESCARTAR. Y el número se puede abrir para ver de dónde sale.

**Los datos son gratis.** Salen de la Biblioteca de Anuncios de Meta, que es
pública. No hay ninguna suscripción de pago detrás.

También entra el receptor de webhooks de Beeping, que está **apagado a
propósito** — eso se explica en `PEDRO-BEEPING-WEBHOOK.md`.

---

## 1 · Ponte en la rama

```bash
cd <tu carpeta del repo>
git fetch origin
git checkout feat/ai-winner-radar
git pull --ff-only
git rev-parse --short HEAD    # tiene que decir 7934bef
npm install
```

Si `git checkout` se queja de cambios locales, **para y dímelo**. No fuerces
nada.

---

## 2 · Las tres puertas

```bash
npm test
npm run typecheck
npm run build
```

Esperado: **744 tests, 0 fallos**, typecheck sin una línea, build compilando.

Si algo falla, no sigas: pégame la salida tal cual.

---

## 3 · ¿Está el radar vivo?

```bash
npm run hunter:doctor
```

Tiene que terminar en **`● SE PUEDE BUSCAR`**, y por el camino:

```
● PROVIDER   meta
● META       CONNECTED
● OPENAI     CONNECTED
● JOBS       READY
```

**`HISTORY SIN_DATOS` y `ECONOMIA_PROPIA POCA_MUESTRA` son NORMALES.** El
primero se llena con la primera búsqueda; el segundo, con cierres de pedidos
reales.

Si META u OPENAI dicen otra cosa, es la clave en `.env.local`, no el código.
**No me mandes la clave**: dime qué variable falla.

---

## 4 · La migración, sobre una copia

El esquema sube de 19 a 20. Solo añade tablas nuevas con prefijo `hunter_`;
no toca ni una columna de `orders`. Aun así se ensaya sobre una copia.

El código abre siempre `$DATA_DIR/messages.db`, así que la copia tiene que
llamarse **exactamente así**, dentro de una carpeta aparte. En la primera
validación esta guía decía `cp … /tmp/prueba-20.db` y `DATA_DIR=/tmp`: eso
abría `/tmp/messages.db`, o sea otro fichero. El comando comprobaba algo que
no era la copia.

```bash
mkdir -p /tmp/radar-prueba
cp data/messages.db /tmp/radar-prueba/messages.db
DATA_DIR=/tmp/radar-prueba npm run db:health
```

Comprueba que dice **esquema 20**, **integridad ok**, y que el número de
pedidos es **el mismo que antes**.

Y que tu base ORIGINAL sigue intacta:

```bash
npm run db:health     # debe seguir en el esquema que tenías, con tus pedidos
```

```bash
rm -rf /tmp/radar-prueba
```

> **Si tu base local está vacía** (0 pedidos, esquema 0), esto valida 0 → 20,
> que no es lo mismo que 19 → 20 con datos reales. Dímelo y preparo una copia
> con pedidos para ensayar el salto de verdad.

---

## 5 · Una búsqueda real ← ESTE ES EL PASO QUE IMPORTA

Todo lo anterior lo he corrido yo y está en verde. **Esto no se ha hecho
nunca**: hasta ahora el módulo solo se ha probado con datos de ejemplo.

```bash
npm run dev
```

Abre el panel, entra en **Cazador** y escribe algo concreto. Por ejemplo:

> Productos de mascotas para España, contrareembolso, 25-50 €, no frágiles

Pulsa **Buscar oportunidades** y mira estas cuatro cosas:

**a) ¿Avanza?** Verás seis etapas con nombre y contadores que se mueven
(«1.284 anuncios revisados»). **Irá más lento que una web normal**: el código
deja 1,2 s entre llamadas a Meta y no pasa de 180 por hora, para no acabar
con la app bloqueada. Dos o tres minutos es lo esperado.

**b) ¿Los productos son productos distintos?** Abre dos o tres. Si ves uno
que mezcla anuncios de cosas que no tienen nada que ver —un quitapelos de
mascotas con un organizador de coche—, **para y mándame una captura**. Es un
fallo que ya encontré y creía cerrado, y sería importante saber que vuelve.

**c) Abre uno y mira la pestaña «Anuncios».** Los anuncios de ahí tienen que
ser de ese producto.

**d) Prueba a salir.** Desde la ficha de un producto, sal de las tres formas:
el botón «Volver a los resultados», la tecla Escape y el botón de atrás del
navegador. Las tres tienen que devolverte a los resultados **con los
resultados todavía ahí**.

Si Meta devuelve un error, no lo interpretes: pégamelo tal cual.

---

## 5 bis · Si Meta falla, ahora lo dice

En la primera validación el doctor decía `META ERROR · respuesta 400` y tres
líneas más abajo `SE PUEDE BUSCAR`, saliendo con código 0. Y la pantalla de
resultados vacíos culpaba al vocabulario de un fallo del proveedor. Las dos
cosas están arregladas:

- El doctor enseña **el motivo real** (`Session has expired on…`), dice
  `NO SE PUEDE BUSCAR` y **sale con código 1**.
- La pantalla vacía distingue «no hay productos» de «no se ha podido mirar».

Si te vuelve a pasar, el propio doctor debería decirte qué arreglar sin que
tengas que lanzar un `curl`.

---

## 6 · Lo que YA SÉ que falta

No hace falta que me lo reportes, ya está anotado:

- Si Meta falla, verás el error técnico en crudo en vez de un mensaje claro.
- La saturación dice «Media» pero no explica por qué.
- La economía de cada producto sale vacía: hace falta meter costes de
  proveedor a mano, porque Dropi no tiene API.
- La tendencia sale vacía la primera vez: necesita dos búsquedas separadas en
  el tiempo para poder comparar.

---

## 7 · Qué contarme

1. Las tres puertas: verde o rojo.
2. Las cinco líneas del `hunter:doctor`.
3. Esquema y pedidos tras la migración de prueba.
4. De la búsqueda real: cuántos productos salieron, si estaban bien
   separados, cuánto tardó, y si las tres salidas de la ficha funcionaron.
5. Cualquier cosa que te haya parecido rara **aunque no fallara**. Eso es
   normalmente lo más útil.

---

## Lo que esta rama NO hace

- No despliega nada ni toca el NAS.
- No manda un solo WhatsApp: el radar no habla con clientes.
- No escribe en Shopify, Dropea, Dropi ni Beeping. **Solo lee.**
- No enseña datos de ejemplo si falta una fuente: dice que falta.
- No manda datos de clientes a ningún modelo de IA. Hay un cortafuegos que
  bloquea el envío si detecta un teléfono, un correo o una dirección.
