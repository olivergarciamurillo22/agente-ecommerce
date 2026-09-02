# ============================================================
# Casamable™ — imagen de producción (NAS UGREEN DXP2800)
#
# Un solo contenedor con web + bot, igual que `npm run start:all` en local:
# no separamos procesos porque dashboard y bot comparten el MISMO SQLite.
#
# Base Debian slim (NO Alpine) a propósito: better-sqlite3 es un módulo
# nativo y en Alpine (musl) hay que recompilarlo; en slim se usan los
# binarios precompilados y la imagen es reproducible sin sorpresas.
# ============================================================

# ---------- Etapa 1: dependencias + build ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Herramientas de compilación por si algún módulo nativo no trae prebuild.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Capa cacheada de dependencias: solo se reinstala si cambian los manifiestos.
COPY package.json package-lock.json ./
RUN npm ci

# Código y build de Next.js
COPY . .
RUN npm run build

# Fuera lo que solo sirve para compilar (deja tsx/concurrently, que son
# dependencies y hacen falta en runtime para arrancar el bot).
RUN npm prune --omit=dev

# ---------- Etapa 2: runtime ----------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Europe/Madrid \
    NEXT_TELEMETRY_DISABLED=1

# tzdata: sin ella TZ se ignora y las fechas locales de SQLite
# (contadores "hoy" del panel) y la ventana horaria se desviarían.
# curl: lo usa el HEALTHCHECK.
# procps (ps): lo necesita `concurrently --kill-others` para tumbar al
# proceso hermano cuando uno muere. Sin `ps`, el arranque moría con
# "spawn ps ENOENT" y el log tapaba la causa real (visto en el ensayo
# Docker del 03-09).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

# Todo lo necesario para servir y para ejecutar el bot con tsx.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/config ./config

# Puntos de montaje del estado persistente. Se crean para que el contenedor
# arranque también sin volúmenes (aunque en el NAS SIEMPRE se montan), y
# pertenecen al usuario `node` para poder escribir sin ser root.
RUN mkdir -p /app/data /app/auth /app/backups \
    && chown -R node:node /app/data /app/auth /app/backups

# No correr como root.
USER node

EXPOSE 3000

# Liveness: la app y la BASE DE DATOS. Un WhatsApp desconectado NO marca el
# contenedor como unhealthy (Baileys reconecta solo; reiniciar cortaría la
# reconexión y entraría en bucle). start-period da margen al primer build.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/api/health/live || exit 1

# web + bot en el mismo contenedor. --kill-others: si uno muere, cae el otro
# y Docker reinicia el conjunto limpio (restart: unless-stopped).
CMD ["npm", "run", "start:all"]
