const { expect } = require('chai');
const { validateGHLPayload, validateWhatsAppPayload, truncateMessage } = require('../../../utils/validation');

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

  describe('truncateMessage', () => {
    it('should not truncate short messages', () => {
      const message = 'Short message';
      const result = truncateMessage(message);

      expect(result.truncated).to.be.false;
      expect(result.text).to.equal(message);
    });

    it('should truncate messages longer than 4096 chars', () => {
      const longMessage = 'a'.repeat(5000);
      const result = truncateMessage(longMessage);

      expect(result.truncated).to.be.true;
      expect(result.originalLength).to.equal(5000);
      expect(result.text.length).to.be.at.most(4096);
      expect(result.text).to.include('[Mensaje truncado');
    });

    it('should handle custom max length', () => {
      const message = 'a'.repeat(200);
      const result = truncateMessage(message, 100);

      expect(result.truncated).to.be.true;
      expect(result.text.length).to.be.at.most(100);
    });

    it('should handle null/undefined messages', () => {
      expect(truncateMessage(null).truncated).to.be.false;
      expect(truncateMessage(undefined).truncated).to.be.false;
    });
  });
});
