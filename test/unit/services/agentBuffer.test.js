const { expect } = require('chai');
const sinon = require('sinon');
const {
  pushMessage,
  getBuffer,
  clearBuffer,
  setupDebounce,
  cancelDebounce
} = require('../../../services/agentBuffer');

describe('Agent Buffer Service', () => {
  const contactId = 'contact_123';
  const canal = 'SMS';
  let clock;

  beforeEach(() => {
    clearBuffer(contactId, canal);
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    cancelDebounce(contactId, canal);
    clock.restore();
  });

  describe('Buffer Management', () => {
    it('should push and retrieve messages from buffer', () => {
      pushMessage(contactId, canal, 'Message 1');
      pushMessage(contactId, canal, 'Message 2');

      const buffer = getBuffer(contactId, canal);
      expect(buffer).to.have.lengthOf(2);
      expect(buffer).to.deep.equal(['Message 1', 'Message 2']);
    });

    it('should enforce limit of 7 messages per buffer', () => {
      for (let i = 0; i < 10; i++) {
        pushMessage(contactId, canal, `Message ${i}`);
      }

      const buffer = getBuffer(contactId, canal);
      expect(buffer).to.have.lengthOf(7);
    });

    it('should keep separate buffers per canal', () => {
      pushMessage(contactId, 'SMS', 'SMS message');
      pushMessage(contactId, 'IG', 'IG message');

      const smsBuffer = getBuffer(contactId, 'SMS');
      const igBuffer = getBuffer(contactId, 'IG');

      expect(smsBuffer).to.have.lengthOf(1);
      expect(igBuffer).to.have.lengthOf(1);
    });

    it('should clear buffer', () => {
      pushMessage(contactId, canal, 'Message 1');
      clearBuffer(contactId, canal);

      const buffer = getBuffer(contactId, canal);
      expect(buffer).to.have.lengthOf(0);
    });
  });

  describe('Debounce Timer', () => {
    it('should execute callback after delay', () => {
      const callback = sinon.spy();
      setupDebounce(contactId, canal, callback, 7000);

      clock.tick(7000);
      expect(callback.calledOnce).to.be.true;
    });

    it('should reset timer when new message arrives', () => {
      const callback = sinon.spy();

      setupDebounce(contactId, canal, callback, 7000);
      clock.tick(5000);

      setupDebounce(contactId, canal, callback, 7000);
      clock.tick(5000);
      expect(callback.called).to.be.false;

      clock.tick(2000);
      expect(callback.calledOnce).to.be.true;
    });

    it('should cancel debounce manually', () => {
      const callback = sinon.spy();
      setupDebounce(contactId, canal, callback, 7000);

      const cancelled = cancelDebounce(contactId, canal);
      expect(cancelled).to.be.true;

      clock.tick(7000);
      expect(callback.called).to.be.false;
    });
  });
});
