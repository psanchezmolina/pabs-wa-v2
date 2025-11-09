const OpenAI = require('openai');
const { toFile } = require('openai');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

async function transcribeAudio(base64Audio, mimeType) {
  const buffer = Buffer.from(base64Audio, 'base64');

  // Usar toFile de OpenAI para crear un file-like object compatible con Node.js
  const file = await toFile(buffer, 'audio.ogg', { type: mimeType });

  const response = await withRetry(() =>
    openai.audio.transcriptions.create({
      file,
      model: 'whisper-1'
    })
  );

  return response.text;
}

async function analyzeImage(base64Image) {
  const response = await withRetry(() =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe la imagen en una sola linea y texto sin formato. Nunca uses comillas dobles "", mejor usa parentesis () ya que se usará dentro de un JSON.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`
            }
          }
        ]
      }],
      max_tokens: 300
    })
  );

  const description = response.choices[0].message.content;

  // Sanitizar descripción: reemplazar comillas dobles por comillas simples
  // Esto evita romper el JSON cuando se sube a GHL
  return description.replace(/"/g, "'").replace(/\n/g, ' ').trim();
}

module.exports = {
  transcribeAudio,
  analyzeImage
};