/**
 * Webhook Authentication Middleware
 * Valida que los webhooks provengan de clientes configurados en BD (whitelist)
 */

const logger = require('../utils/logger');
const { getClientByLocationId, getClientByInstanceName } = require('../services/supabase');

/**
 * Middleware para validar webhook de GHL
 * Verifica que el locationId exista en BD
 */
async function validateGHLWebhook(req, res, next) {
  try {
    const locationId = req.body?.locationId;

    if (!locationId) {
      logger.warn('GHL webhook missing locationId', {
        ip: req.ip,
        body: req.body
      });
      return res.status(400).json({ error: 'Missing locationId' });
    }

    // Verificar que el locationId existe en BD (whitelist)
    const client = await getClientByLocationId(locationId);

    if (!client) {
      logger.warn('GHL webhook from unknown locationId (not in whitelist)', {
        locationId,
        ip: req.ip
      });
      return res.status(403).json({ error: 'Unauthorized locationId' });
    }

    // Cliente válido, continuar
    req.client = client; // Pasar cliente al handler (evitar consulta duplicada)
    next();

  } catch (error) {
    logger.error('Error validating GHL webhook', {
      error: error.message,
      locationId: req.body?.locationId
    });
    return res.status(500).json({ error: 'Validation error' });
  }
}

/**
 * Middleware para validar webhook de WhatsApp
 * Verifica que la instancia exista en BD
 */
async function validateWhatsAppWebhook(req, res, next) {
  try {
    const instance = req.body?.instance;

    if (!instance) {
      logger.warn('WhatsApp webhook missing instance', {
        ip: req.ip,
        event: req.body?.event
      });
      return res.status(400).json({ error: 'Missing instance' });
    }

    // Verificar que la instancia existe en BD (whitelist)
    const client = await getClientByInstanceName(instance);

    if (!client) {
      logger.warn('WhatsApp webhook from unknown instance (not in whitelist)', {
        instance,
        ip: req.ip,
        event: req.body?.event
      });
      return res.status(403).json({ error: 'Unauthorized instance' });
    }

    // Cliente válido, continuar
    req.client = client; // Pasar cliente al handler (evitar consulta duplicada)
    next();

  } catch (error) {
    logger.error('Error validating WhatsApp webhook', {
      error: error.message,
      instance: req.body?.instance
    });
    return res.status(500).json({ error: 'Validation error' });
  }
}

/**
 * Middleware para validar webhook del Agent System
 * Verifica que el locationId exista en BD y que is_beta esté activado
 */
async function validateAgentWhitelist(req, res, next) {
  try {
    const locationId = req.body?.location_id;

    if (!locationId) {
      logger.warn('Agent webhook missing location_id', {
        ip: req.ip,
        body: req.body
      });
      return res.status(400).json({ error: 'Missing location_id' });
    }

    // Verificar que el locationId existe en BD (whitelist)
    const client = await getClientByLocationId(locationId);

    if (!client) {
      logger.warn('Agent webhook from unknown location_id (not in whitelist)', {
        locationId,
        ip: req.ip
      });
      return res.status(403).json({ error: 'Unauthorized location_id' });
    }

    // Verificar que el cliente tiene is_beta activado
    if (!client.is_beta) {
      logger.warn('Agent webhook from non-beta client', {
        locationId,
        ip: req.ip
      });
      return res.status(403).json({ error: 'Agent feature not enabled for this location' });
    }

    // Cliente válido y beta activado, continuar
    req.client = client; // Pasar cliente al handler (evitar consulta duplicada)
    next();

  } catch (error) {
    logger.error('Error validating Agent webhook', {
      error: error.message,
      location_id: req.body?.location_id
    });
    return res.status(500).json({ error: 'Validation error' });
  }
}

module.exports = {
  validateGHLWebhook,
  validateWhatsAppWebhook,
  validateAgentWhitelist
};
