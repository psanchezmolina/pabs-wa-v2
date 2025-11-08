const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateGHLPayload } = require('../utils/validation');
const { getClientByLocationId } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');

async function handleGHLWebhook(req, res) {
  // Log COMPLETO del webhook para debugging
  logger.info('🔔 GHL WEBHOOK RECEIVED', {
    body: req.body,
    headers: req.headers,
    method: req.method
  });

  try {
    // Validar payload
    const validation = validateGHLPayload(req.body);
    if (!validation.valid) {
      logger.warn('Invalid GHL payload', {
        reason: validation.reason || validation.missing,
        receivedFields: Object.keys(req.body),
        bodyType: req.body.type,
        fullBody: req.body
      });
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }

    const { locationId, contactId, messageId } = req.body;

    // El texto puede venir como 'body' o 'message'
    const messageText = req.body.body || req.body.message;

    logger.info('✅ GHL webhook validated', { locationId, contactId, messageId, messageText });

    // Buscar cliente
    const client = await getClientByLocationId(locationId);

    logger.info('Client found', {
      locationId,
      instanceName: client.instance_name,
      hasApiKey: !!client.instance_apikey
    });

    // Obtener teléfono del contacto
    let contactPhone;

    if (req.body.phone) {
      // El webhook nuevo trae el teléfono directamente
      contactPhone = req.body.phone;
      logger.info('Phone from webhook', { contactPhone });
    } else {
      // El webhook antiguo requiere obtenerlo de GHL API
      logger.info('Fetching contact from GHL', { contactId });
      const contact = await ghlAPI.getContact(client, contactId);
      contactPhone = contact.phone;
      logger.info('Contact retrieved', { contactId, contactPhone });
    }

    // Formatear número WhatsApp
    const waNumber = contactPhone.replace(/^\+/, '') + '@s.whatsapp.net';

    try {
      // Enviar mensaje a WhatsApp
      logger.info('Sending to Evolution API', {
        instanceName: client.instance_name,
        waNumber,
        messageLength: messageText.length
      });

      await evolutionAPI.sendText(
        client.instance_name,
        client.instance_apikey,
        waNumber,
        messageText
      );

      logger.info('✅ Message sent to WhatsApp successfully', { locationId, waNumber });

      // Intentar marcar como entregado en GHL (no crítico si falla)
      try {
        logger.info('Updating message status in GHL', { messageId });
        await ghlAPI.updateMessageStatus(client, messageId, 'delivered');
        logger.info('✅ Message marked as delivered in GHL', { messageId });
      } catch (statusError) {
        logger.warn('⚠️ Could not update message status (message sent successfully)', {
          messageId,
          error: statusError.message
        });
      }

      return res.status(200).json({ success: true });

    } catch (sendError) {
      logger.error('❌ Failed to send to WhatsApp', {
        locationId,
        error: sendError.message,
        errorCode: sendError.response?.status,
        errorData: sendError.response?.data,
        stack: sendError.stack
      });

      // Verificar si tiene WhatsApp
      logger.info('Checking if number has WhatsApp', { contactPhone });

      const hasWhatsApp = await evolutionAPI.checkWhatsAppNumber(
        client.instance_name,
        client.instance_apikey,
        contactPhone
      );

      logger.info('WhatsApp verification result', {
        contactPhone,
        hasWhatsApp: !!hasWhatsApp
      });

      if (!hasWhatsApp) {
        logger.info('Number does not have WhatsApp - notifying in GHL conversation', {
          contactId
        });

        // Buscar conversación
        const conversationSearch = await ghlAPI.searchConversation(client, contactId);
        const conversationId = conversationSearch.conversations?.[0]?.id;

        logger.info('Conversation search result', {
          contactId,
          conversationId,
          totalConversations: conversationSearch.total
        });

        if (conversationId) {
          await ghlAPI.sendInboundMessage(
            client,
            conversationId,
            contactId,
            'NOTA: El contacto no tiene WhatsApp'
          );

          logger.info('✅ Notification sent to GHL conversation', { conversationId });
        } else {
          logger.warn('No conversation found to send notification', { contactId });
        }
      }

      // No notificar al admin por ahora (requiere ADMIN_INSTANCE_APIKEY)
      // await notifyAdmin('Failed to send WhatsApp message', {
      //   location_id: locationId,
      //   error: sendError.message
      // });

      return res.status(500).json({ error: 'Failed to send message' });
    }
    
  } catch (error) {
    logger.error('GHL webhook error', { error: error.message, stack: error.stack });

    // No notificar al admin por ahora (requiere ADMIN_INSTANCE_APIKEY)
    // await notifyAdmin('GHL Webhook Error', {
    //   location_id: req.body?.locationId,
    //   error: error.message
    // });

    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { handleGHLWebhook };