const express = require('express');
const path = require('path');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./utils/logger');
const { handleGHLWebhook } = require('./webhooks/ghl');
const { handleWhatsAppWebhook } = require('./webhooks/whatsapp');
const { handleAgentWebhook } = require('./webhooks/agent');
const { updateGHLTokens } = require('./services/supabase');
const { createClient } = require('@supabase/supabase-js');
const { validateGHLWebhook, validateWhatsAppWebhook, validateAgentWhitelist } = require('./utils/webhookAuth');

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", config.N8N_BASE_URL],
      fontSrc: ["'self'", "https://at.alicdn.com"],
      frameAncestors: ["'self'", "https://*.gohighlevel.com", "https://*.msgsndr.com", "https://*.highlevel.company", "https://*.pabs.ai", "https://*.roisnap.com"]
    }
  },
  frameguard: false // Desactivar X-Frame-Options para permitir iframe en GHL
}));

// CORS - permitir todos los orígenes (webhooks vienen de múltiples fuentes)
app.use(cors());

// Rate limiter solo para OAuth (evitar brute force)
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 intentos OAuth por IP
  message: { error: 'Too many OAuth attempts' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/panel', express.static(path.join(__dirname, 'public-v2'), {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// Webhooks (con validación de whitelist)
app.post('/webhook/ghl', validateGHLWebhook, handleGHLWebhook);
app.post('/webhook/whatsapp', validateWhatsAppWebhook, handleWhatsAppWebhook);
// Evolution API envía eventos con el tipo en la ruta (ej: /webhook/whatsapp/messages-upsert)
app.post('/webhook/whatsapp/*', validateWhatsAppWebhook, handleWhatsAppWebhook);
// Agent webhook (beta feature - requiere is_beta=true)
app.post('/webhook/agent', validateAgentWhitelist, handleAgentWebhook);

// Check beta status
app.get('/api/check-beta', async (req, res) => {
  const { locationId } = req.query;
  if (!locationId) {
    return res.json({ is_beta: false });
  }

  try {
    const { getClientByLocationId } = require('./services/supabase');
    const { isBetaClient } = require('./utils/betaFeatures');
    const client = await getClientByLocationId(locationId);
    res.json({ is_beta: isBetaClient(client) });
  } catch (error) {
    res.json({ is_beta: false });
  }
});

// Panel v2 - Connection Management
// GET /panel/status/:locationId - Estado de instancia
app.get('/panel/status/:locationId', async (req, res) => {
  const { locationId } = req.params;

  try {
    const { getClientByLocationId } = require('./services/supabase');
    const { getConnectionState } = require('./services/evolution');

    const client = await getClientByLocationId(locationId);
    if (!client) {
      return res.status(404).json({
        error: 'Servicio no dado de alta. Contacte con el equipo.',
        notConfigured: true
      });
    }

    const stateData = await getConnectionState(client.instance_name, client.instance_apikey);

    res.json({
      state: stateData.instance?.state || 'unknown',
      instanceName: client.instance_name,
      phoneNumber: client.instance_sender || null
    });
  } catch (error) {
    logger.error('Error getting panel status', {
      locationId,
      error: error.message
    });

    // Si es error de cliente no encontrado, mensaje específico
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({
        error: 'Servicio no dado de alta. Contacte con el equipo.',
        notConfigured: true
      });
    }

    res.status(500).json({ error: 'Error al obtener estado de la instancia' });
  }
});

// POST /panel/qr/:locationId - Generar QR code
app.post('/panel/qr/:locationId', async (req, res) => {
  const { locationId } = req.params;

  try {
    const { getClientByLocationId } = require('./services/supabase');
    const { connectInstance } = require('./services/evolution');

    const client = await getClientByLocationId(locationId);
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const result = await connectInstance(client.instance_name, client.instance_apikey);

    // Si hay base64 → Instancia desconectada, retornar QR
    if (result.base64) {
      return res.json({ qrBase64: result.base64 });
    }

    // Si NO hay base64 → Instancia ya conectada
    return res.json({ message: 'Conexión ya establecida' });
  } catch (error) {
    logger.error('Error generating QR code', {
      locationId,
      error: error.message
    });
    res.status(500).json({ error: 'Error al generar código QR' });
  }
});

// POST /panel/pairing/:locationId - Generar pairing code
app.post('/panel/pairing/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const { phoneNumber } = req.body;

  // Validar número de teléfono
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return res.status(400).json({ error: 'Número de teléfono requerido' });
  }

  // Validar formato: solo dígitos, max 15 caracteres, sin +
  if (!/^\d{1,15}$/.test(phoneNumber)) {
    return res.status(400).json({
      error: 'Formato de número inválido. Debe ser solo dígitos sin el signo +, máximo 15 caracteres.'
    });
  }

  try {
    const { getClientByLocationId, updateClient } = require('./services/supabase');
    const { connectInstance } = require('./services/evolution');

    const client = await getClientByLocationId(locationId);
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Intentar generar pairing code
    const result = await connectInstance(client.instance_name, client.instance_apikey, phoneNumber);

    if (result.pairingCode) {
      // Éxito - Guardar número en BD
      await updateClient(locationId, {
        instance_sender: `${phoneNumber}@s.whatsapp.net`
      });

      logger.info('Pairing code generated successfully', {
        locationId,
        instanceName: client.instance_name
      });

      return res.json({
        pairingCode: result.pairingCode,
        phoneNumber,
        success: true
      });
    }

    // No se generó pairing code (caso inesperado)
    return res.status(400).json({
      error: 'No se pudo generar el código de vinculación',
      fallbackToQR: true
    });
  } catch (error) {
    logger.error('Error generating pairing code', {
      locationId,
      error: error.message,
      status: error.response?.status
    });

    // Error - Sugerir fallback a QR
    return res.status(400).json({
      error: 'Pairing code no disponible. Por favor, usa QR Code.',
      fallbackToQR: true
    });
  }
});

// Legacy proxy genérico (NO MODIFICAR)
app.all('/api/:action', async (req, res) => {
  const { action } = req.params;
  const locationId = req.method === 'GET'
    ? req.query.locationId
    : req.body.locationId;
  if (!locationId) {
    return res.status(400).json({ error: 'locationId missing' });
  }

  let url = `${config.N8N_BASE_URL}/webhook/${action}`;
  let opts = { method: req.method, headers: { Authorization: config.N8N_AUTH_HEADER } };

  // GET: pasamos locationId como query; POST/PUT: en body
  if (req.method === 'GET') {
    url += `?locationId=${encodeURIComponent(locationId)}`;
  } else {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify({ locationId, ...req.body });
  }

  try {
    const proxyRes = await fetch(url, opts);
    const contentType = proxyRes.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
      data = await proxyRes.json();
    } else {
      // Fetch nativo usa arrayBuffer(), convertir a Buffer para Express
      const arrayBuffer = await proxyRes.arrayBuffer();
      data = Buffer.from(arrayBuffer);
    }

    res.status(proxyRes.status).type(contentType).send(data);
  } catch (err) {
    logger.error('Proxy error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// OAuth: Iniciar flujo
app.get('/oauth/ghl/connect', oauthLimiter, (req, res) => {
  const { location_id } = req.query;
  
  if (!location_id) {
    return res.status(400).json({ error: 'location_id required' });
  }
  
  const scopes = [
    'contacts.readonly',
    'contacts.write',
    'conversations.readonly',
    'conversations.write',
    'conversations/message.readonly',
    'conversations/message.write',
    'locations.readonly',
    'opportunities.readonly',
    'opportunities.write',
    'users.readonly',
    'calendars.readonly',
    'calendars.write',
    'calendars/events.write'
  ].join(' ');
  
  const authUrl = `https://marketplace.gohighlevel.com/oauth/chooselocation?` +
    `response_type=code` +
    `&client_id=${config.GHL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(config.GHL_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${location_id}`;

  res.redirect(authUrl);
});

// OAuth: Callback
app.get('/auth/credentials2/callback', oauthLimiter, async (req, res) => {
  const { code, state: locationId } = req.query;
  
  if (!code || !locationId) {
    return res.status(400).send('Missing code or location_id');
  }
  
  try {
    // Log de parámetros de entrada
    logger.info('OAuth callback initiated', {
      locationId,
      hasCode: !!code,
      redirectUri: config.GHL_REDIRECT_URI
    });

    // Intercambiar code por tokens
    // GHL requiere application/x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append('client_id', config.GHL_CLIENT_ID);
    params.append('client_secret', config.GHL_CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', config.GHL_REDIRECT_URI);

    const response = await axios.post('https://services.leadconnectorhq.com/oauth/token', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token, expires_in } = response.data;

    // Guardar en Supabase
    await updateGHLTokens(locationId, access_token, refresh_token, expires_in);

    logger.info('OAuth completed', { locationId });

    res.send(`
      <h1>✅ Conexión exitosa</h1>
      <p>GHL conectado para location: ${locationId}</p>
      <p>Puedes cerrar esta ventana.</p>
    `);

  } catch (error) {
    // Log detallado del error
    const errorDetails = {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      headers: error.response?.headers
    };

    logger.error('OAuth callback error', errorDetails);

    res.status(500).send(`
      <h1>❌ Error en OAuth</h1>
      <p>Error: ${error.message}</p>
      <p>Detalles: ${JSON.stringify(error.response?.data || {})}</p>
    `);
  }
});

// Health Check
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {}
  };
  
  // Check Supabase
  try {
    await supabase.from('clients_details').select('id').limit(1);
    health.services.supabase = 'connected';
  } catch (error) {
    health.services.supabase = 'error';
    health.status = 'degraded';
  }
  
  // Check Evolution API (usar endpoint raíz que no requiere auth)
  try {
    await axios.get(`${config.EVOLUTION_BASE_URL}/`, { timeout: 3000 });
    health.services.evolution_api = 'reachable';
  } catch (error) {
    health.services.evolution_api = 'unreachable';
    health.status = 'degraded';
  }
  
  // Check OpenAI
  try {
    await axios.get('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${config.OPENAI_API_KEY}` },
      timeout: 3000
    });
    health.services.openai = 'reachable';
  } catch (error) {
    health.services.openai = 'unreachable';
    health.status = 'degraded';
  }
  
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ============================================================================
// ERROR HANDLER MIDDLEWARE - Captura global de errores
// ============================================================================

const { notifyAdmin } = require('./utils/notifications');

// Error handler debe ir DESPUÉS de todas las rutas
app.use((err, req, res, next) => {
  logger.error('Unhandled error in Express', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
    body: req.body
  });

  // Notificar al admin
  notifyAdmin('Unhandled Express Error', {
    error: err.message,
    stack: err.stack,
    endpoint: `${req.method} ${req.url}`,
    location_id: req.body?.locationId,
    instance_name: req.body?.instance,
    // Datos de API si es error de axios
    status: err.response?.status,
    statusText: err.response?.statusText,
    responseData: err.response?.data
  });

  // Responder al cliente
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Manejar errores no capturados de Node.js
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', {
    error: err.message,
    stack: err.stack
  });

  notifyAdmin('Uncaught Exception', {
    error: err.message,
    stack: err.stack,
    endpoint: 'Node.js Process',
    // Datos de API si es error de axios
    status: err.response?.status,
    statusText: err.response?.statusText,
    responseData: err.response?.data
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });

  notifyAdmin('Unhandled Rejection', {
    error: reason?.message || String(reason),
    stack: reason?.stack,
    endpoint: 'Node.js Promise',
    // Datos de API si es error de axios
    status: reason?.response?.status,
    statusText: reason?.response?.statusText,
    responseData: reason?.response?.data
  });
});

// Evita cerrar el servidor si se están ejecutando flujos
let server;

function gracefulShutdown(signal) {
  logger.info(`${signal} received, closing server gracefully`);
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  // Forzar cierre después de 30 segundos
  setTimeout(() => {
    logger.error('Forced shutdown after 30s timeout');
    process.exit(1);
  }, 30000);
}

server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);

  // Iniciar monitor de instancias (cada 2 horas - backup, webhooks CONNECTION_UPDATE son primarios)
  const { startMonitoring } = require('./utils/instanceMonitor');
  startMonitoring(2);
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));