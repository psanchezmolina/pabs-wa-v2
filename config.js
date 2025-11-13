require('dotenv').config();

// Validar variables críticas al inicio
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'GHL_CLIENT_ID',
  'GHL_CLIENT_SECRET',
  'GHL_REDIRECT_URI',
  'OPENAI_API_KEY',
  'EVOLUTION_BASE_URL'
];

const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('❌ Missing required environment variables:', missing);
  console.error('Please check your .env file');
  process.exit(1);
}

// Validar formato de URLs
const urlVars = ['SUPABASE_URL', 'EVOLUTION_BASE_URL', 'GHL_REDIRECT_URI'];
for (const key of urlVars) {
  try {
    new URL(process.env[key]);
  } catch (error) {
    console.error(`❌ Invalid URL format for ${key}:`, process.env[key]);
    process.exit(1);
  }
}

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

  // Email fallback (Resend) - Opcional
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,

  // Legacy (QR panel)
  N8N_BASE_URL: process.env.N8N_BASE_URL,
  N8N_AUTH_HEADER: process.env.N8N_AUTH_HEADER
};