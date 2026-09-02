> **ARCHIVED — KIT ORIGINAL.** Documentación del kit genérico del que nació
> este repo. El proyecto real es el Casamable Control Center: fuente de
> verdad en `docs/README.md`. Conservado porque las skills /setup y
> /personaliza aún lo referencian.

# 01 · Instalar el kit en tu ordenador

Esta guía cubre la instalación completa en macOS y Windows. Si usas Claude Code, escribe `/setup` y te lleva paso a paso por todo esto sin que tengas que abrir terminales. Si no, sigue manualmente.

## Requisitos previos

| Requisito | Por qué |
|---|---|
| **Node.js 20+** | El kit es Node. Necesita 20 o superior |
| **VS Code** (opcional pero recomendado) | Para abrir el proyecto con comodidad |
| **Claude Code** (opcional pero MUY recomendado) | Para el setup guiado |
| **Cuenta de OpenRouter** | El cerebro del agente. Plan gratis + 5€ de saldo da para meses |

## Instalar Node.js

### macOS

1. Abre https://nodejs.org/es/download
2. Descarga el LTS más reciente (botón verde)
3. Abre el `.pkg` y sigue el instalador
4. Verifica en Terminal: `node --version` (debe decir v20.x o superior)

### Windows

1. Abre https://nodejs.org/es/download
2. Descarga el LTS más reciente para Windows (botón verde, archivo `.msi`)
3. Ejecuta el instalador. **MARCA la casilla "Automatically install necessary tools"** cuando aparezca
4. Verifica en PowerShell o cmd: `node --version` (debe decir v20.x o superior)

**Windows · Bash requerido para Claude Code**

Claude Code en Windows necesita un shell con Bash. Tienes dos opciones:

- **Opción A (más simple)**: instala [**Git for Windows**](https://git-scm.com/download/win). Trae Bash incorporado. Después de instalarlo, Claude Code lo detecta automáticamente
- **Opción B (más limpia para uso avanzado)**: instala [**WSL2**](https://learn.microsoft.com/es-es/windows/wsl/install) con Ubuntu. Te da un Linux completo dentro de Windows

Sin esto, Claude Code en Windows nativo cae a PowerShell y algunos comandos del kit pueden fallar.

## Instalar el kit

1. Descomprime el ZIP del kit en una carpeta de tu ordenador (ej: `~/Documents/agente-whatsapp/` o `C:\Users\TuUsuario\Documents\agente-whatsapp\`)
2. Abre VS Code: `Archivo → Abrir carpeta...` y selecciona la carpeta del kit
3. Abre la terminal integrada de VS Code: menú `Terminal → Nueva terminal` (o `Ctrl + ñ` en mac, `Ctrl + ñ` o `Ctrl + ´` en Windows)
4. Ejecuta:

```
npm install
```

Tarda 1-2 minutos. Verás muchas líneas y al final un resumen tipo `added 500 packages`.

### Si npm install falla

| Error | Solución |
|---|---|
| `permission denied` (macOS) | Probablemente intentaste correr con `sudo`. NO uses sudo. Si ya lo hiciste, borra `node_modules` y prueba sin sudo |
| `cannot find module 'better-sqlite3'` | Falló la compilación. Ejecuta `npm rebuild better-sqlite3` |
| `Visual Studio not found` (Windows) | Instala Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/ . Después, `npm rebuild better-sqlite3` |
| `EACCES` (Windows) | Cierra antivirus temporalmente, vuelve a intentar |

## Verificar que todo está bien

Ejecuta:

```
npm run check
```

Te dirá si tu sistema cumple todos los requisitos. Si todo aparece con `✓` en verde, estás listo.

## Siguiente paso

Sigue a [02-conectar-whatsapp.md](02-conectar-whatsapp.md) para vincular tu WhatsApp.
