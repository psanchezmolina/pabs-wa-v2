const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateWhatsAppPayload } = require('../utils/validation');
const { getClientByInstanceName } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const openaiAPI = require('../services/openai');

async function handleWhatsAppWebhook(req, res) {
  // Log COMPLETO del webhook para debugging
  logger.info('📱 WHATSAPP WEBHOOK RECEIVED', {
    body: JSON.stringify(req.body, null, 2),
    headers: req.headers,
    method: req.method
  });

  try {
    // Validar payload
    logger.info('🔍 Step 1: Validating payload...');
    const validation = validateWhatsAppPayload(req.body);
    if (!validation.valid) {
      logger.warn('❌ Invalid WhatsApp payload', { reason: validation.reason || validation.missing });
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }

    const { instance } = req.body;
    const messageData = req.body.data;

    logger.info('✅ Step 1 COMPLETE: WhatsApp webhook validated', {
      instance,
      remoteJid: messageData.key.remoteJid,
      fromMe: messageData.key.fromMe
    });
    
    // Buscar cliente
    logger.info('🔍 Step 2: Searching for client by instance name...', { instance });
    const client = await getClientByInstanceName(instance);
    logger.info('✅ Step 2 COMPLETE: Client found', {
      location_id: client.location_id,
      conversation_provider_id: client.conversation_provider_id
    });

    // Extraer datos
    const phone = '+' + messageData.key.remoteJid.replace(/@s\.whatsapp\.net$/, '');
    const userName = messageData.pushName;
    const messageId = messageData.key.id;

    logger.info('📋 Extracted data', { phone, userName, messageId });

    // Detectar tipo de mensaje
    logger.info('🔍 Step 3: Detecting message type...');
    let messageText = '';
    let contentType = 'text';
    
    if (messageData.message.conversation) {
      contentType = 'text';
      messageText = messageData.message.conversation;
      logger.info('📝 Text message detected (conversation)', { messageText });
    } else if (messageData.message.extendedTextMessage) {
      contentType = 'text';
      messageText = messageData.message.extendedTextMessage.text;
      logger.info('📝 Text message detected (extendedTextMessage)', { messageText });
    } else if (messageData.message.audioMessage) {
      contentType = 'audio';
      logger.info('🎤 Audio message detected, fetching media...');

      // Obtener audio en base64
      const audioData = await evolutionAPI.getMediaBase64(
        client.instance_name,
        client.instance_apikey,
        messageId
      );
      logger.info('✅ Audio fetched, transcribing with Whisper...', { mimetype: audioData.mimetype });

      // Transcribir con Whisper
      const transcription = await openaiAPI.transcribeAudio(
        audioData.base64,
        audioData.mimetype
      );

      messageText = `audio: ${transcription}`;
      logger.info('✅ Audio transcribed', { transcription });

    } else if (messageData.message.imageMessage) {
      contentType = 'image';
      logger.info('🖼️ Image message detected, fetching media...');

      // Obtener imagen en base64
      const imageData = await evolutionAPI.getMediaBase64(
        client.instance_name,
        client.instance_apikey,
        messageId
      );
      logger.info('✅ Image fetched, analyzing with Vision...', { mimetype: imageData.mimetype });

      // Analizar con GPT-4o-mini Vision
      const description = await openaiAPI.analyzeImage(imageData.base64);

      const caption = messageData.message.imageMessage.caption || '';
      messageText = `descripcion imagen: ${description}${caption ? ' - ' + caption : ''}`;
      logger.info('✅ Image analyzed', { description, caption });

    } else {
      logger.warn('❌ Unsupported message type', {
        messageData: JSON.stringify(messageData.message, null, 2)
      });
      return res.status(200).json({ success: true, ignored: true });
    }

    logger.info('✅ Step 3 COMPLETE: Message processed', { contentType, messageText: messageText.substring(0, 100) });
    
    // Buscar o crear contacto en GHL
    logger.info('🔍 Step 4: Searching for contact in GHL...', { phone });
    let contactId;
    const searchResult = await ghlAPI.searchContact(client, phone);
    logger.info('📊 Contact search result', {
      total: searchResult.total,
      contacts: searchResult.contacts?.length
    });

    if (searchResult.total === 0) {
      logger.info('➕ Creating new contact...', { userName, phone });
      const newContact = await ghlAPI.createContact(client, userName, phone);
      contactId = newContact.id;
      logger.info('✅ Step 4 COMPLETE: Contact created', { contactId, phone });
    } else {
      contactId = searchResult.contacts[0].id;
      logger.info('✅ Step 4 COMPLETE: Contact found', { contactId, phone });
    }

    // Buscar o crear conversación
    logger.info('🔍 Step 5: Searching for conversation in GHL...', { contactId });
    let conversationId;
    const convSearch = await ghlAPI.searchConversation(client, contactId);
    logger.info('📊 Conversation search result', {
      total: convSearch.total,
      conversations: convSearch.conversations?.length
    });

    if (convSearch.total >= 1) {
      conversationId = convSearch.conversations[0].id;
      logger.info('✅ Step 5 COMPLETE: Conversation found', { conversationId });
    } else {
      logger.info('➕ Creating new conversation...', { contactId });
      const newConv = await ghlAPI.createConversation(client, contactId);
      conversationId = newConv.id;
      logger.info('✅ Step 5 COMPLETE: Conversation created', { conversationId });
    }

    // Subir mensaje a GHL
    logger.info('🔍 Step 6: Uploading message to GHL...', {
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

    logger.info('✅ Step 6 COMPLETE: Message uploaded to GHL successfully!', {
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

    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

module.exports = { handleWhatsAppWebhook };