const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateWhatsAppPayload } = require('../utils/validation');
const { getClientByInstanceName } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const openaiAPI = require('../services/openai');

async function handleWhatsAppWebhook(req, res) {
  // Detectar si es el número de debug para logging
  const debugNumber = '34660722687@s.whatsapp.net';
  const isDebugNumber = req.body?.data?.key?.remoteJid === debugNumber;

  // Solo logear si es el número de debug
  const log = isDebugNumber ? logger : { info: () => {}, warn: () => {}, error: logger.error };

  log.info('📱 WHATSAPP WEBHOOK RECEIVED', {
    body: JSON.stringify(req.body, null, 2),
    headers: req.headers,
    method: req.method
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
    
    // Buscar cliente (crítico para multi-tenant)
    log.info('🔍 Step 2: Searching for client by instance name...', { instance });
    const client = await getClientByInstanceName(instance);

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
      conversation_provider_id: client.conversation_provider_id
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

    } else if (messageData.message.imageMessage) {
      contentType = 'image';
      log.info('🖼️ Image message detected, fetching media...');

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

    } else {
      log.warn('❌ Unsupported message type', {
        messageData: JSON.stringify(messageData.message, null, 2)
      });
      return res.status(200).json({ success: true, ignored: true });
    }

    log.info('✅ Step 3 COMPLETE: Message processed', { contentType, messageText: messageText.substring(0, 100) });
    
    // Buscar o crear contacto en GHL (formato E.164 estándar)
    log.info('🔍 Step 4: Searching for contact in GHL...', { phone });
    let contactId;

    // Buscar con formato E.164 estándar (único formato oficial de GHL)
    const searchResult = await ghlAPI.searchContact(client, phone);
    log.info('📊 Contact search result', {
      total: searchResult.total,
      format: 'E.164'
    });

    if (searchResult.total > 0) {
      contactId = searchResult.contacts[0].id;
      log.info('✅ Step 4 COMPLETE: Contact found', { contactId, phone });
    } else {
      // No existe, crear contacto (con fallback de duplicado)
      log.info('➕ Creating new contact...', { userName, phone });
      try {
        const newContact = await ghlAPI.createContact(client, userName, phone);
        contactId = newContact.id;
        log.info('✅ Step 4 COMPLETE: Contact created', { contactId, phone });
      } catch (createError) {
        // Si falla por duplicado, GHL nos da el contactId en el error
        if (createError.response?.status === 400 &&
            createError.response?.data?.meta?.contactId) {
          contactId = createError.response.data.meta.contactId;
          log.info('✅ Step 4 COMPLETE: Contact exists (from duplicate error)', {
            contactId,
            matchingField: createError.response.data.meta.matchingField
          });
        } else {
          throw createError;
        }
      }
    }

    // Buscar o crear conversación
    log.info('🔍 Step 5: Searching for conversation in GHL...', { contactId });
    let conversationId;
    const convSearch = await ghlAPI.searchConversation(client, contactId);
    log.info('📊 Conversation search result', {
      total: convSearch.total,
      conversations: convSearch.conversations?.length
    });

    if (convSearch.total >= 1) {
      conversationId = convSearch.conversations[0].id;
      log.info('✅ Step 5 COMPLETE: Conversation found', { conversationId });
    } else {
      log.info('➕ Creating new conversation...', { contactId });
      const newConv = await ghlAPI.createConversation(client, contactId);
      conversationId = newConv.id;
      log.info('✅ Step 5 COMPLETE: Conversation created', { conversationId });
    }

    // Subir mensaje a GHL
    log.info('🔍 Step 6: Uploading message to GHL...', {
      conversationId,
      contactId,
      messagePreview: messageText.substring(0, 100)
    });

    await ghlAPI.sendInboundMessage(
      client,
      conversationId,
      contactId,
      messageText
    );

    log.info('✅ Step 6 COMPLETE: Message uploaded to GHL successfully!', {
      conversationId,
      contactId
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
      stack: error.stack
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