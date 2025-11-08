const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateGHLPayload } = require('../utils/validation');
const { getClientByLocationId } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');

async function handleGHLWebhook(req, res) {
  try {
    // Validar payload
    const validation = validateGHLPayload(req.body);
    if (!validation.valid) {
      logger.warn('Invalid GHL payload', { reason: validation.reason || validation.missing });
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }
    
    const { locationId, contactId, messageId, message, phone } = req.body;
    
    logger.info('GHL webhook received', { locationId, contactId, messageId });
    
    // Buscar cliente
    const client = await getClientByLocationId(locationId);
    
    // Obtener contacto para sacar teléfono
    const contact = await ghlAPI.getContact(client, contactId);
    const contactPhone = contact.phone;
    
    // Formatear número WhatsApp
    const waNumber = contactPhone.replace(/^\+/, '') + '@s.whatsapp.net';
    
    try {
      // Enviar mensaje a WhatsApp
      await evolutionAPI.sendText(
        client.instance_name,
        client.instance_apikey,
        waNumber,
        message
      );
      
      // Marcar como entregado en GHL
      await ghlAPI.updateMessageStatus(client, messageId, 'delivered');
      
      logger.info('Message sent to WhatsApp', { locationId, contactPhone });
      
      return res.status(200).json({ success: true });
      
    } catch (sendError) {
      logger.error('Failed to send to WhatsApp', { 
        locationId, 
        error: sendError.message 
      });
      
      // Verificar si tiene WhatsApp
      const hasWhatsApp = await evolutionAPI.checkWhatsAppNumber(
        client.instance_name,
        client.instance_apikey,
        contactPhone
      );
      
      if (!hasWhatsApp) {
        // Subir nota a GHL
        const conversationSearch = await ghlAPI.searchConversation(client, contactId);
        const conversationId = conversationSearch.conversations?.[0]?.id;
        
        if (conversationId) {
          await ghlAPI.sendInboundMessage(
            client,
            conversationId,
            contactId,
            'NOTA: El contacto no tiene WhatsApp'
          );
        }
      }
      
      // Notificar admin
      await notifyAdmin('Failed to send WhatsApp message', {
        location_id: locationId,
        error: sendError.message
      });
      
      return res.status(500).json({ error: 'Failed to send message' });
    }
    
  } catch (error) {
    logger.error('GHL webhook error', { error: error.message, stack: error.stack });
    
    await notifyAdmin('GHL Webhook Error', {
      location_id: req.body?.locationId,
      error: error.message
    });
    
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { handleGHLWebhook };