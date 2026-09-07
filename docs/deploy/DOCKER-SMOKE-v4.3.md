# Smoke test Docker v4.3

## Resultado en el entorno de preparación

Omitido el 5 de septiembre de 2026: `docker --version` devuelve «docker no se reconoce como nombre de un cmdlet». No se construyó ninguna imagen ni se levantó ningún contenedor; este resultado no acredita el despliegue Docker.

## Ejecución pendiente en un host con Docker

El smoke debe usar un nombre de proyecto y contenedor exclusivos, sin volúmenes y con solo el servicio web. Debe arrancar con `EMERGENCY_STOP=1`; no debe arrancar el bot.

Comprobaciones obligatorias:

1. construir la imagen sin reutilizar una imagen de otro release;
2. confirmar `GET /` con redirección 307 a login;
3. confirmar `GET /api/health` con estado 200;
4. confirmar `GET /login` con estado 200;
5. confirmar `POST /api/webhooks/retell/call-events` sin firma con estado 401;
6. detener y eliminar únicamente el contenedor efímero del smoke.

No se declarará F10 superada hasta conservar la salida de esas cinco comprobaciones en el host de despliegue.
