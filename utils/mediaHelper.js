const openaiAPI = require('../services/openai');
const logger = require('./logger');
const { notifyAdmin } = require('./notifications');

/**
 * Procesar audio a texto usando Whisper
 * @param {string} base64 - Audio en base64
 * @param {string} mimetype - Tipo MIME del audio
 * @param {object} context - Contexto para logging/notificaciones
 * @returns {Promise<string>} - Texto formateado: "audio: {transcripción}"
 */
async function processAudioToText(base64, mimetype, context = {}) {
  try {
    logger.info('🎤 Transcribing audio with Whisper', {
      mimetype,
      size: base64.length,
      ...context
    });

    const transcription = await openaiAPI.transcribeAudio(base64, mimetype);

    logger.info('✅ Audio transcribed', {
      transcriptionLength: transcription.length,
      ...context
    });

    return `audio: ${transcription}`;

  } catch (error) {
    logger.error('❌ Failed to transcribe audio', {
      error: error.message,
      mimetype,
      ...context
    });

    // Notificar al admin del fallo de OpenAI
    await notifyAdmin('OpenAI Audio Processing Failed', {
      error: error.message,
      stack: error.stack,
      mimetype,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      ...context
    });

    // Fallback
    return '🎤 [audio no procesado]';
  }
}

/**
 * Procesar imagen a texto usando Vision
 * @param {string} base64 - Imagen en base64
 * @param {string} caption - Caption opcional de la imagen
 * @param {object} context - Contexto para logging/notificaciones
 * @returns {Promise<string>} - Texto formateado: "descripcion imagen: {descripción}"
 */
async function processImageToText(base64, caption = '', context = {}) {
  try {
    logger.info('🖼️ Analyzing image with Vision', {
      size: base64.length,
      hasCaption: !!caption,
      ...context
    });

    const description = await openaiAPI.analyzeImage(base64);

    logger.info('✅ Image analyzed', {
      descriptionLength: description.length,
      hasCaption: !!caption,
      ...context
    });

    const captionSuffix = caption ? ` - ${caption}` : '';
    return `descripcion imagen: ${description}${captionSuffix}`;

  } catch (error) {
    logger.error('❌ Failed to analyze image', {
      error: error.message,
      hasCaption: !!caption,
      ...context
    });

    // Notificar al admin del fallo de OpenAI
    await notifyAdmin('OpenAI Image Processing Failed', {
      error: error.message,
      stack: error.stack,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      ...context
    });

    // Fallback (incluir caption si existe)
    const captionSuffix = caption ? ` - ${caption}` : '';
    return `🖼️ [imagen no procesada]${captionSuffix}`;
  }
}

/**
 * Formatear otros tipos de mensajes (video, documento, etc.)
 * @param {string} type - Tipo de mensaje
 * @param {object} data - Datos adicionales (caption, fileName, etc.)
 * @returns {string} - Texto formateado
 */
function formatOtherMediaType(type, data = {}) {
  const { caption, fileName, name, lat, lng, displayName } = data;

  switch (type) {
    case 'video':
      return `🎥 [video]${caption ? ' - ' + caption : ''} - Ver más en WhatsApp`;

    case 'document':
      const docName = fileName || 'documento';
      return `📎 [${docName}]${caption ? ' - ' + caption : ''} - Ver más en WhatsApp`;

    case 'location':
      const locationName = name ? ': ' + name : '';
      const coords = lat && lng ? ` (${lat}, ${lng})` : '';
      return `📍 [ubicación]${locationName}${coords} - Ver más en WhatsApp`;

    case 'contact':
      const contactName = displayName || 'contacto';
      return `👤 [contacto: ${contactName}] - Ver más en WhatsApp`;

    case 'sticker':
      return '😊 [sticker]';

    default:
      return `📎 [${type}] - Ver más en WhatsApp`;
  }
}

module.exports = {
  processAudioToText,
  processImageToText,
  formatOtherMediaType
};
