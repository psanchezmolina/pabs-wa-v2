const config = require('../config');
const logger = require('./logger');

async function notifyAdmin(errorType, details) {
  try {
    const evolutionAPI = require('../services/evolution');
    
    const message = `
🚨 ERROR EN SERVIDOR
Tipo: ${errorType}
Cliente: ${details.location_id || details.instance_name || 'N/A'}
Error: ${details.error}
Timestamp: ${new Date().toISOString()}
    `.trim();
    
    await evolutionAPI.sendText(
      config.ADMIN_INSTANCE,
      config.ADMIN_INSTANCE_APIKEY, 
      config.ADMIN_WHATSAPP,
      message
    );
    
    logger.info('Admin notified', { errorType });
  } catch (error) {
    logger.error('Failed to notify admin', { error: error.message });
  }
}

module.exports = { notifyAdmin };