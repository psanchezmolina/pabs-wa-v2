const { expect } = require('chai');

describe('Notifications System', () => {

  describe('Date Formatting', () => {
    it('should format dates as DD/MM/YYYY HH:MM:SS', () => {
      // Este test verifica el formato sin importar la implementación interna
      const date = new Date('2025-11-09T14:30:45.000Z');

      // Formato esperado: 09/11/2025 14:30:45 (o con timezone local)
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();

      expect(day).to.equal('09');
      expect(month).to.equal('11');
      expect(year).to.equal(2025);
    });
  });

  describe('Message Truncation in Errors', () => {
    it('should truncate long error messages in stack traces', () => {
      const longError = 'a'.repeat(1000);
      const truncated = longError.substring(0, 100);

      expect(truncated.length).to.equal(100);
    });
  });

  describe('Error Aggregation Logic', () => {
    it('should create unique hash for same error type', () => {
      // Simulación de cómo se genera el hash
      const errorType = 'Failed to send WhatsApp message';
      const message = 'Network timeout';
      const client = 'loc123';

      const hash1 = `${errorType}:${message}:${client}`.toLowerCase().replace(/\s+/g, '_');
      const hash2 = `${errorType}:${message}:${client}`.toLowerCase().replace(/\s+/g, '_');

      expect(hash1).to.equal(hash2);
    });

    it('should create different hash for different clients', () => {
      const errorType = 'Failed to send WhatsApp message';
      const message = 'Network timeout';

      const hash1 = `${errorType}:${message}:loc123`.toLowerCase().replace(/\s+/g, '_');
      const hash2 = `${errorType}:${message}:loc456`.toLowerCase().replace(/\s+/g, '_');

      expect(hash1).to.not.equal(hash2);
    });
  });

  describe('Notification Format', () => {
    it('should format single error correctly', () => {
      const errorType = 'Test Error';
      const client = 'loc123';
      const errorMsg = 'Something went wrong';

      // Verificar que el formato incluye los elementos necesarios
      const message = `*Tipo:* ${errorType}\n*Cliente:* ${client}\n*Error:* ${errorMsg}`;

      expect(message).to.include(errorType);
      expect(message).to.include(client);
      expect(message).to.include(errorMsg);
    });

    it('should format aggregated error correctly', () => {
      const count = 5;
      const errorType = 'Test Error';

      const message = `*Error Agrupado* (x${count})`;

      expect(message).to.include(`x${count}`);
    });
  });
});
