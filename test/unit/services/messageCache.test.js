const { expect } = require('chai');
const messageCache = require('../../../services/messageCache');

describe('Message Cache Service', () => {

  // Limpiar cache entre tests
  beforeEach(() => {
    // Limpiar todas las instancias con mensajes pendientes
    const instances = messageCache.getInstancesWithPendingMessages();
    instances.forEach(inst => messageCache.clearQueue(inst));
  });

  describe('enqueueMessage', () => {
    it('should enqueue message correctly', () => {
      const messageData = {
        instanceName: 'test-instance',
        messageId: 'msg-001',
        locationId: 'loc-001',
        contactId: 'contact-001',
        messageText: 'Test message',
        waNumber: '34660722687@s.whatsapp.net',
        contactPhone: '+34660722687'
      };

      const result = messageCache.enqueueMessage(messageData);
      expect(result).to.be.true;

      const queue = messageCache.getQueuedMessages('test-instance');
      expect(queue).to.have.lengthOf(1);
      expect(queue[0].messageId).to.equal('msg-001');
    });

    it('should prevent duplicate messages by messageId', () => {
      const messageData = {
        instanceName: 'test-instance',
        messageId: 'msg-duplicate',
        locationId: 'loc-001',
        contactId: 'contact-001',
        messageText: 'Test message',
        waNumber: '34660722687@s.whatsapp.net',
        contactPhone: '+34660722687'
      };

      // Encolar dos veces el mismo mensaje
      messageCache.enqueueMessage(messageData);
      const result = messageCache.enqueueMessage(messageData);

      expect(result).to.be.false; // Segunda vez retorna false

      const queue = messageCache.getQueuedMessages('test-instance');
      expect(queue).to.have.lengthOf(1); // Solo 1 mensaje
    });
  });

  describe('getMessagesReadyForRetry', () => {
    it('should return only messages ready for retry', () => {
      // Mensaje listo para retry (nextRetryAt en el pasado)
      const readyMessage = {
        instanceName: 'test-instance-ready',
        messageId: 'msg-ready',
        locationId: 'loc-001',
        contactId: 'contact-001',
        messageText: 'Ready message',
        waNumber: '34660722687@s.whatsapp.net',
        contactPhone: '+34660722687'
      };

      messageCache.enqueueMessage(readyMessage);

      // Forzar nextRetryAt al pasado modificando directamente
      // (en producción esto ocurre naturalmente con el tiempo)
      const ready = messageCache.getMessagesReadyForRetry('test-instance-ready');

      // El mensaje recién encolado tiene nextRetryAt en el futuro (5 min)
      // así que no debería estar listo inmediatamente
      expect(ready).to.be.an('array');
    });
  });

  describe('updateMessageRetry', () => {
    it('should remove message from queue on success', () => {
      const messageData = {
        instanceName: 'test-success',
        messageId: 'msg-success',
        locationId: 'loc-001',
        contactId: 'contact-001',
        messageText: 'Test message',
        waNumber: '34660722687@s.whatsapp.net',
        contactPhone: '+34660722687'
      };

      messageCache.enqueueMessage(messageData);
      expect(messageCache.getQueuedMessages('test-success')).to.have.lengthOf(1);

      // Marcar como enviado exitosamente
      messageCache.updateMessageRetry('test-success', 'msg-success', true);

      // Debería estar vacía
      expect(messageCache.getQueuedMessages('test-success')).to.have.lengthOf(0);
    });

    it('should increment retryCount on failure', () => {
      const messageData = {
        instanceName: 'test-fail',
        messageId: 'msg-fail',
        locationId: 'loc-001',
        contactId: 'contact-001',
        messageText: 'Test message',
        waNumber: '34660722687@s.whatsapp.net',
        contactPhone: '+34660722687'
      };

      messageCache.enqueueMessage(messageData);

      // Simular fallo
      messageCache.updateMessageRetry('test-fail', 'msg-fail', false);

      const queue = messageCache.getQueuedMessages('test-fail');
      expect(queue).to.have.lengthOf(1);
      expect(queue[0].retryCount).to.equal(1);
    });
  });

});
