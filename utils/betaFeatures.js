const logger = require('./logger');

/**
 * Check if a client is enrolled in beta program
 *
 * @param {Object} client - Client object from Supabase
 * @returns {boolean} - True if client is in beta
 *
 * @example
 * const client = await getClientByLocationId(locationId);
 * if (isBetaClient(client)) {
 *   // Execute beta-only logic
 * }
 */
function isBetaClient(client) {
  if (!client) {
    logger.warn('isBetaClient called with null/undefined client');
    return false;
  }

  return client.is_beta === true;
}

/**
 * Execute different logic based on beta status
 *
 * @param {Object} client - Client object from Supabase
 * @param {Function} betaFn - Function to execute for beta clients
 * @param {Function} prodFn - Function to execute for production clients
 * @returns {*} - Result from executed function
 *
 * @example
 * const result = await executeBetaAware(
 *   client,
 *   async () => await newBetaFeature(),
 *   async () => await currentProductionFeature()
 * );
 */
async function executeBetaAware(client, betaFn, prodFn) {
  const isBeta = isBetaClient(client);

  logger.info('Executing beta-aware logic', {
    locationId: client?.location_id,
    instanceName: client?.instance_name,
    isBeta
  });

  return isBeta ? await betaFn() : await prodFn();
}

/**
 * Log when beta feature is used (only logs for beta clients)
 *
 * @param {Object} client - Client object from Supabase
 * @param {string} featureName - Name of the beta feature
 * @param {Object} metadata - Additional metadata to log
 *
 * @example
 * logBetaUsage(client, 'new-audio-transcription', { model: 'whisper-v2' });
 */
function logBetaUsage(client, featureName, metadata = {}) {
  if (isBetaClient(client)) {
    logger.info('Beta feature used', {
      feature: featureName,
      locationId: client?.location_id,
      instanceName: client?.instance_name,
      ...metadata
    });
  }
}

module.exports = {
  isBetaClient,
  executeBetaAware,
  logBetaUsage
};
