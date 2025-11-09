const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { updateGHLTokens } = require('./supabase');
const { withRetry } = require('../utils/retry');
const { notifyAdmin } = require('../utils/notifications');
const { getCachedToken, setCachedToken, invalidateToken } = require('./cache');

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

// Refresh token si está expirado
async function ensureValidToken(client) {
  const now = Date.now();

  // 1. Verificar caché primero
  const cached = getCachedToken(client.location_id);
  if (cached && cached.expiry > now + 5 * 60 * 1000) {
    return cached.access_token;
  }

  // 2. Verificar token del objeto client (viene de BD)
  const expiry = new Date(client.ghl_token_expiry);
  if (expiry > new Date(now + 5 * 60 * 1000)) {
    // Cachear token válido de BD
    setCachedToken(client.location_id, client.ghl_access_token, expiry.getTime());
    return client.ghl_access_token;
  }

  // 3. Necesita refresh
  logger.info('Refreshing GHL token', { location_id: client.location_id });

  try {
    // GHL requiere application/x-www-form-urlencoded según documentación
    const params = new URLSearchParams({
      client_id: config.GHL_CLIENT_ID,
      client_secret: config.GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: client.ghl_refresh_token,
      user_type: 'Company',
      redirect_uri: config.GHL_REDIRECT_URI
    });

    const response = await axios.post(
      'https://services.leadconnectorhq.com/oauth/token',
      params,
      {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    await updateGHLTokens(client.location_id, access_token, refresh_token, expires_in);

    // Actualizar caché con nuevo token
    const newExpiry = Date.now() + expires_in * 1000;
    setCachedToken(client.location_id, access_token, newExpiry);

    return access_token;
  } catch (error) {
    // Invalidar caché en caso de error
    invalidateToken(client.location_id);

    logger.error('Failed to refresh GHL token', {
      location_id: client.location_id,
      error: error.message
    });

    await notifyAdmin('GHL Token Refresh Failed', {
      location_id: client.location_id,
      error: error.message,
      stack: error.stack,
      endpoint: 'GHL OAuth Token Refresh',
      errorCode: error.response?.status,
      errorData: JSON.stringify(error.response?.data)
    });

    throw error;
  }
}

// Wrapper genérico para llamadas GHL con auto-refresh
async function ghlRequest(client, method, path, data = null) {
  const accessToken = await ensureValidToken(client);

  const requestConfig = {
    method,
    url: `${GHL_API_BASE}${path}`,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Version': '2021-07-28',
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  };

  if (data) {
    requestConfig.data = data;
  }

  try {
    return await withRetry(() => axios(requestConfig));
  } catch (error) {
    // No loguear errores 403 en update message status (esperados para mensajes no-provider)
    const isStatusUpdateError = path.includes('/messages/') && path.includes('/status') && error.response?.status === 403;

    if (!isStatusUpdateError) {
      logger.error('GHL API request failed', {
        method,
        path,
        data,
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
        message: error.message
      });
    }
    throw error;
  }
}

// Funciones específicas GHL
async function getContact(client, contactId) {
  const response = await ghlRequest(client, 'GET', `/contacts/${contactId}`);
  return response.data.contact;
}

async function searchContact(client, phone) {
  // NO limpiar el teléfono - buscar con el formato exacto que se pasa
  const response = await ghlRequest(client, 'POST', '/contacts/search', {
    locationId: client.location_id,
    pageLimit: 20,
    filters: [{
      field: 'phone',
      operator: 'eq',
      value: phone
    }]
  });

  return response.data;
}

async function createContact(client, name, phone) {
  const payload = {
    locationId: client.location_id,
    phone,
    source: 'SMS'
  };

  // Solo incluir name si existe y no está vacío
  if (name && name.trim() !== '') {
    payload.name = name.trim();
  }

  const response = await ghlRequest(client, 'POST', '/contacts/', payload);

  return response.data.contact;
}

async function searchConversation(client, contactId) {
  const params = new URLSearchParams({
    contactId,
    locationId: client.location_id
  });

  const response = await ghlRequest(
    client,
    'GET',
    `/conversations/search?${params.toString()}`
  );

  return response.data;
}

async function createConversation(client, contactId) {
  const response = await ghlRequest(client, 'POST', '/conversations/', {
    locationId: client.location_id,
    contactId
  });
  
  return response.data.conversation;
}

async function registerMessage(client, conversationId, contactId, message, direction) {
  await ghlRequest(client, 'POST', '/conversations/messages/inbound', {
    type: 'SMS',
    message,
    conversationId,
    direction,
    conversationProviderId: client.conversation_provider_id,
    contactId,
    locationId: client.location_id
  });
}

async function updateMessageStatus(client, messageId, status, errorMessage = null) {
  const payload = {
    status,
    conversationProviderId: client.conversation_provider_id
  };

  // Solo incluir error si el status es de fallo
  if (status !== 'delivered' && status !== 'read' && errorMessage) {
    payload.error = {
      code: '1',
      type: 'saas',
      message: errorMessage || 'There was an error from the provider'
    };
  }

  try {
    const response = await ghlRequest(client, 'PUT', `/conversations/messages/${messageId}/status`, payload);
    return response;
  } catch (error) {
    // No loguear aquí - se maneja en el webhook handler
    // Error 403 es esperado para mensajes no creados por el provider
    throw error;
  }
}

async function addTags(client, contactId, tags) {
  logger.info('Adding tags to contact', {
    contactId,
    tags,
    locationId: client.location_id
  });

  try {
    const response = await ghlRequest(client, 'POST', `/contacts/${contactId}/tags`, {
      tags
    });
    logger.info('Tags added successfully', {
      contactId,
      tags,
      responseStatus: response.status
    });
    return response;
  } catch (error) {
    logger.error('Failed to add tags', {
      contactId,
      tags,
      error: error.message,
      errorCode: error.response?.status,
      errorData: error.response?.data
    });
    throw error;
  }
}

module.exports = {
  getContact,
  searchContact,
  createContact,
  searchConversation,
  createConversation,
  registerMessage,
  updateMessageStatus,
  addTags
};