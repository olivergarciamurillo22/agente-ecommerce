# Piloto real 02-09 — hoja de resultados (rellenar con EVIDENCIA)

Pedro/Óliver: pegad aquí las salidas TAL CUAL (sin tokens ni secretos).
Cuando esté relleno, se analiza la evidencia — nada se da por hecho antes.

---

## WHATSAPP

**template doctor** (`npm run whatsapp:templates:doctor`, en el NAS):

```
(pegar salida completa)
```

**pedido test** (número de la allowlist, pedido real de prueba):

- Nº de pedido: ______
- ¿Salió la plantilla `pedido`?: SÍ / NO
- Hora de envío vs hora del pedido: ______

**delivery** (estado en el panel / webhook de Meta):

- sent → delivered → read: ______

**button** (el cliente de prueba pulsa "Confirmar"):

- ¿Respuesta del bot correcta?: SÍ / NO — texto recibido: ______

**DB** (panel → Pedidos):

- ¿El pedido pasó a CONFIRMADO?: SÍ / NO
- ¿Tag WA_CONFIRMED en Shopify (si writes abiertos)?: SÍ / NO / N/A

---

## RETELL

**prompt version:**

- ¿Prompt del repo pegado en Retell?: SÍ / NO
- Nº de versión PUBLICADA: ______
- `RETELL_AGENT_VERSION` puesto a: ______

**doctor** (`npm run retell:doctor`, donde esté la key):

```
(pegar salida completa)
```

**simulate** (`npm run calls:simulate`):

```
(pegar salida)
```

**real call** (UNA llamada al número autorizado, escuchada ENTERA):

- ¿Dijo el NOMBRE real (no un placeholder)?: SÍ / NO
- ¿Producto correcto?: SÍ / NO
- ¿Dirección + CP dígito a dígito?: SÍ / NO
- ¿Importe correcto en palabras?: SÍ / NO
- ¿Tono natural, <90 s?: SÍ / NO
- Frases raras oídas (si las hubo): ______

**result** (panel → Agente → últimas llamadas / DB):

- `resultado` registrado: ______
- ¿Coincide con lo que pasó en la llamada?: SÍ / NO
- agent_version registrado en el intento: ______

---

## VEREDICTOS (rellenar al final)

- WhatsApp automático (subir rampa a 25%): GO / NO-GO — motivo: ______
- Retell piloto ampliado (más números en allowlist): GO / NO-GO — motivo: ______
