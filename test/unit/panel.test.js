const { expect } = require('chai');
const sinon = require('sinon');
const nock = require('nock');
const { connectInstance, getConnectionState } = require('../../services/evolution');
const config = require('../../config');

describe('Panel Services - Evolution API Integration', () => {
  const instanceName = 'test-instance';
  const apiKey = 'test-api-key';
  const baseURL = config.EVOLUTION_BASE_URL;

  afterEach(() => {
    sinon.restore();
    nock.cleanAll();
  });

  describe('connectInstance', () => {
    it('should generate QR code when no phone number provided', async () => {
      const mockResponse = {
        base64: 'data:image/png;base64,iVBORw0KGgo...',
        code: '2@y8eK+bjtEjUWy9...',
        count: 1
      };

      nock(baseURL)
        .get(`/instance/connect/${instanceName}`)
        .matchHeader('apikey', apiKey)
        .reply(200, mockResponse);

      const result = await connectInstance(instanceName, apiKey);

      expect(result).to.deep.equal(mockResponse);
      expect(result.base64).to.exist;
    });

    it('should generate pairing code when phone number provided', async () => {
      const phoneNumber = '34660722687';
      const mockResponse = {
        pairingCode: 'WZYEH1YY',
        code: '2@y8eK+bjtEjUWy9...',
        count: 1
      };

      nock(baseURL)
        .get(`/instance/connect/${instanceName}?number=${phoneNumber}`)
        .matchHeader('apikey', apiKey)
        .reply(200, mockResponse);

      const result = await connectInstance(instanceName, apiKey, phoneNumber);

      expect(result.pairingCode).to.equal('WZYEH1YY');
    });

    it('should throw error when Evolution API fails', async () => {
      nock(baseURL)
        .get(`/instance/connect/${instanceName}`)
        .matchHeader('apikey', apiKey)
        .reply(404, { error: 'Instance not found' });

      try {
        await connectInstance(instanceName, apiKey);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.exist;
        expect(error.response.status).to.equal(404);
      }
    });
  });

  describe('getConnectionState', () => {
    it('should return valid connection states', async () => {
      const states = ['open', 'close', 'connecting'];

      for (const state of states) {
        const mockResponse = {
          instance: {
            instanceName: instanceName,
            state: state
          }
        };

        nock(baseURL)
          .get(`/instance/connectionState/${instanceName}`)
          .matchHeader('apikey', apiKey)
          .reply(200, mockResponse);

        const result = await getConnectionState(instanceName, apiKey);
        expect(result.instance.state).to.equal(state);
      }
    });

    it('should throw error when Evolution API fails', async () => {
      nock(baseURL)
        .get(`/instance/connectionState/${instanceName}`)
        .matchHeader('apikey', apiKey)
        .reply(404, { error: 'Instance not found' });

      try {
        await getConnectionState(instanceName, apiKey);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.exist;
        expect(error.response.status).to.equal(404);
      }
    });
  });
});
