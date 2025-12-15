const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateGHLPayload, splitMessage } = require('../utils/validation');
const { getClientByLocationId } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const messageCache = require('../services/messageCache');

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
      provider: client.whatsapp_provider,
      fromCache: !!req.client
    });

    // ✅ Si usa API oficial, GHL maneja el envío directamente
    if (client.whatsapp_provider === 'official') {
      logger.info('⏩ Client uses official API - skipping send (GHL handles it)', {
        locationId,
        provider: client.whatsapp_provider
      });

      return res.status(200).json({
        success: true,
        message: 'Client uses official WhatsApp API - handled by GHL directly'
      });
    }

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
        }

        // Pequeño delay entre mensajes (500ms) para mantener el orden
        if (i < messageParts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
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

      // PASO 1: Verificar estado de la instancia ANTES de verificar número
      const instanceState = await evolutionAPI.checkInstanceConnection(
        client.instance_name,
        client.instance_apikey
      );

      // Si la instancia está caída, encolar mensaje para retry
      if (!instanceState.connected) {
        logger.warn('Instance disconnected - queueing message for retry', {
          instanceName: client.instance_name,
          instanceState: instanceState.state,
          contactPhone
        });

        // Encolar mensaje
        messageCache.enqueueMessage({
          locationId,
          instanceName: client.instance_name,
          instanceApiKey: client.instance_apikey,
          contactId,
          messageId,
          messageText,
          waNumber,
          contactPhone
        });

        // Notificar admin sobre instancia caída
        await notifyAdmin('Instance disconnected - message queued', {
          location_id: locationId,
          instance_name: client.instance_name,
          instance_state: instanceState.state,
          endpoint: '/webhook/ghl',
          contactId,
          phone: contactPhone,
          queueStats: messageCache.getStats()
        });

        return res.status(503).json({
          success: false,
          queued: true,
          message: 'Instance disconnected - message queued for retry'
        });
      }

      // PASO 2: Instancia conectada, verificar si tiene WhatsApp
      const hasWhatsApp = await evolutionAPI.checkWhatsAppNumber(
        client.instance_name,
        client.instance_apikey,
        contactPhone
      );

      // CASO 1: hasWhatsApp === false → No tiene WhatsApp (confirmado)
      if (hasWhatsApp === false) {
        // Buscar conversación
        const conversationSearch = await ghlAPI.searchConversation(client, contactId);
        const conversationId = conversationSearch.conversations?.[0]?.id;

        if (conversationId) {
          await ghlAPI.registerMessage(
            client,
            conversationId,
            contactId,
            'NOTA: El contacto no tiene WhatsApp',
            'outbound'
          );
        } else {
          logger.warn('No conversation found to send notification', { contactId });
        }

        // Añadir tag "no-wa" al contacto
        try {
          await ghlAPI.addTags(client, contactId, ['no-wa']);
        } catch (tagError) {
          logger.error('❌ Failed to add tag to contact', {
            contactId,
            error: tagError.message
          });
        }

        return res.status(200).json({
          success: true,
          message: 'Contact does not have WhatsApp - registered in GHL and tagged'
        });
      }

      // CASO 2: hasWhatsApp === null → No se pudo verificar (API error)
      if (hasWhatsApp === null) {
        logger.warn('Could not verify WhatsApp number - queueing message', {
          contactPhone,
          instanceName: client.instance_name
        });

        // Encolar mensaje por si acaso
        messageCache.enqueueMessage({
          locationId,
          instanceName: client.instance_name,
          instanceApiKey: client.instance_apikey,
          contactId,
          messageId,
          messageText,
          waNumber,
          contactPhone
        });

        await notifyAdmin('Failed to verify WhatsApp number - message queued', {
          location_id: locationId,
          error: sendError.message,
          endpoint: '/webhook/ghl',
          contactId,
          phone: contactPhone,
          note: 'No se pudo verificar si tiene WhatsApp, mensaje encolado para retry'
        });

        return res.status(500).json({
          success: false,
          queued: true,
          message: 'Could not verify WhatsApp - message queued for retry'
        });
      }

      // CASO 3: hasWhatsApp === true → Tiene WhatsApp pero falló el envío
      await notifyAdmin('Failed to send WhatsApp message', {
        location_id: locationId,
        error: sendError.message,
        stack: sendError.stack,
        endpoint: '/webhook/ghl',
        contactId,
        messageId,
        phone: contactPhone,
        hasWhatsApp: true,
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