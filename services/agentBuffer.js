const NodeCache = require('node-cache');
const logger = require('../utils/logger');

// Buffer de mensajes por contacto (10 min TTL, auto-expira)
const messageBuffer = new NodeCache({
  stdTTL: 600,  // 10 minutos
  checkperiod: 60,
  useClones: false
});

// Timers de debouncing (Map porque necesitamos clearTimeout)
const debounceTimers = new Map();

/**
 * Agregar mensaje al buffer
 * @param {string} contactId - ID del contacto en GHL
 * @param {string} canal - Tipo de canal (SMS/IG/FB)
 * @param {string} messageText - Texto del mensaje
 */
function pushMessage(contactId, canal, messageText) {
  const key = `${contactId}_${canal}_buffer`;

  // Obtener buffer existente o crear nuevo
  const buffer = messageBuffer.get(key) || [];

  // Agregar mensaje
  buffer.push(messageText);

  // Guardar en caché
  messageBuffer.set(key, buffer);

  logger.debug('📝 Message added to buffer', {
    contactId,
    canal,
    bufferSize: buffer.length,
    messagePreview: messageText.substring(0, 50)
  });
}

/**
 * Obtener buffer de mensajes
 * @param {string} contactId
 * @param {string} canal
 * @returns {string[]} Array de mensajes
 */
function getBuffer(contactId, canal) {
  const key = `${contactId}_${canal}_buffer`;
  const buffer = messageBuffer.get(key) || [];

  logger.debug('📋 Buffer retrieved', {
    contactId,
    canal,
    bufferSize: buffer.length
  });

  return buffer;
}

/**
 * Limpiar buffer
 * @param {string} contactId
 * @param {string} canal
 */
function clearBuffer(contactId, canal) {
  const key = `${contactId}_${canal}_buffer`;
  messageBuffer.del(key);

  logger.debug('🗑️ Buffer cleared', { contactId, canal });
}

/**
 * Verificar si el último mensaje del buffer coincide con el esperado
 * (Para evitar procesar si llegaron nuevos mensajes)
 * @param {string} contactId
 * @param {string} canal
 * @param {string} expectedMessage
 * @returns {boolean}
 */
function isLastMessage(contactId, canal, expectedMessage) {
  const buffer = getBuffer(contactId, canal);

  if (buffer.length === 0) {
    return false;
  }

  const lastMessage = buffer[buffer.length - 1];
  const isMatch = lastMessage === expectedMessage;

  logger.debug('🔍 Checking if last message matches', {
    contactId,
    canal,
    isMatch,
    bufferSize: buffer.length,
    expectedPreview: expectedMessage.substring(0, 50),
    actualPreview: lastMessage.substring(0, 50)
  });

  return isMatch;
}

/**
 * Configurar debouncing para procesar buffer
 * Auto-reset si llegan nuevos mensajes
 *
 * @param {string} contactId
 * @param {string} canal
 * @param {Function} callback - Función a ejecutar después del debounce
 * @param {number} delay - Delay en milisegundos (default: 7000)
 */
function setupDebounce(contactId, canal, callback, delay = 7000) {
  const timerKey = `${contactId}_${canal}`;

  // Limpiar timer existente (auto-reset)
  const existingTimer = debounceTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    logger.debug('⏱️ Debounce timer reset (new message arrived)', {
      contactId,
      canal,
      delay
    });
  } else {
    logger.debug('⏱️ Debounce timer started', {
      contactId,
      canal,
      delay
    });
  }

  // Configurar nuevo timer
  const timer = setTimeout(() => {
    logger.info('⏰ Debounce timer expired, executing callback', {
      contactId,
      canal,
      delay
    });

    // Limpiar timer del Map
    debounceTimers.delete(timerKey);

    // Ejecutar callback
    callback();
  }, delay);

  debounceTimers.set(timerKey, timer);
}

/**
 * Cancelar debouncing manualmente
 * @param {string} contactId
 * @param {string} canal
 */
function cancelDebounce(contactId, canal) {
  const timerKey = `${contactId}_${canal}`;
  const timer = debounceTimers.get(timerKey);

  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(timerKey);
    logger.debug('❌ Debounce timer cancelled', { contactId, canal });
    return true;
  }

  return false;
}

/**
 * Obtener stats del buffer (para debugging/monitoring)
 */
function getBufferStats() {
  const keys = messageBuffer.keys();
  const stats = {
    totalBuffers: keys.length,
    buffers: keys.map(key => ({
      key,
      size: (messageBuffer.get(key) || []).length
    })),
    activeTimers: debounceTimers.size
  };

  logger.debug('📊 Buffer stats', stats);
  return stats;
}

module.exports = {
  pushMessage,
  getBuffer,
  clearBuffer,
  isLastMessage,
  setupDebounce,
  cancelDebounce,
  getBufferStats
};
