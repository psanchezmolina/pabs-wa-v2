const axios = require('axios');
const config = require('../config');
const logger = require('./logger');
const { notifyAdmin } = require('./notifications');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

// ============================================================================
// INSTANCE MONITOR - Verifica estado de conexión de todas las instancias
// ============================================================================

// Tracking de estados previos para notificar solo en cambios
const previousStates = new Map(); // Key: instanceName, Value: { connected: boolean, timestamp: Date }

async function checkInstanceConnection(instanceName, apiKey) {
  try {
    const response = await axios.get(
      `${config.EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`,
      {
        headers: { apikey: apiKey },
        timeout: 5000
      }
    );

    // El estado viene en response.data.instance.state o response.data.state
    const state = response.data?.instance?.state || response.data?.state;

    return {
      instanceName,
      connected: state === 'open',
      state: state || 'unknown',
      error: null
    };

  } catch (error) {
    logger.error('Failed to check instance connection', {
      instanceName,
      error: error.message,
      status: error.response?.status
    });

    return {
      instanceName,
      connected: false,
      state: 'error',
      error: error.message
    };
  }
}

async function checkAllInstances() {
  logger.info('🔍 Starting instance connection check...');

  try {
    // Obtener todas las instancias únicas de la BD
    const { data: instances, error } = await supabase
      .from('clients_details')
      .select('instance_name, instance_apikey, location_id')
      .not('instance_name', 'is', null)
      .not('instance_apikey', 'is', null);

    if (error) {
      logger.error('Failed to fetch instances from database', { error: error.message });
      return;
    }

    if (!instances || instances.length === 0) {
      logger.warn('No instances found in database');
      return;
    }

    // Agrupar por instance_name (puede haber múltiples location_ids por instancia)
    const uniqueInstances = new Map();
    instances.forEach(inst => {
      if (!uniqueInstances.has(inst.instance_name)) {
        uniqueInstances.set(inst.instance_name, {
          apiKey: inst.instance_apikey,
          locationIds: []
        });
      }
      uniqueInstances.get(inst.instance_name).locationIds.push(inst.location_id);
    });

    logger.info('Checking instances', {
      total: uniqueInstances.size,
      instances: Array.from(uniqueInstances.keys())
    });

    // Verificar cada instancia
    const results = await Promise.all(
      Array.from(uniqueInstances.entries()).map(([name, data]) =>
        checkInstanceConnection(name, data.apiKey)
      )
    );

    // Detectar CAMBIOS de estado (no solo desconectados)
    const newlyDisconnected = [];
    const reconnected = [];

    results.forEach(result => {
      const previous = previousStates.get(result.instanceName);

      if (!previous) {
        // Primera vez que checkeamos esta instancia
        previousStates.set(result.instanceName, {
          connected: result.connected,
          timestamp: new Date()
        });

        // Si está desconectada desde el inicio, notificar
        if (!result.connected) {
          newlyDisconnected.push({ ...result, locationIds: uniqueInstances.get(result.instanceName).locationIds });
        }
      } else {
        // Ya la habíamos checkeado antes
        if (previous.connected && !result.connected) {
          // Se acaba de desconectar
          newlyDisconnected.push({ ...result, locationIds: uniqueInstances.get(result.instanceName).locationIds });
        } else if (!previous.connected && result.connected) {
          // Se reconectó
          reconnected.push({ ...result, locationIds: uniqueInstances.get(result.instanceName).locationIds });
        }

        // Actualizar estado
        previousStates.set(result.instanceName, {
          connected: result.connected,
          timestamp: new Date()
        });
      }
    });

    const connected = results.filter(r => r.connected);
    const disconnected = results.filter(r => !r.connected);

    logger.info('Instance check completed', {
      total: results.length,
      connected: connected.length,
      disconnected: disconnected.length,
      newlyDisconnected: newlyDisconnected.length,
      reconnected: reconnected.length
    });

    // Notificar solo NUEVAS desconexiones
    if (newlyDisconnected.length > 0) {
      await notifyAdmin('Instancias WhatsApp Desconectadas', {
        error: `${newlyDisconnected.length} instancia(s) desconectada(s)`,
        endpoint: 'Instance Monitor',
        instance_name: newlyDisconnected.map(d => d.instanceName).join(', '),
        details: formatDisconnectedAlert(newlyDisconnected)
      });
    }

    // Notificar reconexiones (buenas noticias)
    if (reconnected.length > 0) {
      await notifyAdmin('Instancias WhatsApp Reconectadas', {
        error: `${reconnected.length} instancia(s) reconectada(s)`,
        endpoint: 'Instance Monitor',
        instance_name: reconnected.map(r => r.instanceName).join(', '),
        details: formatReconnectedAlert(reconnected)
      });
    }

    return {
      total: results.length,
      connected: connected.length,
      disconnected: disconnected.length,
      newlyDisconnected: newlyDisconnected.length,
      reconnected: reconnected.length,
      results
    };

  } catch (error) {
    logger.error('Instance monitor error', {
      error: error.message,
      stack: error.stack
    });

    await notifyAdmin('Error en Instance Monitor', {
      error: error.message,
      stack: error.stack,
      endpoint: 'Instance Monitor',
      // Datos de API si es error de axios
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data
    });
  }
}

function formatDisconnectedAlert(disconnected) {
  let message = '⚠️ *Instancias Desconectadas* ⚠️\n\n';

  disconnected.forEach(inst => {
    message += `*${inst.instanceName}*\n`;
    message += `Estado: ${inst.state}\n`;
    message += `Clientes afectados: ${inst.locationIds.length}\n`;
    if (inst.error) {
      message += `Error: ${inst.error}\n`;
    }
    message += '\n';
  });

  return message;
}

function formatReconnectedAlert(reconnected) {
  let message = '✅ *Instancias Reconectadas* ✅\n\n';

  reconnected.forEach(inst => {
    message += `*${inst.instanceName}*\n`;
    message += `Estado: ${inst.state}\n`;
    message += `Clientes: ${inst.locationIds.length}\n\n`;
  });

  return message;
}

// ============================================================================
// SCHEDULER - Ejecutar cada X horas
// ============================================================================

function startMonitoring(intervalHours = 4) {
  logger.info(`🔄 Instance monitor started (interval: ${intervalHours}h)`);

  // Ejecutar inmediatamente al iniciar
  checkAllInstances();

  // Luego cada X horas
  const intervalMs = intervalHours * 60 * 60 * 1000;
  setInterval(() => {
    checkAllInstances();
  }, intervalMs);
}

module.exports = {
  checkAllInstances,
  checkInstanceConnection,
  startMonitoring
};
