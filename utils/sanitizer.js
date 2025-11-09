/**
 * Sanitizer - Redacta datos sensibles en logs
 */

const SENSITIVE_FIELDS = [
  'ghl_access_token', 'ghl_refresh_token', 'instance_apikey',
  'authorization', 'apikey', 'password', 'secret', 'token',
  'access_token', 'refresh_token', 'client_secret',
  'OPENAI_API_KEY', 'SUPABASE_KEY', 'ADMIN_INSTANCE_APIKEY'
];

/**
 * Sanitiza un objeto redactando campos sensibles
 */
function sanitizeObject(obj, depth = 0) {
  if (depth > 10) return '[Max depth reached]';
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();

    // Redactar campos sensibles
    if (SENSITIVE_FIELDS.some(field => keyLower.includes(field.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Sanitiza headers HTTP
 */
function sanitizeHeaders(headers) {
  if (!headers) return {};
  const sanitized = { ...headers };
  if (sanitized.authorization) sanitized.authorization = '[REDACTED]';
  if (sanitized.apikey) sanitized.apikey = '[REDACTED]';
  if (sanitized['x-api-key']) sanitized['x-api-key'] = '[REDACTED]';
  return sanitized;
}

module.exports = { sanitizeObject, sanitizeHeaders };
