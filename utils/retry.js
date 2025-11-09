const axiosRetry = require('axios-retry');
const axios = require('axios');

// Configurar timeout global (15 segundos)
axios.defaults.timeout = 15000;

// Configurar axios-retry globalmente
axiosRetry(axios, {
  retries: 4,
  retryDelay: () => 800,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
           (error.response && error.response.status >= 500);
  }
});

// Wrapper para funciones async con reintentos
async function withRetry(fn, retries = 4, delay = 800) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

module.exports = { withRetry };