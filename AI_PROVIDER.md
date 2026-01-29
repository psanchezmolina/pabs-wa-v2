# Plan de Migración: FASE 1 (is_beta) → FASE 2 (ai_provider)

## Contexto

**Problema actual (FASE 1):**
- Usamos `is_beta = true` para activar el LLM Message Splitter con GHL Conversation AI
- Esto desactiva automáticamente el Agent System (Flowise)
- `is_beta` es temporal y no semántico (no indica qué sistema de IA se usa)
- Difícil escalar cuando queramos usar ambos sistemas en producción

**Solución (FASE 2):**
- Crear campo `ai_provider` que indique explícitamente qué sistema de IA usa el cliente
- Crear campo `split_messages` independiente para activar/desactivar división de mensajes
- Permite combinaciones flexibles y es más semántico

---

## Schema de Base de Datos

### Estado Actual (FASE 1)

```sql
-- Tabla: clients_details
location_id VARCHAR(255) NOT NULL UNIQUE,
whatsapp_provider VARCHAR(20) DEFAULT 'evolution',  -- 'evolution' o 'official'
is_beta BOOLEAN DEFAULT false,                      -- Activa LLM Splitter + desactiva Agent System
-- ... otros campos
```

**Lógica actual:**
- `is_beta = true` + `whatsapp_provider = 'evolution'` → GHL Conversation AI + LLM Splitter
- `is_beta = false` → Agent System (Flowise + Langfuse)

### Estado Objetivo (FASE 2)

```sql
-- Tabla: clients_details
location_id VARCHAR(255) NOT NULL UNIQUE,
whatsapp_provider VARCHAR(20) DEFAULT 'evolution',  -- 'evolution' o 'official'
is_beta BOOLEAN DEFAULT false,                      -- Libre para otras features
ai_provider VARCHAR(20) DEFAULT 'flowise',          -- NUEVO: 'flowise' o 'ghl_native'
split_messages BOOLEAN DEFAULT false,               -- NUEVO: Dividir mensajes con LLM
-- ... otros campos
```

**Nueva lógica:**
- `ai_provider = 'flowise'` → Usa Agent System (Flowise + Langfuse) vía `/webhook/agent`
- `ai_provider = 'ghl_native'` → Usa GHL Conversation AI vía `/webhook/ghl`
- `split_messages = true` → Divide mensajes con LLM (independiente del provider)

---

## Plan de Migración Paso a Paso

### PASO 1: Crear Columnas Nuevas en BD

```sql
-- 1.1: Crear campo ai_provider
ALTER TABLE clients_details
ADD COLUMN ai_provider VARCHAR(20) DEFAULT 'flowise'
CHECK (ai_provider IN ('flowise', 'ghl_native'));

-- 1.2: Crear campo split_messages
ALTER TABLE clients_details
ADD COLUMN split_messages BOOLEAN DEFAULT false;

-- 1.3: Añadir comentarios (PostgreSQL)
COMMENT ON COLUMN clients_details.ai_provider IS 'Sistema de IA usado: flowise (Agent System) o ghl_native (GHL Conversation AI)';
COMMENT ON COLUMN clients_details.split_messages IS 'Activar división de mensajes con LLM (GPT-4o-mini)';

-- 1.4: Verificar creación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'clients_details'
AND column_name IN ('ai_provider', 'split_messages');
```

**Resultado esperado:**
```
column_name     | data_type           | column_default
----------------|---------------------|----------------
ai_provider     | character varying   | 'flowise'::character varying
split_messages  | boolean             | false
```

---

### PASO 2: Migrar Datos Existentes

```sql
-- 2.1: Migrar clientes beta a ghl_native
UPDATE clients_details
SET
  ai_provider = 'ghl_native',
  split_messages = true
WHERE is_beta = true AND whatsapp_provider = 'evolution';

-- 2.2: Verificar migración
SELECT
  location_id,
  instance_name,
  is_beta,
  ai_provider,
  split_messages,
  whatsapp_provider
FROM clients_details
WHERE is_beta = true;

-- Resultado esperado:
-- location_id | instance_name | is_beta | ai_provider | split_messages | whatsapp_provider
-- ------------|---------------|---------|-------------|----------------|-------------------
-- XXX         | nombre-inst   | true    | ghl_native  | true           | evolution

-- 2.3: Verificar clientes NO beta permanecen como 'flowise'
SELECT
  location_id,
  instance_name,
  is_beta,
  ai_provider,
  split_messages
FROM clients_details
WHERE is_beta = false
LIMIT 5;

-- Resultado esperado:
-- location_id | instance_name | is_beta | ai_provider | split_messages
-- ------------|---------------|---------|-------------|----------------
-- YYY         | nombre-inst2  | false   | flowise     | false
```

---

### PASO 3: Modificar Código - webhooks/agent.js

**Ubicación:** Línea ~76 (validación de clientes beta)

**Cambio:**
```javascript
// ⛔ ANTES (FASE 1):
if (client && client.is_beta) {
  logger.warn('⛔ Beta client - Agent System disabled (uses GHL Conversation AI)', {
    location_id,
    contact_id,
    agente,
    is_beta: client.is_beta
  });

  return res.status(200).json({
    success: false,
    message: 'Beta client - Agent System disabled. This client uses GHL Conversation AI instead of Flowise.',
    note: 'Configure GHL Conversation AI in GHL settings. Messages are processed via /webhook/ghl with LLM message splitter.'
  });
}

// ✅ DESPUÉS (FASE 2):
if (client && client.ai_provider === 'ghl_native') {
  logger.warn('⛔ Client uses GHL Conversation AI - Agent System disabled', {
    location_id,
    contact_id,
    agente,
    ai_provider: client.ai_provider
  });

  return res.status(200).json({
    success: false,
    message: 'Client uses GHL Conversation AI. Agent System (Flowise) is disabled.',
    note: 'Messages are processed via /webhook/ghl. LLM message splitter is ' +
          (client.split_messages ? 'enabled' : 'disabled') + '.',
    ai_provider: client.ai_provider,
    split_messages: client.split_messages
  });
}
```

**Logging actualizado:**
```javascript
// También actualizar el log de validación (línea ~96)
logger.info('✅ Step 1 COMPLETE: Agent webhook validated', {
  location_id,
  contact_id,
  agente,
  canal,
  ai_provider: client?.ai_provider || 'flowise',  // CAMBIO: reemplaza is_beta
  split_messages: client?.split_messages || false  // NUEVO
});
```

---

### PASO 4: Modificar Código - webhooks/ghl.js

**Ubicación:** Línea ~52 (lógica beta LLM splitter)

**Cambio:**
```javascript
// ⛔ ANTES (FASE 1):
if (client.is_beta && client.whatsapp_provider === 'evolution') {
  logger.info('🧪 Beta client - Using LLM message splitter', {
    locationId,
    messageLength: messageText.length,
    instanceName: client.instance_name
  });
  // ... resto del código
}

// ✅ DESPUÉS (FASE 2):
if (client.split_messages) {
  logger.info('✂️ Using LLM message splitter', {
    locationId,
    messageLength: messageText.length,
    instanceName: client.instance_name,
    ai_provider: client.ai_provider,
    whatsapp_provider: client.whatsapp_provider
  });
  // ... resto del código (sin cambios)
}
```

**Ventaja:** Ahora `split_messages` funciona con **Evolution API Y API Oficial** (antes solo Evolution)

**Logging actualizado:**
```javascript
// Línea ~47 - actualizar log de cliente encontrado
logger.info('Client found', {
  locationId,
  instanceName: client.instance_name,
  hasApiKey: !!client.instance_apikey,
  provider: client.whatsapp_provider,
  fromCache: !!req.client,
  ai_provider: client.ai_provider,        // CAMBIO: reemplaza is_beta
  split_messages: client.split_messages   // NUEVO
});
```

---

### PASO 5: Actualizar Documentación - CLAUDE.md

#### 5.1: Actualizar sección "Beta Features"

**Cambiar:**
```markdown
### LLM Message Splitter (Beta - FASE 1)

**Estado:** En testing con clientes beta
```

**Por:**
```markdown
### LLM Message Splitter (Producción)

**Estado:** Disponible para todos los clientes mediante flag `split_messages`
```

#### 5.2: Actualizar sección "Activación"

**Cambiar:**
```markdown
#### Activación (FASE 1):

**Condiciones:**
- Cliente tiene `is_beta = true` en BD
- Cliente usa `whatsapp_provider = 'evolution'`
- Mensaje es tipo `outbound` (saliente de GHL)

**IMPORTANTE:** Cuando `is_beta = true`, el Agent System (Flowise) se **desactiva automáticamente**:
```

**Por:**
```markdown
#### Activación (Producción):

**Condiciones:**
- Cliente tiene `split_messages = true` en BD
- Mensaje es tipo `outbound` (saliente de GHL)
- Funciona con `whatsapp_provider = 'evolution'` Y `whatsapp_provider = 'official'`

**IMPORTANTE:** Cuando `ai_provider = 'ghl_native'`, el Agent System (Flowise) se **desactiva automáticamente**:
```

#### 5.3: Actualizar tabla comparativa

**Añadir fila:**
```markdown
| **Sistema de IA** | Flowise (Agent System) | GHL Conversation AI |
| **Flag en BD** | `ai_provider = 'flowise'` | `ai_provider = 'ghl_native'` |
```

#### 5.4: Actualizar SQL de configuración

**Cambiar:**
```sql
-- Activar cliente para beta (LLM Message Splitter)
UPDATE clients_details
SET is_beta = true
WHERE location_id = 'XXX' AND whatsapp_provider = 'evolution';
```

**Por:**
```sql
-- Activar GHL Conversation AI + LLM Message Splitter
UPDATE clients_details
SET
  ai_provider = 'ghl_native',
  split_messages = true
WHERE location_id = 'XXX';

-- Activar solo LLM Splitter (mantener Flowise)
UPDATE clients_details
SET split_messages = true
WHERE location_id = 'XXX' AND ai_provider = 'flowise';

-- Ver configuración de clientes
SELECT location_id, instance_name, ai_provider, split_messages, whatsapp_provider
FROM clients_details
WHERE ai_provider = 'ghl_native' OR split_messages = true;
```

#### 5.5: Eliminar referencia a FASE 2

**Eliminar sección:**
```markdown
#### Plan de migración a FASE 2 (Producción):
```

**Reemplazar por:**
```markdown
#### Configuración Avanzada:

**Combinaciones posibles:**

| `ai_provider` | `split_messages` | Resultado |
|---------------|------------------|-----------|
| `flowise` | `false` | Agent System sin dividir mensajes (default) |
| `flowise` | `true` | Agent System + división de mensajes (experimental) |
| `ghl_native` | `false` | GHL Conversation AI sin dividir mensajes |
| `ghl_native` | `true` | GHL Conversation AI + división de mensajes ✅ |
```

---

### PASO 6: Testing y Validación

#### 6.1: Test con cliente GHL Conversation AI

```sql
-- Configurar cliente de prueba
UPDATE clients_details
SET
  ai_provider = 'ghl_native',
  split_messages = true
WHERE location_id = 'TEST_LOCATION_ID';
```

**Verificar:**
1. Enviar mensaje desde WhatsApp
2. GHL Conversation AI responde
3. `/webhook/ghl` intercepta y divide mensaje
4. Usuario recibe 2-3 mensajes en WhatsApp
5. **Verificar que `/webhook/agent` rechace el mensaje** (si GHL lo llama):
   ```
   LOG: "⛔ Client uses GHL Conversation AI - Agent System disabled"
   RESPONSE: { success: false, ai_provider: 'ghl_native' }
   ```

#### 6.2: Test con cliente Flowise (Agent System)

```sql
-- Verificar cliente usa Flowise
SELECT location_id, ai_provider, split_messages
FROM clients_details
WHERE location_id = 'EXISTING_FLOWISE_CLIENT';

-- Resultado esperado:
-- location_id | ai_provider | split_messages
-- ------------|-------------|----------------
-- XXX         | flowise     | false
```

**Verificar:**
1. Enviar mensaje desde WhatsApp
2. `/webhook/agent` procesa con Flowise + Langfuse
3. Respuesta se registra en GHL
4. Usuario recibe respuesta en WhatsApp
5. **NO debe pasar por `/webhook/ghl` con división**

#### 6.3: Test combinación Flowise + split_messages (experimental)

```sql
-- Activar división de mensajes con Flowise
UPDATE clients_details
SET split_messages = true
WHERE location_id = 'TEST_FLOWISE_LOCATION';
```

**Verificar:**
1. `/webhook/agent` procesa con Flowise
2. Respuesta se registra en GHL como outbound
3. `/webhook/ghl` intercepta y divide mensaje
4. Usuario recibe 2-3 mensajes en WhatsApp

**Nota:** Esta configuración puede causar doble división (Flowise ya divide + LLM divide de nuevo). Evaluar si tiene sentido o mejor desactivar.

#### 6.4: Verificar logs

**Buscar en logs del servidor:**
```bash
# Cliente GHL Conversation AI
grep "✂️ Using LLM message splitter" combined.log
grep "ai_provider.*ghl_native" combined.log

# Cliente Flowise
grep "✅ Step 1 COMPLETE: Agent webhook validated" combined.log
grep "ai_provider.*flowise" combined.log

# Rechazos esperados
grep "⛔ Client uses GHL Conversation AI - Agent System disabled" combined.log
```

---

### PASO 7: Rollback Plan (Si algo sale mal)

#### 7.1: Revertir cambios en BD

```sql
-- Revertir valores migrados
UPDATE clients_details
SET
  ai_provider = 'flowise',
  split_messages = false
WHERE ai_provider = 'ghl_native';

-- Verificar rollback
SELECT location_id, ai_provider, split_messages, is_beta
FROM clients_details
WHERE is_beta = true;
```

#### 7.2: Revertir cambios en código

**webhooks/agent.js:**
```javascript
// Restaurar lógica FASE 1
if (client && client.is_beta) {
  // ... código original
}
```

**webhooks/ghl.js:**
```javascript
// Restaurar lógica FASE 1
if (client.is_beta && client.whatsapp_provider === 'evolution') {
  // ... código original
}
```

#### 7.3: Revertir documentación

```bash
# Restaurar CLAUDE.md desde git
git checkout HEAD -- CLAUDE.md
```

#### 7.4: Eliminar columnas (SOLO si es necesario - DESTRUCTIVO)

```sql
-- ⚠️ CUIDADO: Esto eliminará los datos permanentemente
ALTER TABLE clients_details DROP COLUMN ai_provider;
ALTER TABLE clients_details DROP COLUMN split_messages;
```

---

## Checklist de Ejecución

### Pre-Migración
- [ ] Hacer backup de BD: `pg_dump` o snapshot en Supabase
- [ ] Revisar clientes beta actuales:
  ```sql
  SELECT location_id, instance_name, is_beta, whatsapp_provider
  FROM clients_details WHERE is_beta = true;
  ```
- [ ] Notificar al equipo de la migración
- [ ] Crear branch de git: `git checkout -b feat/ai-provider-migration`

### Ejecución (Orden Estricto)
1. [ ] **PASO 1:** Crear columnas en BD (`ai_provider`, `split_messages`)
2. [ ] **PASO 2:** Migrar datos existentes (clientes beta → `ghl_native`)
3. [ ] **PASO 3:** Modificar `webhooks/agent.js` (cambiar `is_beta` → `ai_provider`)
4. [ ] **PASO 4:** Modificar `webhooks/ghl.js` (cambiar `is_beta` → `split_messages`)
5. [ ] **PASO 5:** Actualizar `CLAUDE.md` (documentación)
6. [ ] **PASO 6:** Testing completo (GHL AI, Flowise, combinaciones)
7. [ ] Commit y push: `git commit -m "feat: migrate to ai_provider + split_messages"`
8. [ ] Deploy a producción
9. [ ] Monitorear logs durante 24-48h

### Post-Migración
- [ ] Verificar logs de todos los clientes beta migrados
- [ ] Verificar clientes Flowise NO afectados
- [ ] Actualizar documentación de cliente (si aplica)
- [ ] Considerar deprecar `is_beta` en el futuro (mantener para otras features o eliminar)

---

## Configuración de Clientes - Ejemplos

### Cliente 1: GHL Conversation AI + División de Mensajes

```sql
UPDATE clients_details
SET
  ai_provider = 'ghl_native',
  split_messages = true,
  whatsapp_provider = 'evolution'
WHERE location_id = 'cliente_ghl_native_evolution';
```

**Flujo:**
1. WhatsApp → Evolution → `/webhook/whatsapp` → GHL (inbound)
2. GHL Conversation AI procesa
3. GHL registra outbound → `/webhook/ghl` divide → Evolution → WhatsApp

---

### Cliente 2: GHL Conversation AI + API Oficial + División

```sql
UPDATE clients_details
SET
  ai_provider = 'ghl_native',
  split_messages = true,
  whatsapp_provider = 'official'
WHERE location_id = 'cliente_ghl_native_official';
```

**Flujo:**
1. WhatsApp API Oficial → GHL (inbound) - directo
2. GHL Conversation AI procesa
3. GHL registra outbound → `/webhook/ghl` divide → **Evolution API** → WhatsApp

**Nota:** Incluso con API Oficial, necesitas Evolution API para enviar las partes divididas (GHL no divide nativamente).

---

### Cliente 3: Flowise (Agent System) sin división

```sql
UPDATE clients_details
SET
  ai_provider = 'flowise',
  split_messages = false
WHERE location_id = 'cliente_flowise_default';
```

**Flujo:**
1. WhatsApp → Evolution → `/webhook/whatsapp` → GHL (inbound)
2. GHL → `/webhook/agent` → Flowise → GHL (outbound)
3. GHL → `/webhook/ghl` (flujo normal) → Evolution → WhatsApp

---

### Cliente 4: Flowise + División (experimental)

```sql
UPDATE clients_details
SET
  ai_provider = 'flowise',
  split_messages = true
WHERE location_id = 'cliente_flowise_with_split';
```

**Flujo:**
1. WhatsApp → Evolution → `/webhook/whatsapp` → GHL (inbound)
2. GHL → `/webhook/agent` → Flowise → GHL (outbound multiparte)
3. GHL → `/webhook/ghl` divide de nuevo → Evolution → WhatsApp

**⚠️ Advertencia:** Posible doble división (Flowise + LLM Splitter). Evaluar si tiene sentido.

---

## Preguntas Frecuentes (FAQ)

### ¿Qué pasa con `is_beta` después de la migración?

`is_beta` quedará libre para usarse en otras features beta futuras. Los clientes migrados mantendrán `is_beta = true` pero ahora `ai_provider` es lo que determina el sistema de IA.

### ¿Puedo cambiar un cliente de Flowise a GHL Conversation AI sin problemas?

Sí, solo necesitas:
```sql
UPDATE clients_details
SET ai_provider = 'ghl_native'
WHERE location_id = 'XXX';
```

Y configurar GHL Conversation AI en el dashboard de GHL.

### ¿Puedo activar `split_messages` con API Oficial de WhatsApp?

Sí, pero necesitas mantener una instancia de Evolution API activa para enviar las partes divididas. GHL API Oficial no soporta división nativa.

### ¿Qué pasa si tengo `ai_provider = 'ghl_native'` pero `split_messages = false`?

GHL Conversation AI procesará los mensajes, pero se enviarán completos sin dividir (flujo normal de `/webhook/ghl`).

### ¿Puedo tener ambos sistemas (Flowise + GHL AI) para el mismo cliente?

No, `ai_provider` es exclusivo: o `flowise` o `ghl_native`. Debes elegir uno.

---

## Notas Técnicas

### Compatibilidad con API Oficial

Cuando `whatsapp_provider = 'official'`:
- **Sin `split_messages`:** GHL envía mensajes directamente (no pasa por tu servidor)
- **Con `split_messages = true`:** Requiere Evolution API activa para enviar las partes divididas (limitación actual)

**Posible mejora futura:** Soportar división con API Oficial llamando directamente a la API de GHL para enviar cada parte.

### Performance

- Campo `ai_provider` es VARCHAR(20) con CHECK constraint → Sin impacto en performance
- `split_messages` es BOOLEAN → Muy eficiente
- Índices existentes no requieren cambios

### Caché

Los servicios de caché (`services/cache.js`) no almacenan `ai_provider` ni `split_messages`. Se leen directamente de BD en cada webhook (aceptable, no es cuello de botella).

---

## Recursos Adicionales

- **CLAUDE.md:** Documentación principal del proyecto
- **FLOWISE.md:** Documentación técnica del Agent System
- **webhooks/agent.js:** Webhook del Agent System (Flowise)
- **webhooks/ghl.js:** Webhook de mensajes salientes (GHL)
- **services/messageSplitter.js:** Servicio de división de mensajes con LLM

---

## Historial de Cambios

- **2026-01-29:** Creación del documento - Plan de migración FASE 1 → FASE 2
- **Pendiente:** Ejecución de la migración (fecha TBD)

---

**Autor:** Claude (con supervisión del equipo)
**Última actualización:** 2026-01-29
**Estado:** Pendiente de ejecución
