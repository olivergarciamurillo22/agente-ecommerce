# Entorno local en el Mac — configuración

> 26-08-2026. El archivo local de entorno de ESTE proyecto es **`.env.local`**
> (verificado: Next.js lo carga nativamente y todos los scripts CLI lo cargan
> vía `scripts/env-loader.ts`). El NAS usa `.env` — son mundos separados.

## Las tres reglas

1. **`.env.local` no se sube a Git** (está en `.gitignore`, con test que lo
   verifica). Los secretos se pegan ahí y solo ahí.
2. **No se copia el `.env` del NAS.** Ni por scp, ni entero, ni pegado en
   Claude/ChatGPT. Cada credencial que necesites la introduces tú,
   individualmente, para el perfil concreto.
3. **Los secretos jamás se pegan en un chat.** `env:doctor` solo dice
   `configurado`/`falta` — nunca un valor.

## Perfiles

| Perfil | Para qué | Necesita credenciales |
|---|---|---|
| `local-safe` | desarrollo diario: tests, fixtures, panel local | **NINGUNA** |
| `shopify-readonly` | consultar Shopify desde el Mac, sin writes | token estático O client_id+secret |
| `whatsapp-baileys` | comportamiento actual de producción | ninguna extra |
| `whatsapp-cloud-pilot` | el piloto de Meta | las 6 de Meta + allowlist |
| `retell-pilot` | el piloto de llamadas | Retell + allowlist |
| `nas-production` | SOLO documental — no se ejecuta desde el Mac | — |

## Seguridad de datos

- La DB local vive en `./data` (propia del Mac). `local:doctor` **bloquea**
  si `DATA_DIR` apunta a una ruta con pinta de NAS (`/volume1/`, `/app/data`,
  `nas-data`), y `local:reset` se **niega** a borrar en esas rutas o con
  `APP_MODE=production`.
- `local-safe` exige efectos reales apagados (envíos, writes de Shopify y
  Dropea, Cloud API, llamadas) y **grita** si detecta
  `APP_MODE=production` + `TEST_MODE≠1` en el Mac.

## Si una credencial anduvo suelta

Si un secreto pasó por un chat, un correo o un portapapeles compartido,
**se regenera en origen** (no lo hace nadie por ti):
- Meta App Secret → Ajustes de la app → Básico → restablecer.
- Token de Meta → regenerar (y mejor: usuario del sistema permanente).
- Retell API Key → dashboard de Retell → regenerar.
Después: pegar el nuevo en `.env.local` y `npm run env:doctor`.

---

## ÓLIVER — EMPIEZA AQUÍ

```bash
git pull
npm install
npm run env:init        # crea .env.local desde la plantilla (no toca uno existente)
npm run env:doctor      # ¿qué falta para trabajar? (perfil local-safe)
npm run local:doctor    # entorno + DB local + rutas + git, todo junto
npm test
npm run dev:all         # bot + panel en localhost:3000
```

Para un perfil concreto:

```bash
npm run env:doctor -- --profile whatsapp-cloud-pilot
npm run env:doctor -- --profile retell-pilot
npm run env:doctor -- --profile shopify-readonly
```

Cuando el doctor diga que falta una variable:

1. abre **`.env.local`** (en la raíz del proyecto),
2. pega TÚ el valor en la línea correspondiente (los secretos van vacíos a
   propósito en la plantilla),
3. vuelve a ejecutar el doctor hasta verlo en verde.
