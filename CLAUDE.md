# GHL-WhatsApp Integration Server

## Project Overview

**GHL-WhatsApp Integration Server** - Aplicación multi-tenant Node.js/Express que conecta GoHighLevel CRM con WhatsApp a través de Evolution API. Maneja mensajería bidireccional, procesamiento multimedia (audio/imagen) con OpenAI y gestión de OAuth para múltiples clientes.

**Current State:** 7 clientes activos, escalando a 150. MVP en desarrollo.

**Philosophy:** Simple, funcional, robusto. Sin sobre-ingeniería.

**Multi-Tenant Architecture:**
- **Un solo servidor** maneja múltiples clientes/instancias
- **Un solo endpoint de webhook** (`/webhook/whatsapp`) para TODAS las instancias de Evolution API
- Cada instancia se identifica por el campo `instance` en el payload del webhook
- La configuración de cada cliente (tokens GHL, API keys, etc.) se almacena en Supabase indexada por `instance_name` y `location_id`

---

## Tech Stack

- **Node.js 20 LTS + Express 4.18**
- **Database:** Supabase (PostgreSQL) - tabla `clients_details`
- **HTTP Client:** Axios + axios-retry (4 reintentos, 800ms de retraso)
- **Logging:** Winston (logs JSON estructurados)
- **Testing:** Mocha + Chai + Supertest (post-MVP)
- **Deploy:** Docker en Easypanel/Contabo VPS

### External APIs

- GoHighLevel (CRM + OAuth)
- Evolution API v2 (WhatsApp)
- OpenAI (Whisper + GPT-4o-mini Vision)

---

## Project Structure

```
/
├── server.js               # Express app + routes
├── config.js               # Env vars (CommonJS)
├── webhooks/
│   ├── ghl.js            # GHL → WhatsApp handler
│   └── whatsapp.js       # WhatsApp → GHL handler
├── services/
│   ├── supabase.js       # DB client + queries
│   ├── ghl.js            # GHL API + OAuth auto-refresh
│   ├── evolution.js      # Evolution API wrapper
│   └── openai.js         # Whisper + Vision
├── utils/
│   ├── retry.js          # axios-retry config
│   ├── logger.js         # Winston logger
│   ├── notifications.js  # Admin WhatsApp alerts
│   └── validation.js     # Payload validation
├── public/                 # QR panel (DO NOT MODIFY)
└── test/                   # Tests (phase 3)
```

---

## Key Commands

```bash
# Development
npm start               # Start server (port 3000)
npm run dev             # Start with auto-reload
npm test                # Run tests (Mocha)

# Docker
docker-compose up --build

# Database queries (via Supabase client)
# See services/supabase.js for available functions
```

---

## Environment Variables

Requerido en `.env`:

```bash
# Server
PORT=3000
LOG_LEVEL=info

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJxxx...

# GHL OAuth
GHL_CLIENT_ID=xxx
GHL_CLIENT_SECRET=xxx
GHL_REDIRECT_URI=https://domain.com/auth/credentials2/callback

# OpenAI (global key)
OPENAI_API_KEY=sk-xxx

# Evolution API
EVOLUTION_BASE_URL=https://pabs-evolution-api.r4isqy.easypanel.host

# Admin alerts
ADMIN_WHATSAPP=34633839200@s.whatsapp.net
ADMIN_INSTANCE=pabsai

# Legacy (QR panel)
N8N_BASE_URL=https://newbrain.pabs.ai
N8N_AUTH_HEADER=Bearer xxx
```

---

## Database Schema

### Table: `clients_details`

**Columnas clave:**

- `location_id` (VARCHAR, UNIQUE) - Identificador de ubicación GHL, usado en webhooks
- `instance_name` (VARCHAR) - Nombre de instancia de Evolution API
- `instance_apikey` (VARCHAR) - Clave API de Evolution
- `instance_sender` (VARCHAR) - Formato de número de WhatsApp: `34XXX@s.whatsapp.net`
- `conversation_provider_id` (VARCHAR) - ID de proveedor de conversación GHL
- `ghl_access_token` (TEXT) - Token de acceso OAuth
- `ghl_refresh_token` (TEXT) - Token de refresco OAuth
- `ghl_token_expiry` (TIMESTAMPTZ) - Expiración del token

**Columnas ignoradas:** `openai_apikey`, `is_active`, `webhook_secret`

**Índices:** `location_id`, `instance_name`

---

## API Endpoints

### Webhooks

- `POST /webhook/ghl` - Recibe mensajes salientes de GHL (uno por cada `location_id`)
- `POST /webhook/whatsapp` - **Webhook único** que recibe mensajes de TODAS las instancias de Evolution API
  - Identifica la instancia mediante el campo `instance` en el payload
  - Busca automáticamente la configuración del cliente en Supabase usando `instance_name`
  - Soporta múltiples instancias simultáneamente sin necesidad de endpoints diferentes

### OAuth

- `GET /oauth/ghl/connect?location_id=XXX` - Inicia flujo OAuth
- `GET /auth/credentials2/callback` - Handler de callback de OAuth

### Health

- `GET /health` - Estado del servidor + servicios externos

### Legacy (QR Panel)

- `GET /` - Sirve `public/index.html`
- `POST /api/:action` - Proxy a n8n (NO MODIFICAR)

---

## Core Workflows

### 1. GHL → WhatsApp

**Trigger:** GHL envía webhook en mensaje saliente

**Proceso:**

1. Validar payload (solo procesar si `direction === "outbound"`, usar campo `body` para el texto)
2. Obtener cliente por `location_id` de Supabase
3. Obtener teléfono de contacto desde GHL API
4. Enviar a Evolution API
5. Marcar como entregado en GHL (o manejar fallo)

**Manejo de errores:** 4 reintentos, notificar al admin en caso de fallo, verificar si el contacto tiene WhatsApp

### 2. WhatsApp → GHL

**Trigger:** Webhook de Evolution API al recibir mensaje

**Proceso:**

1. Validar payload (procesa todos los mensajes, incluyendo propios)
2. Obtener cliente por `instance_name` de Supabase
3. Detectar tipo de mensaje: texto/audio/imagen
4. Procesar multimedia si es necesario (Whisper/Vision)
5. Buscar o crear contacto GHL
6. Buscar o crear conversación GHL
7. Subir mensaje a GHL

**Procesamiento de mensajes:**

- **Texto:** Usar directamente
- **Audio:** Transcribir → formatear como `"audio: {text}"`
- **Imagen:** Analizar → formatear como `"descripcion imagen: {text}"`

### 3. OAuth Flow

1. **Inicio:** `/oauth/ghl/connect?location_id=XXX` redirige a GHL
2. **Callback:** Intercambiar código por tokens, guardar en Supabase
3. **Auto-refresco:** Ocurre automáticamente en `ghl.js` cuando el token expira en < 5 min

---

## Coding Conventions

### Module System

Usar **CommonJS** (`require`/`module.exports`), NO módulos ES

### Error Handling

- Siempre usar `try/catch` en los manejadores de rutas
- Loguear errores con Winston: `logger.error('msg', { context })`
- Notificar al admin en fallos críticos vía WhatsApp
- Devolver códigos de estado HTTP adecuados

### Retries

Todas las llamadas a API externas usan 4 reintentos con 800ms de retraso (configurado en `utils/retry.js`)

### Logging

```javascript
logger.info('Event name', { key1: 'value1', key2: 'value2' });
logger.error('Error name', { error: err.message, stack: err.stack });
```

### Validation

Validar siempre los payloads de los webhooks antes de procesar (`utils/validation.js`)

---

## Critical Rules

1. **NO MODIFICAR** el directorio `/public` - Panel QR legacy, mantener intacto
2. **Siempre verificar la expiración del token** - Auto-refresco en `services/ghl.js`
3. **Formatear números de WhatsApp correctamente** - `34XXX@s.whatsapp.net`
4. **Usar clave global de OpenAI** - Ignorar columna `openai_apikey` en BD
5. **Notificar al admin en errores críticos** - Usar `utils/notifications.js`
6. **Loguear todos los eventos importantes** - Usar Winston con contexto

---

## Common Patterns

### Getting a client

```javascript
const client = await getClientByLocationId(locationId); // GHL webhooks
const client = await getClientByInstanceName(instanceName); // WhatsApp webhooks
```

### Calling GHL API

```javascript
const contact = await ghlAPI.getContact(client, contactId);
```

### Sending WhatsApp

```javascript
await evolutionAPI.sendText(instanceName, apikey, number, message);
```

### Processing audio

```javascript
const media = await evolutionAPI.getMediaBase64(instance, apikey, messageId);
const text = await openaiAPI.transcribeAudio(media.base64, media.mimetype);
```

### Processing image

```javascript
const media = await evolutionAPI.getMediaBase64(instance, apikey, messageId);
const description = await openaiAPI.analyzeImage(media.base64);
```

---

## Known Issues & Caveats

- **Webhook de Evolution API:** Configurar el MISMO webhook para TODAS las instancias: `https://domain.com/webhook/whatsapp`. El servidor identifica automáticamente la instancia por el campo `instance` del payload
- Los tokens GHL expiran (típicamente 24h) - el auto-refresco maneja esto
- **Números de teléfono - Formato E.164:**
  - GHL usa formato **E.164 estándar**: `+34660722687` (único formato oficial soportado)
  - WhatsApp envía: `34660722687@s.whatsapp.net`
  - Conversión automática: se quita `@s.whatsapp.net` y se añade `+` al inicio
  - **Búsqueda optimizada:** Solo se busca en formato E.164 (1 llamada vs 3 llamadas multi-formato)
  - Si falla create por duplicado, se extrae el `contactId` del error (fallback inteligente)
- **Cálculo de retraso de mensaje:** `Math.min(Math.max(text.length * 50, 2000), 10000)`
- Las notificaciones de admin requieren que `ADMIN_INSTANCE` exista en la tabla `clients_details`

---

## Development Workflow

### Local Development

1. **Iniciar servidor:** `npm start` or `npm run dev`
2. **Revisar logs:** `tail -f combined.log` o salida de consola
3. **Probar webhooks:** Usar herramientas como ngrok para pruebas locales
4. **Revisar salud:** `curl http://localhost:3000/health`
5. **Monitorear uso:** Vigilar logs de Winston en busca de errores

### Production Deployment (Easypanel/Contabo VPS)

**Infraestructura actual:**
- **Hosting:** Contabo VPS
- **Panel de control:** Easypanel
- **Contenedor:** Docker
- **URL del servidor:** Se configura en Easypanel

**Acceso a logs en producción:**
1. Acceder a Easypanel web interface
2. Seleccionar el proyecto/servicio
3. Ver logs en tiempo real en la sección "Logs"
4. Los logs de Winston se escriben a archivos (`combined.log`, `error.log`) dentro del contenedor

**Configuración de webhooks en Evolution API:**
- **IMPORTANTE:** Usar el MISMO webhook para TODAS las instancias
- Webhook único: `https://tu-dominio.com/webhook/whatsapp`
- Configurar cada instancia de Evolution API para que apunte a este mismo endpoint
- El servidor identifica automáticamente la instancia usando el campo `instance` del payload
- Ejemplo: Si el payload tiene `"instance": "MasterAgente"`, el servidor busca ese cliente en la BD

**Verificar deployment:**
- Health check: `https://tu-dominio.com/health`
- Debe retornar estado de Supabase, Evolution API y OpenAI

---

## Testing (Phase 3)

Una vez que el MVP sea funcional, implementar:

- Tests unitarios para servicios (Mocha + Chai)
- Tests de integración para webhooks (Supertest)
- Mock de APIs externas (Nock)

**Ejecutar con:** `npm test`

---

## External API References

- [GHL API V2 Docs](https://marketplace.gohighlevel.com/docs/oauth/GettingStarted)
- [GHL OAuth 2.0](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0)
- [Evolution API Docs](https://doc.evolution-api.com/v2/api-reference/get-information)
- [OpenAI API Docs](https://platform.openai.com/docs/)