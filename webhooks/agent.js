const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateAgentPayload } = require('../utils/validation');
const { getAgentConfig } = require('../services/supabase');
const { getCachedContactId, setCachedContactId, getCachedConversationId, setCachedConversationId } = require('../services/cache');
const ghlAPI = require('../services/ghl');
const langfuseAPI = require('../services/langfuse');
const flowiseAPI = require('../services/flowise');
const agentBuffer = require('../services/agentBuffer');
const mediaProcessor = require('../services/mediaProcessor');

async function handleAgentWebhook(req, res) {
  logger.info('🤖 AGENT WEBHOOK RECEIVED', {
    location_id: req.body?.location_id,
    contact_id: req.body?.contact_id,
    agente: req.body?.customData?.agente,
    canal: req.body?.message?.type
  });

  try {
    // Validar payload
    logger.info('🔍 Step 1: Validating payload...');
    const validation = validateAgentPayload(req.body);
    if (!validation.valid) {
      logger.warn('❌ Invalid Agent payload', { reason: validation.reason || validation.missing });
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }

    const { contact_id, location_id, customData, message } = req.body;
    const { message_body, agente } = customData;

    // Cliente viene del middleware (ya validado)
    const client = req.client;

    logger.info('✅ Step 1 COMPLETE: Agent webhook validated', {
      location_id,
      contact_id,
      agente,
      canal: message.type
    });

    // Mapear canal (SMS/IG/FB desde message.type)
    const canal = message.type; // SMS, IG, FB

    logger.info('🔍 Step 2: Processing message and attachments...');

    // Procesar attachment si existe
    let processedMessage = message_body;
    if (message.attachments && message.attachments.length > 0) {
      logger.info('📎 Processing attachments', { count: message.attachments.length });

      // Procesar cada attachment
      for (const attachment of message.attachments) {
        const attachmentText = await mediaProcessor.processAttachment(attachment);
        processedMessage += `\n${attachmentText}`;
      }

      logger.info('✅ Attachments processed', { attachmentCount: message.attachments.length });
    }

    logger.info('✅ Step 2 COMPLETE: Message processed', {
      originalLength: message_body.length,
      processedLength: processedMessage.length,
      hasAttachments: message.attachments?.length > 0
    });

    // Obtener configuración del agente
    logger.info('🔍 Step 3: Getting agent config...', { location_id, agente });
    const agentConfig = await getAgentConfig(location_id, agente);

    logger.info('✅ Step 3 COMPLETE: Agent config found', {
      agente,
      chatflow_id: agentConfig.chatflow_id
    });

    // Gestión de buffer
    logger.info('🔍 Step 4: Managing message buffer...', { contact_id, canal });

    // Obtener o crear buffer
    const buffer = agentBuffer.getOrCreateBuffer(contact_id, canal);

    // Añadir mensaje al buffer
    agentBuffer.appendMessage(contact_id, canal, processedMessage);

    logger.info('✅ Step 4 COMPLETE: Message added to buffer', {
      contact_id,
      canal,
      bufferSize: buffer.messages.length
    });

    // Configurar debounce (7 segundos)
    logger.info('🔍 Step 5: Setting up debounce (7s)...', { contact_id, canal });

    agentBuffer.setupDebounce(contact_id, canal, async () => {
      // IMPORTANTE: Este callback se ejecuta de forma asíncrona
      // Necesita su propio manejo de errores
      try {
        logger.info('⏰ Debounce fired, processing buffered messages...', {
          contact_id,
          canal,
          location_id
        });

        // Obtener estado actual del buffer
        const currentBuffer = agentBuffer.getBuffer(contact_id, canal);

        if (!currentBuffer || currentBuffer.messages.length === 0) {
          logger.warn('⚠️ Buffer empty or deleted, skipping processing', {
            contact_id,
            canal
          });
          return;
        }

        // v1: Verificación simple - comparar cantidad de mensajes
        const expectedCount = buffer.messages.length;
        const actualCount = currentBuffer.messages.length;

        if (actualCount !== expectedCount) {
          logger.warn('⚠️ Buffer changed during debounce, discarding', {
            contact_id,
            canal,
            expectedCount,
            actualCount
          });
          // Limpiar buffer y no procesar
          agentBuffer.clearBuffer(contact_id, canal);
          return;
        }

        logger.info('✅ Buffer verification passed', {
          contact_id,
          canal,
          messageCount: actualCount
        });

        // Obtener prompt desde Langfuse usando las keys del cliente
        logger.info('🔍 Step 6: Getting prompt from Langfuse...', { agente });

        // Validar que el cliente tenga las keys de Langfuse configuradas
        if (!client.langfuse_public_key || !client.langfuse_secret_key) {
          throw new Error(`Client ${location_id} missing Langfuse API keys. Please configure langfuse_public_key and langfuse_secret_key in clients_details.`);
        }

        const prompt = await langfuseAPI.getPrompt(
          agente,
          client.langfuse_public_key,
          client.langfuse_secret_key
        );

        logger.info('✅ Step 6 COMPLETE: Prompt retrieved', {
          agente,
          promptLength: prompt.length
        });

        // Preparar datos para Flowise
        logger.info('🔍 Step 7: Preparing Flowise request...');

        // Obtener datos del contacto desde GHL (contact_id es el GHL contactId)
        let ghlContactId = getCachedContactId(location_id, contact_id);

        if (!ghlContactId) {
          // El contact_id del webhook YA ES el contactId de GHL
          ghlContactId = contact_id;
          setCachedContactId(location_id, contact_id, ghlContactId);
        }

        // Obtener o crear conversación
        let conversationId = getCachedConversationId(location_id, ghlContactId);

        if (!conversationId) {
          const convSearch = await ghlAPI.searchConversation(client, ghlContactId);

          if (convSearch.total >= 1) {
            conversationId = convSearch.conversations[0].id;
            setCachedConversationId(location_id, ghlContactId, conversationId);
            logger.info('✅ Conversation found', { conversationId });
          } else {
            // Crear conversación
            logger.info('➕ Creating new conversation...', { ghlContactId });
            const newConv = await ghlAPI.createConversation(client, ghlContactId);
            conversationId = newConv.id;
            setCachedConversationId(location_id, ghlContactId, conversationId);
            logger.info('✅ Conversation created', { conversationId });
          }
        }

        // Preparar startState para Flowise
        const startState = {
          contact_id: contact_id,
          conversation_id: conversationId,
          location_id: location_id,
          canal: canal,
          prompt: prompt
        };

        // Unir todos los mensajes del buffer
        const combinedMessages = currentBuffer.messages.join('\n');

        logger.info('✅ Step 7 COMPLETE: Flowise request prepared', {
          ghlContactId,
          conversationId,
          canal,
          messageCount: currentBuffer.messages.length,
          combinedLength: combinedMessages.length
        });

        // Llamar a Flowise
        logger.info('🔍 Step 8: Calling Flowise API...', {
          chatflow_id: agentConfig.chatflow_id,
          messagePreview: combinedMessages.substring(0, 100)
        });

        const flowiseResponse = await flowiseAPI.callFlowise(
          agentConfig.flowise_webhook,
          agentConfig.chatflow_id,
          combinedMessages,
          startState
        );

        logger.info('✅ Step 8 COMPLETE: Flowise response received', {
          chatflow_id: agentConfig.chatflow_id
        });

        // Parsear respuesta (3-level fallback)
        logger.info('🔍 Step 9: Parsing Flowise response...');
        const parsed = flowiseAPI.parseFlowiseResponse(flowiseResponse);

        logger.info('✅ Step 9 COMPLETE: Response parsed', {
          hasParte1: !!parsed.parte1,
          hasParte2: !!parsed.parte2,
          hasParte3: !!parsed.parte3
        });

        // Registrar respuestas en GHL
        logger.info('🔍 Step 10: Registering responses in GHL...', {
          conversationId,
          ghlContactId,
          canal
        });

        // Filtrar partes que existan
        const parts = [parsed.parte1, parsed.parte2, parsed.parte3].filter(Boolean);

        // Registrar cada parte en GHL (dirección outbound = respuesta del agente)
        for (let i = 0; i < parts.length; i++) {
          await ghlAPI.registerMessage(
            client,
            conversationId,
            ghlContactId,
            parts[i],
            'outbound'
          );

          logger.info(`✅ Registered part ${i + 1}/${parts.length} in GHL`, {
            conversationId,
            ghlContactId,
            canal,
            length: parts[i].length
          });
        }

        logger.info('✅ Step 10 COMPLETE: All responses registered in GHL', {
          conversationId,
          ghlContactId,
          canal,
          totalParts: parts.length
        });

        // Limpiar buffer
        agentBuffer.clearBuffer(contact_id, canal);

        logger.info('🎉 Agent processing complete!', {
          contact_id,
          conversationId,
          canal,
          location_id,
          agente
        });

      } catch (debounceError) {
        // Error durante procesamiento asíncrono
        logger.error('❌ Error in debounce callback', {
          error: debounceError.message,
          stack: debounceError.stack,
          contact_id,
          canal,
          location_id
        });

        await notifyAdmin('Agent Debounce Processing Error', {
          contact_id,
          canal,
          location_id,
          agente,
          error: debounceError.message,
          stack: debounceError.stack,
          endpoint: '/webhook/agent',
          status: debounceError.response?.status,
          statusText: debounceError.response?.statusText,
          responseData: debounceError.response?.data
        });

        // Limpiar buffer en caso de error
        agentBuffer.clearBuffer(contact_id, canal);
      }
    }, 7000);

    logger.info('✅ Step 5 COMPLETE: Debounce configured', {
      contact_id,
      canal,
      delay: '7s'
    });

    // Retornar 200 inmediatamente (procesamiento asíncrono)
    return res.status(200).json({
      success: true,
      message: 'Message queued for processing',
      contact_id,
      canal
    });

  } catch (error) {
    logger.error('❌ Agent webhook error', {
      error: error.message,
      stack: error.stack,
      location_id: req.body?.location_id,
      contact_id: req.body?.contact_id
    });

    await notifyAdmin('Agent Webhook Error', {
      location_id: req.body?.location_id,
      contact_id: req.body?.contact_id,
      agente: req.body?.customData?.agente,
      error: error.message,
      stack: error.stack,
      endpoint: '/webhook/agent',
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });

    // IMPORTANTE: Devolver 200 para evitar reintentos de GHL
    return res.status(200).json({
      success: false,
      error: error.message,
      note: 'Error logged but returning 200 to prevent retries'
    });
  }
}

module.exports = { handleAgentWebhook };
