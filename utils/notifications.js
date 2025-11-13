const config = require('../config');
const logger = require('./logger');
const { sendEmail, formatErrorEmailHtml, isEmailConfigured } = require('./email');

// ============================================================================
// ERROR AGGREGATOR - Agrupa errores idénticos en ventana de 5 minutos
// ============================================================================

class ErrorAggregator {
  constructor() {
    this.errors = new Map(); // Key: errorHash, Value: { count, first, last, details, timeout }
    this.windowMs = 5 * 60 * 1000; // 5 minutos
  }

  // Generar hash único para identificar errores idénticos
  getErrorHash(errorType, message, client) {
    const key = `${errorType}:${message}:${client || 'global'}`;
    return key.toLowerCase().replace(/\s+/g, '_');
  }

  // Procesar error: devuelve true si debe enviar inmediatamente
  async process(errorType, details, sendCallback) {
    const hash = this.getErrorHash(errorType, details.error, details.location_id || details.instance_name);

    const existing = this.errors.get(hash);

    if (!existing) {
      // PRIMER ERROR - Enviar inmediatamente
      this.errors.set(hash, {
        count: 1,
        first: new Date(),
        last: new Date(),
        errorType,
        details: [details],
        timeout: null
      });

      // Enviar inmediatamente
      await sendCallback(errorType, details, false);

      // Configurar timeout para enviar agrupados si hay más
      const timeoutId = setTimeout(() => {
        this.sendAggregated(hash, sendCallback);
      }, this.windowMs);

      this.errors.get(hash).timeout = timeoutId;

      return;
    }

    // ERROR REPETIDO - Agregar a la lista
    existing.count++;
    existing.last = new Date();
    existing.details.push(details);

    logger.info('Error agregado al grupo', {
      hash,
      count: existing.count,
      errorType
    });
  }

  // Enviar errores agrupados
  async sendAggregated(hash, sendCallback) {
    const aggregated = this.errors.get(hash);

    if (!aggregated || aggregated.count <= 1) {
      // Solo hubo 1 ocurrencia, ya se envió
      this.errors.delete(hash);
      return;
    }

    // Hay 2+ ocurrencias, enviar agrupado
    await sendCallback(aggregated.errorType, aggregated, true);

    // Limpiar
    this.errors.delete(hash);
  }

  // Limpiar errores antiguos (llamar periódicamente)
  cleanup() {
    const now = Date.now();
    for (const [hash, data] of this.errors.entries()) {
      if (now - data.last.getTime() > this.windowMs) {
        if (data.timeout) clearTimeout(data.timeout);
        this.errors.delete(hash);
      }
    }
  }
}

const aggregator = new ErrorAggregator();

// Cleanup cada 10 minutos
setInterval(() => aggregator.cleanup(), 10 * 60 * 1000);

// ============================================================================
// FORMATTERS - Crear mensajes estilo n8n
// ============================================================================

function formatDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function formatStack(stack) {
  if (!stack) return 'N/A';

  // Tomar primeras 5 líneas
  const lines = stack.split('\n').slice(0, 5);
  return lines.map(line => line.trim()).join('\n');
}

// Extraer archivo:línea del primer error del stack
function extractFileLocation(stack) {
  if (!stack) return null;

  const match = stack.match(/at .*\(?(\/usr\/src\/app\/[^:]+):(\d+):\d+\)?/);
  if (match) {
    const fullPath = match[1];
    const file = fullPath.replace('/usr/src/app/', '');
    const line = match[2];
    return `${file}:${line}`;
  }
  return null;
}

// Generar sugerencias basadas en el tipo de error
function getQuickFixSuggestions(errorType, details) {
  const suggestions = [];

  // Errores de API GHL
  if (details.status === 400 || details.responseData?.statusCode === 400) {
    suggestions.push('Revisar formato de datos en BD (trim, espacios, \\r\\n)');
    suggestions.push('Verificar que conversation_provider_id sea válido');
    suggestions.push('Validar formato de teléfono (E.164: +34XXX)');
  }

  if (details.status === 403 || details.responseData?.statusCode === 403) {
    suggestions.push('Verificar conversation_provider_id en BD');
    suggestions.push('Revisar permisos OAuth del location');
  }

  if (details.status === 401 || errorType.includes('Token')) {
    suggestions.push('Token expirado - verificar ghl_token_expiry en BD');
    suggestions.push('Ejecutar refresh token manualmente');
  }

  // Errores de referencia (código)
  if (errorType.includes('ReferenceError') || details.error?.includes('is not defined')) {
    suggestions.push('Error de tipeo en código (variable, función, import)');
    suggestions.push('Revisar el archivo mencionado en el stack trace');
  }

  // Errores de OpenAI
  if (errorType.includes('OpenAI')) {
    suggestions.push('Verificar OPENAI_API_KEY en variables de entorno');
    suggestions.push('Check OpenAI API status: https://status.openai.com');
  }

  // Errores de Evolution API
  if (errorType.includes('WhatsApp') || details.instance_name) {
    suggestions.push('Verificar que la instancia esté conectada');
    suggestions.push('Revisar instance_apikey en BD');
  }

  return suggestions;
}

function formatSingleError(errorType, details) {
  const client = `${details.location_id} (${details.instance_name})`;
  const endpoint = details.endpoint || details.webhook || 'N/A';

  let message = `🚨 *Error en Servidor* 🚨\n\n`;
  message += `*Tipo:* ${errorType}\n`;
  message += `*Cliente:* ${client}\n`;
  message += `*Endpoint:* ${endpoint}\n`;
  message += `*Error:* ${details.error}\n`;

  // Extraer ubicación del archivo
  const fileLocation = extractFileLocation(details.stack);
  if (fileLocation) {
    message += `*📁 Archivo:* ${fileLocation}\n`;
  }
  message += `\n`;

  // Información de API externa (GHL, Evolution, OpenAI)
  if (details.status || details.errorCode || details.responseData) {
    message += `*🌐 API Response:*\n`;
    if (details.status || details.errorCode) {
      message += `• Status: ${details.status || details.errorCode}\n`;
    }
    if (details.statusText) {
      message += `• Status Text: ${details.statusText}\n`;
    }
    if (details.responseData) {
      const responseStr = typeof details.responseData === 'string'
        ? details.responseData
        : JSON.stringify(details.responseData, null, 2);
      message += `• Response: ${responseStr.substring(0, 300)}\n`;
    }
    if (details.errorData) {
      message += `• Error Data: ${details.errorData.substring(0, 300)}\n`;
    }
    message += `\n`;
  }

  // Payload enviado (útil para errores 400)
  if (details.data || details.payload) {
    const payload = details.data || details.payload;
    const payloadStr = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload, null, 2);
    message += `*📤 Payload Enviado:*\n\`\`\`\n${payloadStr.substring(0, 400)}\n\`\`\`\n\n`;
  }

  // Contexto adicional
  if (details.contactId || details.messageId || details.remoteJid || details.phone) {
    message += `*Contexto:*\n`;
    if (details.contactId) message += `• Contact ID: ${details.contactId}\n`;
    if (details.messageId) message += `• Message ID: ${details.messageId}\n`;
    if (details.remoteJid) message += `• Remote: ${details.remoteJid}\n`;
    if (details.phone) message += `• Phone: ${details.phone}\n`;
    message += `\n`;
  }

  // Sugerencias de solución
  const suggestions = getQuickFixSuggestions(errorType, details);
  if (suggestions.length > 0) {
    message += `*💡 Quick Fix Suggestions:*\n`;
    suggestions.forEach(s => message += `• ${s}\n`);
    message += `\n`;
  }

  // Stack trace (reducido ahora que tenemos más info)
  if (details.stack) {
    message += `*Stack:*\n\`\`\`\n${formatStack(details.stack)}\n\`\`\`\n\n`;
  }

  message += `*Timestamp:* ${formatDate(new Date())}`;

  return message;
}

function formatAggregatedError(errorType, aggregated) {
  const count = aggregated.count;
  const first = formatDate(aggregated.first);
  const last = formatDate(aggregated.last);

  // Agrupar por cliente
  const clientCounts = {};
  aggregated.details.forEach(d => {
    const client = d.location_id || d.instance_name || 'N/A';
    clientCounts[client] = (clientCounts[client] || 0) + 1;
  });

  const lastDetail = aggregated.details[aggregated.details.length - 1];
  const fileLocation = extractFileLocation(lastDetail.stack);

  let message = `🚨 *Error Agrupado* (x${count}) 🚨\n\n`;
  message += `*Tipo:* ${errorType}\n`;
  message += `*Mensaje:* ${aggregated.details[0].error}\n`;
  if (fileLocation) {
    message += `*📁 Archivo:* ${fileLocation}\n`;
  }
  message += `\n`;

  message += `*Estadísticas:*\n`;
  message += `• Ocurrencias: ${count}\n`;
  message += `• Primera: ${first}\n`;
  message += `• Última: ${last}\n`;
  message += `• Clientes afectados: ${Object.keys(clientCounts).length}\n\n`;

  message += `*Detalles por cliente:*\n`;
  for (const [client, clientCount] of Object.entries(clientCounts)) {
    message += `- ${client} (${clientCount}x)\n`;
  }
  message += `\n`;

  // Sugerencias de solución (basadas en el último error)
  const suggestions = getQuickFixSuggestions(errorType, lastDetail);
  if (suggestions.length > 0) {
    message += `*💡 Quick Fix Suggestions:*\n`;
    suggestions.forEach(s => message += `• ${s}\n`);
    message += `\n`;
  }

  // Stack del último error
  if (lastDetail.stack) {
    message += `*Último stack:*\n\`\`\`\n${formatStack(lastDetail.stack)}\n\`\`\``;
  }

  return message;
}

// ============================================================================
// SENDER - Enviar a WhatsApp
// ============================================================================

async function sendToWhatsApp(message) {
  const evolutionAPI = require('../services/evolution');

  // Verificar configuración
  if (!config.ADMIN_INSTANCE_APIKEY) {
    logger.warn('ADMIN_INSTANCE_APIKEY not configured, cannot send notification');
    throw new Error('ADMIN_INSTANCE_APIKEY not configured');
  }

  await evolutionAPI.sendText(
    config.ADMIN_INSTANCE,
    config.ADMIN_INSTANCE_APIKEY,
    config.ADMIN_WHATSAPP,
    message
  );

  logger.info('Admin notified successfully via WhatsApp');
}

// ============================================================================
// MAIN FUNCTION - notifyAdmin (mejorada)
// ============================================================================

async function notifyAdmin(errorType, details) {
  try {
    // Añadir timestamp si no existe
    if (!details.timestamp) {
      details.timestamp = new Date().toISOString();
    }

    // Procesar con aggregator
    await aggregator.process(errorType, details, async (type, data, isAggregated) => {
      const message = isAggregated
        ? formatAggregatedError(type, data)
        : formatSingleError(type, data);

      try {
        // 1. Intentar WhatsApp primero
        await sendToWhatsApp(message);

      } catch (whatsappError) {
        // 2. WhatsApp falló, usar Email como fallback
        logger.warn('WhatsApp notification failed, trying email fallback', {
          whatsappError: whatsappError.message
        });

        if (!isEmailConfigured()) {
          logger.error('CRITICAL: Email fallback not configured, notification lost', {
            errorType: type,
            whatsappError: whatsappError.message
          });
          return;
        }

        try {
          const htmlContent = formatErrorEmailHtml(type, isAggregated ? data.details[data.details.length - 1] : data);
          await sendEmail(type, htmlContent);
          logger.info('Notification sent via email (fallback successful)');

        } catch (emailError) {
          // 3. Ambos fallaron - CRÍTICO
          logger.error('CRITICAL: Both WhatsApp and Email notifications failed', {
            errorType: type,
            whatsappError: whatsappError.message,
            emailError: emailError.message
          });
        }
      }
    });

  } catch (error) {
    logger.error('Error in notifyAdmin', {
      error: error.message,
      stack: error.stack
    });
  }
}

module.exports = { notifyAdmin };
