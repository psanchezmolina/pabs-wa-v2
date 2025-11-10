const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateGHLPayload, splitMessage } = require('../utils/validation');
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

    // Obtener cliente (viene de middleware o buscar en BD como fallback)
    const client = req.client || await getClientByLocationId(locationId);

    logger.info('Client found', {
      locationId,
      instanceName: client.instance_name,
      hasApiKey: !!client.instance_apikey,
      fromCache: !!req.client
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

    // Dividir mensaje si es muy largo (GHL → WhatsApp)
    const messageParts = splitMessage(messageText);

    if (messageParts.length > 1) {
      logger.info('📝 Message split into multiple parts', {
        totalParts: messageParts.length,
        originalLength: messageText.length,
        locationId
      });
    }

    try {
      // Enviar mensaje(s) a WhatsApp
      logger.info('Sending to Evolution API', {
        instanceName: client.instance_name,
        waNumber,
        parts: messageParts.length,
        messageLength: messageText.length
      });

      // Enviar cada parte como mensaje separado
      for (let i = 0; i < messageParts.length; i++) {
        await evolutionAPI.sendText(
          client.instance_name,
          client.instance_apikey,
          waNumber,
          messageParts[i]
        );

        if (messageParts.length > 1) {
          logger.info(`✅ Sent part ${i + 1}/${messageParts.length}`);

          // Pequeño delay entre mensajes (500ms) para mantener el orden
          if (i < messageParts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }

      logger.info('✅ Message sent to WhatsApp successfully', {
        locationId,
        waNumber,
        totalParts: messageParts.length
      });

      // Intentar marcar como entregado en GHL (no crítico si falla)
      try {
        logger.debug('Attempting to update message status in GHL', { messageId });
        await ghlAPI.updateMessageStatus(client, messageId, 'delivered');
        logger.debug('✅ Message marked as delivered in GHL', { messageId });
      } catch (statusError) {
        logger.debug('Could not update message status (expected for non-provider messages)', {
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
        hasWhatsApp
      });

      if (hasWhatsApp === false) {
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
          await ghlAPI.registerMessage(
            client,
            conversationId,
            contactId,
            'NOTA: El contacto no tiene WhatsApp',
            'outbound'
          );

          logger.info('✅ Notification sent to GHL conversation (outbound)', { conversationId });
        } else {
          logger.warn('No conversation found to send notification', { contactId });
        }

        // Añadir tag "no-wa" al contacto
        try {
          await ghlAPI.addTags(client, contactId, ['no-wa']);
          logger.info('✅ Tag "no-wa" added to contact', { contactId });
        } catch (tagError) {
          logger.error('❌ Failed to add tag to contact', {
            contactId,
            error: tagError.message
          });
        }

        // Caso normal de contacto sin WhatsApp - NO notificar al admin
        logger.info('✅ Contact without WhatsApp handled successfully', {
          contactId,
          phone: contactPhone
        });

        return res.status(200).json({
          success: true,
          message: 'Contact does not have WhatsApp - registered in GHL and tagged'
        });
      }

      // Si NO es un caso de "sin WhatsApp", entonces SÍ notificar al admin
      await notifyAdmin('Failed to send WhatsApp message', {
        location_id: locationId,
        error: sendError.message,
        stack: sendError.stack,
        endpoint: '/webhook/ghl',
        contactId,
        messageId,
        phone: contactPhone,
        // Datos de API si es error de axios
        status: sendError.response?.status,
        statusText: sendError.response?.statusText,
        responseData: sendError.response?.data
      });

      return res.status(500).json({ error: 'Failed to send message' });
    }
    
  } catch (error) {
    logger.error('GHL webhook error', { error: error.message, stack: error.stack });

    await notifyAdmin('GHL Webhook Error', {
      location_id: req.body?.locationId,
      error: error.message,
      stack: error.stack,
      endpoint: '/webhook/ghl',
      contactId: req.body?.contactId,
      messageId: req.body?.messageId,
      // Datos de API si es error de axios
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      data: error.config?.data ? JSON.parse(error.config.data) : undefined
    });

    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { handleGHLWebhook };