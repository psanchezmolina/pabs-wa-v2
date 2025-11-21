const config = require('../config');
const logger = require('./logger');
const { notifyAdmin } = require('./notifications');
const { createClient } = require('@supabase/supabase-js');
const evolutionAPI = require('../services/evolution');
const messageCache = require('../services/messageCache');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

// ============================================================================
// INSTANCE MONITOR - Verifica estado de conexión de todas las instancias
// ============================================================================

// Tracking de estados previos para notificar solo en cambios
const previousStates = new Map(); // Key: instanceName, Value: { connected: boolean, timestamp: Date }

// Flag para distinguir el check inicial (solo informativo) de los checks posteriores
let isFirstCheck = true;

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

    // Verificar cada instancia (usando evolutionAPI.checkInstanceConnection)
    const results = await Promise.all(
      Array.from(uniqueInstances.entries()).map(async ([name, data]) => {
        const result = await evolutionAPI.checkInstanceConnection(name, data.apiKey);
        return { ...result, instanceName: name }; // Añadir instanceName al resultado
      })
    );

    // Detectar CAMBIOS de estado (no solo desconectados)
    const newlyDisconnected = [];
    const reconnected = [];

    results.forEach(result => {
      const previous = previousStates.get(result.instanceName);

      if (!previous) {
        // Primera vez que checkeamos esta instancia - solo registrar estado
        previousStates.set(result.instanceName, {
          connected: result.connected,
          timestamp: new Date()
        });

        // En el primer check (inicio del servidor), NO intentar auto-restart
        // Solo registramos el estado inicial para detectar cambios futuros
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
      reconnected: reconnected.length,
      isFirstCheck
    });

    // En el PRIMER CHECK (inicio del servidor): solo resumen informativo
    if (isFirstCheck) {
      isFirstCheck = false; // Marcar que ya pasó el primer check

      if (disconnected.length > 0) {
        // Notificar resumen de instancias desconectadas (sin intentar auto-restart)
        const disconnectedWithLocations = disconnected.map(d => ({
          ...d,
          locationIds: uniqueInstances.get(d.instanceName).locationIds
        }));

        await notifyAdmin('Resumen Inicial - Instancias WhatsApp', {
          error: `${connected.length} conectadas, ${disconnected.length} desconectadas`,
          endpoint: 'Instance Monitor (Inicio)',
          instance_name: disconnected.map(d => d.instanceName).join(', '),
          details: formatInitialSummary(connected, disconnectedWithLocations)
        });
      } else {
        logger.info('✅ All instances connected on startup', {
          count: connected.length
        });
      }

      // No intentar auto-restart en el primer check
      return {
        total: results.length,
        connected: connected.length,
        disconnected: disconnected.length,
        newlyDisconnected: 0,
        reconnected: 0,
        results,
        isFirstCheck: true
      };
    }

    // En CHECKS POSTERIORES: detectar cambios y auto-restart
    if (newlyDisconnected.length > 0) {
      logger.info('Attempting auto-restart for newly disconnected instances', {
        count: newlyDisconnected.length,
        instances: newlyDisconnected.map(d => d.instanceName)
      });

      for (const inst of newlyDisconnected) {
        const apiKey = uniqueInstances.get(inst.instanceName).apiKey;
        // attemptAutoRestart ya maneja notificaciones (éxito o fallo)
        await attemptAutoRestart(inst.instanceName, apiKey, inst.locationIds);
      }
    }

    // Notificar conexiones (buenas noticias)
    if (reconnected.length > 0) {
      await notifyAdmin('Instancias WhatsApp Conectadas', {
        error: `${reconnected.length} instancia(s) conectada(s)`,
        endpoint: 'Instance Monitor',
        instance_name: reconnected.map(r => r.instanceName).join(', '),
        details: formatConnectedAlert(reconnected)
      });

      // Procesar mensajes pendientes para instancias reconectadas
      for (const inst of reconnected) {
        await processQueuedMessages(inst.instanceName, uniqueInstances.get(inst.instanceName).apiKey);
      }
    }

    // Procesar mensajes pendientes que estén listos para retry (independiente de reconexión)
    await processAllPendingMessages();

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

// ============================================================================
// MESSAGE QUEUE PROCESSOR - Procesa mensajes pendientes
// ============================================================================

/**
 * Procesa los mensajes pendientes de una instancia específica
 */
async function processQueuedMessages(instanceName, apiKey) {
  const messages = messageCache.getMessagesReadyForRetry(instanceName);

  if (messages.length === 0) {
    return { processed: 0, success: 0, failed: 0 };
  }

  logger.info('Processing queued messages for reconnected instance', {
    instanceName,
    messageCount: messages.length
  });

  let success = 0;
  let failed = 0;

  for (const msg of messages) {
    try {
      await evolutionAPI.sendText(instanceName, apiKey, msg.waNumber, msg.messageText);
      messageCache.updateMessageRetry(instanceName, msg.messageId, true);
      success++;

      logger.info('Queued message sent successfully', {
        instanceName,
        messageId: msg.messageId,
        contactPhone: msg.contactPhone
      });
    } catch (error) {
      messageCache.updateMessageRetry(instanceName, msg.messageId, false);
      failed++;

      logger.error('Failed to send queued message', {
        instanceName,
        messageId: msg.messageId,
        error: error.message
      });
    }

    // Pequeño delay entre mensajes para no saturar
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (success > 0 || failed > 0) {
    logger.info('Queued messages processing completed', {
      instanceName,
      total: messages.length,
      success,
      failed
    });
  }

  return { processed: messages.length, success, failed };
}

/**
 * Procesa mensajes pendientes de todas las instancias
 */
async function processAllPendingMessages() {
  const instances = messageCache.getInstancesWithPendingMessages();

  if (instances.length === 0) {
    return;
  }

  logger.info('Processing pending messages for all instances', {
    instancesWithPending: instances.length
  });

  // Obtener API keys de la BD
  const { data: clientsData, error } = await supabase
    .from('clients_details')
    .select('instance_name, instance_apikey')
    .in('instance_name', instances);

  if (error) {
    logger.error('Failed to fetch API keys for message processing', { error: error.message });
    return;
  }

  const apiKeys = new Map();
  clientsData?.forEach(c => apiKeys.set(c.instance_name, c.instance_apikey));

  for (const instanceName of instances) {
    const apiKey = apiKeys.get(instanceName);
    if (!apiKey) {
      logger.warn('No API key found for instance', { instanceName });
      continue;
    }

    // Verificar si la instancia está conectada antes de procesar
    const state = await evolutionAPI.checkInstanceConnection(instanceName, apiKey);
    if (state.connected) {
      await processQueuedMessages(instanceName, apiKey);
    }
  }
}

/**
 * Intenta reconectar automáticamente una instancia desconectada
 * @param {string} instanceName - Nombre de la instancia
 * @param {string} apiKey - API key de la instancia
 * @param {Array} locationIds - Location IDs afectados (para notificaciones)
 * @returns {Object} { success: boolean, needsQR: boolean }
 */
async function attemptAutoRestart(instanceName, apiKey, locationIds = []) {
  logger.info('Attempting auto-restart for disconnected instance', { instanceName });

  const result = await evolutionAPI.restartInstance(instanceName, apiKey);

  if (result.success) {
    // Reconexión exitosa
    logger.info('Auto-restart successful', { instanceName, state: result.state });

    // Notificar admin del éxito
    await notifyAdmin('Instancia Reconectada Automáticamente ✅', {
      instance_name: instanceName,
      error: 'Reconexión automática exitosa',
      endpoint: 'Auto-Restart',
      details: formatAutoRestartSuccess(instanceName, locationIds)
    });

    // Procesar cola de mensajes pendientes
    await processQueuedMessages(instanceName, apiKey);

    return { success: true, needsQR: false };
  }

  // Reconexión falló - requiere QR
  logger.warn('Auto-restart failed, QR scan required', {
    instanceName,
    state: result.state,
    error: result.error
  });

  await notifyAdmin('Instancia Requiere QR ⚠️', {
    instance_name: instanceName,
    error: 'Reconexión automática falló - requiere escanear QR',
    endpoint: 'Auto-Restart',
    details: formatQRRequiredAlert(instanceName, locationIds, result.error)
  });

  return { success: false, needsQR: true };
}

function formatAutoRestartSuccess(instanceName, locationIds) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  let message = '🟢 *Instancia Reconectada Automáticamente*\n\n';
  message += `⏰ Hora: ${timestamp}\n`;
  message += `📱 Instancia: *${instanceName}*\n`;
  message += `👥 Clientes activos: *${locationIds.length}*\n\n`;
  message += '✨ La instancia se reconectó usando credenciales de sesión existentes.\n';
  message += '📤 Los mensajes pendientes se están procesando.\n';
  return message;
}

function formatQRRequiredAlert(instanceName, locationIds, error) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  let message = '🟠 *Instancia Requiere Escanear QR*\n\n';
  message += `⏰ Hora: ${timestamp}\n`;
  message += `📱 Instancia: *${instanceName}*\n`;
  message += `👥 Clientes afectados: *${locationIds.length}*\n`;
  if (error) {
    message += `⚠️ Error: ${error}\n`;
  }
  message += '\n━━━━━━━━━━━━━━━━━━━\n\n';
  message += '💡 *Acción requerida:*\n';
  message += '   • Acceder al panel de Evolution API\n';
  message += '   • Escanear código QR con WhatsApp\n';
  message += '   • Los mensajes pendientes se enviarán al reconectar\n';
  return message;
}

function formatInitialSummary(connected, disconnected) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  let message = '📊 *Resumen Inicial - Servidor Iniciado*\n\n';
  message += `⏰ Hora: ${timestamp}\n`;
  message += `✅ Conectadas: *${connected.length}*\n`;
  message += `❌ Desconectadas: *${disconnected.length}*\n\n`;

  if (connected.length > 0) {
    message += '━━━━━━━━━━━━━━━━━━━\n';
    message += '🟢 *Instancias Operativas:*\n';
    connected.forEach(inst => {
      message += `   • ${inst.instanceName}\n`;
    });
    message += '\n';
  }

  if (disconnected.length > 0) {
    message += '━━━━━━━━━━━━━━━━━━━\n';
    message += '🔴 *Requieren Atención:*\n';
    disconnected.forEach(inst => {
      message += `   • *${inst.instanceName}* (${inst.state})\n`;
      message += `     └ Clientes: ${inst.locationIds.length}\n`;
    });
    message += '\n';
    message += '💡 Estas instancias necesitan escanear QR para conectarse.\n';
  }

  return message;
}

function formatDisconnectedAlert(disconnected) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  let message = '🔴 *ALERTA: Instancias WhatsApp Desconectadas*\n\n';
  message += `⏰ Detectado: ${timestamp}\n`;
  message += `📊 Total afectadas: ${disconnected.length} instancia(s)\n\n`;
  message += '━━━━━━━━━━━━━━━━━━━\n\n';

  disconnected.forEach((inst, index) => {
    message += `${index + 1}. *${inst.instanceName}*\n`;
    message += `   └ Estado: \`${inst.state}\`\n`;
    message += `   └ Clientes afectados: *${inst.locationIds.length}*\n`;

    if (inst.locationIds.length <= 3) {
      message += `   └ Location IDs: ${inst.locationIds.map(id => `\`${id.substring(0, 8)}...\``).join(', ')}\n`;
    } else {
      message += `   └ Location IDs: ${inst.locationIds.slice(0, 2).map(id => `\`${id.substring(0, 8)}...\``).join(', ')} y ${inst.locationIds.length - 2} más\n`;
    }

    if (inst.error) {
      message += `   └ ⚠️ Error: ${inst.error}\n`;
    }
    message += '\n';
  });

  message += '━━━━━━━━━━━━━━━━━━━\n';
  message += '💡 *Acciones sugeridas:*\n';
  message += '   • Verificar conexión de WhatsApp\n';
  message += '   • Escanear QR si es necesario\n';
  message += '   • Revisar logs de Evolution API\n';

  return message;
}

function formatConnectedAlert(connected) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  let message = '🟢 *Instancias WhatsApp Conectadas*\n\n';
  message += `⏰ Detectado: ${timestamp}\n`;
  message += `📊 Total conectadas: ${connected.length} instancia(s)\n\n`;
  message += '━━━━━━━━━━━━━━━━━━━\n\n';

  connected.forEach((inst, index) => {
    message += `${index + 1}. ✅ *${inst.instanceName}*\n`;
    message += `   └ Estado: \`${inst.state}\` (operativa)\n`;
    message += `   └ Clientes activos: *${inst.locationIds.length}*\n`;

    if (inst.locationIds.length <= 3) {
      message += `   └ Location IDs: ${inst.locationIds.map(id => `\`${id.substring(0, 8)}...\``).join(', ')}\n`;
    } else {
      message += `   └ Location IDs: ${inst.locationIds.slice(0, 2).map(id => `\`${id.substring(0, 8)}...\``).join(', ')} y ${inst.locationIds.length - 2} más\n`;
    }
    message += '\n';
  });

  message += '━━━━━━━━━━━━━━━━━━━\n';
  message += '✨ Los mensajes se están procesando con normalidad\n';

  return message;
}

// ============================================================================
// SCHEDULER - Ejecutar cada X horas
// ============================================================================

function startMonitoring(intervalHours = 0.5) {
  const intervalMinutes = intervalHours * 60;
  const displayInterval = intervalHours >= 1 ? `${intervalHours}h` : `${intervalMinutes}min`;
  logger.info(`🔄 Instance monitor started (interval: ${displayInterval})`);

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
  startMonitoring,
  attemptAutoRestart,
  processQueuedMessages
};
