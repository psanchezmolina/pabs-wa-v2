# Feature: Agente Conversacional Multi-Canal con Flowise

## Descripción

Integración de sistema de agentes conversacionales (Flowise + Langfuse) activados opcionalmente después de que los mensajes se suben a GHL. Soporta múltiples canales (WhatsApp, Instagram, Facebook) y múltiples agentes por cliente.

**Prompts gestionados centralmente en Langfuse**, permitiendo actualizaciones sin redespliegue de código.

---

## Estado: 🚧 En Desarrollo (Beta Feature)

- **Beta Flag:** `is_beta = true` en `clients_details`
- **Cliente de prueba:** pabs.ai (location_id: `jWmwy7nMqnsXQPdZdSW8`)
- **Fecha inicio:** 2025-01-15
- **Versión objetivo:** v1.0.0 (MVP)

---

## Arquitectura General

### Flujo de Datos

```
Usuario → WhatsApp/IG/FB
    ↓
Evolution API / GHL
    ↓
webhooks/whatsapp.js → Procesa y sube a GHL
    ↓
GHL Workflow (detecta tag "activar-ia")
    ↓
[NUEVO] /webhook/agent
    ↓
1. Validar payload + whitelist + beta flag
2. Obtener agente de BD (agent_configs)
3. Procesar attachment si existe (audio/imagen → texto)
4. Agregar mensaje a buffer (RAM)
5. Debouncing 7s (espera a que usuario termine)
6. Llamar Langfuse (obtener prompt dinámico)
7. Construir startState con contexto completo
8. Llamar Flowise (agente conversacional)
9. Parsear respuesta JSON (3 partes con fallback)
10. Verificar buffer (si cambió, descartar - v1)
11. Enviar a GHL con delays calculados
12. Limpiar buffer
    ↓
webhooks/ghl.js → Envía al canal original
    ↓
Usuario recibe respuesta del agente
```

---

## Base de Datos

### Tabla: `agent_configs` (SIMPLIFICADA)

```sql
CREATE TABLE agent_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id VARCHAR NOT NULL,
  agent_name VARCHAR NOT NULL,  -- Identificador + nombre en Langfuse
  flowise_webhook_url TEXT NOT NULL,
  flowise_api_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(location_id, agent_name),
  FOREIGN KEY (location_id) REFERENCES clients_details(location_id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_configs_location_id ON agent_configs(location_id);
CREATE INDEX idx_agent_configs_agent_name ON agent_configs(agent_name);
```

**Simplificaciones:**
- ✅ `agent_name` único (no separar `agent_key` + `langfuse_prompt_name`)
- ✅ Sin `is_active` (eliminar registro si se desactiva)
- ✅ Langfuse API key global en `.env` (no por cliente)

**Ejemplo de datos:**
```sql
INSERT INTO agent_configs (location_id, agent_name, flowise_webhook_url, flowise_api_key)
VALUES (
  'jWmwy7nMqnsXQPdZdSW8',
  'agente-roi',
  'https://flow.pabs.ai/api/v1/prediction/xxx',
  'Bearer xxx'
);
```

---

## Payload del Webhook

### Entrada: `POST /webhook/agent` (desde GHL)

```json
{
  "contact_id": "GcwK4TcH5FfPfIu5MtjN",
  "location_id": "jWmwy7nMqnsXQPdZdSW8",
  "full_name": "Pablo Sánchez",
  "email": "hola@pabs.ai",
  "phone": "+34660722687",
  "tags": "activar-ia",
  "message": {
    "type": 20
  },
  "customData": {
    "message_body": "hola kevin, qué tal?",
    "message_attachment": "https://...",
    "agente": "agente-roi",
    "info_crm": "nombre: Pablo Sánchez\nemail: hola@pabs.ai\ntelefono: +34660722687\ncontact_id: GcwK4TcH5FfPfIu5MtjN\nEtiquetas: activar-ia",
    "info_crm_adicional": "Nivel: Pro\nTipo de Bici: Montaña\n¿Qué te gustaría mejorar?: Resistencia",
    "resumen_llamadas": "Usuario preguntó sobre precios del curso avanzado",
    "recuento_llamadas": 3
  }
}
```

**Campos clave:**
- `customData.agente` → Identifica qué agente usar (busca en BD)
- `customData.message_body` → Texto del mensaje
- `customData.message_attachment` → URL del archivo (opcional)
- `customData.info_crm` → Contexto estándar del contacto (GHL construye)
- `customData.info_crm_adicional` → Contexto custom por cliente (GHL construye)
- `customData.resumen_llamadas` → Resumen de conversaciones previas por voz (opcional)
- `customData.recuento_llamadas` → Número de llamadas previas (opcional)

**Mapeo de canales:**
- `message.type: 20` → SMS (WhatsApp en realidad)
- `message.type: 18` → IG (Instagram)
- `message.type: 11` → FB (Facebook)

---

## Servicios Nuevos

### 0. `utils/mediaHelper.js` ⭐ (Helpers Compartidos - DRY)

**Responsabilidad:** Helpers compartidos para procesamiento de multimedia

**Funciones:**
- `processAudioToText(base64, mimetype, context)` → Whisper → `"audio: {texto}"`
- `processImageToText(base64, caption, context)` → Vision → `"descripcion imagen: {texto}"`
- `formatOtherMediaType(type, data)` → Formatea video, documento, location, etc.

**Reutilizado por:**
- ✅ `webhooks/whatsapp.js` - Procesar mensajes de Evolution API
- ✅ `services/mediaProcessor.js` - Procesar attachments de GHL

**Beneficio (Opción B - DRY):**
- ✅ Un solo lugar para lógica de procesamiento
- ✅ Cambios en formato afectan a ambos webhooks
- ✅ Fácil de testear aisladamente
- ✅ Consistencia garantizada entre whatsapp.js y agent.js

---

### 1. `services/langfuse.js`

**Responsabilidad:** Obtener prompts de Langfuse con caché

**API:**
```http
GET {LANGFUSE_BASE_URL}/api/public/v2/prompts/{promptName}

Auth: Basic Auth
  Username: {client.langfuse_public_key}
  Password: {client.langfuse_secret_key}
```

**Ejemplo:**
```bash
curl -u pk-lf-xxx:sk-lf-xxx \
  https://pabs-langfuse-web.r4isqy.easypanel.host/api/public/v2/prompts/agente-roi
```

**Respuesta esperada:**
```json
{
  "id": "...",
  "name": "agente-roi",
  "prompt": "Eres un asistente experto en ciclismo...",
  "version": 1,
  "createdAt": "...",
  "updatedAt": "..."
}
```

**Funciones:**
- `getPrompt(agentName, publicKey, secretKey)` → Obtiene prompt de Langfuse
- **Keys por cliente:** Obtenidas de `clients_details.langfuse_public_key` y `langfuse_secret_key`
- Caché de 1 hora (NodeCache) con clave combinada `publicKey:agentName`
- Reintentos automáticos (4x con 800ms delay)
- Notificación a admin si falla

**Configuración:**
```sql
-- En clients_details (por cliente)
langfuse_public_key: pk-lf-xxx  (obtenida de Langfuse project settings)
langfuse_secret_key: sk-lf-xxx  (obtenida de Langfuse project settings)
```

**Variables de entorno:**
```env
# Solo URL base global (las keys están en BD por cliente)
LANGFUSE_BASE_URL=https://pabs-langfuse-web.r4isqy.easypanel.host
```

---

### 2. `services/flowise.js`

**Responsabilidad:** Llamar agentes de Flowise y parsear respuestas

**Payload a Flowise:**
```json
{
  "question": "hola kevin, qué tal?",
  "overrideConfig": {
    "sessionId": "conv_xxx",
    "startState": [
      { "key": "contact_id", "value": "GcwK4TcH5FfPfIu5MtjN" },
      { "key": "conversation_id", "value": "conv_xxx" },
      { "key": "location_id", "value": "jWmwy7nMqnsXQPdZdSW8" },
      { "key": "canal", "value": "SMS" },
      { "key": "tags", "value": "activar-ia, cliente-premium" },
      { "key": "info_crm", "value": "nombre: Pablo..." },
      { "key": "info_crm_adicional", "value": "Nivel: Pro..." },
      { "key": "resumen_llamadas", "value": "Usuario preguntó..." },
      { "key": "recuento_llamadas", "value": 3 },
      { "key": "prompt", "value": "Eres un asistente experto..." }
    ]
  }
}
```

**Nota importante:** El `sessionId` se pasa dentro de `overrideConfig` (no como parámetro separado) para mantener la memoria de la conversación en Flowise. Usa el `conversationId` de GHL como valor único por conversación.

**StartState siempre incluye (todo en snake_case):**
- `contact_id` (string) - REQUERIDO - ID del contacto en GHL
- `conversation_id` (string) - REQUERIDO - ID de la conversación en GHL
- `location_id` (string) - REQUERIDO - ID de la ubicación en GHL
- `canal` (string) - REQUERIDO - Canal del mensaje: "SMS", "IG", "FB"
- `tags` (string) - Tags/etiquetas del contacto en GHL (puede estar vacío)
- `info_crm` (string) - Contexto estándar del contacto (puede estar vacío)
- `info_crm_adicional` (string) - Contexto custom adicional (puede estar vacío)
- `resumen_llamadas` (string) - Resumen de llamadas previas (puede estar vacío)
- `recuento_llamadas` (number) - Número de llamadas (puede ser 0)
- `prompt` (string) - REQUERIDO - Prompt dinámico desde Langfuse

**Respuesta de Flowise:**
```json
[{
  "text": "{\"parte1\": \"Hola Pablo...\", \"parte2\": \"¿Cómo puedo ayudarte?\", \"parte3\": null}",
  "question": "hola kevin, qué tal?",
  "chatId": "...",
  "sessionId": "..."
}]
```

**Parser con 3 niveles de fallback:**
1. **Nivel 1:** Parse directo del JSON
2. **Nivel 2:** Limpiar caracteres especiales (`\n`, `\r`, `\"`) y parsear
3. **Nivel 3:** Fallback - enviar todo como `parte1`, `parte2` y `parte3` = null

**Funciones:**
- `callFlowiseAgent(agentConfig, question, overrideConfig)` → Llama Flowise (sessionId va dentro de overrideConfig)
- `parseFlowiseResponse(data)` → Parsea respuesta con fallback robusto

---

### 3. `services/agentBuffer.js`

**Responsabilidad:** Buffer de mensajes en RAM con debouncing

**Caché:**
- TTL: 10 minutos (auto-expira si no se procesa)
- Key format: `{contactId}_{canal}_buffer`
- Ejemplo: `GcwK4TcH5FfPfIu5MtjN_SMS_buffer`

**Debouncing:**
- Delay: **7 segundos** desde el ÚLTIMO mensaje
- Si llega nuevo mensaje → **reset timer** automáticamente
- Cuando timer expira → **procesar buffer completo**

**Funciones:**
- `pushMessage(contactId, canal, messageText)` → Agrega mensaje
- `getBuffer(contactId, canal)` → Obtiene array de mensajes
- `clearBuffer(contactId, canal)` → Limpia buffer
- `isLastMessage(contactId, canal, expectedMessage)` → Verifica último mensaje
- `setupDebounce(contactId, canal, callback, delay=7000)` → Configura timer

**Ejemplo de uso:**
```javascript
// Usuario escribe "hola"
pushMessage('contact123', 'SMS', 'hola');
setupDebounce('contact123', 'SMS', () => procesar(), 7000);

// 3s después, usuario escribe "cómo estás?"
pushMessage('contact123', 'SMS', 'cómo estás?');
// Timer se resetea automáticamente

// 7s después de último mensaje → callback ejecuta
// Buffer contiene: ["hola", "cómo estás?"]
// Se concatenan y envían a Flowise: "hola\ncómo estás?"
```

---

### 4. `services/mediaProcessor.js`

**Responsabilidad:** Descargar attachments de URLs y procesarlos

**Flujo:**
1. Descarga archivo desde URL (axios)
2. Convierte a base64
3. Detecta tipo por `Content-Type`
4. **Usa `mediaHelper.*` para procesar** (DRY)

**Tipos soportados:**
- **Audio** → `mediaHelper.processAudioToText()` → Whisper
- **Imagen** → `mediaHelper.processImageToText()` → Vision
- **Video** → `mediaHelper.formatOtherMediaType('video')`
- **Otro** → `mediaHelper.formatOtherMediaType('unknown')`

**Funciones:**
- `processAttachment(attachmentUrl)` → Download + procesar

**Diferencia vs whatsapp.js:**
- whatsapp.js: Evolution API → `getMediaBase64(messageId)` → helpers
- mediaProcessor.js: URL directa → `axios.get(url)` → helpers
- Ambos usan los mismos helpers para procesamiento ✅

---

## Modificaciones a Archivos Existentes

### 0. `webhooks/whatsapp.js` ⭐ (Refactorizado - DRY)

**Cambios:**
- ✅ Importa `mediaHelper` en vez de `openaiAPI`
- ✅ Audio: Usa `mediaHelper.processAudioToText()` (elimina try/catch duplicado)
- ✅ Imagen: Usa `mediaHelper.processImageToText()` (elimina try/catch duplicado)
- ✅ Video/Document/Location/Contact/Sticker: Usa `mediaHelper.formatOtherMediaType()`

**Antes (código duplicado):**
```javascript
const transcription = await openaiAPI.transcribeAudio(...);
messageText = `audio: ${transcription}`;
// + 40 líneas de error handling
```

**Después (DRY):**
```javascript
messageText = await mediaHelper.processAudioToText(base64, mimetype, context);
// Error handling incluido en el helper
```

**Resultado:**
- ✅ -80 líneas de código duplicado eliminadas
- ✅ Mismo comportamiento, más mantenible

---

### 1. `services/supabase.js`

**Agregar:**
```javascript
async function getAgentConfig(locationId, agentName) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('location_id', locationId)
    .eq('agent_name', agentName)
    .single();

  if (error || !data) {
    throw new Error(`Agent config not found: ${locationId}/${agentName}`);
  }

  return data;
}

module.exports = {
  getClientByLocationId,
  getClientByInstanceName,
  updateGHLTokens,
  getAgentConfig  // NUEVO
};
```

---

### 2. `utils/validation.js`

**Agregar:**
```javascript
function validateAgentPayload(body) {
  const required = ['contact_id', 'location_id'];

  for (const field of required) {
    if (!body[field]) {
      return { valid: false, missing: field };
    }
  }

  if (!body.customData) {
    return { valid: false, missing: 'customData' };
  }

  if (!body.customData.message_body) {
    return { valid: false, missing: 'customData.message_body' };
  }

  if (!body.customData.agente) {
    return { valid: false, missing: 'customData.agente' };
  }

  if (!body.message || !body.message.type) {
    return { valid: false, missing: 'message.type' };
  }

  return { valid: true };
}

module.exports = {
  validateGHLPayload,
  validateWhatsAppPayload,
  validateAgentPayload,  // NUEVO
  splitMessage
};
```

---

### 3. `utils/webhookAuth.js`

**Agregar:**
```javascript
async function validateAgentWhitelist(req, res, next) {
  const locationId = req.body?.location_id;

  if (!locationId) {
    logger.warn('❌ Agent webhook missing location_id');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'location_id is required'
    });
  }

  try {
    const client = await getClientByLocationId(locationId);

    if (!client) {
      logger.warn('❌ Unauthorized agent webhook attempt', { locationId });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'location_id not authorized'
      });
    }

    // Beta feature check
    if (!client.is_beta) {
      logger.warn('⚠️ Agent webhook for non-beta client', { locationId });
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Agent feature not enabled for this client'
      });
    }

    req.client = client;
    next();

  } catch (error) {
    logger.error('Error validating agent webhook', {
      locationId,
      error: error.message
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  validateWhitelist,
  validateAgentWhitelist  // NUEVO
};
```

---

### 4. `server.js`

**Agregar:**
```javascript
const { handleAgentWebhook } = require('./webhooks/agent');
const { validateAgentWhitelist } = require('./utils/webhookAuth');

// Agregar ruta DESPUÉS de las existentes
app.post(
  '/webhook/agent',
  validateAgentWhitelist,
  handleAgentWebhook
);

logger.info('✅ Agent webhook registered: POST /webhook/agent');
```

---

### 5. `config.js`

**Agregar:**
```javascript
module.exports = {
  // ... existentes

  // Langfuse (base URL only - keys stored per-client in DB)
  LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL || 'https://pabs-langfuse-web.r4isqy.easypanel.host'
};
```

---

### 6. `.env`

**Agregar:**
```env
# Langfuse (Base URL only - keys per client in clients_details table)
LANGFUSE_BASE_URL=https://pabs-langfuse-web.r4isqy.easypanel.host
```

**Configurar keys por cliente en BD:**
```sql
-- Actualizar cliente con sus Langfuse API keys
UPDATE clients_details
SET
  langfuse_public_key = 'pk-lf-xxx',  -- Desde Langfuse UI → Project Settings → API Keys
  langfuse_secret_key = 'sk-lf-xxx'   -- Desde Langfuse UI → Project Settings → API Keys
WHERE location_id = 'jWmwy7nMqnsXQPdZdSW8';
```

**Nota:** Cada cliente tiene su propio proyecto en Langfuse con sus propias API keys.

---

## Plan de Desarrollo (Checklist)

### Fase 1: Base de Datos ✅

- [ ] Crear tabla `agent_configs` en Supabase
- [ ] Configurar RLS (Row Level Security)
- [ ] Insertar registro de prueba para pabs.ai
- [ ] Activar `is_beta = true` para pabs.ai
- [ ] Agregar variables de entorno en `.env`

---

### Fase 2: Servicios Base ⚙️

- [ ] `services/langfuse.js`
- [ ] `services/flowise.js`
- [ ] `services/agentBuffer.js`
- [ ] `services/mediaProcessor.js`

---

### Fase 3: Validación y Seguridad 🔒

- [ ] `utils/validation.js`
- [ ] `utils/webhookAuth.js`
- [ ] `services/supabase.js`

---

### Fase 4: Webhook Principal 🎯

- [ ] `webhooks/agent.js`
- [ ] `server.js`
- [ ] `config.js`

---

### Fase 5: Testing 🧪

- [ ] Tests unitarios
- [ ] Ejecutar suite completa: `npm test`
- [ ] Tests de integración manual

---

### Fase 6: Documentación 📚

- [ ] Crear `FLOWISE.md`
- [ ] Actualizar `CLAUDE.md`

---

## Métricas de Éxito

### KPIs a Monitorear

1. **Latencia:**
   - Tiempo total (webhook → primera respuesta): < 10s
   - Tiempo Langfuse API: < 500ms
   - Tiempo Flowise API: < 5s
   - Debouncing: 7s exactos

2. **Confiabilidad:**
   - Tasa de éxito procesamiento: > 95%
   - Tasa de éxito Langfuse: > 99%
   - Tasa de éxito Flowise: > 90%

3. **Calidad:**
   - Parse exitoso de respuestas: > 98%
   - Attachments procesados correctamente: > 95%
   - Buffer sin pérdidas: 100%

---

## Troubleshooting

### Problema: Webhook no se activa

**Verificar:**
1. Cliente tiene `is_beta = true` en BD
2. Agente existe en `agent_configs` para ese `location_id`
3. GHL workflow configurado correctamente
4. Payload tiene `customData.agente`
5. Logs: `grep "Agent webhook" combined.log`

### Problema: Langfuse falla

**Verificar:**
1. Credenciales correctas en `.env`
2. Base URL correcta: `https://pabs-langfuse-web.r4isqy.easypanel.host`
3. Prompt existe en Langfuse con nombre exacto (ej: "agente-roi")
4. Caché: revisar si está expirado
5. Logs: `grep "Langfuse" error.log`

### Problema: Flowise no responde

**Verificar:**
1. URL correcta en `agent_configs.flowise_webhook_url`
2. API key correcta en `agent_configs.flowise_api_key`
3. Chatflow activo en Flowise
4. Timeout de 15s no excedido
5. Logs: `grep "Flowise" error.log`

### Problema: Buffer no concatena mensajes

**Verificar:**
1. Mensajes llegan con < 7s de diferencia
2. Debouncing se resetea correctamente
3. Buffer se limpia después de procesar
4. NodeCache no está lleno
5. Logs: `grep "buffer" combined.log`

---

## Rollback Plan

Si algo sale mal:

**1. Deshabilitar agente para cliente:**
```sql
UPDATE clients_details SET is_beta = false WHERE location_id = 'xxx';
```

**2. Eliminar configuración de agente:**
```sql
DELETE FROM agent_configs WHERE location_id = 'xxx' AND agent_name = 'xxx';
```

**3. Deshabilitar workflow en GHL:**
- Pausar workflow que dispara `/webhook/agent`

---

## Próximos Pasos (v2)

1. **Re-procesamiento inteligente:**
   - Si buffer cambia después de Flowise, re-procesar automáticamente
   - Límite de reintentos para evitar loops

2. **Métricas en Dashboard:**
   - Panel de control para ver uso de agentes
   - Integración con Langfuse tracing completo

3. **Multi-turn conversations:**
   - Mantener contexto entre múltiples interacciones
   - Integrar con memoria persistente de Flowise

4. **A/B Testing:**
   - Comparar respuestas con/sin agente
   - Métricas de satisfacción del usuario

5. **Soporte para más tipos de archivos:**
   - PDFs, documentos, etc.

---

## Referencias

- [Flowise Docs](https://docs.flowiseai.com/)
- [Langfuse API](https://api.reference.langfuse.com/)
- [GHL API](https://marketplace.gohighlevel.com/docs/oauth/GettingStarted)
- [Evolution API](https://doc.evolution-api.com/v2/api-reference/get-information)

---

**Última actualización:** 2025-01-15
**Responsable:** Pablo Sánchez
**Estado:** 🚧 En Desarrollo
