> **ARCHIVED — KIT ORIGINAL.** Documentación del kit genérico del que nació
> este repo. El proyecto real es el Casamable Control Center: fuente de
> verdad en `docs/README.md`. Conservado porque las skills /setup y
> /personaliza aún lo referencian.

# 09 · Personalizar el dashboard (tu marca)

El panel viene con una marca neutra ("Tu Agente"). Puedes ponerle **tu identidad**:
nombre, colores, logo, e incluso **añadir secciones o funciones nuevas**.

Lo más fácil: **díselo a Claude en lenguaje normal** y lo hace por ti. Ejemplos:
- "Pon el panel con los colores de mi marca: azul #1e40af y blanco."
- "Cambia el nombre del panel a 'Clínica Sonrisa'."
- "Mete mi logo (está en Descargas) arriba a la izquierda."
- "Añade una pestaña de 'Citas' al panel."

Aquí tienes el mapa de qué toca cada cosa, por si quieres entenderlo o hacerlo tú.

---

## 1. El nombre de la marca

Archivo: **`src/components/Logo.tsx`** → cambia la constante de arriba:

```ts
const BRAND_NAME = "Tu Agente";   // ← pon aquí el nombre de tu negocio
```

Ese nombre aparece en la cabecera del panel y en la pantalla del QR.

---

## 2. Los colores

Archivo: **`src/app/globals.css`**. Ahí están definidas las variables de color de
la marca (busca los tokens `--brand-*` o `--color-brand-*`). Cambia sus valores:

- `--brand-gold` / el color de acento (botones, resaltados)
- `--brand-bg` / el fondo
- `--brand-text` / el texto
- `--brand-surface`, `--brand-border`, `--brand-muted` / superficies y detalles

Todo el panel usa estas variables, así que cambiándolas ahí se re-tiñe entero.
El verde de WhatsApp (`--color-wa-green`) déjalo: es un guiño reconocible.

> Consejo: elige un color de acento y un fondo, y deja que Claude ajuste el resto
> para que contraste bien. Dile "revísame que los colores contrastan y se leen".

---

## 3. Tu logo o imagen

- **Logo tipográfico** (solo texto con estilo): con el paso 1 basta.
- **Logo en imagen / un banner**: mete tu archivo en la carpeta `public/` (por
  ejemplo `public/mi-logo.png`) y dile a Claude "usa `public/mi-logo.png` como
  logo en la cabecera". Él pondrá el `<img src="/mi-logo.png">` donde toca
  (`src/components/DashboardHeader.tsx` y/o `QRScreen.tsx`).

---

## 4. El fondo

Hay un fondo ambiental sutil en **`src/components/AmbientBackground.tsx`** (puedes
renombrarlo). Dile a Claude si lo quieres más discreto, con otro color, o quitarlo
del todo. Se controla desde `src/components/Dashboard.tsx`.

---

## 5. Añadir una sección o función nueva

El panel tiene tres vistas: **Chats**, **Métricas** y **Ajustes**
(`src/components/Dashboard.tsx` y `DashboardHeader.tsx`). Puedes añadir más.

La forma cómoda: **descríbeselo a Claude**. Por ejemplo:
- "Añade una vista de 'Leads' que muestre los últimos guardados en el CRM."
- "Quiero un botón para exportar las conversaciones a CSV."
- "Mete un contador de ventas del día en las métricas."

Claude sabe la estructura (componentes en `src/components/`, datos en `src/lib/db.ts`,
rutas API en `src/app/api/`) y lo monta. Tú solo pruebas y confirmas.

---

## Regla de oro

Después de cualquier cambio en el panel, Claude debe ejecutar `npm run build` para
confirmar que compila, y tú abres el panel para verlo. Si algo se ve raro, dilo y
se ajusta. Nada de esto toca al agente ni a tus datos: el panel es solo la ventana.
