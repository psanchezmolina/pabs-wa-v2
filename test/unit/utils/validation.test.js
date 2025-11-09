const { expect } = require('chai');
const { validateGHLPayload, validateWhatsAppPayload, splitMessage } = require('../../../utils/validation');

describe('Validation Utils', () => {

  describe('validateGHLPayload', () => {
    it('should validate correct SMS payload', () => {
      const payload = {
        locationId: 'loc123',
        messageId: 'msg456',
        contactId: 'contact789',
        message: 'Test message',
        type: 'SMS'
      };

      const result = validateGHLPayload(payload);
      expect(result.valid).to.be.true;
    });

    it('should accept body field instead of message', () => {
      const payload = {
        locationId: 'loc123',
        messageId: 'msg456',
        contactId: 'contact789',
        body: 'Test message',
        type: 'SMS'
      };

      const result = validateGHLPayload(payload);
      expect(result.valid).to.be.true;
    });

    it('should reject payload without locationId', () => {
      const payload = {
        messageId: 'msg456',
        contactId: 'contact789',
        message: 'Test',
        type: 'SMS'
      };

      const result = validateGHLPayload(payload);
      expect(result.valid).to.be.false;
      expect(result.missing).to.equal('locationId');
    });

    it('should reject non-SMS type', () => {
      const payload = {
        locationId: 'loc123',
        messageId: 'msg456',
        contactId: 'contact789',
        message: 'Test',
        type: 'OutboundMessage'
      };

      const result = validateGHLPayload(payload);
      expect(result.valid).to.be.false;
      expect(result.reason).to.include('Only SMS type processed');
    });

    it('should reject already delivered messages', () => {
      const payload = {
        locationId: 'loc123',
        messageId: 'msg456',
        contactId: 'contact789',
        message: 'Test',
        type: 'SMS',
        status: 'delivered'
      };

      const result = validateGHLPayload(payload);
      expect(result.valid).to.be.false;
      expect(result.reason).to.include('already delivered');
    });
  });

  describe('validateWhatsAppPayload', () => {
    it('should validate correct WhatsApp payload', () => {
      const payload = {
        instance: 'test-instance',
        data: {
          key: {
            remoteJid: '34660722687@s.whatsapp.net',
            id: 'msg123',
            fromMe: false
          }
        }
      };

      const result = validateWhatsAppPayload(payload);
      expect(result.valid).to.be.true;
    });

    it('should reject payload without instance', () => {
      const payload = {
        data: {
          key: {
            remoteJid: '34660722687@s.whatsapp.net',
            id: 'msg123'
          }
        }
      };

      const result = validateWhatsAppPayload(payload);
      expect(result.valid).to.be.false;
      expect(result.missing).to.equal('instance');
    });

    it('should reject payload without data.key', () => {
      const payload = {
        instance: 'test-instance',
        data: {}
      };

      const result = validateWhatsAppPayload(payload);
      expect(result.valid).to.be.false;
      expect(result.missing).to.equal('data.key');
    });
  });

  describe('splitMessage', () => {
    it('should not split short messages', () => {
      const message = 'Short message';
      const result = splitMessage(message);

      expect(result).to.be.an('array');
      expect(result).to.have.length(1);
      expect(result[0]).to.equal(message);
    });

    it('should split messages longer than 3500 chars', () => {
      const longMessage = 'a'.repeat(5000);
      const result = splitMessage(longMessage);

      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(1);
      expect(result[0]).to.include('📝 [Parte 1/');
    });

    it('should handle custom max length', () => {
      const message = 'a'.repeat(200);
      const result = splitMessage(message, 100);

      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(1);
      expect(result[0].length).to.be.at.most(120); // Incluye marcador de parte
    });

    it('should handle null/undefined messages', () => {
      expect(splitMessage(null)).to.deep.equal([null]);
      expect(splitMessage(undefined)).to.deep.equal([undefined]);
    });

    it('should split at newlines when possible', () => {
      const message = 'a'.repeat(3400) + '\n' + 'b'.repeat(100);
      const result = splitMessage(message);

      expect(result).to.be.an('array');
      // Debería dividir en el salto de línea
      expect(result[0]).to.not.include('b');
    });
  });
});
