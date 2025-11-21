const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateWhatsAppPayload, splitMessage } = require('../utils/validation');
const { getClientByInstanceName } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const mediaHelper = require('../utils/mediaHelper');
const { getCachedContactId, setCachedContactId, getCachedConversationId, setCachedConversationId } = require('../services/cache');
const { attemptAutoRestart, processQueuedMessages } = require('../utils/instanceMonitor');

async function handleWhatsAppWebhook(req, res) {
  // ============================================================================
  // MANEJAR EVENTOS DE CONEXIÓN (CONNECTION_UPDATE) - Detección en tiempo real
  // ============================================================================
  const event = req.body?.event;
  const instanceName = req.body?.instance;

  if (event === 'connection.update') {
    const state = req.body?.data?.state;

    logger.info('Connection update received', { instanceName, state, event });

    // Solo actuar en cambios de estado significativos
    if (state === 'close') {
      // Instancia desconectada - intentar auto-restart
      logger.warn('Instance disconnected via webhook', { instanceName, state });

      // Obtener cliente para API key
      const client = await getClientByInstanceName(instanceName);
      if (client) {
        // attemptAutoRestart maneja notificaciones y cola de mensajes
        await attemptAutoRestart(instanceName, client.instance_apikey, [client.location_id]);
      }

      return res.status(200).json({ success: true, handled: 'connection_close' });
    }

    if (state === 'open') {
      // Instancia reconectada - procesar cola de mensajes
      logger.info('Instance reconnected via webhook', { instanceName, state });

      const client = await getClientByInstanceName(instanceName);
      if (client) {
        await processQueuedMessages(instanceName, client.instance_apikey);
      }

      return res.status(200).json({ success: true, handled: 'connection_open' });
    }

    // Otros estados (connecting) - solo log
    return res.status(200).json({ success: true, handled: 'connection_update', state });
  }

  // ============================================================================
  // MANEJAR MENSAJES (flujo normal)
  // ============================================================================

  // Detectar si es el número de debug para logging
  const debugNumber = '34660722687@s.whatsapp.net';
  const isDebugNumber = req.body?.data?.key?.remoteJid === debugNumber;

  // Solo logear si es el número de debug - DESACTIVADO temporalmente para debugging agent
  const log = { info: () => {}, warn: () => {}, error: logger.error };

  try {
    // Validar payload
    const validation = validateWhatsAppPayload(req.body);
    if (!validation.valid) {
      log.warn('❌ Invalid WhatsApp payload', { reason: validation.reason || validation.missing });
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }

    const { instance } = req.body;
    const messageData = req.body.data;

    log.info('✅ Step 1 COMPLETE: WhatsApp webhook validated', {
      instance,
      remoteJid: messageData.key.remoteJid,
      fromMe: messageData.key.fromMe
    });

    // Filtrar mensajes de grupos, listas y canales
    const remoteJid = messageData.key.remoteJid;
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@lid')) {
      const messageType = remoteJid.endsWith('@g.us') ? 'grupo' : 'lista/canal';
      log.info(`⏭️ Mensaje de ${messageType} ignorado`, {
        instance,
        remoteJid,
        messageType
      });
      return res.status(200).json({
        success: true,
        ignored: true,
        reason: `Mensajes de ${messageType}s no se procesan`
      });
    }

    // Obtener cliente (viene de middleware o buscar en BD como fallback)
    log.info('🔍 Step 2: Getting client...', { instance });
    const client = req.client || await getClientByInstanceName(instance);

    if (!client) {
      logger.error('❌ Client not found in database', { instance });
      return res.status(404).json({
        error: 'Client not found',
        instance,
        message: 'Esta instancia no está configurada en la base de datos'
      });
    }

    log.info('✅ Step 2 COMPLETE: Client found', {
      instance,
      location_id: client.location_id,
      conversation_provider_id: client.conversation_provider_id,
      fromMiddleware: !!req.client
    });

    // Extraer datos (quitar @s.whatsapp.net y device ID como :0, :1, etc.)
    const phone = '+' + messageData.key.remoteJid
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/:\d+$/, '');
    const userName = messageData.pushName;
    const messageId = messageData.key.id;

    log.info('📋 Extracted data', { phone, userName, messageId });

    // Detectar tipo de mensaje
    log.info('🔍 Step 3: Detecting message type...');
    let messageText = '';
    let contentType = 'text';
    
    if (messageData.message.conversation) {
      contentType = 'text';
      messageText = messageData.message.conversation;
      log.info('📝 Text message detected (conversation)', { messageText });
    } else if (messageData.message.extendedTextMessage) {
      contentType = 'text';
      messageText = messageData.message.extendedTextMessage.text;
      log.info('📝 Text message detected (extendedTextMessage)', { messageText });
    } else if (messageData.message.audioMessage) {
      contentType = 'audio';
      log.info('🎤 Audio message detected, fetching media...');

      // Obtener audio en base64
      const audioData = await evolutionAPI.getMediaBase64(
        client.instance_name,
        client.instance_apikey,
        messageId
      );
      log.info('✅ Audio fetched, processing with Whisper...', { mimetype: audioData.mimetype });

      // Procesar audio usando helper compartido (maneja errores y notificaciones)
      messageText = await mediaHelper.processAudioToText(
        audioData.base64,
        audioData.mimetype,
        {
          endpoint: '/webhook/whatsapp',
          instance_name: client.instance_name,
          messageId,
          remoteJid: messageData.key.remoteJid
        }
      );

    } else if (messageData.message.imageMessage) {
      contentType = 'image';
      log.info('🖼️ Image message detected, fetching media...');

      // Obtener imagen en base64
      const imageData = await evolutionAPI.getMediaBase64(
        client.instance_name,
        client.instance_apikey,
        messageId
      );
      log.info('✅ Image fetched, processing with Vision...', { mimetype: imageData.mimetype });

      // Procesar imagen usando helper compartido (maneja errores y notificaciones)
      const caption = messageData.message.imageMessage.caption || '';
      messageText = await mediaHelper.processImageToText(
        imageData.base64,
        caption,
        {
          endpoint: '/webhook/whatsapp',
          instance_name: client.instance_name,
          messageId,
          remoteJid: messageData.key.remoteJid
        }
      );

    } else if (messageData.message.videoMessage) {
      contentType = 'video';
      const caption = messageData.message.videoMessage.caption || '';
      messageText = mediaHelper.formatOtherMediaType('video', { caption });
      log.info('🎥 Video message detected', { hasCaption: !!caption });

    } else if (messageData.message.documentMessage) {
      contentType = 'document';
      const fileName = messageData.message.documentMessage.fileName || 'documento';
      const caption = messageData.message.documentMessage.caption || '';
      messageText = mediaHelper.formatOtherMediaType('document', { fileName, caption });
      log.info('📎 Document message detected', { fileName, hasCaption: !!caption });

    } else if (messageData.message.locationMessage) {
      contentType = 'location';
      const lat = messageData.message.locationMessage.degreesLatitude;
      const lng = messageData.message.locationMessage.degreesLongitude;
      const name = messageData.message.locationMessage.name || '';
      messageText = mediaHelper.formatOtherMediaType('location', { name, lat, lng });
      log.info('📍 Location message detected', { lat, lng, name });

    } else if (messageData.message.contactMessage) {
      contentType = 'contact';
      const displayName = messageData.message.contactMessage.displayName || 'contacto';
      messageText = mediaHelper.formatOtherMediaType('contact', { displayName });
      log.info('👤 Contact message detected', { displayName });

    } else if (messageData.message.stickerMessage) {
      contentType = 'sticker';
      messageText = mediaHelper.formatOtherMediaType('sticker');
      log.info('😊 Sticker message detected');

    } else {
      log.warn('❌ Unsupported message type', {
        messageTypes: Object.keys(messageData.message),
        messageData: JSON.stringify(messageData.message, null, 2)
      });
      return res.status(200).json({ success: true, ignored: true });
    }

    log.info('✅ Step 3 COMPLETE: Message processed', { contentType, messageText: messageText.substring(0, 100) });
    
    // Buscar o crear contacto en GHL (formato E.164 estándar)
    log.info('🔍 Step 4: Searching for contact in GHL...', { phone });
    let contactId;

    // Verificar caché primero
    contactId = getCachedContactId(client.location_id, phone);

    if (contactId) {
      log.info('✅ Step 4 COMPLETE: Contact found in cache', { contactId, phone });
    } else {
      // No en caché, buscar en GHL API
      const searchResult = await ghlAPI.searchContact(client, phone);
      log.info('📊 Contact search result', {
        total: searchResult.total,
        format: 'E.164'
      });

      if (searchResult.total > 0) {
        contactId = searchResult.contacts[0].id;
        setCachedContactId(client.location_id, phone, contactId);
        log.info('✅ Step 4 COMPLETE: Contact found', { contactId, phone });
      } else {
        // No existe, crear contacto (con fallback de duplicado)
        log.info('➕ Creating new contact...', { userName, phone });
        try {
          const newContact = await ghlAPI.createContact(client, userName, phone);
          contactId = newContact.id;
          setCachedContactId(client.location_id, phone, contactId);
          log.info('✅ Step 4 COMPLETE: Contact created', { contactId, phone });
        } catch (createError) {
          // Si falla por duplicado, GHL nos da el contactId en el error
          if (createError.response?.status === 400 &&
              createError.response?.data?.meta?.contactId) {
            contactId = createError.response.data.meta.contactId;
            setCachedContactId(client.location_id, phone, contactId);
            log.info('✅ Step 4 COMPLETE: Contact exists (from duplicate error)', {
              contactId,
              matchingField: createError.response.data.meta.matchingField
            });
          } else {
            throw createError;
          }
        }
      }
    }

    // Buscar o crear conversación
    log.info('🔍 Step 5: Searching for conversation in GHL...', { contactId });
    let conversationId;

    // Verificar caché primero
    conversationId = getCachedConversationId(client.location_id, contactId);

    if (conversationId) {
      log.info('✅ Step 5 COMPLETE: Conversation found in cache', { conversationId });
    } else {
      // No en caché, buscar en GHL API
      const convSearch = await ghlAPI.searchConversation(client, contactId);
      log.info('📊 Conversation search result', {
        total: convSearch.total,
        conversations: convSearch.conversations?.length
      });

      if (convSearch.total >= 1) {
        conversationId = convSearch.conversations[0].id;
        setCachedConversationId(client.location_id, contactId, conversationId);
        log.info('✅ Step 5 COMPLETE: Conversation found', { conversationId });
      } else {
        log.info('➕ Creating new conversation...', { contactId });
        const newConv = await ghlAPI.createConversation(client, contactId);
        conversationId = newConv.id;
        setCachedConversationId(client.location_id, contactId, conversationId);
        log.info('✅ Step 5 COMPLETE: Conversation created', { conversationId });
      }
    }

    // Calcular direction basándose en fromMe
    const direction = messageData.key.fromMe ? 'outbound' : 'inbound';

    // Dividir mensaje si es muy largo (WhatsApp → GHL)
    const messageParts = splitMessage(messageText);

    if (messageParts.length > 1) {
      log.info('📝 Message split into multiple parts', {
        totalParts: messageParts.length,
        originalLength: messageText.length,
        contactId
      });
    }

    // Registrar mensaje(s) en GHL
    log.info('🔍 Step 6: Registering message in GHL...', {
      conversationId,
      contactId,
      direction,
      parts: messageParts.length,
      messagePreview: messageParts[0].substring(0, 100)
    });

    // Enviar cada parte como mensaje separado
    for (let i = 0; i < messageParts.length; i++) {
      await ghlAPI.registerMessage(
        client,
        conversationId,
        contactId,
        messageParts[i],
        direction
      );

      if (messageParts.length > 1) {
        log.info(`✅ Registered part ${i + 1}/${messageParts.length}`);
      }
    }

    log.info('✅ Step 6 COMPLETE: Message registered in GHL successfully!', {
      conversationId,
      contactId,
      direction,
      totalParts: messageParts.length
    });
    
    return res.status(200).json({ success: true });
    
  } catch (error) {
    logger.error('❌ WhatsApp webhook error', {
      error: error.message,
      stack: error.stack,
      instance: req.body?.instance,
      remoteJid: req.body?.data?.key?.remoteJid
    });

    await notifyAdmin('WhatsApp Webhook Error', {
      instance_name: req.body?.instance,
      error: error.message,
      stack: error.stack,
      endpoint: '/webhook/whatsapp',
      remoteJid: req.body?.data?.key?.remoteJid,
      messageId: req.body?.data?.key?.id,
      // Datos de API si es error de axios
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      data: error.config?.data ? JSON.parse(error.config.data) : undefined
    });

    // IMPORTANTE: Siempre devolver 200 para evitar que Evolution API reintente
    return res.status(200).json({
      success: false,
      error: error.message,
      note: 'Error logged but returning 200 to prevent retries'
    });
  }
}

module.exports = { handleWhatsAppWebhook };