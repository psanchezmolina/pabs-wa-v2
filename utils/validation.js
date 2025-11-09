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

function truncateMessage(message, maxLength = 4096) {
  if (!message || message.length <= maxLength) {
    return { text: message, truncated: false };
  }

  const suffix = '\n\n⚠️ [Mensaje truncado - supera el límite de caracteres]';
  const truncateAt = maxLength - suffix.length;

  return {
    text: message.substring(0, truncateAt) + suffix,
    truncated: true,
    originalLength: message.length
  };
}

module.exports = {
  validateGHLPayload,
  validateWhatsAppPayload,
  truncateMessage
};