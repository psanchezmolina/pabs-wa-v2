const axios = require('axios');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { notifyAdmin } = require('../utils/notifications');

/**
 * Llamar al agente de Flowise
 * @param {object} agentConfig - Configuración del agente de BD
 * @param {string} question - Mensaje concatenado del usuario
 * @param {string} sessionId - ID de sesión único
 * @param {object} overrideConfig - Configuración con startState
 * @returns {Promise<object>} - Respuesta de Flowise
 */
async function callFlowiseAgent(agentConfig, question, sessionId, overrideConfig) {
  const { flowise_webhook_url, flowise_api_key, agent_name } = agentConfig;

  const payload = {
    question,
    overrideConfig
  };

  const headers = {
    'Content-Type': 'application/json'
  };

  if (flowise_api_key) {
    headers['Authorization'] = flowise_api_key;
  }

  logger.info('🔄 Calling Flowise agent', {
    agentName: agent_name,
    sessionId,
    questionLength: question.length,
    startStateFields: overrideConfig.startState?.length || 0
  });

  try {
    const response = await withRetry(() =>
      axios.post(flowise_webhook_url, payload, {
        headers,
        timeout: 15000  // 15 segundos
      })
    );

    logger.info('✅ Flowise agent responded', {
      agentName: agent_name,
      sessionId,
      responseSize: JSON.stringify(response.data).length
    });

    return response.data;

  } catch (error) {
    logger.error('❌ Flowise agent call failed', {
      agentName: agent_name,
      sessionId,
      error: error.message,
      stack: error.stack,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });

    await notifyAdmin('Flowise Agent Call Failed', {
      agentName: agent_name,
      sessionId,
      error: error.message,
      stack: error.stack,
      endpoint: flowise_webhook_url,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      payload: {
        question: question.substring(0, 200),
        startStateKeys: overrideConfig.startState?.map(s => s.key)
      }
    });

    throw error;
  }
}

/**
 * Parser robusto de respuesta de Flowise
 * Niveles de fallback:
 * 1. Parse directo del JSON
 * 2. Limpiar y parsear
 * 3. Fallback: enviar todo como parte1
 *
 * @param {object|array} flowiseData - Respuesta de Flowise
 * @returns {object} - { parte1, parte2, parte3 }
 */
function parseFlowiseResponse(flowiseData) {
  // Flowise devuelve array, tomamos primer elemento
  const firstResult = Array.isArray(flowiseData) ? flowiseData[0] : flowiseData;
  const text = firstResult?.text;

  if (!text) {
    logger.warn('⚠️ Flowise response has no text field', { flowiseData });
    return {
      parte1: 'Error: respuesta vacía del agente',
      parte2: null,
      parte3: null
    };
  }

  // Nivel 1: Parse directo
  try {
    const parsed = JSON.parse(text);
    logger.debug('✅ Flowise response parsed (level 1)', {
      hasParte1: !!parsed.parte1,
      hasParte2: !!parsed.parte2,
      hasParte3: !!parsed.parte3
    });

    return {
      parte1: parsed.parte1 || null,
      parte2: parsed.parte2 || null,
      parte3: parsed.parte3 || null
    };
  } catch (e1) {
    logger.debug('Parse attempt 1 failed, trying cleanup...', { error: e1.message });
  }

  // Nivel 2: Limpiar y parsear
  try {
    // Remover caracteres problemáticos
    let cleaned = text
      .replace(/\n/g, '')  // Remover saltos de línea
      .replace(/\r/g, '')  // Remover retornos de carro
      .trim();

    // Intentar arreglar JSON malformado común
    // Caso: "parte2": "texto\",\"parte3\":null}" → arreglar comillas escapadas mal
    cleaned = cleaned.replace(/\\"/g, '"');  // Desescapar comillas dobles
    cleaned = cleaned.replace(/"\s*,\s*"/g, '","');  // Arreglar espacios entre comillas

    const parsed = JSON.parse(cleaned);
    logger.debug('✅ Flowise response parsed (level 2 - cleaned)', {
      hasParte1: !!parsed.parte1,
      hasParte2: !!parsed.parte2,
      hasParte3: !!parsed.parte3
    });

    return {
      parte1: parsed.parte1 || null,
      parte2: parsed.parte2 || null,
      parte3: parsed.parte3 || null
    };
  } catch (e2) {
    logger.debug('Parse attempt 2 failed, using fallback...', { error: e2.message });
  }

  // Nivel 3: Fallback - enviar todo como parte1
  logger.warn('⚠️ Failed to parse Flowise response, using fallback', {
    textPreview: text.substring(0, 200),
    error: 'JSON parse failed at all levels'
  });

  notifyAdmin('Flowise Response Parse Failed (Using Fallback)', {
    textPreview: text.substring(0, 500),
    error: 'Could not parse JSON after cleanup, using entire text as parte1'
  }).catch(err => {
    logger.error('Failed to send admin notification', { error: err.message });
  });

  return {
    parte1: text,
    parte2: null,
    parte3: null
  };
}

module.exports = {
  callFlowiseAgent,
  parseFlowiseResponse
};
