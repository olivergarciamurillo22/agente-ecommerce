# 08 · Memoria de largo plazo con Supabase

Por defecto el agente recuerda lo que se habla **dentro de una misma conversación**
(lo guarda en SQLite, en el servidor). Con Supabase le damos **memoria de largo
plazo por persona**: aunque alguien vuelva a escribir dentro de meses, el agente
lo reconoce por su teléfono y retoma lo que hablaron.

Es **opcional**. Si no configuras Supabase, el agente funciona igual, solo que
sin memoria entre conversaciones separadas en el tiempo.

---

## Qué hace exactamente

- Guarda **un registro por persona** (`lead_memory`): nombre, email, objetivo,
  situación, temperatura y un **resumen** que va creciendo con lo que habláis.
- Opcionalmente guarda **todos los mensajes** (`message_log`) en Supabase, para
  que tengas el historial completo también ahí, consultable.
- Cuando la persona vuelve a escribir, el agente **lee su memoria** y la usa para
  saludarla por su nombre y continuar, en vez de empezar de cero.

Todo es a prueba de fallos: si Supabase se cae o va lento, el agente responde
igual (sin memoria en ese momento), nunca se queda colgado.

---

## Paso 1 · Crear el proyecto en Supabase

1. Entra en https://supabase.com y crea una cuenta (el plan gratuito sobra).
2. **New project**. Ponle un nombre (ej. `agente-whatsapp`), elige una contraseña
   de base de datos y la región más cercana. Espera 1-2 minutos a que se cree.

## Paso 2 · Crear las tablas

En el menú lateral, abre **SQL Editor** > **New query**, pega esto y dale a **Run**:

```sql
-- Memoria por persona (una fila por teléfono)
create table if not exists lead_memory (
  phone       text primary key,
  name        text,
  email       text,
  objetivo    text,
  situacion   text,
  temperatura text,
  resumen     text,
  first_seen  timestamptz default now(),
  last_seen   timestamptz default now()
);

-- Log histórico de todos los mensajes (opcional, pero recomendado)
create table if not exists message_log (
  id         bigserial primary key,
  phone      text,
  role       text,
  content    text,
  created_at timestamptz default now()
);
create index if not exists message_log_phone_idx on message_log (phone, created_at);

-- Seguridad: nadie accede a estos datos salvo tu servidor (clave service_role,
-- que salta RLS). Con RLS activado y sin políticas, la anon key no lee nada.
alter table lead_memory enable row level security;
alter table message_log enable row level security;
```

Debe decir "Success. No rows returned". Ya tienes las tablas.

## Paso 3 · Copiar las credenciales

En **Project Settings** (rueda dentada) > **API**:

- **Project URL** — algo como `https://xxxxxxxx.supabase.co`
- **service_role** (en "Project API keys") — una clave larga. Es **secreta**: da
  acceso total a la base. Trátala como una contraseña.

## Paso 4 · Ponerlas en el agente

Abre tu `.env.local` (en la raíz del proyecto) y añade estas dos líneas con tus
valores reales:

```
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=la-clave-service_role
```

> El `.env.local` está protegido por `.gitignore`: no se sube a Git. **Nunca**
> pegues la clave service_role en un chat, un repositorio público ni un correo.

### En producción (EasyPanel)

Añade esas dos mismas variables en tu app de EasyPanel: pestaña **Environment**,
las pegas ahí igual que `OPENROUTER_API_KEY`, y haces **Redeploy**. A partir de
ahí, el agente en producción tiene memoria.

---

## Cómo comprobar que funciona

1. Escríbele al agente desde otro WhatsApp, dile tu nombre y algo ("soy Ana,
   quiero mi primer cliente"). Deja que responda.
2. En Supabase > **Table Editor** > `lead_memory` debería aparecer una fila con
   tu teléfono, tu nombre y un resumen.
3. Más tarde (o al día siguiente) vuelve a escribirle "hola, ¿te acuerdas de mí?"
   → debería saludarte por tu nombre y retomar, sin pedirte el nombre otra vez.

En los logs del bot verás `+ memoria` cuando esté cargando el recuerdo de alguien:
`[bot] llamando al LLM con N mensajes + memoria...`

---

## Preguntas frecuentes

- **¿Necesito Supabase sí o sí?** No. Sin él, el agente recuerda dentro de cada
  conversación pero no reconoce a alguien que vuelve meses después.
- **¿Se duplican los datos con Airtable?** No es duplicar: Airtable es tu CRM de
  ventas (leads a captar); Supabase es la memoria conversacional del agente. Cada
  uno cumple un papel. El nombre/email van a los dos.
- **¿Cuánto cuesta?** El plan gratuito de Supabase aguanta de sobra el volumen de
  un agente de WhatsApp. Solo crece si guardas millones de mensajes.
- **¿Y si borro una fila de `lead_memory`?** El agente simplemente tratará a esa
  persona como nueva la próxima vez. No pasa nada más.
