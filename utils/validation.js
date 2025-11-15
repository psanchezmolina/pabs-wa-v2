function validateGHLPayload(body) {
  // Campos requeridos básicos
  const required = ['locationId', 'messageId', 'contactId'];

  for (const field of required) {
    if (!body[field]) {
      return { valid: false, missing: field };
    }
  }

  // El texto del mensaje puede venir como 'body' o 'message'
  if (!body.body && !body.message) {
    return { valid: false, missing: 'body or message' };
  }

  // Ignorar mensajes que ya están delivered/read (son notificaciones)
  if (body.status === 'delivered' || body.status === 'read') {
    return { valid: false, reason: 'Message already delivered/read' };
  }

  // Solo procesar tipo SMS (el primero que llega)
  // OutboundMessage son retries/notificaciones que ignoramos
  if (body.type !== 'SMS') {
    return { valid: false, reason: 'Only SMS type processed' };
  }

  return { valid: true };
}

function validateWhatsAppPayload(body) {
  // Validar campo instance (crítico para multi-tenant)
  if (!body.instance) {
    return { valid: false, missing: 'instance' };
  }

  if (!body.data || !body.data.key) {
    return { valid: false, missing: 'data.key' };
  }

  const required = ['remoteJid', 'id'];
  for (const field of required) {
    if (!body.data.key[field]) {
      return { valid: false, missing: `data.key.${field}` };
    }
  }

  // Removido filtro fromMe - procesamos todos los mensajes

  return { valid: true };
}

function splitMessage(message, maxLength = 3500) {
  if (!message || message.length <= maxLength) {
    return [message];
  }

  const parts = [];
  let remaining = message;
  let partNumber = 1;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      // Última parte
      parts.push(remaining);
      break;
    }

    // Buscar un buen punto de corte (espacio, salto de línea)
    let cutPoint = maxLength;
    const searchStart = Math.max(0, maxLength - 100); // Buscar en los últimos 100 chars

    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    const lastSpace = remaining.lastIndexOf(' ', maxLength);

    if (lastNewline >= searchStart) {
      cutPoint = lastNewline;
    } else if (lastSpace >= searchStart) {
      cutPoint = lastSpace;
    }

    // Extraer parte y añadir marcador
    const part = remaining.substring(0, cutPoint).trim();
    const totalParts = Math.ceil(message.length / maxLength);
    parts.push(`${part}\n\n📝 [Parte ${partNumber}/${totalParts}]`);

    remaining = remaining.substring(cutPoint).trim();
    partNumber++;
  }

  return parts;
}

/**
 * Validar payload del webhook del agente
 */
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
  validateAgentPayload,
  splitMessage
};