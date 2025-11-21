/**
 * Message Cache Service - Cola de mensajes fallidos por instancia caída
 * Almacena mensajes para reintento cuando la instancia se reconecte
 */

const NodeCache = require('node-cache');
const logger = require('../utils/logger');

// Cache de mensajes pendientes (TTL 8 horas - tiempo máximo de retry)
const messageCache = new NodeCache({
  stdTTL: 28800, // 8 horas
  checkperiod: 300, // Check cada 5 min
  useClones: true // Clonar objetos para evitar mutaciones
});

// Configuración de retry
const RETRY_CONFIG = {
  maxRetries: 5,
  delays: [5 * 60, 10 * 60, 20 * 60, 40 * 60, 60 * 60] // 5min, 10min, 20min, 40min, 1h (en segundos)
};

/**
 * Encola un mensaje fallido para reintento posterior
 * @param {Object} messageData - Datos del mensaje
 * @param {string} messageData.locationId - Location ID de GHL
 * @param {string} messageData.instanceName - Nombre de instancia Evolution
 * @param {string} messageData.instanceApiKey - API key de instancia
 * @param {string} messageData.contactId - Contact ID de GHL
 * @param {string} messageData.messageId - Message ID de GHL (opcional)
 * @param {string} messageData.messageText - Texto del mensaje
 * @param {string} messageData.waNumber - Número de WhatsApp formateado
 * @param {string} messageData.contactPhone - Teléfono del contacto
 */
function enqueueMessage(messageData) {
  const { instanceName } = messageData;
  const key = `pending:${instanceName}`;

  // Obtener cola existente o crear nueva
  let queue = messageCache.get(key) || [];

  // Evitar duplicados por messageId
  if (messageData.messageId) {
    const exists = queue.some(m => m.messageId === messageData.messageId);
    if (exists) {
      logger.info('Message already in queue, skipping', {
        messageId: messageData.messageId,
        instanceName
      });
      return false;
    }
  }

  // Añadir mensaje con metadata de retry
  const queuedMessage = {
    ...messageData,
    retryCount: 0,
    queuedAt: Date.now(),
    nextRetryAt: Date.now() + (RETRY_CONFIG.delays[0] * 1000)
  };

  queue.push(queuedMessage);
  messageCache.set(key, queue);

  logger.info('Message enqueued for retry', {
    instanceName,
    messageId: messageData.messageId,
    contactPhone: messageData.contactPhone,
    queueSize: queue.length
  });

  return true;
}

/**
 * Obtiene todos los mensajes pendientes para una instancia
 * @param {string} instanceName - Nombre de instancia
 * @returns {Array} Cola de mensajes
 */
function getQueuedMessages(instanceName) {
  const key = `pending:${instanceName}`;
  return messageCache.get(key) || [];
}

/**
 * Obtiene mensajes listos para reintentar (nextRetryAt <= ahora)
 * @param {string} instanceName - Nombre de instancia
 * @returns {Array} Mensajes listos para retry
 */
function getMessagesReadyForRetry(instanceName) {
  const queue = getQueuedMessages(instanceName);
  const now = Date.now();

  return queue.filter(msg => msg.nextRetryAt <= now && msg.retryCount < RETRY_CONFIG.maxRetries);
}

/**
 * Actualiza un mensaje después de un intento de retry
 * @param {string} instanceName - Nombre de instancia
 * @param {string} messageId - ID del mensaje (o índice si no hay ID)
 * @param {boolean} success - Si el envío fue exitoso
 */
function updateMessageRetry(instanceName, messageId, success) {
  const key = `pending:${instanceName}`;
  let queue = messageCache.get(key) || [];

  const msgIndex = queue.findIndex(m => m.messageId === messageId);
  if (msgIndex === -1) return;

  if (success) {
    // Mensaje enviado exitosamente - remover de la cola
    queue.splice(msgIndex, 1);
    logger.info('Message sent successfully, removed from queue', {
      instanceName,
      messageId
    });
  } else {
    // Incrementar contador y calcular próximo retry
    queue[msgIndex].retryCount++;
    const nextDelayIndex = Math.min(queue[msgIndex].retryCount, RETRY_CONFIG.delays.length - 1);
    queue[msgIndex].nextRetryAt = Date.now() + (RETRY_CONFIG.delays[nextDelayIndex] * 1000);

    logger.info('Message retry failed, scheduled for next attempt', {
      instanceName,
      messageId,
      retryCount: queue[msgIndex].retryCount,
      maxRetries: RETRY_CONFIG.maxRetries,
      nextRetryIn: `${RETRY_CONFIG.delays[nextDelayIndex] / 60} minutes`
    });

    // Si alcanzó max retries, remover de la cola
    if (queue[msgIndex].retryCount >= RETRY_CONFIG.maxRetries) {
      logger.warn('Message exceeded max retries, removing from queue', {
        instanceName,
        messageId,
        contactPhone: queue[msgIndex].contactPhone
      });
      queue.splice(msgIndex, 1);
    }
  }

  messageCache.set(key, queue);
}

/**
 * Limpia la cola de una instancia
 * @param {string} instanceName - Nombre de instancia
 */
function clearQueue(instanceName) {
  const key = `pending:${instanceName}`;
  const queue = messageCache.get(key) || [];
  messageCache.del(key);

  logger.info('Message queue cleared', {
    instanceName,
    messagesCleared: queue.length
  });
}

/**
 * Obtiene todas las instancias con mensajes pendientes
 * @returns {Array} Lista de nombres de instancia
 */
function getInstancesWithPendingMessages() {
  const keys = messageCache.keys();
  return keys
    .filter(k => k.startsWith('pending:'))
    .map(k => k.replace('pending:', ''));
}

/**
 * Obtiene estadísticas del cache
 * @returns {Object} Estadísticas
 */
function getStats() {
  const instances = getInstancesWithPendingMessages();
  let totalMessages = 0;

  instances.forEach(instance => {
    totalMessages += getQueuedMessages(instance).length;
  });

  return {
    instancesWithPending: instances.length,
    totalPendingMessages: totalMessages,
    instances: instances.map(i => ({
      name: i,
      pendingCount: getQueuedMessages(i).length
    }))
  };
}

module.exports = {
  enqueueMessage,
  getQueuedMessages,
  getMessagesReadyForRetry,
  updateMessageRetry,
  clearQueue,
  getInstancesWithPendingMessages,
  getStats,
  RETRY_CONFIG
};
