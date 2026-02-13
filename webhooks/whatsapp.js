const logger = require('../utils/logger');
const { notifyAdmin } = require('../utils/notifications');
const { validateWhatsAppPayload, splitMessage } = require('../utils/validation');
const { getClientByInstanceName } = require('../services/supabase');
const ghlAPI = require('../services/ghl');
const evolutionAPI = require('../services/evolution');
const mediaHelper = require('../utils/mediaHelper');
const { getCachedContactId, setCachedContactId, getCachedConversationId, setCachedConversationId } = require('../services/cache');
const { attemptAutoRestart, processQueuedMessages } = require('../utils/instanceMonitor');

// ✅ GRACE PERIOD para auto-restart (tiempo real via webhooks)
const GRACE_PERIOD_MS = 60 * 1000; // 1 minuto
const gracePeriodTimers = new Map(); // Key: instanceName, Value: { timer, disconnectedAt }

async function handleWhatsAppWebhook(req, res) {
  const startTime = Date.now();

  // ============================================================================
  // LOGGING INICIAL - Captura SIEMPRE (para diagnóstico de mensajes perdidos)
  // ============================================================================
  const event = req.body?.event;
  const instanceName = req.body?.instance;
  const remoteJid = req.body?.data?.key?.remoteJid;
  const messageId = req.body?.data?.key?.id;
  const fromMe = req.body?.data?.key?.fromMe;

  // Log de entrada SIEMPRE (incluso si falla validación después)
  logger.info('📥 Webhook received', {
    event,
    instanceName,
    remoteJid,
    messageId,
    fromMe,
    timestamp: new Date().toISOString(),
    payloadSize: JSON.stringify(req.body).length
  });

  // ============================================================================
  // MANEJAR EVENTOS DE CONEXIÓN (CONNECTION_UPDATE) - Detección en tiempo real
  // ============================================================================

  if (event === 'connection.update') {
    const state = req.body?.data?.state;

    logger.info('Connection update received', { instanceName, state, event });

    // Solo actuar en cambios de estado significativos
    if (state === 'close') {
      // ✅ INSTANCIA DESCONECTADA - INICIAR GRACE PERIOD
      logger.warn('Instance disconnected via webhook - starting grace period', {
        instanceName,
        state,
        gracePeriodMs: GRACE_PERIOD_MS
      });

      // Cancelar timer anterior si existe
      if (gracePeriodTimers.has(instanceName)) {
        clearTimeout(gracePeriodTimers.get(instanceName).timer);
        logger.debug('Cleared previous grace period timer', { instanceName });
      }

      // Obtener cliente para API key
      const client = await getClientByInstanceName(instanceName);
      if (!client) {
        logger.error('Client not found for disconnected instance', { instanceName });
        return res.status(200).json({ success: true, handled: 'connection_close', error: 'client_not_found' });
      }

      // Notificar al admin que se detectó desconexión (esperando grace period)
      await notifyAdmin('Instancia Desconectada - Monitoreando', {
        instance_name: instanceName,
        location_id: client.location_id,
        error: `Esperando ${GRACE_PERIOD_MS / 1000}s antes de auto-restart`,
        endpoint: 'CONNECTION_UPDATE Webhook',
        details: formatGracePeriodNotification(instanceName, GRACE_PERIOD_MS)
      });

      // ✅ PROGRAMAR AUTO-RESTART DESPUÉS DEL GRACE PERIOD
      const timer = setTimeout(async () => {
        logger.info('Grace period expired - attempting auto-restart', {
          instanceName,
          gracePeriodMs: GRACE_PERIOD_MS
        });

        // Verificar si todavía está desconectada
        const currentState = await evolutionAPI.checkInstanceConnection(
          instanceName,
          client.instance_apikey
        );

        if (!currentState.connected) {
          // Sigue desconectada - intentar auto-restart
          logger.warn('Instance still disconnected after grace period', {
            instanceName,
            state: currentState.state
          });

          await attemptAutoRestart(instanceName, client.instance_apikey, [client.location_id]);
        } else {
          // Se reconectó durante el grace period - todo bien
          logger.info('Instance reconnected during grace period - no restart needed', {
            instanceName,
            state: currentState.state
          });
        }

        // Limpiar timer
        gracePeriodTimers.delete(instanceName);
      }, GRACE_PERIOD_MS);

      // Guardar timer para poder cancelarlo si reconecta
      gracePeriodTimers.set(instanceName, {
        timer: timer,
        disconnectedAt: new Date()
      });

      return res.status(200).json({
        success: true,
        handled: 'connection_close',
        gracePeriod: true,
        gracePeriodMs: GRACE_PERIOD_MS
      });
    }

    if (state === 'open') {
      // ✅ INSTANCIA RECONECTADA
      logger.info('Instance reconnected via webhook', { instanceName, state });

      // Cancelar grace period timer si existe
      if (gracePeriodTimers.has(instanceName)) {
        const gracePeriod = gracePeriodTimers.get(instanceName);
        clearTimeout(gracePeriod.timer);
        gracePeriodTimers.delete(instanceName);

        const disconnectedDuration = new Date() - gracePeriod.disconnectedAt;
        logger.info('Instance reconnected during grace period - auto-restart canceled', {
          instanceName,
          disconnectedDurationMs: disconnectedDuration
        });

        // Notificar reconexión durante grace period
        await notifyAdmin('Instancia Reconectada (Grace Period)', {
          instance_name: instanceName,
          error: `Reconectada automáticamente después de ${Math.round(disconnectedDuration / 1000)}s`,
          endpoint: 'CONNECTION_UPDATE Webhook',
          details: `✅ La instancia *${instanceName}* se reconectó sola después de ${Math.round(disconnectedDuration / 1000)} segundos.\n\nNo se requirió auto-restart.`
        });
      }

      // Procesar cola de mensajes pendientes
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

  // Logging activado para todos los mensajes (diagnóstico de mensajes perdidos)
  const log = logger;

  try {
    // Validar payload
    const validation = validateWhatsAppPayload(req.body);
    if (!validation.valid) {
      logger.warn('❌ Invalid WhatsApp payload - mensaje descartado', {
        reason: validation.reason || validation.missing,
        instance: req.body?.instance,
        event: req.body?.event,
        hasData: !!req.body?.data,
        validation
      });
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
      // Tipo de mensaje no soportado - IMPORTANTE: Loguear y notificar
      logger.error('❌ Unsupported message type - mensaje descartado', {
        instance,
        remoteJid: messageData.key.remoteJid,
        messageId: messageData.key.id,
        messageTypes: Object.keys(messageData.message),
        messageData: JSON.stringify(messageData.message, null, 2)
      });

      // Notificar al admin para que sepa que se están perdiendo mensajes
      await notifyAdmin('Mensaje WhatsApp No Soportado', {
        instance_name: instance,
        remoteJid: messageData.key.remoteJid,
        messageId: messageData.key.id,
        messageTypes: Object.keys(messageData.message).join(', '),
        note: 'Este tipo de mensaje no está implementado y se está descartando'
      });

      return res.status(200).json({ success: true, ignored: true, reason: 'Unsupported message type' });
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

    // Log final de éxito con timing
    const processingTime = Date.now() - startTime;
    logger.info('✅ Webhook processed successfully', {
      instanceName: instance,
      remoteJid,
      messageId,
      contactId,
      conversationId,
      direction,
      contentType,
      processingTimeMs: processingTime,
      location_id: client.location_id
    });

    return res.status(200).json({ success: true });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('❌ WhatsApp webhook error', {
      error: error.message,
      stack: error.stack,
      instance: instanceName,
      remoteJid,
      messageId,
      fromMe,
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString()
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

// ============================================================================
// HELPER: Formatear notificación de grace period
// ============================================================================

function formatGracePeriodNotification(instanceName, gracePeriodMs) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const gracePeriodSeconds = Math.round(gracePeriodMs / 1000);

  let message = '⏳ *Instancia Desconectada - Monitoreando*\n\n';
  message += `⏰ Detectado: ${timestamp}\n`;
  message += `📱 Instancia: *${instanceName}*\n`;
  message += `⏱️ Grace period: *${gracePeriodSeconds} segundos*\n\n`;
  message += '━━━━━━━━━━━━━━━━━━━\n\n';
  message += '💡 *Esperando reconexión automática*\n';
  message += `   • Si se reconecta sola: No se requiere acción\n`;
  message += `   • Si sigue desconectada: Auto-restart en ${gracePeriodSeconds}s\n`;
  message += '   • Los mensajes se están encolando para envío posterior\n';
  return message;
}

module.exports = { handleWhatsAppWebhook };