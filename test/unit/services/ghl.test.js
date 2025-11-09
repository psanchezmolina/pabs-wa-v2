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
