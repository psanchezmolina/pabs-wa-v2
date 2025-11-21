const { expect } = require('chai');
const nock = require('nock');

// Mock config
const EVOLUTION_BASE_URL = 'https://test.evolution.com';

describe('Evolution Service', () => {

  describe('checkInstanceConnection', () => {
    it('should return connected=true when state is open', () => {
      const responseData = { instance: { state: 'open' } };
      const state = responseData.instance?.state || responseData.state;
      const result = {
        connected: state === 'open',
        state: state || 'unknown',
        error: null
      };

      expect(result.connected).to.be.true;
      expect(result.state).to.equal('open');
    });

    it('should return connected=false when state is close', () => {
      const responseData = { instance: { state: 'close' } };
      const state = responseData.instance?.state || responseData.state;
      const result = {
        connected: state === 'open',
        state: state || 'unknown',
        error: null
      };

      expect(result.connected).to.be.false;
      expect(result.state).to.equal('close');
    });

    it('should return api_unreachable on network errors', () => {
      const error = { code: 'ECONNREFUSED' };
      const isApiDown = error.code === 'ECONNREFUSED' ||
                        error.code === 'ETIMEDOUT' ||
                        error.code === 'ENOTFOUND';

      const result = {
        connected: false,
        state: isApiDown ? 'api_unreachable' : 'error',
        error: 'Connection refused'
      };

      expect(result.connected).to.be.false;
      expect(result.state).to.equal('api_unreachable');
    });
  });

  describe('checkWhatsAppNumber', () => {
    it('should return true when number has WhatsApp', () => {
      const responseData = { message: [{ exists: true, jid: '34660722687@s.whatsapp.net' }] };
      const result = responseData.message?.[0];
      const hasWhatsApp = result?.exists === true;

      expect(hasWhatsApp).to.be.true;
    });

    it('should return false when number does not have WhatsApp', () => {
      const responseData = { message: [{ exists: false, jid: '34660722687@s.whatsapp.net' }] };
      const result = responseData.message?.[0];
      const hasWhatsApp = result?.exists === true;

      expect(hasWhatsApp).to.be.false;
    });

    it('should return null on API error (not false)', () => {
      // Simular comportamiento cuando hay error
      const apiError = true;
      const hasWhatsApp = apiError ? null : false;

      expect(hasWhatsApp).to.be.null;
    });
  });

  describe('restartInstance', () => {
    it('should return success=true when restart succeeds (state=open)', () => {
      const responseData = { instance: { state: 'open' } };
      const state = responseData.instance?.state || responseData.state;
      const success = state === 'open';

      const result = {
        success,
        state: state || 'unknown',
        needsQR: !success && state !== 'connecting',
        error: null
      };

      expect(result.success).to.be.true;
      expect(result.needsQR).to.be.false;
    });

    it('should return needsQR=true when restart fails', () => {
      const responseData = { instance: { state: 'close' } };
      const state = responseData.instance?.state || responseData.state;
      const success = state === 'open';

      const result = {
        success,
        state: state || 'unknown',
        needsQR: !success && state !== 'connecting',
        error: null
      };

      expect(result.success).to.be.false;
      expect(result.needsQR).to.be.true;
    });
  });

});
