# Natural Behavior System

Sistema para simular comportamiento humano en WhatsApp usando Evolution API: marcar mensajes como leídos aleatoriamente, mostrar estado "escribiendo...", y presencia online/offline.

**Estado:** Diseño completo - Pendiente implementación

---

## Endpoints Evolution API Disponibles

### 1. Mark Message As Read
```bash
POST /chat/markMessageAsRead/{instance}
Headers: apikey, Content-Type: application/json
Body: {
  "readMessages": [{
    "remoteJid": "34660722687@s.whatsapp.net",
    "fromMe": false,
    "id": "mensaje-id"
  }]
}
```

### 2. Set Presence (Instancia global)
```bash
POST /instance/setPresence/{instance}
Headers: apikey, Content-Type: application/json
Body: {
  "presence": "available" | "unavailable"
}
```

### 3. Send Presence (Por contacto)
```bash
POST /chat/sendPresence/{instance}
Headers: apikey, Content-Type: application/json
Body: {
  "number": "34660722687@s.whatsapp.net",
  "presence": "composing" | "recording" | "available" | "unavailable",
  "delay": 1200  // opcional, en ms
}
```

---

## Propuesta de Implementación

### Comportamiento al recibir mensajes (WhatsApp → GHL)

```javascript
1. Recibir mensaje del contacto
2. ⏱️ Delay aleatorio 1-3 segundos (simula ver notificación)
3. 📱 Marcar como leído con probabilidad 70-80%
   - Si marcaste mensaje de este contacto hace <5s → probabilidad 95%
   - NUNCA marcar mensajes propios (fromMe: true)
4. 🟢 Opcional: Set presence "available" (instancia en línea)
5. Procesar mensaje normalmente (flujo actual)
```

### Comportamiento al enviar respuesta (GHL → WhatsApp, Agent System)

```javascript
1. Tenemos respuesta lista del agente/IA
2. 💬 Send presence "composing" al contacto
   - Delay calculado: texto.length * 80ms (mín 2s, máx 8s)
   - Audio: presence "recording", delay 3-10s
3. ⏱️ Esperar el delay (simula escribir/grabar)
4. 📤 Enviar mensaje
5. ⏸️ Después de 10-15s: Set presence "unavailable" (opcional)
```

**Nota:** Ya existe simulación de delay en `services/evolution.js:7`:
```javascript
const delay = Math.min(Math.max(text.length * 50, 2000), 10000);
```
Mejorar con `sendPresence` antes del envío para mostrar "escribiendo...".

---

## Archivos a Crear/Modificar

### 1. `services/evolution.js` - Nuevas funciones
```javascript
async function markAsRead(instanceName, apiKey, remoteJid, messageId, fromMe = false)
async function setPresence(instanceName, apiKey, status) // available/unavailable
async function sendPresence(instanceName, apiKey, number, presence, delay = null)
```

### 2. `services/naturalBehavior.js` - Lógica de decisión (nuevo)
```javascript
// Tracking temporal en caché (último read por contacto)
function shouldMarkAsRead(client, contactId, remoteJid)
  - Probabilidad base: 70-80%
  - Si último read <5s: 95%
  - Retorna: boolean

function calculateTypingDelay(messageText, messageType)
  - Texto: texto.length * 80ms (mín 2s, máx 8s)
  - Audio: 3-10s
  - Retorna: milliseconds

async function simulateTyping(client, phone, messageText, messageType = 'text')
  - Orquesta sendPresence("composing") + delay + envío
  - Maneja errores sin romper flujo
```

### 3. `webhooks/whatsapp.js` - Integración
Después de procesar mensaje (línea ~265):
```javascript
if (client.is_beta && !messageData.key.fromMe) {
  const shouldMark = shouldMarkAsRead(client, contactId, remoteJid);
  if (shouldMark) {
    const readDelay = 1000 + Math.random() * 2000; // 1-3s
    setTimeout(() => {
      markAsRead(instance, apikey, remoteJid, messageId, false);
    }, readDelay);
  }
}
```

### 4. `webhooks/ghl.js` - Integración
Antes de `evolutionAPI.sendText()`:
```javascript
if (client.is_beta) {
  await simulateTyping(client, phone, messageText);
}
// Luego enviar mensaje normal
```

### 5. `webhooks/agent.js` - Integración
Antes de registrar cada parte en GHL:
```javascript
if (client.is_beta) {
  await simulateTyping(client, phone, messagePart);
}
// Luego registrar en GHL
```

---

## Configuración

### Activación (usar sistema beta actual)
```sql
-- Activar comportamiento natural para cliente
UPDATE clients_details
SET is_beta = true
WHERE location_id = 'XXX' AND whatsapp_provider = 'evolution';
```

### Configuración futura (FASE 2)
Si se quiere separar de `is_beta`:
```sql
ALTER TABLE clients_details
ADD COLUMN natural_behavior BOOLEAN DEFAULT false,
ADD COLUMN read_probability INTEGER DEFAULT 75,   -- % de marcar leído
ADD COLUMN typing_speed INTEGER DEFAULT 80;       -- ms por caracter
```

---

## Casos Especiales

**Múltiples mensajes seguidos (LLM Message Splitter):**
- Simular "composing" antes de cada parte
- Mantener delay entre partes (actual: 2s, 1.5s)

**Mensajes propios (`fromMe: true`):**
- NUNCA marcar como leído
- Ya están "leídos" por definición

**Grupos y listas:**
- Ya filtrados en flujo actual (línea 106 whatsapp.js)
- No aplicar comportamiento natural

**Errores en Evolution API:**
- NO deben romper flujo principal
- Loguear como warning, continuar procesamiento normal

---

## Delay Calculations

### Lectura (mark as read)
- Delay inicial: 1-3 segundos (aleatorio)
- Simula tiempo de ver notificación

### Escritura (send presence)
- **Texto:** `texto.length * 80` ms
  - Mínimo: 2000ms (2s)
  - Máximo: 8000ms (8s)
  - Ejemplo: 100 caracteres = 8s

- **Audio/Recording:** 3000-10000ms (3-10s)
  - Aleatorio dentro del rango

- **Reset presencia:** 10-15s después de enviar último mensaje

### Actual en código (mejorar)
`services/evolution.js:7`: `Math.min(Math.max(text.length * 50, 2000), 10000)`
- Cambiar de 50ms → 80ms por carácter
- Añadir `sendPresence` antes del delay

---

## Testing

**Plan:**
1. Activar `is_beta = true` para cliente test
2. Enviar varios mensajes desde WhatsApp
3. Verificar:
   - ✅ "Leído" aparece aleatoriamente (~75% de mensajes)
   - ✅ "Escribiendo..." antes de respuestas del agente
   - ✅ Delays realistas (no instantáneos)
   - ✅ Logs sin errores críticos
4. Ajustar probabilidades/delays según feedback

---

## Referencias

- [Evolution API - Mark Message As Read](https://doc.evolution-api.com/v2/api-reference/chat-controller/mark-as-read)
- [Evolution API - Set Presence](https://docs.evoapicloud.com/api-reference/instance-controller/set-presence)
- [Evolution API - Send Presence](https://doc.evolution-api.com/v2/api-reference/chat-controller/send-presence)
- [GitHub Issue #1639 - sendPresence Discussion](https://github.com/EvolutionAPI/evolution-api/issues/1639)
- [GitHub Issue #1107 - sendPresence Documentation](https://github.com/EvolutionAPI/evolution-api/issues/1107)

---

## Notas Importantes

- Sistema diseñado para NO romper flujo actual si falla
- Usar `withRetry` en llamadas Evolution API
- Tracking temporal en caché volátil (se pierde al reiniciar - aceptable)
- Compatible con Evolution API provider solamente (no API Oficial)
- Feature activada con `is_beta = true` para testing inicial
