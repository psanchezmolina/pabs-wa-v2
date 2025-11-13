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
- **Testing:** Mocha + Chai + Supertest + Nock (53 tests unitarios passing, 4 pending integración)
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
│   ├── ghl.js            # GHL API + OAuth auto-refresh + caché tokens
│   ├── evolution.js      # Evolution API wrapper
│   ├── openai.js         # Whisper + Vision
│   └── cache.js          # Caché en memoria (tokens, contactos, conversaciones)
├── utils/
│   ├── retry.js          # axios-retry config + timeout global
│   ├── logger.js         # Winston logger
│   ├── notifications.js  # Sistema notificaciones con agregación + fallback email
│   ├── email.js          # Servicio de email usando Resend
│   ├── validation.js     # Payload validation + truncamiento
│   ├── sanitizer.js      # Redactar datos sensibles en logs
│   ├── webhookAuth.js    # Validación whitelist de webhooks
│   ├── betaFeatures.js   # Beta feature flags helpers
│   └── instanceMonitor.js # Monitor instancias (cada 30min)
├── public/                 # QR panel (DO NOT MODIFY)
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
- `is_beta` (BOOLEAN, DEFAULT false) - Flag para clientes en programa beta

**Columnas ignoradas:** `openai_apikey`, `is_active`, `webhook_secret`

**Índices:** `location_id`, `instance_name`

**Seguridad:**
- RLS (Row Level Security) activado
- Política: "Allow authenticated access" permite acceso con anon key
- No requiere service_role key

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

### OAuth

- `GET /oauth/ghl/connect?location_id=XXX` - Inicia flujo OAuth
  - **Rate limiting:** 10 intentos cada 15 minutos por IP
- `GET /auth/credentials2/callback` - Handler de callback de OAuth
  - **Rate limiting:** 10 intentos cada 15 minutos por IP

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
- **Audio:** Transcribir con Whisper → `"audio: {text}"` (fallback: `"🎤 [audio no procesado]"`)
- **Imagen:** Analizar con Vision → `"descripcion imagen: {text}"` (fallback: `"🖼️ [imagen no procesada]"`)
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

### 5. Monitor de Instancias

**Frecuencia:** Cada 30 minutos automáticamente

**Funcionalidad:**
- Verifica conexión de todas las instancias Evolution API (`/instance/connectionState`)
- Detecta cambios de estado (desconexión/reconexión)
- Notifica solo en cambios (no spam)
- Agrupa por cliente afectado
- Carga mínima: ~7,200 requests/día con 150 instancias (~0.08 req/s)

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
  - WhatsApp envía: `34660722687@s.whatsapp.net`
  - Conversión automática: se quita `@s.whatsapp.net` y se añade `+` al inicio
  - **Búsqueda optimizada:** Solo se busca en formato E.164 (1 llamada vs 3 llamadas multi-formato)
  - Si falla create por duplicado, se extrae el `contactId` del error (fallback inteligente)
- **Cálculo de retraso de mensaje:** `Math.min(Math.max(text.length * 50, 2000), 10000)`
- **Límite mensajes:** >4096 chars se truncan automáticamente con aviso
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

**Estado:** 53 tests unitarios passing, 4 pending (integración)

### Ejecutar Tests

```bash
npm test                    # Ejecutar todos los tests
npm run test:watch          # Modo watch (auto-reload)
npm test -- test/unit/**/*  # Solo tests unitarios
```

### Cobertura Actual

**✅ Tests Unitarios (test/unit/):**
- `validation.test.js` - Validación payloads + truncamiento (11 tests)
- `notifications.test.js` - Sistema notificaciones (5 tests)
- `ghl.test.js` - Lógica GHL (token refresh, phone format) (9 tests)
- `sanitizer.test.js` - Redacción datos sensibles (6 tests) **NUEVO**
- `cache.test.js` - Caché en memoria (10 tests) **NUEVO**
- `webhookAuth.test.js` - Validación whitelist (8 tests) **NUEVO**

**⏳ Tests Integración (test/integration/):**
- `webhooks.test.js` - HTTP endpoints (4 tests preparados, deshabilitados)

**Documentación:** Ver `test/README.md` para más detalles

---

## External API References

- [GHL API V2 Docs](https://marketplace.gohighlevel.com/docs/oauth/GettingStarted)
- [GHL OAuth 2.0](https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0)
- [Evolution API Docs](https://doc.evolution-api.com/v2/api-reference/get-information)
- [OpenAI API Docs](https://platform.openai.com/docs/)