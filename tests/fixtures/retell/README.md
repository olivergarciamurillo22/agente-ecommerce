# Fixtures de Retell (SIN PII)

Formas reales del webhook `{event, call}` según docs.retellai.com (03-09-2026):
`call_started`, `call_ended` (sin `call_analysis`), `call_analyzed` (con
`call_analysis.custom_analysis_data`), una llamada NO conectada
(`call_status: not_connected`, `disconnection_reason: dial_no_answer`, análisis
vacío), una malformada y una con deriva de versión (`agent_version: 9` con pin 7).

`create-phone-call.expected.json` es el cuerpo EXACTO que enviamos a
`POST /v2/create-phone-call` (golden test). Datos sintéticos: teléfono
`+34999000001`, pedido `TEST_1501`, agente `agent_TEST_ONLY`.

Firma (para tests): `X-Retell-Signature: v=<ts_ms>,d=HMAC-SHA256(raw_body + ts_ms, RETELL_API_KEY)`.
