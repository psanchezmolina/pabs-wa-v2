const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateWhatsAppPayload, splitMessage } = require('../utils/validation');
const { getClientByInstanceName } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const openaiAPI = require('../services/openai');
const { getCachedContactId, setCachedContactId, getCachedConversationId, setCachedConversationId } = require('../services/cache');

async function handleWhatsAppWebhook(req, res) {
  // Detectar si es el número de debug para logging
  const debugNumber = '34660722687@s.whatsapp.net';
  const isDebugNumber = req.body?.data?.key?.remoteJid === debugNumber;

  // Solo logear si es el número de debug
  const log = isDebugNumber ? logger : { info: () => {}, warn: () => {}, error: logger.error };

  log.info('📱 WHATSAPP WEBHOOK RECEIVED', {
    instance: req.body?.instance,
    event: req.body?.event,
    remoteJid: req.body?.data?.key?.remoteJid,
    fromMe: req.body?.data?.key?.fromMe,
    messageType: req.body?.data?.messageType
  });

  try {
    // Validar payload
    log.info('🔍 Step 1: Validating payload...');
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

    // Extraer datos
    const phone = '+' + messageData.key.remoteJid.replace(/@s\.whatsapp\.net$/, '');
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

      try {
        // Obtener audio en base64
        const audioData = await evolutionAPI.getMediaBase64(
          client.instance_name,
          client.instance_apikey,
          messageId
        );
        log.info('✅ Audio fetched, transcribing with Whisper...', { mimetype: audioData.mimetype });

        // Transcribir con Whisper
        const transcription = await openaiAPI.transcribeAudio(
          audioData.base64,
          audioData.mimetype
        );

        messageText = `audio: ${transcription}`;
        log.info('✅ Audio transcribed', { transcription });

      } catch (audioError) {
        log.error('❌ Failed to process audio', {
          error: audioError.message,
          messageId
        });

        // Fallback: marcar como audio no procesado
        messageText = '🎤 [audio no procesado]';

        // Notificar al admin del fallo de OpenAI
        await notifyAdmin('OpenAI Audio Processing Failed', {
          error: audioError.message,
          stack: audioError.stack,
          endpoint: '/webhook/whatsapp',
          instance_name: client.instance_name,
          messageId,
          remoteJid: messageData.key.remoteJid,
          // Datos de API si es error de axios
          status: audioError.response?.status,
          statusText: audioError.response?.statusText,
          responseData: audioError.response?.data
        });
      }

    } else if (messageData.message.imageMessage) {
      contentType = 'image';
      log.info('🖼️ Image message detected, fetching media...');

      try {
        // Obtener imagen en base64
        const imageData = await evolutionAPI.getMediaBase64(
          client.instance_name,
          client.instance_apikey,
          messageId
        );
        log.info('✅ Image fetched, analyzing with Vision...', { mimetype: imageData.mimetype });

        // Analizar con GPT-4o-mini Vision
        const description = await openaiAPI.analyzeImage(imageData.base64);

        const caption = messageData.message.imageMessage.caption || '';
        messageText = `descripcion imagen: ${description}${caption ? ' - ' + caption : ''}`;
        log.info('✅ Image analyzed', { description, caption });

      } catch (imageError) {
        log.error('❌ Failed to process image', {
          error: imageError.message,
          messageId
        });

        // Fallback: marcar como imagen no procesada (incluir caption si existe)
        const caption = messageData.message.imageMessage.caption || '';
        messageText = `🖼️ [imagen no procesada]${caption ? ' - ' + caption : ''}`;

        // Notificar al admin del fallo de OpenAI
        await notifyAdmin('OpenAI Image Processing Failed', {
          error: imageError.message,
          stack: imageError.stack,
          endpoint: '/webhook/whatsapp',
          instance_name: client.instance_name,
          messageId,
          remoteJid: messageData.key.remoteJid,
          // Datos de API si es error de axios
          status: imageError.response?.status,
          statusText: imageError.response?.statusText,
          responseData: imageError.response?.data
        });
      }

    } else if (messageData.message.videoMessage) {
      contentType = 'video';
      const caption = messageData.message.videoMessage.caption || '';
      messageText = `🎥 [video]${caption ? ' - ' + caption : ''} - Ver más en WhatsApp`;
      log.info('🎥 Video message detected', { hasCaption: !!caption });

    } else if (messageData.message.documentMessage) {
      contentType = 'document';
      const fileName = messageData.message.documentMessage.fileName || 'documento';
      const caption = messageData.message.documentMessage.caption || '';
      messageText = `📎 [${fileName}]${caption ? ' - ' + caption : ''} - Ver más en WhatsApp`;
      log.info('📎 Document message detected', { fileName, hasCaption: !!caption });

    } else if (messageData.message.locationMessage) {
      contentType = 'location';
      const lat = messageData.message.locationMessage.degreesLatitude;
      const lng = messageData.message.locationMessage.degreesLongitude;
      const name = messageData.message.locationMessage.name || '';
      messageText = `📍 [ubicación]${name ? ': ' + name : ''}${lat && lng ? ` (${lat}, ${lng})` : ''} - Ver más en WhatsApp`;
      log.info('📍 Location message detected', { lat, lng, name });

    } else if (messageData.message.contactMessage) {
      contentType = 'contact';
      const displayName = messageData.message.contactMessage.displayName || 'contacto';
      messageText = `👤 [contacto: ${displayName}] - Ver más en WhatsApp`;
      log.info('👤 Contact message detected', { displayName });

    } else if (messageData.message.stickerMessage) {
      contentType = 'sticker';
      messageText = '😊 [sticker]';
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