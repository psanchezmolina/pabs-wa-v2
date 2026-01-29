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
- **Testing:** Mocha + Chai + Supertest + Nock (~78 tests unitarios passing, 4 pending integración)
- **Deploy:** Docker en Easypanel/Contabo VPS

### External APIs

- GoHighLevel (CRM + OAuth)
- Evolution API v2 (WhatsApp)
- OpenAI (Whisper + GPT-4o-mini Vision)
- Langfuse (Prompt Management - beta feature)
- Flowise (Conversational AI - beta feature)

---

## Project Structure

```
/
├── server.js               # Express app + routes
├── config.js               # Env vars (CommonJS)
├── webhooks/
│   ├── ghl.js            # GHL → WhatsApp handler
│   ├── whatsapp.js       # WhatsApp → GHL handler
│   └── agent.js          # Agent system handler
├── services/
│   ├── supabase.js       # DB client + queries
│   ├── ghl.js            # GHL API + OAuth auto-refresh + caché tokens
│   ├── evolution.js      # Evolution API wrapper + panel connection (QR/pairing)
│   ├── openai.js         # Whisper + Vision
│   ├── cache.js          # Caché en memoria (tokens, contactos, conversaciones)
│   ├── messageCache.js   # Cola de mensajes fallidos (8h TTL, retry automático)
│   ├── langfuse.js       # Langfuse API client
│   ├── flowise.js        # Flowise API client
│   ├── agentBuffer.js    # Message buffering + debouncing
│   ├── mediaProcessor.js # Attachment processing
│   └── messageSplitter.js # LLM message splitter (beta - divide mensajes en 1-3 partes)
├── utils/
│   ├── retry.js          # axios-retry config + timeout global
│   ├── logger.js         # Winston logger
│   ├── notifications.js  # Sistema notificaciones con agregación + fallback email
│   ├── email.js          # Servicio de email usando Resend
│   ├── validation.js     # Payload validation + truncamiento
│   ├── sanitizer.js      # Redactar datos sensibles en logs
│   ├── webhookAuth.js    # Validación whitelist de webhooks
│   ├── betaFeatures.js   # Beta feature flags helpers
│   ├── mediaHelper.js    # DRY media processing helpers (shared)
│   └── instanceMonitor.js # Monitor instancias + auto-restart (webhook + polling 2h)
├── public-v2/              # Panel de conexión WhatsApp v2
│   ├── index.html        # Panel UI
│   ├── app.js            # Lógica vanilla JS
│   └── style.css         # Estilos custom
├── public/                 # Panel legacy (DEPRECATED - mantener para compatibilidad)
└── test/                   # Tests unitarios e integración
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
ADMIN_INSTANCE_APIKEY=xxx  # Requerido para notificaciones

# Email fallback (opcional - usa Resend)
RESEND_API_KEY=re_xxx  # API key de Resend (opcional)
ADMIN_EMAIL=tu-email@example.com  # Email para recibir alertas de fallback

# Langfuse (opcional - para agent system)
# Solo URL base global - Las API keys se guardan por cliente en clients_details
LANGFUSE_BASE_URL=https://pabs-langfuse-web.r4isqy.easypanel.host

# Legacy (panel v1 - deprecated)
N8N_BASE_URL=https://newbrain.pabs.ai
N8N_AUTH_HEADER=Bearer xxx

# Branding (panel v2 - white-label)
BRAND_NAME=Pabs.ai  # Nombre de marca mostrado en panel de conexión (opcional)
```

---

## Database Schema

### Table: `clients_details`

**Estructura completa:**

```sql
CREATE TABLE clients_details (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    location_id VARCHAR(255) NOT NULL UNIQUE,
    whatsapp_provider VARCHAR(20) NOT NULL DEFAULT 'evolution' CHECK (whatsapp_provider IN ('evolution', 'official')),
    instance_name VARCHAR(255),
    instance_apikey VARCHAR(255),
    instance_sender VARCHAR(255),
    conversation_provider_id VARCHAR(255) DEFAULT '690f3c36cc3a9220c22aa883',
    ghl_access_token TEXT,
    ghl_refresh_token TEXT,
    ghl_token_expiry TIMESTAMPTZ,
    is_beta BOOLEAN NOT NULL DEFAULT FALSE,
    langfuse_public_key VARCHAR,
    langfuse_secret_key VARCHAR,
    last_connected_at TIMESTAMPTZ
);
```

**Columnas clave:**

- `id` (BIGSERIAL PRIMARY KEY) - Identificador único auto-incremental
- `created_at` (TIMESTAMPTZ NOT NULL) - Timestamp de creación
- `updated_at` (TIMESTAMPTZ NOT NULL) - Timestamp de última actualización
- `location_id` (VARCHAR(255) NOT NULL UNIQUE) - Identificador de ubicación GHL, usado en webhooks
- `whatsapp_provider` (VARCHAR(20) NOT NULL) - Tipo de provider WhatsApp: 'evolution' (Evolution API) o 'official' (WhatsApp API Oficial vía GHL) (default: 'evolution')
- `instance_name` (VARCHAR(255) NULL) - Nombre de instancia de Evolution API (NULL si provider='official')
- `instance_apikey` (VARCHAR(255) NULL) - Clave API de Evolution (NULL si provider='official')
- `instance_sender` (VARCHAR(255) NULL) - Formato de número de WhatsApp: `34XXX@s.whatsapp.net` (NULL si provider='official')
- `conversation_provider_id` (VARCHAR(255) NULL) - ID de proveedor de conversación GHL (default: '690f3c36cc3a9220c22aa883')
- `ghl_access_token` (TEXT NULL) - Token de acceso OAuth
- `ghl_refresh_token` (TEXT NULL) - Token de refresco OAuth
- `ghl_token_expiry` (TIMESTAMPTZ NULL) - Expiración del token
- `is_beta` (BOOLEAN NOT NULL) - Flag para clientes en programa beta (default: false)
- `langfuse_public_key` (VARCHAR NULL) - Langfuse Public Key del proyecto del cliente (pk-lf-...)
- `langfuse_secret_key` (VARCHAR NULL) - Langfuse Secret Key del proyecto del cliente (sk-lf-...)
- `last_connected_at` (TIMESTAMPTZ NULL) - Timestamp de última conexión exitosa de WhatsApp (solo para provider='evolution')

**Índices:**
- `clients_details_pkey` - PRIMARY KEY on `id`
- `clients_details_location_id_key` - UNIQUE INDEX on `location_id`
- `idx_location_id` - INDEX on `location_id`
- `idx_instance_name` - INDEX on `instance_name`
- `idx_clients_last_connected` - INDEX on `last_connected_at`

**Seguridad:**
- RLS (Row Level Security) activado
- Política: "Allow all access" - Acceso total para `public` role
- Funciona con anon key, no requiere service_role key

### Table: `agent_configs`

```sql
CREATE TABLE agent_configs (
    id SERIAL PRIMARY KEY,
    location_id VARCHAR NOT NULL,
    agent_name VARCHAR NOT NULL,
    flowise_webhook_url TEXT NOT NULL,
    flowise_api_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(location_id, agent_name),
    FOREIGN KEY (location_id) REFERENCES clients_details(location_id) ON DELETE CASCADE
);
```

**Propósito:** Configuración de agentes conversacionales (Flowise) por cliente.

---

## WhatsApp Providers: Evolution API vs API Oficial

### **1. Evolution API (Default)**
- **Flujo:** GHL → `/webhook/ghl` → Evolution API → WhatsApp
- **Setup BD:** `whatsapp_provider='evolution'`, requiere `instance_name/apikey`
- **Monitoreo:** ✅ Auto-restart cada 2h
- **Panel:** ✅ `/panel/` (QR/Pairing)

### **2. WhatsApp API Oficial**
- **Flujo:** GHL ↔ WhatsApp API Oficial (directo, sin pasar por servidor)
- **Setup BD:** `whatsapp_provider='official'`, `instance_name/apikey/sender=NULL`
- **Monitoreo:** ❌ GHL maneja
- **Panel:** ❌ Gestión en GHL UI

| Característica | Evolution | Oficial |
|----------------|-----------|---------|
| Coste | Gratis | Pago/mensaje |
| Monitoreo | ✅ Auto-restart | ❌ |
| Setup | Panel QR | GHL UI |

**Importante:**
- Agent System funciona con AMBOS providers
- Cada cliente usa UN solo provider
- Webhooks GHL outbound solo para Evolution

---

## Beta Features

Sistema de feature flags simple para testear nuevas funcionalidades con clientes específicos.

**Nota:** El Agent System (Flowise + Langfuse) ya NO es beta y está disponible para todos los clientes.

### LLM Message Splitter (Beta - FASE 1)

**Objetivo:** Divide respuestas largas de GHL Conversation AI en 2-3 mensajes usando GPT-4o-mini

**Activación:**
- `is_beta = true` + `whatsapp_provider = 'evolution'`
- **IMPORTANTE:** Desactiva Agent System automáticamente (no configurar `/webhook/agent`)

**Lógica (servicios/messageSplitter.js):**
- Máximo 3 fragmentos con puntuación final
- Respeta párrafos (\n\n)
- Listas NUNCA se dividen
- Delays: 2s entre parte 1-2, 1.5s entre parte 2-3
- Fallback: mensaje completo si falla

```sql
-- Activar/desactivar
UPDATE clients_details SET is_beta = true WHERE location_id = 'XXX';
```

### Uso en Código

Ver `utils/betaFeatures.js`: `isBetaClient()`, `executeBetaAware()`, `logBetaUsage()`

**Workflow:** Desarrollo → Testing (1-2 clientes) → Validación → Rollout → Cleanup docs

---

## API Endpoints

### Webhooks

- `POST /webhook/ghl` - Recibe mensajes salientes de GHL (uno por cada `location_id`)
  - **Validación whitelist:** Verifica que `location_id` exista en BD antes de procesar
  - Rechaza con 403 si `location_id` no está autorizado
  - **Beta feature:** Si cliente tiene `is_beta = true` + `whatsapp_provider = 'evolution'`:
    - Intercepta mensaje outbound de GHL Conversation AI
    - Divide con LLM (GPT-4o-mini) en hasta 3 partes
    - Envía partes a Evolution API con delays (2s, 1.5s)
    - Si falla, cae a flujo normal (mensaje completo)
- `POST /webhook/whatsapp` - **Webhook único** que recibe mensajes de TODAS las instancias de Evolution API
  - Identifica la instancia mediante el campo `instance` en el payload
  - **Validación whitelist:** Verifica que `instance_name` exista en BD antes de procesar
  - Rechaza con 403 si instancia no está autorizada
  - Busca automáticamente la configuración del cliente en Supabase usando `instance_name`
  - Soporta múltiples instancias simultáneamente sin necesidad de endpoints diferentes
- `POST /webhook/agent` - **Webhook de agent system** (solo clientes NO beta)
  - Recibe mensajes de GHL para procesamiento con IA conversacional
  - **Validación whitelist:** Verifica que `location_id` exista en BD
  - Rechaza con 403 si no está autorizado
  - **Rechaza clientes beta (200):** Clientes beta usan GHL Conversation AI, no Flowise
  - Buffering de mensajes con debouncing de 7 segundos
  - Procesamiento asíncrono con Flowise + Langfuse
  - Retorna 200 inmediatamente, procesamiento ocurre en background

### OAuth

- `GET /oauth/ghl/connect?location_id=XXX` - Inicia flujo OAuth
  - **Rate limiting:** 10 intentos cada 15 minutos por IP
- `GET /auth/credentials2/callback` - Handler de callback de OAuth
  - **Rate limiting:** 10 intentos cada 15 minutos por IP

### Health

- `GET /health` - Estado del servidor + servicios externos

### Panel de Conexión WhatsApp v2

**Endpoints:**
- `GET /panel/config` - Branding config
- `GET /panel/status/:locationId` - Estado instancia
- `POST /panel/qr/:locationId` - QR Code (base64)
- `POST /panel/pairing/:locationId` - Pairing Code (body: `{phoneNumber}`)

**URL GHL Custom Menu Link:** `https://tu-dominio.com/panel/?location_id={{location.id}}`

**Características:** Auto-detección location_id, white-label (`BRAND_NAME`), fecha conexión relativa, formato E.164

**Nota:** Pairing code puede fallar en instancias antiguas (fallback a QR automático)

### Legacy (QR Panel) - DEPRECATED

- `GET /` - Sirve `public/index.html` (mantener para compatibilidad)
- `POST /api/:action` - Proxy a n8n (NO MODIFICAR)
- **Migrar usuarios a panel v2 (`/panel/`)**

---

## Core Workflows

### 1. GHL → WhatsApp
1. Validar payload (`direction === "outbound"`, campo `body`)
2. Obtener cliente por `location_id`
3. Obtener teléfono contacto (GHL API)
4. Enviar a Evolution API
5. Marcar entregado en GHL

**Error handling:** 4 reintentos, notificar admin, verificar WhatsApp

### 2. WhatsApp → GHL
1. Validar payload, obtener cliente por `instance_name`
2. Detectar tipo mensaje + procesar media (Whisper/Vision)
3. Buscar/crear contacto + conversación GHL
4. Subir mensaje a GHL

**Formatos media:** Texto (directo), Audio (`"audio: {text}"`), Imagen (`"descripcion imagen: {text}"`), MP4 (Whisper si posible), Video/Document/Location/Contact/Sticker (placeholders)

### 3. OAuth Flow
`/oauth/ghl/connect` → Intercambiar código → Guardar tokens Supabase → Auto-refresh en `ghl.js` (<5min expiry)

### 4. Sistema de Notificaciones
- Agregación 5min (primer error inmediato, siguientes agrupados)
- Formato: archivo:línea, API response, payload, quick fix suggestions, stack trace
- Fallback: WhatsApp → Email (Resend) → Winston log
- Triggers: token refresh, webhooks, OpenAI, instancias desconectadas

### 5. Monitor de Instancias + Auto-Restart
- Detección: Webhook `CONNECTION_UPDATE` (primario) + Polling 2h (backup)
- Auto-restart: `/instance/restart` → Si éxito: procesa cola mensajes, Si falla: notifica "Requiere QR"
- Carga: ~1,800 requests/día (150 instancias)

### 6. Agent System

Sistema de agentes conversacionales IA: procesa mensajes GHL (SMS/IG/FB) → Buffer 7s → Flowise + Langfuse → Respuesta multiparte a GHL

**Arquitectura:**
- Webhook: `/webhook/agent` (whitelist)
- Buffer: RAM (NodeCache, 10min TTL, límite 7 mensajes)
- Debouncing: 7s (auto-reset)
- AI: Flowise + Langfuse (prompts cacheados 1h)

**Servicios:** `langfuse.js`, `flowise.js`, `agentBuffer.js`, `mediaProcessor.js`, `mediaHelper.js` (DRY compartido con whatsapp.js)

**Workflow:**
1. Recepción + validación webhook
2. Procesar attachments (OpenAI)
3. Buffering con debounce 7s
4. AI Processing: Langfuse (prompts) + Flowise (chatflow)
5. Registrar respuesta en GHL (hasta 3 partes)

**Payload GHL:**
```json
{
  "contact_id": "xxx",
  "location_id": "xxx",
  "customData": {"message_body": "texto", "agente": "nombre-agente"},
  "message": {"type": "SMS", "attachments": ["url"]}  // type opcional, default SMS
}
```

**Mapeo canales:** 20=SMS, 19=WhatsApp, 18=IG, 11=FB, 29=Live_Chat

**Flowise payload:**
```json
{
  "question": "mensaje",
  "overrideConfig": {
    "sessionId": "conversationId_de_ghl",  // Mantiene memoria
    "startState": [{"key": "contact_id", "value": "xxx"}, ...]
  }
}
```

**Configuración Langfuse:**
```sql
UPDATE clients_details SET langfuse_public_key='pk-lf-xxx', langfuse_secret_key='sk-lf-xxx' WHERE location_id='xxx';
```

**Notas:**
- 1 cliente = 1 proyecto Langfuse (keys en BD)
- `sessionId` en `overrideConfig` (usa conversationId de GHL)
- Procesamiento asíncrono (webhook retorna 200 inmediatamente)
- Media helpers DRY compartidos con whatsapp.js

Ver `FLOWISE.md` para documentación técnica completa del sistema.

---

## Coding Conventions

- **Module System:** CommonJS (`require`/`module.exports`)
- **Error Handling:** `try/catch` + Winston logs + notificar admin (fallos críticos)
- **Retries:** 4 reintentos, 800ms delay (APIs externas)
- **Logging:** `logger.info('Event', {context})`, `logger.error('Error', {error, stack})`
- **Validation:** Validar payloads webhooks con `utils/validation.js`

---

## Critical Rules

1. **NO MODIFICAR** el directorio `/public` - Panel QR legacy, mantener intacto
2. **Siempre verificar la expiración del token** - Auto-refresco en `services/ghl.js` con caché
3. **Formatear números de WhatsApp correctamente** - `34XXX@s.whatsapp.net`
4. **Usar clave global de OpenAI** - Ignorar columna `openai_apikey` en BD
5. **Notificar al admin en errores críticos** - Usar `utils/notifications.js`
6. **Loguear todos los eventos importantes** - Usar Winston con contexto
7. **Sanitizar logs sensibles** - NUNCA loguear tokens/keys sin redactar (usar `utils/sanitizer.js`)
8. **Validar webhooks** - Todos los webhooks pasan por middleware de whitelist (`utils/webhookAuth.js`)
9. **Usar caché cuando sea posible** - Tokens, contactIds y conversationIds se cachean 1h (`services/cache.js`)
10. **Timeout en requests externos** - 15s global para prevenir bloqueos indefinidos

---

## Common Patterns

```javascript
// Getting client
const client = req.client || await getClientByLocationId(locationId); // GHL
const client = req.client || await getClientByInstanceName(instanceName); // WhatsApp

// Using cache
let contactId = getCachedContactId(locationId, phone);
if (!contactId) {
  contactId = (await ghlAPI.searchContact(client, phone)).contacts[0].id;
  setCachedContactId(locationId, phone, contactId);
}

// APIs
await ghlAPI.getContact(client, contactId);
await evolutionAPI.sendText(instanceName, apikey, number, message);

// Media processing
const media = await evolutionAPI.getMediaBase64(instance, apikey, messageId);
const text = await openaiAPI.transcribeAudio(media.base64, media.mimetype);
const description = await openaiAPI.analyzeImage(media.base64);
```

---

## Known Issues & Caveats

**Webhooks & Validación:**
- Webhook único Evolution API: `https://domain.com/webhook/whatsapp` (identifica instancia por payload)
- Whitelist: solo procesa `location_id`/`instance_name` en BD (rechaza 403 si no autorizado)

**Caché & Memoria (volátil):**
- Tokens GHL, contactIds, conversationIds cacheados 1h en RAM
- Se pierde al reiniciar (normal) - primer mensaje post-reinicio más lento
- Cola mensajes fallidos: 8h TTL, retry 5-10-20-40-60min (máx 5 intentos)

**Timeouts:**
- APIs (GHL, Evolution, OpenAI): 15s
- Flowise: 2min (permite herramientas)

**Formatos & Límites:**
- Teléfonos: GHL usa E.164 (`+34660722687`), WhatsApp envía con `@s.whatsapp.net` y device ID (`:0`, `:1`)
- Mensajes: >4096 chars se truncan
- Buffer agent: máx 7 mensajes (notifica admin)
- Delay mensajes: `Math.min(Math.max(text.length * 50, 2000), 10000)`

**Otros:**
- Campos BD se limpian con `.trim()` automáticamente
- Tokens GHL auto-refresh cuando expiran <5min
- Fallback OpenAI: `"🎤/🖼️ [no procesado]"` + notificación admin

---

## Development Workflow

**Local:** `npm start` / `npm run dev` → Logs: `tail -f combined.log` → Health: `curl localhost:3000/health`

**Process (Nuevas features/fixes):**
1. Implementar código
2. Ejecutar tests (`npm test`)
3. Verificar logs
4. Actualizar CLAUDE.md (conciso)
5. Probar manualmente (cliente beta si es nuevo)

**Importante:** Tests y documentación no son opcionales

### Production Deployment (Easypanel/Contabo VPS)

**Infraestructura actual:**
- **Hosting:** Contabo VPS
- **Panel de control:** Easypanel
- **Contenedor:** Docker
- **URL del servidor:** Se configura en Easypanel

**Configuración crítica de servidor:**
- El servidor DEBE escuchar en `0.0.0.0` (no localhost) para funcionar en Docker
- Esto está configurado en `server.js:537`: `app.listen(PORT, '0.0.0.0')`
- **NUNCA cambiar a localhost** - causará error 502 en Easypanel
- **Trust Proxy configurado:** `app.set('trust proxy', 1)` (server.js:24)
  - Requerido para que express-rate-limit funcione correctamente detrás del proxy de Easypanel
  - Valor `1` = confía solo en el primer proxy (más seguro que `true`)
  - Sin esto, OAuth y endpoints con rate limiting fallarán con error `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` o `ERR_ERL_PERMISSIVE_TRUST_PROXY`

**Configuración crítica en Easypanel:**
- **Puerto de aplicación:** DEBE estar configurado en `3000` (Settings → General → Port o App Port)
- Si está configurado en 80 u otro puerto → Error 502 (proxy no puede conectar)
- El Dockerfile expone el puerto 3000 (`EXPOSE 3000`) - Easypanel debe coincidir con este puerto

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

## Testing

**Estado:** ~78 tests unitarios passing, 4 pending (integración)

**Comandos:** `npm test`, `npm run test:watch`

**Cobertura:**
- Unitarios: validation, notifications, ghl, sanitizer, cache, webhookAuth
- Agent System: agentBuffer, flowise, langfuse, validation-agent
- Integración: webhooks (pendientes)

Ver `test/README.md` para detalles

---

## External API References

- [GHL API V2 Docs](https://marketplace.gohighlevel.com/docs/oauth/GettingStarted)
- [GHL OAuth 2.0](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0)
- [Evolution API Docs](https://doc.evolution-api.com/v2/api-reference/get-information)
- [OpenAI API Docs](https://platform.openai.com/docs/)
- [Langfuse API Docs](https://api.reference.langfuse.com)
- [Flowise API Docs](https://docs.flowiseai.com)