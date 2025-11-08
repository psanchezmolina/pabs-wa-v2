const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

async function getClientByLocationId(locationId) {
  const { data, error } = await supabase
    .from('clients_details')
    .select('*')
    .eq('location_id', locationId)
    .single();
  
  if (error) {
    logger.error('Error getting client by location_id', { locationId, error: error.message });
    throw new Error(`Client not found: ${locationId}`);
  }
  
  return data;
}

async function getClientByInstanceName(instanceName) {
  const { data, error } = await supabase
    .from('clients_details')
    .select('*')
    .eq('instance_name', instanceName)
    .single();
  
  if (error) {
    logger.error('Error getting client by instance_name', { instanceName, error: error.message });
    throw new Error(`Client not found: ${instanceName}`);
  }
  
  return data;
}

async function updateGHLTokens(locationId, accessToken, refreshToken, expiresIn) {
  const expiryDate = new Date(Date.now() + expiresIn * 1000);
  
  const { error } = await supabase
    .from('clients_details')
    .update({
      ghl_access_token: accessToken,
      ghl_refresh_token: refreshToken,
      ghl_token_expiry: expiryDate.toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('location_id', locationId);
  
  if (error) {
    logger.error('Error updating GHL tokens', { locationId, error: error.message });
    throw error;
  }
  
  logger.info('GHL tokens updated', { locationId });
}

module.exports = {
  getClientByLocationId,
  getClientByInstanceName,
  updateGHLTokens
};