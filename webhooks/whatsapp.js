const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateWhatsAppPayload } = require('../utils/validation');
const { getClientByInstanceName } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const openaiAPI = require('../services/openai');

async function handleWhatsAppWebhook(req, res) {
  try {
    // Validar payload
    const validation = validateWhatsAppPayload(req.body);
    if (!validation.valid) {
      logger.warn('Invalid WhatsApp payload', { reason: validation.reason || validation.missing });
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }
    
    const { instance } = req.body;
    const messageData = req.body.data;
    
    logger.info('WhatsApp webhook received', { 
      instance, 
      remoteJid: messageData.key.remoteJid 
    });
    
    // Buscar cliente
    const client = await getClientByInstanceName(instance);
    
    // Extraer datos
    const phone = '+' + messageData.key.remoteJid.replace(/@s\.whatsapp\.net$/, '');
    const userName = messageData.pushName;
    const messageId = messageData.key.id;
    
    // Detectar tipo de mensaje
    let messageText = '';
    let contentType = 'text';
    
    if (messageData.message.conversation) {
      contentType = 'text';
      messageText = messageData.message.conversation;
    } else if (messageData.message.extendedTextMessage) {
      contentType = 'text';
      messageText = messageData.message.extendedTextMessage.text;
    } else if (messageData.message.audioMessage) {
      contentType = 'audio';
      
      // Obtener audio en base64
      const audioData = await evolutionAPI.getMediaBase64(
        client.instance_name,
        client.instance_apikey,
        messageId
      );
      
      // Transcribir con Whisper
      const transcription = await openaiAPI.transcribeAudio(
        audioData.base64,
        audioData.mimetype
      );
      
      messageText = `audio: ${transcription}`;
      
    } else if (messageData.message.imageMessage) {
      contentType = 'image';
      
      // Obtener imagen en base64
      const imageData = await evolutionAPI.getMediaBase64(
        client.instance_name,
        client.instance_apikey,
        messageId
      );
      
      // Analizar con GPT-4o-mini Vision
      const description = await openaiAPI.analyzeImage(imageData.base64);
      
      const caption = messageData.message.imageMessage.caption || '';
      messageText = `descripcion imagen: ${description}${caption ? ' - ' + caption : ''}`;
      
    } else {
      logger.warn('Unsupported message type', { messageData });
      return res.status(200).json({ success: true, ignored: true });
    }
    
    logger.info('Message processed', { contentType, phone });
    
    // Buscar o crear contacto en GHL
    let contactId;
    const searchResult = await ghlAPI.searchContact(client, phone);
    
    if (searchResult.total === 0) {
      const newContact = await ghlAPI.createContact(client, userName, phone);
      contactId = newContact.id;
      logger.info('Contact created', { contactId, phone });
    } else {
      contactId = searchResult.contacts[0].id;
    }
    
    // Buscar o crear conversación
    let conversationId;
    const convSearch = await ghlAPI.searchConversation(client, contactId);
    
    if (convSearch.total >= 1) {
      conversationId = convSearch.conversations[0].id;
    } else {
      const newConv = await ghlAPI.createConversation(client, contactId);
      conversationId = newConv.id;
      logger.info('Conversation created', { conversationId });
    }
    
    // Subir mensaje a GHL
    await ghlAPI.sendInboundMessage(
      client,
      conversationId,
      contactId,
      messageText
    );
    
    logger.info('Message uploaded to GHL', { conversationId, contactId });
    
    return res.status(200).json({ success: true });
    
  } catch (error) {
    logger.error('WhatsApp webhook error', { error: error.message, stack: error.stack });
    
    await notifyAdmin('WhatsApp Webhook Error', {
      instance_name: req.body?.instance,
      error: error.message
    });
    
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { handleWhatsAppWebhook };