const request = require('supertest');
const { expect } = require('chai');
const nock = require('nock');

// NOTA: Este test requiere que server.js exporte la app sin iniciar el servidor
// Para esto, necesitarás modificar server.js para exportar `app`

describe('Webhook Integration Tests', () => {

  // Estos tests están preparados pero comentados hasta que se exporte app de server.js
  // Para habilitar: en server.js añadir al final: module.exports = app;

  describe.skip('GHL Webhook', () => {
    let app;

    before(() => {
      // app = require('../../server');
    });

    it('should reject invalid payload without locationId', async () => {
      const response = await request(app)
        .post('/webhook/ghl')
        .send({
          messageId: 'test123',
          contactId: 'contact456',
          message: 'Test'
        });

      expect(response.status).to.equal(400);
      expect(response.body.error).to.include('Invalid payload');
    });

    it('should reject non-SMS type messages', async () => {
      const response = await request(app)
        .post('/webhook/ghl')
        .send({
          locationId: 'loc123',
          messageId: 'msg456',
          contactId: 'contact789',
          message: 'Test',
          type: 'OutboundMessage'
        });

      expect(response.status).to.equal(400);
    });
  });

  describe.skip('WhatsApp Webhook', () => {
    let app;

    before(() => {
      // app = require('../../server');
    });

    it('should reject payload without instance', async () => {
      const response = await request(app)
        .post('/webhook/whatsapp')
        .send({
          data: {
            key: {
              remoteJid: '34660722687@s.whatsapp.net',
              id: 'msg123'
            }
          }
        });

      expect(response.status).to.equal(400);
      expect(response.body.error).to.include('Invalid payload');
    });
  });

  describe('Health Check', () => {
    // Este test puede funcionar sin modificar server.js si usas la URL real
    it.skip('should return health status', async () => {
      // Mockear las APIs externas
      nock('https://api.openai.com')
        .get('/v1/models')
        .reply(200, { data: [] });

      const response = await request('http://localhost:3000')
        .get('/health');

      expect(response.status).to.be.oneOf([200, 503]);
      expect(response.body).to.have.property('status');
      expect(response.body).to.have.property('services');
    });
  });
});

/**
 * INSTRUCCIONES PARA HABILITAR ESTOS TESTS:
 *
 * 1. Modificar server.js al final:
 *
 *    // Antes:
 *    server = app.listen(PORT, () => {
 *      logger.info(`Server running on port ${PORT}`);
 *    });
 *
 *    // Después:
 *    if (require.main === module) {
 *      // Solo iniciar servidor si se ejecuta directamente
 *      server = app.listen(PORT, () => {
 *        logger.info(`Server running on port ${PORT}`);
 *      });
 *    }
 *
 *    module.exports = app;
 *
 * 2. Descomentar los bloques describe.skip -> describe
 *
 * 3. Ejecutar: npm test
 */
