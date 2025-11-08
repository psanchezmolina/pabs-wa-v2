require('dotenv').config();

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  // GHL OAuth
  GHL_CLIENT_ID: process.env.GHL_CLIENT_ID,
  GHL_CLIENT_SECRET: process.env.GHL_CLIENT_SECRET,
  GHL_REDIRECT_URI: process.env.GHL_REDIRECT_URI,

  // OpenAI (global key)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,

  // Evolution API
  EVOLUTION_BASE_URL: process.env.EVOLUTION_BASE_URL,

  // Admin alerts
  ADMIN_WHATSAPP: process.env.ADMIN_WHATSAPP,
  ADMIN_INSTANCE: process.env.ADMIN_INSTANCE,
  ADMIN_INSTANCE_APIKEY: process.env.ADMIN_INSTANCE_APIKEY,

  // Legacy (QR panel)
  N8N_BASE_URL: process.env.N8N_BASE_URL,
  N8N_AUTH_HEADER: process.env.N8N_AUTH_HEADER
};