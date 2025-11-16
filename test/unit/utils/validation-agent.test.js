const { expect } = require('chai');
const { validateAgentPayload } = require('../../../utils/validation');

describe('Agent Payload Validation', () => {
  describe('Valid Payloads', () => {
    it('should validate complete payload', () => {
      const payload = {
        contact_id: 'contact_123',
        location_id: 'location_456',
        customData: {
          message_body: 'Hola, qué tal?',
          agente: 'agente-roi'
        },
        message: {
          type: 20
        }
      };

      const result = validateAgentPayload(payload);
      expect(result.valid).to.be.true;
    });

    it('should validate payload with IG and FB channels', () => {
      const payloadIG = {
        contact_id: 'contact_123',
        location_id: 'location_456',
        customData: { message_body: 'IG message', agente: 'agente-roi' },
        message: { type: 18 }
      };

      const payloadFB = {
        contact_id: 'contact_123',
        location_id: 'location_456',
        customData: { message_body: 'FB message', agente: 'agente-roi' },
        message: { type: 11 }
      };

      expect(validateAgentPayload(payloadIG).valid).to.be.true;
      expect(validateAgentPayload(payloadFB).valid).to.be.true;
    });

    it('should accept location.id alternative field', () => {
      const payload = {
        contact_id: 'contact_123',
        location: { id: 'location_456' },
        customData: { message_body: 'Test', agente: 'agente-roi' },
        message: { type: 20 }
      };

      const result = validateAgentPayload(payload);
      expect(result.valid).to.be.true;
    });
  });

  describe('Invalid Payloads', () => {
    it('should reject payload without contact_id', () => {
      const payload = {
        location_id: 'location_456',
        customData: { message_body: 'Test', agente: 'agente-roi' },
        message: { type: 20 }
      };

      const result = validateAgentPayload(payload);
      expect(result.valid).to.be.false;
      expect(result.missing).to.equal('contact_id');
    });

    it('should reject payload without location_id', () => {
      const payload = {
        contact_id: 'contact_123',
        customData: { message_body: 'Test', agente: 'agente-roi' },
        message: { type: 20 }
      };

      const result = validateAgentPayload(payload);
      expect(result.valid).to.be.false;
    });

    it('should reject payload without customData.message_body', () => {
      const payload = {
        contact_id: 'contact_123',
        location_id: 'location_456',
        customData: { agente: 'agente-roi' },
        message: { type: 20 }
      };

      const result = validateAgentPayload(payload);
      expect(result.valid).to.be.false;
    });

    it('should reject payload without customData.agente', () => {
      const payload = {
        contact_id: 'contact_123',
        location_id: 'location_456',
        customData: { message_body: 'Test' },
        message: { type: 20 }
      };

      const result = validateAgentPayload(payload);
      expect(result.valid).to.be.false;
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined payloads', () => {
      expect(() => validateAgentPayload(null)).to.throw(TypeError);
      expect(() => validateAgentPayload(undefined)).to.throw(TypeError);
    });

    it('should handle empty object', () => {
      const result = validateAgentPayload({});
      expect(result.valid).to.be.false;
    });
  });
});
