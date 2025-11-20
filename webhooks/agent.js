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
  // 🐛 DEBUG: Log INMEDIATO para confirmar que llega el webhook
  const initialLog = {
    location_id: req.body?.location_id,
    contact_id: req.body?.contact_id,
    agente: req.body?.customData?.agente,
    canal: req.body?.message?.type,
    timestamp: new Date().toISOString()
  };

  logger.info('🤖 AGENT WEBHOOK RECEIVED', initialLog);
  console.log('🤖 AGENT WEBHOOK RECEIVED (console.log):', JSON.stringify(initialLog, null, 2));

  try {
    // Validar payload
    logger.info('🔍 Step 1: Validating payload...');
    const validation = validateAgentPayload(req.body);
    if (!validation.valid) {
      logger.warn('❌ Invalid Agent payload', { reason: validation.reason || validation.missing });
      console.log('❌ VALIDATION FAILED:', validation);
      return res.status(400).json({ error: 'Invalid payload', details: validation });
    }

    // Normalizar location_id (GHL envía location.id en lugar de location_id)
    const contact_id = req.body.contact_id;
    const location_id = req.body.location_id || req.body.location?.id;
    const customData = req.body.customData;
    const message = req.body.message || {};  // Default a objeto vacío si no existe
    const { message_body, agente } = customData;

    // Extraer tags (puede venir como string o array)
    const tags = req.body.tags || '';

    // Mapear message.type numérico a string (valores verificados de GHL)
    const typeMap = {
      20: 'SMS',
      18: 'IG',
      11: 'FB'
    };

    // Derivar canal: si no hay message.type, siempre es SMS (webhooks de inicio)
    const canal = message.type
      ? (typeof message.type === 'number' ? typeMap[message.type] : message.type)
      : 'SMS';  // Sin message.type = trigger manual = SMS

    // Cliente viene del middleware (ya validado)
    const client = req.client;

    logger.info('✅ Step 1 COMPLETE: Agent webhook validated', {
      location_id,
      contact_id,
      agente,
      canal
    });

    // 🐛 DEBUG: Loguear payload completo para Instagram
    logger.info('🐛 DEBUG: Full payload received', {
      message_body: message_body,
      message_body_length: message_body?.length || 0,
      message_body_type: typeof message_body,
      has_message_attachments: !!message.attachments,
      message_attachments_count: message.attachments?.length || 0,
      has_customData_attachment: !!customData.message_attachment,
      customData_attachment: customData.message_attachment,
      customData_keys: Object.keys(customData || {}),
      message_keys: Object.keys(message || {})
    });

    logger.info('🔍 Step 2: Processing message and attachments...');

    // SIEMPRE usar message_body (incluso si es espacio/punto de trigger)
    // Concatenaremos attachments después, el espacio inicial no molesta al agente
    let processedMessage = message_body || '';

    // Procesar attachments desde message.attachments[] (array de URLs)
    if (message.attachments && message.attachments.length > 0) {
      logger.info('📎 Processing message.attachments[]', { count: message.attachments.length });

      for (let i = 0; i < message.attachments.length; i++) {
        const attachment = message.attachments[i];
        try {
          logger.info(`🔄 Processing attachment ${i + 1}/${message.attachments.length}`, { attachment });
          const attachmentText = await mediaProcessor.processAttachment(attachment);
          processedMessage += `\n${attachmentText}`;  // Siempre concatenar con newline
          logger.info(`✅ Attachment ${i + 1} processed successfully`);
        } catch (attachmentError) {
          logger.error(`❌ Failed to process attachment ${i + 1}`, {
            error: attachmentError.message,
            stack: attachmentError.stack,
            attachment
          });
          console.log(`❌ ATTACHMENT ERROR:`, attachmentError);
          processedMessage += `\n[Attachment ${i + 1} could not be processed]`;
        }
      }

      logger.info('✅ message.attachments[] processed', { count: message.attachments.length });
    }

    // Procesar attachment desde customData.message_attachment (Instagram/FB single attachment)
    if (customData.message_attachment && customData.message_attachment.trim()) {
      logger.info('📎 Processing customData.message_attachment', { url: customData.message_attachment });

      try {
        const attachmentText = await mediaProcessor.processAttachment(customData.message_attachment);
        processedMessage += `\n${attachmentText}`;  // Siempre concatenar con newline
        logger.info('✅ customData.message_attachment processed successfully');
      } catch (attachmentError) {
        logger.error('❌ Failed to process customData.message_attachment', {
          error: attachmentError.message,
          stack: attachmentError.stack,
          url: customData.message_attachment
        });
        console.log(`❌ ATTACHMENT ERROR:`, attachmentError);
        processedMessage += `\n[Attachment could not be processed]`;
      }
    }

    // Fallback: si después de todo no hay nada, usar punto mínimo
    if (!processedMessage.trim()) {
      processedMessage = '.';
      logger.warn('⚠️ No content after processing, using fallback "."');
    }

    logger.info('✅ Step 2 COMPLETE: Message processed', {
      originalLength: message_body?.length || 0,
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

    // Añadir mensaje al buffer (getBuffer crea automáticamente si no existe)
    agentBuffer.pushMessage(contact_id, canal, processedMessage);

    // Obtener buffer actualizado
    const buffer = agentBuffer.getBuffer(contact_id, canal);

    logger.info('✅ Step 4 COMPLETE: Message added to buffer', {
      contact_id,
      canal,
      bufferSize: buffer.length
    });

    // Configurar debounce (7 segundos)
    logger.info('🔍 Step 5: Setting up debounce (7s)...', { contact_id, canal });

    try {
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

        if (!currentBuffer || currentBuffer.length === 0) {
          logger.warn('⚠️ Buffer empty or deleted, skipping processing', {
            contact_id,
            canal
          });
          return;
        }

        // v1: Verificación simple - comparar cantidad de mensajes
        const expectedCount = buffer.length;
        const actualCount = currentBuffer.length;

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

        // Preparar startState para Flowise (todo en snake_case)
        const startState = {
          contact_id: contact_id,
          conversation_id: conversationId,
          location_id: location_id,
          canal: canal,
          tags: tags,
          info_crm: customData.info_crm || '',
          info_crm_adicional: customData.info_crm_adicional || '',
          resumen_llamadas: customData.resumen_llamadas || '',
          recuento_llamadas: customData.recuento_llamadas || 0,
          prompt: prompt
        };

        // Unir todos los mensajes del buffer
        const combinedMessages = currentBuffer.join('\n');

        logger.info('✅ Step 7 COMPLETE: Flowise request prepared', {
          ghlContactId,
          conversationId,
          canal,
          messageCount: currentBuffer.length,
          combinedLength: combinedMessages.length,
          hasTags: !!startState.tags,
          hasInfoCrm: !!startState.info_crm,
          hasInfoCrmAdicional: !!startState.info_crm_adicional,
          hasResumenLlamadas: !!startState.resumen_llamadas,
          recuentoLlamadas: startState.recuento_llamadas
        });

        // Llamar a Flowise
        logger.info('🔍 Step 8: Calling Flowise API...', {
          agentName: agentConfig.agent_name,
          messagePreview: combinedMessages.substring(0, 100)
        });

        // Preparar overrideConfig con sessionId y startState
        const overrideConfig = {
          sessionId: conversationId,  // ✅ Mantiene memoria de conversación en Flowise
          startState: Object.entries(startState).map(([key, value]) => ({
            key,
            value
          }))
        };

        const flowiseResponse = await flowiseAPI.callFlowiseAgent(
          agentConfig,
          combinedMessages,
          overrideConfig
        );

        logger.info('✅ Step 8 COMPLETE: Flowise response received', {
          agentName: agentConfig.agent_name,
          sessionId: conversationId
        });

        // Parsear respuesta (3-level fallback)
        logger.info('🔍 Step 9: Parsing Flowise response...');
        const parsed = flowiseAPI.parseFlowiseResponse(flowiseResponse);

        logger.info('✅ Step 9 COMPLETE: Response parsed', {
          hasParte1: !!parsed.parte1,
          hasParte2: !!parsed.parte2,
          hasParte3: !!parsed.parte3
        });

        // Enviar respuestas a GHL (que las enviará al canal correcto)
        logger.info('🔍 Step 10: Sending responses via GHL...', {
          ghlContactId,
          canal
        });

        // Filtrar partes que existan
        const parts = [parsed.parte1, parsed.parte2, parsed.parte3].filter(Boolean);

        // Enviar cada parte a GHL (se enviarán automáticamente al canal especificado)
        for (let i = 0; i < parts.length; i++) {
          await ghlAPI.sendMessage(
            client,
            ghlContactId,
            parts[i],
            canal  // SMS, WhatsApp, IG, FB
          );

          logger.info(`✅ Sent part ${i + 1}/${parts.length} via GHL`, {
            ghlContactId,
            canal,
            length: parts[i].length
          });

          // Delay entre mensajes para mantener orden (igual que n8n)
          if (i < parts.length - 1) {
            const delay = Math.min(Math.max(parts[i].length * 50, 2000), 10000);
            await new Promise(resolve => setTimeout(resolve, delay));
            logger.info(`⏱️ Wait ${delay}ms before next part`);
          }
        }

        logger.info('✅ Step 10 COMPLETE: All responses sent via GHL', {
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

    } catch (setupError) {
      logger.error('❌ Failed to setup debounce', {
        contact_id,
        canal,
        error: setupError.message,
        stack: setupError.stack
      });

      await notifyAdmin('Debounce Setup Failed', {
        contact_id,
        canal,
        location_id,
        agente,
        error: setupError.message,
        stack: setupError.stack
      });

      // Limpiar buffer para evitar leaks
      agentBuffer.clearBuffer(contact_id, canal);
    }

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
