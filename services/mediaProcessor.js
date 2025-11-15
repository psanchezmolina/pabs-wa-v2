const axios = require('axios');
const logger = require('../utils/logger');
const mediaHelper = require('../utils/mediaHelper');
const { notifyAdmin } = require('../utils/notifications');

/**
 * Procesa attachment (audio/imagen) y devuelve texto
 * Descarga el archivo y usa mediaHelper para procesarlo
 *
 * @param {string} attachmentUrl - URL del archivo
 * @returns {Promise<string>} - Texto procesado
 */
async function processAttachment(attachmentUrl) {
  try {
    logger.info('📥 Downloading attachment', { url: attachmentUrl.substring(0, 100) });

    // Descargar archivo
    const response = await axios.get(attachmentUrl, {
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'];
    const base64 = buffer.toString('base64');

    logger.info('✅ Attachment downloaded', {
      contentType,
      size: buffer.length,
      urlPreview: attachmentUrl.substring(0, 50)
    });

    const context = {
      endpoint: '/webhook/agent',
      attachmentUrl: attachmentUrl.substring(0, 100)
    };

    // Procesar según tipo usando helpers compartidos
    if (contentType.startsWith('audio/')) {
      return await mediaHelper.processAudioToText(base64, contentType, context);

    } else if (contentType.startsWith('image/')) {
      return await mediaHelper.processImageToText(base64, '', context);

    } else if (contentType.startsWith('video/')) {
      logger.info('🎥 Video detected, returning placeholder');
      return mediaHelper.formatOtherMediaType('video');

    } else {
      logger.warn('⚠️ Unsupported attachment type', { contentType });
      return mediaHelper.formatOtherMediaType('unknown');
    }

  } catch (error) {
    logger.error('❌ Failed to download attachment', {
      url: attachmentUrl.substring(0, 100),
      error: error.message,
      stack: error.stack,
      status: error.response?.status
    });

    await notifyAdmin('Attachment Download Failed (Agent)', {
      url: attachmentUrl.substring(0, 200),
      error: error.message,
      stack: error.stack,
      endpoint: '/webhook/agent',
      status: error.response?.status,
      statusText: error.response?.statusText
    });

    // Fallback
    return '📎 [archivo no procesado]';
  }
}

module.exports = {
  processAttachment
};
