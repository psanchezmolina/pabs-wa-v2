/**
 * Cache Service - Cachea tokens GHL y contactIds/conversationIds
 */

const NodeCache = require('node-cache');

// Cache de tokens GHL (1 hora TTL)
const tokenCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
  useClones: false
});

// Cache de contactId por teléfono (1 hora TTL)
const contactCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
  useClones: false
});

// Cache de conversationId por contactId (1 hora TTL)
const conversationCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
  useClones: false
});

// ============= TOKENS GHL =============

function getCachedToken(locationId) {
  return tokenCache.get(`token:${locationId}`);
}

function setCachedToken(locationId, accessToken, expiryTimestamp) {
  tokenCache.set(`token:${locationId}`, {
    access_token: accessToken,
    expiry: expiryTimestamp
  });
}

function invalidateToken(locationId) {
  tokenCache.del(`token:${locationId}`);
}

// ============= CONTACTOS =============

function getCachedContactId(locationId, phone) {
  const key = `contact:${locationId}:${phone}`;
  return contactCache.get(key);
}

function setCachedContactId(locationId, phone, contactId) {
  const key = `contact:${locationId}:${phone}`;
  contactCache.set(key, contactId);
}

// ============= CONVERSACIONES =============

function getCachedConversationId(locationId, contactId) {
  const key = `conv:${locationId}:${contactId}`;
  return conversationCache.get(key);
}

function setCachedConversationId(locationId, contactId, conversationId) {
  const key = `conv:${locationId}:${contactId}`;
  conversationCache.set(key, conversationId);
}

module.exports = {
  // Tokens
  getCachedToken,
  setCachedToken,
  invalidateToken,
  // Contactos
  getCachedContactId,
  setCachedContactId,
  // Conversaciones
  getCachedConversationId,
  setCachedConversationId
};
