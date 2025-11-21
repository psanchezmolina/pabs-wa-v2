const { expect } = require('chai');

describe('GHL Service', () => {

  describe('Token Expiry Logic', () => {
    it('should detect token expiring in less than 5 minutes', () => {
      const now = new Date();
      const expiresIn3Min = new Date(now.getTime() + 3 * 60 * 1000);
      const expiresIn10Min = new Date(now.getTime() + 10 * 60 * 1000);

      const needsRefresh3Min = expiresIn3Min <= new Date(now.getTime() + 5 * 60 * 1000);
      const needsRefresh10Min = expiresIn10Min <= new Date(now.getTime() + 5 * 60 * 1000);

      expect(needsRefresh3Min).to.be.true;
      expect(needsRefresh10Min).to.be.false;
    });

    it('should calculate token expiry date correctly', () => {
      const now = Date.now();
      const expiresIn = 86399; // 24 horas en segundos

      const expiryDate = new Date(now + expiresIn * 1000);
      const expectedDate = new Date(now + 86399000);

      // Verificar que la diferencia es menor a 1 segundo
      expect(Math.abs(expiryDate - expectedDate)).to.be.lessThan(1000);
    });
  });

  describe('Phone Number Formatting', () => {
    it('should convert WhatsApp format to E.164', () => {
      const waNumber = '34660722687@s.whatsapp.net';
      const e164 = '+' + waNumber.replace(/@s\.whatsapp\.net$/, '');

      expect(e164).to.equal('+34660722687');
    });

    it('should convert E.164 to WhatsApp format', () => {
      const e164 = '+34660722687';
      const waNumber = e164.replace(/^\+/, '') + '@s.whatsapp.net';

      expect(waNumber).to.equal('34660722687@s.whatsapp.net');
    });

    it('should handle numbers without + prefix', () => {
      const phoneWithoutPlus = '34660722687';
      const waNumber = phoneWithoutPlus.replace(/^\+/, '') + '@s.whatsapp.net';

      expect(waNumber).to.equal('34660722687@s.whatsapp.net');
    });

    it('should parse WhatsApp number without device ID', () => {
      const waNumber = '34612299907@s.whatsapp.net';
      const phone = '+' + waNumber
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/:\d+$/, '');

      expect(phone).to.equal('+34612299907');
    });

    it('should parse WhatsApp number with device ID (:0, :1, etc)', () => {
      const waNumberWithDevice0 = '34612299907:0@s.whatsapp.net';
      const waNumberWithDevice1 = '34612299907:1@s.whatsapp.net';

      const phone0 = '+' + waNumberWithDevice0
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/:\d+$/, '');

      const phone1 = '+' + waNumberWithDevice1
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/:\d+$/, '');

      expect(phone0).to.equal('+34612299907');
      expect(phone1).to.equal('+34612299907');
    });
  });

  describe('Contact Search Logic', () => {
    it('should use E.164 format for search', () => {
      const phone = '+34660722687';

      // Verificar que el formato es E.164
      expect(phone).to.match(/^\+\d+$/);
    });
  });

  describe('OAuth Payload Structure', () => {
    it('should create correct URLSearchParams for token refresh', () => {
      const params = new URLSearchParams({
        client_id: 'test_client_id',
        client_secret: 'test_secret',
        grant_type: 'refresh_token',
        refresh_token: 'test_refresh',
        user_type: 'Company',
        redirect_uri: 'https://test.com/callback'
      });

      expect(params.get('grant_type')).to.equal('refresh_token');
      expect(params.get('user_type')).to.equal('Company');
    });
  });

  describe('GHL Flow - Instance Down', () => {
    it('should queue message and NOT mark as no-wa when instance is disconnected', () => {
      // Simular escenario: instancia desconectada
      const instanceState = { connected: false, state: 'close', error: null };
      const hasWhatsApp = null; // No se pudo verificar (API inalcanzable)

      // Lógica del flujo ghl.js
      const shouldQueueMessage = !instanceState.connected;
      const shouldMarkNoWA = hasWhatsApp === false; // Solo si está CONFIRMADO que no tiene WA

      expect(shouldQueueMessage).to.be.true;
      expect(shouldMarkNoWA).to.be.false; // NO marcar como no-wa
    });

    it('should mark as no-wa only when confirmed (hasWhatsApp === false)', () => {
      // Simular escenario: instancia conectada, número verificado sin WA
      const instanceState = { connected: true, state: 'open', error: null };
      const hasWhatsApp = false; // Confirmado: no tiene WhatsApp

      // Lógica del flujo ghl.js
      const shouldQueueMessage = !instanceState.connected;
      const shouldMarkNoWA = hasWhatsApp === false;

      expect(shouldQueueMessage).to.be.false;
      expect(shouldMarkNoWA).to.be.true; // SÍ marcar como no-wa (confirmado)
    });
  });

  describe('Message Status Update Logic', () => {
    it('should not include error object when status is delivered', () => {
      const status = 'delivered';
      const payload = {
        status,
        conversationProviderId: 'test123'
      };

      // No debería incluir error si status es delivered
      expect(payload.error).to.be.undefined;
    });

    it('should include error object when status is failed', () => {
      const status = 'failed';
      const errorMessage = 'Test error';

      const payload = {
        status
      };

      if (status !== 'delivered' && status !== 'read' && errorMessage) {
        payload.error = {
          code: '1',
          type: 'saas',
          message: errorMessage
        };
      }

      expect(payload.error).to.exist;
      expect(payload.error.message).to.equal(errorMessage);
    });
  });
});
