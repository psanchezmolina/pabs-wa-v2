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
│   └── agent.js          # Agent system handler (beta)
├── services/
│   ├── supabase.js       # DB client + queries
│   ├── ghl.js            # GHL API + OAuth auto-refresh + caché tokens
│   ├── evolution.js      # Evolution API wrapper + panel connection (QR/pairing)
│   ├── openai.js         # Whisper + Vision
│   ├── cache.js          # Caché en memoria (tokens, contactos, conversaciones)
│   ├── messageCache.js   # Cola de mensajes fallidos (8h TTL, retry automático)
│   ├── langfuse.js       # Langfuse API client (beta)
│   ├── flowise.js        # Flowise API client (beta)
│   ├── agentBuffer.js    # Message buffering + debouncing (beta)
│   └── mediaProcessor.js # Attachment processing (beta)
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

# Langfuse (opcional - solo para agent system beta)
# Solo URL base global - Las API keys se guardan por cliente en clients_details
LANGFUSE_BASE_URL=https://pabs-langfuse-web.r4isqy.easypanel.host

# Legacy (panel v1 - deprecated)
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
- `is_beta` (BOOLEAN, DEFAULT false) - Flag para clientes en programa beta
- `langfuse_public_key` (VARCHAR) - Langfuse Public Key del proyecto del cliente (pk-lf-...)
- `langfuse_secret_key` (VARCHAR) - Langfuse Secret Key del proyecto del cliente (sk-lf-...)

**Columnas ignoradas:** `openai_apikey`, `is_active`, `webhook_secret`

**Índices:** `location_id`, `instance_name`

**Seguridad:**
- RLS (Row Level Security) activado
- Política: "Allow authenticated access" permite acceso con anon key
- No requiere service_role key

### Table: `agent_configs` (Beta)

**Columnas:**

- `id` (SERIAL PRIMARY KEY)
- `location_id` (VARCHAR NOT NULL) - Identificador de ubicación GHL
- `agent_name` (VARCHAR NOT NULL) - Nombre del agente (ej: "agente-roi")
- `flowise_webhook_url` (TEXT NOT NULL) - URL completa del webhook de Flowise
- `flowise_api_key` (TEXT) - API key de Flowise (opcional, ej: "Bearer xxx")
- `created_at` (TIMESTAMPTZ DEFAULT NOW())
- `updated_at` (TIMESTAMPTZ DEFAULT NOW())

**Constraints:**
- `UNIQUE(location_id, agent_name)`
- `FOREIGN KEY (location_id) REFERENCES clients_details(location_id) ON DELETE CASCADE`

**Propósito:** Configuración de agentes conversacionales con IA para el sistema beta de agentes.

---

## Beta Features

Sistema de feature flags simple para testear nuevas funcionalidades con clientes específicos.

### Configuración

**Base de datos:**
```sql
-- Activar cliente para beta
UPDATE clients_details SET is_beta = true WHERE location_id = 'XXX';

-- Desactivar
UPDATE clients_details SET is_beta = false WHERE location_id = 'XXX';

-- Ver clientes beta
SELECT location_id, instance_name, is_beta FROM clients_details WHERE is_beta = true;
```

### Uso en Código

**Helpers disponibles en `utils/betaFeatures.js`:**

```javascript
const { isBetaClient, executeBetaAware, logBetaUsage } = require('../utils/betaFeatures');

// 1. Chequeo simple
if (isBetaClient(client)) {
  // Ejecutar lógica beta
}

// 2. Ejecución condicional
const result = await executeBetaAware(
  client,
  async () => {/* lógica beta */},
  async () => {/* lógica producción */}
);

// 3. Logging de uso beta
logBetaUsage(client, 'feature-name', { metadata: 'value' });
```

### Workflow

1. **Desarrollo:** Implementar feature con chequeo `isBetaClient()`
2. **Testing:** Activar `is_beta=true` para 1-2 clientes de prueba
3. **Validación:** Monitorear logs y notificaciones durante varios días
4. **Rollout:** Si es exitoso, remover chequeo beta y desplegar para todos
5. **Cleanup:** Actualizar CLAUDE.md si es necesario

**Importante:** Beta flags son para features **completas y funcionales**, no para código experimental o roto.

---

## API Endpoints

### Webhooks

- `POST /webhook/ghl` - Recibe mensajes salientes de GHL (uno por cada `location_id`)
  - **Validación whitelist:** Verifica que `location_id` exista en BD antes de procesar
  - Rechaza con 403 si `location_id` no está autorizado
- `POST /webhook/whatsapp` - **Webhook único** que recibe mensajes de TODAS las instancias de Evolution API
  - Identifica la instancia mediante el campo `instance` en el payload
  - **Validación whitelist:** Verifica que `instance_name` exista en BD antes de procesar
  - Rechaza con 403 si instancia no está autorizada
  - Busca automáticamente la configuración del cliente en Supabase usando `instance_name`
  - Soporta múltiples instancias simultáneamente sin necesidad de endpoints diferentes
- `POST /webhook/agent` - **Webhook de agent system** (beta feature)
  - Recibe mensajes de GHL para procesamiento con IA conversacional
  - **Validación whitelist:** Verifica que `location_id` exista en BD + `is_beta=true`
  - Rechaza con 403 si no está autorizado o no tiene beta activado
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

Panel moderno para conectar instancias de WhatsApp mediante QR Code o Pairing Code.

**Endpoints:**
- `GET /panel/status/:locationId` - Estado de instancia (open/connecting/close)
- `POST /panel/qr/:locationId` - Generar QR Code (retorna base64 o mensaje "ya conectado")
- `POST /panel/pairing/:locationId` - Generar Pairing Code (body: `{phoneNumber}` sin +)

**Métodos de conexión:**
1. **QR Code** (principal): Retorna base64 de imagen lista para `<img src="">`
2. **Pairing Code** (experimental): Genera código de 8 dígitos, fallback automático a QR si falla

**URL para GHL Custom Menu Link:**
```
https://tu-dominio.com/panel/?location_id={{location.id}}
```

**Notas:**
- Auto-detecta `location_id` desde URL
- Pairing code puede fallar si instancia fue creada hace tiempo → Fallback a QR
- Panel funciona embebido en iframe (CSP configurado)
- No usa localStorage/cookies (third-party context)

### Legacy (QR Panel) - DEPRECATED

- `GET /` - Sirve `public/index.html` (mantener para compatibilidad)
- `POST /api/:action` - Proxy a n8n (NO MODIFICAR)
- **Migrar usuarios a panel v2 (`/panel/`)**

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
- **Audio:** Transcribir con Whisper → `"audio: {text}"` (fallback: `"🎤 [audio no procesado]"`)
- **Imagen:** Analizar con Vision → `"descripcion imagen: {text}"` (fallback: `"🖼️ [imagen no procesada]"`)
- **MP4:** Intenta Whisper (IG/FB audios) → Si falla, placeholder video
- **Video:** Formato básico → `"🎥 [video] - caption"`
- **Document:** Formato básico → `"📎 [filename] - caption"`
- **Location:** Formato básico → `"📍 [ubicación]: nombre (lat, lng)"`
- **Contact:** Formato básico → `"👤 [contacto: nombre]"`
- **Sticker:** Formato básico → `"😊 [sticker]"`

**Límites:** Mensajes >4096 chars se truncan automáticamente

### 3. OAuth Flow

1. **Inicio:** `/oauth/ghl/connect?location_id=XXX` redirige a GHL
2. **Callback:** Intercambiar código por tokens, guardar en Supabase
3. **Auto-refresco:** Ocurre automáticamente en `ghl.js` cuando el token expira en < 5 min

### 4. Sistema de Notificaciones

**Agregación inteligente (5 min window):**
- Primer error → Notificación inmediata
- Errores repetidos → Agrupados automáticamente
- Envío resumen después de 5 min o al reconectar

**Formato mejorado incluye:**
- 📁 Archivo:línea del error (extraído del stack trace)
- 🌐 API Response completa (status + mensaje + payload)
- 📤 Payload enviado a la API (sanitizado, hasta 400 chars)
- 💡 Quick Fix Suggestions contextuales según tipo de error
- Stack trace completo

**Sistema de fallback (Email):**
- Notificaciones primarias vía WhatsApp (`ADMIN_INSTANCE`)
- Si WhatsApp falla → Email automático vía Resend
- Si ambos fallan → Log crítico en Winston
- Email usa formato HTML con toda la información del error
- Configuración opcional: requiere `RESEND_API_KEY` y `ADMIN_EMAIL`

**Triggers:** Token refresh failed, webhook errors, OpenAI failures, instancias desconectadas

### 5. Monitor de Instancias + Auto-Restart

**Detección Híbrida:**
- **Primario:** Webhook `CONNECTION_UPDATE` (tiempo real, 0 requests)
- **Backup:** Polling cada 2 horas (`/instance/connectionState`)

**Auto-Restart Automático:**
- Al detectar desconexión → Intenta `/instance/restart` (usa sesión existente)
- Si éxito → Notifica "Reconectada Automáticamente ✅" + procesa cola mensajes
- Si falla → Notifica "Requiere QR ⚠️" con instrucciones

**Funcionalidad:**
- Detecta cambios de estado en tiempo real vía webhooks
- Auto-reconexión sin intervención manual (si sesión válida)
- Procesa cola de mensajes pendientes al reconectar
- Notifica solo en cambios (no spam)
- Carga mínima: ~1,800 requests/día con 150 instancias (polling cada 2h)

### 6. Agent System (Beta Feature)

**Estado:** Beta - requiere `is_beta=true` en `clients_details`

**Overview:**
Sistema de agentes conversacionales con IA que procesa mensajes de GHL (SMS, IG, FB), los agrupa con debouncing (7s), los envía a Flowise para procesamiento AI, y retorna respuestas multiparte a través de GHL.

**Arquitectura:**
- **Webhook:** `POST /webhook/agent` (validación whitelist + beta flag)
- **Buffer:** Mensajes se acumulan en RAM (NodeCache, 10min TTL)
- **Debouncing:** 7 segundos (auto-reset en nuevo mensaje)
- **AI Processing:** Flowise + Langfuse (prompt management)
- **Response:** Hasta 3 partes registradas en GHL como outbound

**Database Schema:**

```sql
-- Tabla de configuración de agentes
CREATE TABLE agent_configs (
  id SERIAL PRIMARY KEY,
  location_id VARCHAR NOT NULL,
  agent_name VARCHAR NOT NULL,
  flowise_webhook VARCHAR NOT NULL,  -- URL completa del chatflow
  chatflow_id VARCHAR NOT NULL,      -- ID del chatflow en Flowise
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(location_id, agent_name)
);
```

**Servicios:**
- `services/langfuse.js` - Obtener prompts (caché 1h)
- `services/flowise.js` - Llamar chatflow + parser 3 niveles
- `services/agentBuffer.js` - Gestión de buffers con debouncing (límite 7 mensajes)
- `services/mediaProcessor.js` - Procesar attachments (audio/imagen)
- `utils/mediaHelper.js` - **DRY helpers** compartidos con whatsapp.js

**Protecciones implementadas:**
- Límite de 7 mensajes por buffer (previene abuse)
- Error handling completo en setupDebounce
- Notificación admin cuando se alcanza límite
- Buffer auto-limpia (TTL 10 min)

**Workflow completo:**

1. **Recepción:** GHL envía webhook con mensaje (SMS/IG/FB)
2. **Validación:** Middleware verifica `location_id` + `is_beta=true`
3. **Procesamiento:** Attachments procesados con OpenAI (compartido con whatsapp.js)
4. **Buffering:** Mensaje añadido al buffer del contacto+canal
5. **Debounce:** Timer de 7s configurado (auto-reset si llega nuevo mensaje)
6. **AI Processing (al expirar debounce):**
   - Verificar buffer no cambió (v1: comparar cantidad mensajes)
   - Obtener prompt de Langfuse (cacheado 1h)
   - Buscar/crear conversación en GHL
   - Llamar Flowise con mensajes buffereados + startState
   - Parsear respuesta JSON (3 niveles fallback)
7. **Respuesta:** Registrar partes en GHL con dirección `outbound`
8. **Cleanup:** Limpiar buffer

**Payload esperado (GHL):**

```json
{
  "contact_id": "xxxxx",
  "location_id": "xxxxx",
  "customData": {
    "message_body": "texto del mensaje",
    "agente": "agente-roi"
  },
  "message": {
    "type": "SMS",  // o "IG", "FB" - OPCIONAL (ver nota abajo)
    "attachments": ["url1", "url2"]
  }
}
```

**Nota sobre `message.type`:**
- `message.type` es **opcional** - útil para webhooks de inicio de conversación desde workflows
- Si `message.type` **existe**: usa el valor (puede ser string "SMS"/"IG"/"FB" o número 20/18/11)
- Si `message.type` **NO existe**: canal por defecto = **SMS**
- Webhooks de trigger manual (inicio conversación) típicamente no incluyen `message.type`

**Flowise payload completo:**

```json
{
  "question": "mensaje del usuario",
  "overrideConfig": {
    "sessionId": "conversation_id_de_ghl",
    "startState": [
      { "key": "contact_id", "value": "xxxxx" },
      { "key": "conversation_id", "value": "xxxxx" },
      { "key": "location_id", "value": "xxxxx" },
      { "key": "canal", "value": "SMS" },
      { "key": "tags", "value": "activar-ia, cliente-premium" },
      { "key": "prompt", "value": "texto del prompt desde Langfuse" }
    ]
  }
}
```

**Importante:** `sessionId` se pasa dentro de `overrideConfig` (NO como parámetro separado) para mantener la memoria de la conversación en Flowise. Usa el `conversationId` de GHL como valor.

**Environment Variables (opcionales - solo para beta):**

```bash
# Langfuse (prompt management - solo URL base)
LANGFUSE_BASE_URL=https://pabs-langfuse-web.r4isqy.easypanel.host
```

**Configuración por cliente en BD:**

```sql
-- Cada cliente tiene sus propias Langfuse API keys (1 cliente = 1 proyecto Langfuse)
UPDATE clients_details
SET
  langfuse_public_key = 'pk-lf-xxx',  -- Desde Langfuse UI → Project Settings → API Keys
  langfuse_secret_key = 'sk-lf-xxx'   -- Desde Langfuse UI → Project Settings → API Keys
WHERE location_id = 'jWmwy7nMqnsXQPdZdSW8';
```

**Notas importantes:**
- **1 cliente = 1 proyecto Langfuse** con sus propias API keys almacenadas en BD
- `LANGFUSE_BASE_URL` es global (mismo servidor Langfuse self-hosted para todos)
- `langfuse_public_key` y `langfuse_secret_key` son **por cliente** en `clients_details`
- `services/langfuse.js` recibe keys como parámetros: `getPrompt(agentName, publicKey, secretKey)`
- Caché usa clave combinada `publicKey:agentName` para evitar conflictos entre clientes
- **sessionId en Flowise:** Se pasa dentro de `overrideConfig.sessionId` (usa `conversationId` de GHL) para mantener memoria de conversación
- **message.type opcional:** Si no existe en payload, canal por defecto = SMS (útil para triggers manuales)
- Media helpers en `utils/mediaHelper.js` son **DRY** - compartidos con whatsapp.js
- Respuestas se registran en GHL (no se envían directamente via WhatsApp)
- GHL maneja el envío al canal correcto (SMS, IG, FB, WhatsApp)
- Buffer v1: simple comparación de cantidad de mensajes (puede mejorarse con hash)
- Procesamiento asíncrono: webhook retorna 200 inmediatamente
- Errores en debounce callback tienen manejo separado (no capturados por try/catch principal)

**Cliente de prueba:**
- Location ID: `jWmwy7nMqnsXQPdZdSW8`
- Agente: `agente-roi`
- is_beta: `true`

Ver `FLOWISE.md` para documentación técnica completa del sistema.

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

### Getting a client

```javascript
// En webhooks (viene desde middleware con validación whitelist)
const client = req.client || await getClientByLocationId(locationId); // GHL webhooks
const client = req.client || await getClientByInstanceName(instanceName); // WhatsApp webhooks

// Directo (sin middleware)
const client = await getClientByLocationId(locationId);
const client = await getClientByInstanceName(instanceName);
```

**Nota:** Todos los clientes se limpian automáticamente con `.trim()` en campos críticos (`conversation_provider_id`, `instance_apikey`, etc.) para prevenir errores por espacios/saltos de línea (`\r\n`).

### Using cache

```javascript
const { getCachedContactId, setCachedContactId } = require('./services/cache');

// Verificar caché primero
let contactId = getCachedContactId(locationId, phone);

if (!contactId) {
  // No en caché, buscar en API
  const result = await ghlAPI.searchContact(client, phone);
  contactId = result.contacts[0].id;

  // Cachear para próximas veces
  setCachedContactId(locationId, phone, contactId);
}
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
- Los tokens GHL expiran (típicamente 24h) - el auto-refresco con caché maneja esto
- **Caché en memoria (volátil):**
  - Tokens GHL, contactIds y conversationIds se cachean 1h en RAM
  - Se pierden al reiniciar servidor (esto es normal)
  - Primer mensaje después de reinicio es más lento, siguientes rápidos
  - Consumo memoria estimado: ~330KB para 150 clientes
- **Cola de mensajes fallidos (`services/messageCache.js`):**
  - Mensajes que fallan por instancia caída se encolan automáticamente (8h TTL)
  - Retry automático: 5min, 10min, 20min, 40min, 1h (máx 5 intentos)
  - Se procesan cuando: a) instancia se reconecta, b) cada 30min en monitor
  - **Importante:** No marca contacto como "no-wa" si instancia está caída
  - `checkWhatsAppNumber()` retorna `true`/`false`/`null` (null = no se pudo verificar)
  - Cola se pierde al reiniciar servidor (volátil, no persistente)
- **Timeout global de 15 segundos:**
  - Todas las llamadas a APIs externas tienen timeout de 15s
  - Si una API no responde en 15s → Error timeout
  - Previene bloqueos indefinidos, puede generar más notificaciones si APIs están lentas
- **Validación whitelist de webhooks:**
  - Solo procesa webhooks de `location_id`/`instance_name` que existan en BD
  - Rechaza con 403 webhooks no autorizados
  - Loguea intentos sospechosos
- **RLS en Supabase:**
  - Row Level Security activado en `clients_details`
  - Usa política "Allow authenticated access" (funciona con anon key)
  - No requiere service_role key
- **Limpieza automática de campos de BD:**
  - Todos los campos críticos (`conversation_provider_id`, `instance_apikey`, etc.) se limpian con `.trim()` al leer de BD
  - Previene errores por espacios en blanco o saltos de línea (`\r\n`) ocultos
  - **Recomendación:** Limpiar BD manualmente: `UPDATE clients_details SET conversation_provider_id = TRIM(conversation_provider_id)`
- **Números de teléfono - Formato E.164:**
  - GHL usa formato **E.164 estándar**: `+34660722687` (único formato oficial soportado)
  - WhatsApp envía: `34660722687@s.whatsapp.net` o `34660722687:0@s.whatsapp.net` (con device ID)
  - **Device ID (`:0`, `:1`, etc.):** WhatsApp multi-device añade sufijo de dispositivo (AD-JID format)
  - Conversión automática: se quita `@s.whatsapp.net`, `:digit` (device ID), y se añade `+` al inicio
  - **Búsqueda optimizada:** Solo se busca en formato E.164 (1 llamada vs 3 llamadas multi-formato)
  - Si falla create por duplicado, se extrae el `contactId` del error (fallback inteligente)
- **Cálculo de retraso de mensaje:** `Math.min(Math.max(text.length * 50, 2000), 10000)`
- **Límite mensajes:** >4096 chars se truncan automáticamente con aviso
- **Límite buffer agent:** Máximo 7 mensajes por buffer (previene abuse), notifica admin si se alcanza
- **Fallback OpenAI:** Si Whisper/Vision fallan → `"🎤/🖼️ [no procesado]"` + notificación admin
- Las notificaciones de admin requieren que `ADMIN_INSTANCE` y `ADMIN_INSTANCE_APIKEY` estén configurados

---

## Development Workflow

### Local Development

1. **Iniciar servidor:** `npm start` or `npm run dev`
2. **Revisar logs:** `tail -f combined.log` o salida de consola
3. **Probar webhooks:** Usar herramientas como ngrok para pruebas locales
4. **Revisar salud:** `curl http://localhost:3000/health`
5. **Monitorear uso:** Vigilar logs de Winston en busca de errores

### Development Process (Cambios de Código)

Cuando implementes nuevas funcionalidades o fixes, sigue este proceso:

1. **Implementar código** - Hacer los cambios necesarios
2. **Ejecutar tests** - `npm test` para verificar no hay regresiones
3. **Verificar logs** - Revisar que no haya warnings o errors inesperados
4. **Actualizar CLAUDE.md** - Documentar cambios importantes, remover info obsoleta (ser conciso)
5. **Probar manualmente** - Si es feature nueva, probar con cliente beta primero

**Importante:** Tests y documentación son parte del proceso, no opcionales.

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

## Testing

**Estado:** ~78 tests unitarios passing, 4 pending (integración)

### Ejecutar Tests

```bash
npm test                    # Ejecutar todos los tests
npm run test:watch          # Modo watch (auto-reload)
npm test -- test/unit/**/*  # Solo tests unitarios
```

### Cobertura Actual

**✅ Tests Unitarios Existentes:**
- `validation.test.js` - Validación payloads + truncamiento (11 tests)
- `notifications.test.js` - Sistema notificaciones (5 tests)
- `ghl.test.js` - Lógica GHL (token refresh, phone format) (9 tests)
- `sanitizer.test.js` - Redacción datos sensibles (6 tests)
- `cache.test.js` - Caché en memoria (10 tests)
- `webhookAuth.test.js` - Validación whitelist (8 tests)

**✅ Tests Sistema Flow (Agent):**
- `agentBuffer.test.js` - Buffer + debouncing (7 tests)
- `flowise.test.js` - Parser respuestas (6 tests)
- `langfuse.test.js` - Fetch prompts (4 tests)
- `validation-agent.test.js` - Validación payloads agent (11 tests)

**⏳ Tests Integración (test/integration/):**
- `webhooks.test.js` - HTTP endpoints (4 tests preparados, deshabilitados)

**Documentación:** Ver `test/README.md` para más detalles

---

## External API References

- [GHL API V2 Docs](https://marketplace.gohighlevel.com/docs/oauth/GettingStarted)
- [GHL OAuth 2.0](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0)
- [Evolution API Docs](https://doc.evolution-api.com/v2/api-reference/get-information)
- [OpenAI API Docs](https://platform.openai.com/docs/)
- [Langfuse API Docs](https://api.reference.langfuse.com)
- [Flowise API Docs](https://docs.flowiseai.com)