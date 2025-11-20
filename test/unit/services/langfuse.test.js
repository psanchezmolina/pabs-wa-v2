const { expect } = require('chai');
const nock = require('nock');
const { getPrompt, clearCache } = require('../../../services/langfuse');
const config = require('../../../config');

describe('Langfuse Service', () => {
  const agentName = 'agente-roi';
  const publicKey = 'pk-lf-test123';
  const secretKey = 'sk-lf-test456';
  const baseURL = config.LANGFUSE_BASE_URL || 'https://langfuse-test.example.com';

  beforeEach(() => {
    clearCache();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('getPrompt', () => {
    it.skip('should fetch prompt from Langfuse API', async () => {
      const mockPrompt = {
        name: agentName,
        prompt: 'Eres un asistente experto en ciclismo...',
        version: 1
      };

      nock(baseURL)
        .get(`/api/public/v2/prompts/${agentName}`)
        .basicAuth({ user: publicKey, pass: secretKey })
        .reply(200, mockPrompt);

      const result = await getPrompt(agentName, publicKey, secretKey);

      expect(result).to.equal('Eres un asistente experto en ciclismo...');
    });

    it.skip('should cache prompt after first fetch', async () => {
      const mockPrompt = {
        name: agentName,
        prompt: 'Test prompt',
        version: 1
      };

      // Solo debe llamar una vez (segunda vez viene del caché)
      const scope = nock(baseURL)
        .get(`/api/public/v2/prompts/${agentName}`)
        .basicAuth({ user: publicKey, pass: secretKey })
        .reply(200, mockPrompt);

      const result1 = await getPrompt(agentName, publicKey, secretKey);
      const result2 = await getPrompt(agentName, publicKey, secretKey);

      expect(result1).to.equal('Test prompt');
      expect(result2).to.equal('Test prompt');
      expect(scope.isDone()).to.be.true; // Verificar que solo se llamó una vez
    });

    it.skip('should use different cache keys for different clients', async () => {
      const publicKey1 = 'pk-lf-client1';
      const publicKey2 = 'pk-lf-client2';

      nock(baseURL)
        .get(`/api/public/v2/prompts/${agentName}`)
        .basicAuth({ user: publicKey1, pass: 'sk-lf-client1' })
        .reply(200, { name: agentName, prompt: 'Prompt client 1', version: 1 });

      nock(baseURL)
        .get(`/api/public/v2/prompts/${agentName}`)
        .basicAuth({ user: publicKey2, pass: 'sk-lf-client2' })
        .reply(200, { name: agentName, prompt: 'Prompt client 2', version: 1 });

      const result1 = await getPrompt(agentName, publicKey1, 'sk-lf-client1');
      const result2 = await getPrompt(agentName, publicKey2, 'sk-lf-client2');

      expect(result1).to.equal('Prompt client 1');
      expect(result2).to.equal('Prompt client 2');
    });

    it('should throw error when credentials are missing', async () => {
      try {
        await getPrompt(agentName, '', secretKey);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('not configured');
      }
    });
  });
});
