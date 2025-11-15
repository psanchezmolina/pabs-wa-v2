const axios = require('axios');
const NodeCache = require('node-cache');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { notifyAdmin } = require('../utils/notifications');

// Caché de prompts (1 hora TTL)
const promptCache = new NodeCache({
  stdTTL: 3600,  // 1 hora
  checkperiod: 600,
  useClones: false
});

/**
 * Obtener prompt de Langfuse por nombre
 * @param {string} agentName - Nombre del agente (ej: "agente-roi")
 * @param {string} publicKey - Langfuse Public Key del cliente (pk-lf-...)
 * @param {string} secretKey - Langfuse Secret Key del cliente (sk-lf-...)
 * @returns {Promise<string>} - Texto del prompt
 */
async function getPrompt(agentName, publicKey, secretKey) {
  // Validar que Langfuse esté configurado
  if (!config.LANGFUSE_BASE_URL || !publicKey || !secretKey) {
    const error = new Error('Langfuse not configured. Missing LANGFUSE_BASE_URL or client API keys');
    logger.error('❌ Langfuse configuration missing', { agentName, hasPublicKey: !!publicKey, hasSecretKey: !!secretKey });
    throw error;
  }

  // Verificar caché primero (usar clave combinada para evitar conflictos entre clientes)
  const cacheKey = `${publicKey}:${agentName}`;
  const cached = promptCache.get(cacheKey);
  if (cached) {
    logger.debug('Prompt found in cache', { agentName, cacheKey });
    return cached;
  }

  logger.info('Fetching prompt from Langfuse', { agentName });

  try {
    const response = await withRetry(() =>
      axios.get(
        `${config.LANGFUSE_BASE_URL}/api/public/v2/prompts/${agentName}`,
        {
          auth: {
            username: publicKey,
            password: secretKey
          },
          headers: {
            'Accept': 'application/json'
          }
        }
      )
    );

    const promptText = response.data.prompt;

    if (!promptText) {
      throw new Error('Prompt text is empty or missing');
    }

    // Cachear prompt con clave combinada (evita conflictos entre clientes)
    const cacheKey = `${publicKey}:${agentName}`;
    promptCache.set(cacheKey, promptText);

    logger.info('✅ Prompt fetched from Langfuse', {
      agentName,
      version: response.data.version,
      promptLength: promptText.length
    });

    return promptText;

  } catch (error) {
    logger.error('❌ Failed to fetch prompt from Langfuse', {
      agentName,
      error: error.message,
      stack: error.stack,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });

    await notifyAdmin('Langfuse Prompt Fetch Failed', {
      agentName,
      error: error.message,
      stack: error.stack,
      endpoint: `${config.LANGFUSE_BASE_URL}/api/public/v2/prompts/${agentName}`,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });

    throw error;
  }
}

/**
 * Invalidar caché de un prompt específico
 * @param {string} agentName
 */
function invalidatePrompt(agentName) {
  promptCache.del(agentName);
  logger.debug('Prompt cache invalidated', { agentName });
}

/**
 * Limpiar todo el caché de prompts
 */
function clearCache() {
  promptCache.flushAll();
  logger.debug('All prompts cache cleared');
}

module.exports = {
  getPrompt,
  invalidatePrompt,
  clearCache
};
