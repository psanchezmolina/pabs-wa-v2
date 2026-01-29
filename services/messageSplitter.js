const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

/**
 * Divide un mensaje largo en hasta 3 partes coherentes para mensajería instantánea
 * Replica la lógica del nodo "Dividir Mensajes" de Flowise
 *
 * @param {string} message - Mensaje completo a dividir
 * @returns {Promise<{parte1: string, parte2: string, parte3: string}>}
 */
async function splitMessageWithLLM(message) {
  try {
    logger.info('Dividiendo mensaje con LLM', {
      messageLength: message.length,
      preview: message.substring(0, 100)
    });

    const systemPrompt = `Eres un experto en dividir textos largos en hasta 3 párrafos coherentes para mensajería instantánea (WhatsApp, Facebook, Instagram).

## Instrucciones:

1. Recibes un texto completo que puede contener saltos de párrafo (\\n\\n) ya existentes.
2. Usa estos saltos como potenciales puntos de división siempre que sea posible.
3. Solo divide en 1, 2 o 3 fragmentos.
4. No cambies ni agregues palabras. Solo reordena y fragmenta.
5. Cada fragmento debe terminar justo después de un signo de puntuación final (punto, signo de interrogación o admiración).
6. Si usas solo 1 fragmento, parte2 y parte3 deben ser cadenas vacías (""); si usas 2 fragmentos, parte3 será cadena vacía ("").
7. REGLA CRÍTICA: Las listas NUNCA se dividen. Toda la lista completa va en UNA SOLA parte, eliminando los símbolos (-, *, números) y dejando solo saltos de línea entre elementos. Si hay texto introductorio, va en parte separada.

## REGLAS ABSOLUTAS DE FORMATO:

- SIEMPRE devuelve exactamente 3 propiedades: parte1, parte2, parte3
- NUNCA omitas ninguna propiedad
- NUNCA uses null en ninguna parte
- Si una parte está vacía, usa "" (string vacío)
- El JSON debe ser válido sin errores de escape
- TODAS las comillas dentro del texto deben escaparse correctamente

### Ejemplos

Ejemplo 1 - Lista con introducción:
Entrada: "¡Genial! Me podrías indicar también:\\n\\n- Profesión\\n- Antigüedad (años en el trabajo)\\n- Ingresos netos mensuales (opcional)\\n- ¿Dispones de ahorro para la compra?"

Salida:
{
  "parte1": "¡Genial! Me podrías indicar también:",
  "parte2": "Profesión\\nAntigüedad (años en el trabajo)\\nIngresos netos mensuales (opcional)\\n¿Dispones de ahorro para la compra?",
  "parte3": ""
}

Ejemplo 2 - Dos párrafos sin lista:
{
  "parte1": "Primer párrafo completo.",
  "parte2": "Segundo párrafo completo.",
  "parte3": ""
}

Ejemplo 3 - Una sola frase:
{
  "parte1": "Una única frase corta.",
  "parte2": "",
  "parte3": ""
}

Ejemplo 4 - Párrafo + lista + párrafo:
Entrada: "Aquí están los requisitos:\\n\\n- Requisito 1\\n- Requisito 2\\n- Requisito 3\\n\\n¿Te parece bien?"

Salida:
{
  "parte1": "Aquí están los requisitos:",
  "parte2": "Requisito 1\\nRequisito 2\\nRequisito 3",
  "parte3": "¿Te parece bien?"
}

RECORDATORIO FINAL:
Formato correcto cuando solo hay 1 fragmento:
{
  "parte1": "Todo el texto aquí.",
  "parte2": "",
  "parte3": ""
}`;

    const response = await withRetry(() =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'message_parts',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                parte1: {
                  type: 'string',
                  description: 'Primera parte del mensaje'
                },
                parte2: {
                  type: 'string',
                  description: 'Segunda parte del mensaje (vacío si solo hay 1 fragmento)'
                },
                parte3: {
                  type: 'string',
                  description: 'Tercera parte del mensaje (vacío si hay 1 o 2 fragmentos)'
                }
              },
              required: ['parte1', 'parte2', 'parte3'],
              additionalProperties: false
            }
          }
        },
        temperature: 0.3 // Baja temperatura para consistencia
      })
    );

    const content = response.choices[0].message.content;
    const result = JSON.parse(content);

    logger.info('Mensaje dividido exitosamente', {
      parte1Length: result.parte1.length,
      parte2Length: result.parte2.length,
      parte3Length: result.parte3.length,
      totalParts: [result.parte1, result.parte2, result.parte3].filter(p => p.length > 0).length
    });

    return result;

  } catch (error) {
    logger.error('Error dividiendo mensaje con LLM', {
      error: error.message,
      stack: error.stack
    });

    // Fallback: retornar el mensaje original sin dividir
    logger.warn('Usando fallback: mensaje sin dividir');
    return {
      parte1: message,
      parte2: '',
      parte3: ''
    };
  }
}

module.exports = {
  splitMessageWithLLM
};
