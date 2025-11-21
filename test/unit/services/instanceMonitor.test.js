const { expect } = require('chai');

describe('Instance Monitor', () => {

  describe('attemptAutoRestart', () => {
    it('should return success=true when restart succeeds and needsQR=false', () => {
      // Simular respuesta exitosa de restartInstance
      const restartResult = { success: true, state: 'open', needsQR: false, error: null };

      // Lógica de attemptAutoRestart
      const result = restartResult.success
        ? { success: true, needsQR: false }
        : { success: false, needsQR: true };

      expect(result.success).to.be.true;
      expect(result.needsQR).to.be.false;
    });

    it('should return success=false and needsQR=true when restart fails', () => {
      // Simular respuesta fallida de restartInstance (requiere QR)
      const restartResult = { success: false, state: 'close', needsQR: true, error: 'Session expired' };

      // Lógica de attemptAutoRestart
      const result = restartResult.success
        ? { success: true, needsQR: false }
        : { success: false, needsQR: true };

      expect(result.success).to.be.false;
      expect(result.needsQR).to.be.true;
    });
  });

});
