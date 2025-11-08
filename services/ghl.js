const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { updateGHLTokens } = require('./supabase');
const { withRetry } = require('../utils/retry');
const { notifyAdmin } = require('../utils/notifications');

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

// Refresh token si está expirado
async function ensureValidToken(client) {
  const now = new Date();
  const expiry = new Date(client.ghl_token_expiry);
  
  // Si token válido por más de 5 minutos, usar actual
  if (expiry > new Date(now.getTime() + 5 * 60 * 1000)) {
    return client.ghl_access_token;
  }
  
  logger.info('Refreshing GHL token', { location_id: client.location_id });
  
  try {
    const response = await axios.post('https://services.leadconnectorhq.com/oauth/token', {
      client_id: config.GHL_CLIENT_ID,
      client_secret: config.GHL_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: client.ghl_refresh_token
    });
    
    const { access_token, refresh_token, expires_in } = response.data;
    
    await updateGHLTokens(client.location_id, access_token, refresh_token, expires_in);
    
    return access_token;
  } catch (error) {
    logger.error('Failed to refresh GHL token', { 
      location_id: client.location_id, 
      error: error.message 
    });
    
    await notifyAdmin('GHL Token Refresh Failed', {
      location_id: client.location_id,
      error: error.message
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

  return withRetry(() => axios(requestConfig));
}

// Funciones específicas GHL
async function getContact(client, contactId) {
  const response = await ghlRequest(client, 'GET', `/contacts/${contactId}`);
  return response.data.contact;
}

async function searchContact(client, phone) {
  const cleanPhone = phone.replace(/\D+/g, '');
  
  const response = await ghlRequest(client, 'POST', '/contacts/search', {
    locationId: client.location_id,
    pageLimit: 20,
    filters: [{
      field: 'phone',
      operator: 'eq',
      value: cleanPhone
    }]
  });
  
  return response.data;
}

async function createContact(client, name, phone) {
  const response = await ghlRequest(client, 'POST', '/contacts/', {
    locationId: client.location_id,
    name,
    phone,
    source: 'SMS'
  });
  
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

async function sendInboundMessage(client, conversationId, contactId, message) {
  await ghlRequest(client, 'POST', '/conversations/messages/inbound', {
    type: 'SMS',
    message,
    conversationId,
    direction: 'inbound',
    conversationProviderId: client.conversation_provider_id,
    contactId,
    locationId: client.location_id
  });
}

async function updateMessageStatus(client, messageId, status, errorMessage = null) {
  const payload = { status };

  // Solo incluir error si el status es de fallo
  if (status !== 'delivered' && status !== 'read' && errorMessage) {
    payload.error = {
      code: '1',
      type: 'saas',
      message: errorMessage || 'There was an error from the provider'
    };
  }

  await ghlRequest(client, 'PUT', `/conversations/messages/${messageId}/status`, payload);
}

module.exports = {
  getContact,
  searchContact,
  createContact,
  searchConversation,
  createConversation,
  sendInboundMessage,
  updateMessageStatus
};