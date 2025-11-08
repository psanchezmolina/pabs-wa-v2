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
    
    return response.data;
  } catch (error) {
    logger.warn('Failed to check WhatsApp number', { phone, error: error.message });
    return null;
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

module.exports = {
  sendText,
  checkWhatsAppNumber,
  getMediaBase64
};