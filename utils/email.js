const { Resend } = require('resend');
const config = require('../config');
const logger = require('./logger');

// ============================================================================
// EMAIL SERVICE - Fallback notification system usando Resend
// ============================================================================

let resendClient = null;

// Inicializar cliente de Resend solo si está configurado
if (config.RESEND_API_KEY && config.ADMIN_EMAIL) {
  resendClient = new Resend(config.RESEND_API_KEY);
  logger.info('Resend email service initialized', {
    adminEmail: config.ADMIN_EMAIL
  });
} else {
  logger.warn('Resend email service NOT configured (missing RESEND_API_KEY or ADMIN_EMAIL)');
}

/**
 * Enviar notificación por email usando Resend
 * @param {string} subject - Asunto del email
 * @param {string} htmlContent - Contenido HTML del email
 * @returns {Promise<Object>} - Resultado del envío
 */
async function sendEmail(subject, htmlContent) {
  if (!resendClient) {
    throw new Error('Resend not configured. Set RESEND_API_KEY and ADMIN_EMAIL in environment variables.');
  }

  try {
    const result = await resendClient.emails.send({
      from: 'GHL-WhatsApp Server <onboarding@resend.dev>', // Resend permite este "from" en free tier
      to: config.ADMIN_EMAIL,
      subject: `[GHL-WhatsApp] ${subject}`,
      html: htmlContent
    });

    logger.info('Email sent successfully', {
      subject,
      emailId: result.id,
      to: config.ADMIN_EMAIL
    });

    return result;

  } catch (error) {
    logger.error('Failed to send email', {
      subject,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Formatear notificación de error como HTML para email
 * @param {string} title - Título de la alerta
 * @param {Object} context - Contexto del error
 * @returns {string} - HTML formateado
 */
function formatErrorEmailHtml(title, context) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #dc3545; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
        .content { background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; }
        .section { margin-bottom: 15px; }
        .label { font-weight: bold; color: #495057; }
        .value { background: white; padding: 10px; border-left: 3px solid #007bff; margin-top: 5px; word-break: break-word; }
        .code { font-family: monospace; background: #e9ecef; padding: 2px 5px; border-radius: 3px; }
        .footer { text-align: center; color: #6c757d; font-size: 12px; margin-top: 20px; }
        pre { background: #f1f3f5; padding: 10px; border-radius: 5px; overflow-x: auto; font-size: 11px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin: 0;">🚨 ${title}</h2>
        </div>
        <div class="content">
          <div class="section">
            <span class="label">⏰ Timestamp:</span>
            <div class="value">${timestamp}</div>
          </div>
  `;

  // Agregar campos de contexto
  if (context.instance_name) {
    html += `
      <div class="section">
        <span class="label">📱 Instancia:</span>
        <div class="value"><span class="code">${context.instance_name}</span></div>
      </div>
    `;
  }

  if (context.endpoint) {
    html += `
      <div class="section">
        <span class="label">🌐 Endpoint:</span>
        <div class="value"><span class="code">${context.endpoint}</span></div>
      </div>
    `;
  }

  if (context.error) {
    html += `
      <div class="section">
        <span class="label">❌ Error:</span>
        <div class="value">${context.error}</div>
      </div>
    `;
  }

  // Detalles adicionales
  if (context.details) {
    html += `
      <div class="section">
        <span class="label">📋 Detalles:</span>
        <div class="value"><pre>${context.details}</pre></div>
      </div>
    `;
  }

  // Response de API si existe
  if (context.status || context.responseData) {
    html += `
      <div class="section">
        <span class="label">🌐 API Response:</span>
        <div class="value">
          ${context.status ? `<p><strong>Status:</strong> ${context.status} ${context.statusText || ''}</p>` : ''}
          ${context.responseData ? `<pre>${JSON.stringify(context.responseData, null, 2)}</pre>` : ''}
        </div>
      </div>
    `;
  }

  // Payload enviado si existe
  if (context.data) {
    html += `
      <div class="section">
        <span class="label">📤 Payload Enviado:</span>
        <div class="value"><pre>${JSON.stringify(context.data, null, 2)}</pre></div>
      </div>
    `;
  }

  // Stack trace (truncado para email)
  if (context.stack) {
    const truncatedStack = context.stack.split('\n').slice(0, 10).join('\n');
    html += `
      <div class="section">
        <span class="label">📚 Stack Trace:</span>
        <div class="value"><pre>${truncatedStack}</pre></div>
      </div>
    `;
  }

  html += `
        </div>
        <div class="footer">
          <p>GHL-WhatsApp Integration Server</p>
          <p><em>Este email fue enviado como fallback porque WhatsApp notification falló</em></p>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
}

/**
 * Verificar si el servicio de email está disponible
 * @returns {boolean}
 */
function isEmailConfigured() {
  return resendClient !== null;
}

module.exports = {
  sendEmail,
  formatErrorEmailHtml,
  isEmailConfigured
};
