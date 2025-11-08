function validateGHLPayload(body) {
  // phone es opcional ya que se puede obtener del contacto vía API
  const required = ['locationId', 'messageId', 'contactId', 'message'];

  for (const field of required) {
    if (!body[field]) {
      return { valid: false, missing: field };
    }
  }

  if (body.type === 'OutboundMessage') {
    return { valid: false, reason: 'OutboundMessage ignored' };
  }

  return { valid: true };
}

function validateWhatsAppPayload(body) {
  if (!body.data || !body.data.key) {
    return { valid: false, missing: 'data.key' };
  }
  
  const required = ['remoteJid', 'id'];
  for (const field of required) {
    if (!body.data.key[field]) {
      return { valid: false, missing: `data.key.${field}` };
    }
  }
  
  if (body.data.key.fromMe) {
    return { valid: false, reason: 'Own message ignored' };
  }
  
  return { valid: true };
}

module.exports = {
  validateGHLPayload,
  validateWhatsAppPayload
};