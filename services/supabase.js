const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

async function getClientByLocationId(locationId) {
  // Primero intentar sin .single() para ver cuántos registros hay
  const { data: allData, error: queryError } = await supabase
    .from('clients_details')
    .select('*')
    .eq('location_id', locationId);

  if (queryError) {
    logger.error('Error querying client by location_id', { locationId, error: queryError.message });
    throw new Error(`Database error: ${queryError.message}`);
  }

  logger.info('Query result for location_id', {
    locationId,
    count: allData?.length || 0,
    found: allData?.length > 0
  });

  if (!allData || allData.length === 0) {
    throw new Error(`Client not found: ${locationId}`);
  }

  if (allData.length > 1) {
    logger.warn('Multiple clients found for location_id', {
      locationId,
      count: allData.length
    });
  }

  // Retornar el primero
  return allData[0];
}

async function getClientByInstanceName(instanceName) {
  // Primero intentar sin .single() para ver cuántos registros hay
  const { data: allData, error: queryError } = await supabase
    .from('clients_details')
    .select('*')
    .eq('instance_name', instanceName);

  if (queryError) {
    logger.error('Error querying client by instance_name', { instanceName, error: queryError.message });
    throw new Error(`Database error: ${queryError.message}`);
  }

  logger.info('Query result for instance_name', {
    instanceName,
    count: allData?.length || 0,
    found: allData?.length > 0
  });

  if (!allData || allData.length === 0) {
    throw new Error(`Client not found: ${instanceName}`);
  }

  if (allData.length > 1) {
    logger.warn('Multiple clients found for instance_name', {
      instanceName,
      count: allData.length
    });
  }

  // Retornar el primero
  return allData[0];
}

async function updateGHLTokens(locationId, accessToken, refreshToken, expiresIn) {
  const expiryDate = new Date(Date.now() + expiresIn * 1000);

  logger.info('Attempting to update GHL tokens', {
    locationId,
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    expiresIn,
    expiryDate: expiryDate.toISOString()
  });

  const { data, error } = await supabase
    .from('clients_details')
    .update({
      ghl_access_token: accessToken,
      ghl_refresh_token: refreshToken,
      ghl_token_expiry: expiryDate.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('location_id', locationId)
    .select();

  if (error) {
    logger.error('Error updating GHL tokens', { locationId, error: error.message, details: error });
    throw error;
  }

  logger.info('GHL tokens updated successfully', {
    locationId,
    rowsAffected: data?.length || 0,
    updated: data?.length > 0
  });

  if (!data || data.length === 0) {
    logger.warn('No rows updated - location_id not found', { locationId });
    throw new Error(`No client found with location_id: ${locationId}`);
  }
}

module.exports = {
  getClientByLocationId,
  getClientByInstanceName,
  updateGHLTokens
};