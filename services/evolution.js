const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

async function sendText(instanceName, apiKey, number, text) {
  const delay = Math.min(Math.max(text.length * 50, 2000), 10000);
  
  const response = await withRetry(() => 
    axios.post(
      `${config.EVOLUTION_BASE_URL}/message/sendText/${instanceName}`,
      {
        number,
        text,
        delay
      },
      {
        headers: {
          'apikey': apiKey,
          'Content-Type': 'application/json'
        }
      }
    )
  );
  
  return response.data;
}

/**
 * Verifica el estado de conexión de una instancia
 * @returns {Object} { connected: boolean, state: string, error: string|null }
 */
async function checkInstanceConnection(instanceName, apiKey) {
  try {
    const response = await axios.get(
      `${config.EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`,
      {
        headers: { apikey: apiKey },
        timeout: 5000
      }
    );

    const state = response.data?.instance?.state || response.data?.state;

    return {
      connected: state === 'open',
      state: state || 'unknown',
      error: null
    };
  } catch (error) {
    // Distinguir entre API caída vs instancia no encontrada
    const isApiDown = error.code === 'ECONNREFUSED' ||
                      error.code === 'ETIMEDOUT' ||
                      error.code === 'ENOTFOUND';

    logger.error('Failed to check instance connection', {
      instanceName,
      error: error.message,
      status: error.response?.status,
      isApiDown
    });

    return {
      connected: false,
      state: isApiDown ? 'api_unreachable' : 'error',
      error: error.message
    };
  }
}

/**
 * Verifica si un número tiene WhatsApp
 * @returns {boolean|null} true = tiene WA, false = no tiene WA, null = no se pudo verificar
 */
async function checkWhatsAppNumber(instanceName, apiKey, phone) {
  const cleanPhone = phone.replace(/^\+/, '');

  try {
    const response = await withRetry(() =>
      axios.post(
        `${config.EVOLUTION_BASE_URL}/chat/whatsappNumbers/${instanceName}`,
        {
          numbers: [cleanPhone]
        },
        {
          headers: {
            'apikey': apiKey,
            'Content-Type': 'application/json'
          }
        }
      )
    );

    // Verificar si el número tiene WhatsApp
    const result = response.data?.message?.[0];
    const hasWhatsApp = result?.exists === true;

    logger.info('WhatsApp number check', {
      phone: cleanPhone,
      exists: hasWhatsApp,
      rawResult: result
    });

    return hasWhatsApp;
  } catch (error) {
    logger.warn('Failed to check WhatsApp number', {
      phone,
      error: error.message,
      status: error.response?.status
    });

    // Retornar null para indicar que no se pudo verificar (vs false = no tiene WA)
    return null;
  }
}

/**
 * Reinicia una instancia usando credenciales de sesión existentes
 * @returns {Object} { success: boolean, state: string, needsQR: boolean, error: string|null }
 */
async function restartInstance(instanceName, apiKey) {
  try {
    const response = await axios.put(
      `${config.EVOLUTION_BASE_URL}/instance/restart/${instanceName}`,
      {},
      {
        headers: { apikey: apiKey },
        timeout: 15000 // Más tiempo porque restart puede tardar
      }
    );

    const state = response.data?.instance?.state || response.data?.state;
    const success = state === 'open';

    logger.info('Instance restart attempt', {
      instanceName,
      state,
      success
    });

    return {
      success,
      state: state || 'unknown',
      needsQR: !success && state !== 'connecting',
      error: null
    };
  } catch (error) {
    logger.error('Failed to restart instance', {
      instanceName,
      error: error.message,
      status: error.response?.status
    });

    return {
      success: false,
      state: 'error',
      needsQR: true,
      error: error.message
    };
  }
}

async function getMediaBase64(instanceName, apiKey, messageId) {
  const response = await withRetry(() =>
    axios.post(
      `${config.EVOLUTION_BASE_URL}/chat/getBase64FromMediaMessage/${instanceName}`,
      {
        message: {
          key: {
            id: messageId
          }
        },
        convertToMp4: false
      },
      {
        headers: {
          'apikey': apiKey,
          'Content-Type': 'application/json'
        }
      }
    )
  );

  return response.data;
}

/**
 * Conecta una instancia generando QR code o pairing code
 * @param {string} instanceName - Nombre de la instancia
 * @param {string} apiKey - API key de la instancia
 * @param {string|null} phoneNumber - Número de teléfono sin + para pairing code (opcional)
 * @returns {Object} { base64?, pairingCode?, code? }
 */
async function connectInstance(instanceName, apiKey, phoneNumber = null) {
  try {
    const url = phoneNumber
      ? `${config.EVOLUTION_BASE_URL}/instance/connect/${instanceName}?number=${phoneNumber}`
      : `${config.EVOLUTION_BASE_URL}/instance/connect/${instanceName}`;

    const response = await axios.get(url, {
      headers: { apikey: apiKey },
      timeout: 15000
    });

    logger.info('Instance connect request', {
      instanceName,
      method: phoneNumber ? 'pairing' : 'qr',
      hasBase64: !!response.data?.base64,
      hasPairingCode: !!response.data?.pairingCode
    });

    return response.data; // { base64?, pairingCode?, code?, count? }
  } catch (error) {
    logger.error('Failed to connect instance', {
      instanceName,
      method: phoneNumber ? 'pairing' : 'qr',
      error: error.message,
      status: error.response?.status
    });
    throw error;
  }
}

/**
 * Obtiene el estado de conexión de una instancia (formato crudo para panel)
 * @param {string} instanceName - Nombre de la instancia
 * @param {string} apiKey - API key de la instancia
 * @returns {Object} { instance: { instanceName, state } }
 */
async function getConnectionState(instanceName, apiKey) {
  try {
    const response = await axios.get(
      `${config.EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`,
      {
        headers: { apikey: apiKey },
        timeout: 5000
      }
    );

    return response.data; // { instance: { instanceName, state } }
  } catch (error) {
    logger.error('Failed to get connection state', {
      instanceName,
      error: error.message,
      status: error.response?.status
    });
    throw error;
  }
}

/**
 * Obtiene información completa de una instancia (incluyendo número conectado)
 * @param {string} instanceName - Nombre de la instancia
 * @param {string} apiKey - API key de la instancia
 * @returns {Object} Información completa de la instancia
 */
async function getInstanceInfo(instanceName, apiKey) {
  try {
    const response = await axios.get(
      `${config.EVOLUTION_BASE_URL}/instance/fetchInstances/${instanceName}`,
      {
        headers: { apikey: apiKey },
        timeout: 5000
      }
    );

    // Response incluye: instance.instanceName, instance.owner, instance.profileName,
    // instance.profilePictureUrl, instance.profileStatus, instance.state,
    // instance.number (el número conectado en formato 34660722687@s.whatsapp.net)
    return response.data;
  } catch (error) {
    logger.error('Failed to get instance info', {
      instanceName,
      error: error.message,
      status: error.response?.status
    });
    throw error;
  }
}

module.exports = {
  sendText,
  checkInstanceConnection,
  checkWhatsAppNumber,
  restartInstance,
  getMediaBase64,
  connectInstance,
  getConnectionState,
  getInstanceInfo
};