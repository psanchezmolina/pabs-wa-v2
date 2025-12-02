const { expect } = require('chai');
const { parseFlowiseResponse } = require('../../../services/flowise');

describe('Flowise Service', () => {
  describe('parseFlowiseResponse', () => {
    it('should parse valid JSON with all 3 parts', () => {
      const mockResponse = [{
        text: JSON.stringify({
          parte1: 'Primera parte',
          parte2: 'Segunda parte',
          parte3: 'Tercera parte'
        })
      }];

      const result = parseFlowiseResponse(mockResponse);

      expect(result).to.deep.equal({
        parte1: 'Primera parte',
        parte2: 'Segunda parte',
        parte3: 'Tercera parte'
      });
    });

    it('should parse valid JSON with only parte1', () => {
      const mockResponse = [{
        text: JSON.stringify({
          parte1: 'Solo primera parte',
          parte2: null,
          parte3: null
        })
      }];

      const result = parseFlowiseResponse(mockResponse);

      expect(result.parte1).to.equal('Solo primera parte');
      expect(result.parte2).to.be.null;
      expect(result.parte3).to.be.null;
    });

    it('should handle JSON with newlines (cleanup)', () => {
      const mockResponse = [{
        text: '{\n"parte1": "Primera",\n"parte2": "Segunda",\n"parte3": null\n}'
      }];

      const result = parseFlowiseResponse(mockResponse);

      expect(result.parte1).to.equal('Primera');
      expect(result.parte2).to.equal('Segunda');
    });

    it('should fallback when JSON is completely invalid', () => {
      const mockResponse = [{
        text: 'This is not JSON at all'
      }];

      const result = parseFlowiseResponse(mockResponse);

      expect(result.parte1).to.equal('This is not JSON at all');
      expect(result.parte2).to.be.null;
      expect(result.parte3).to.be.null;
    });

    it('should handle empty response', () => {
      const mockResponse = [];

      const result = parseFlowiseResponse(mockResponse);

      expect(result.parte1).to.include('Error');
    });

    it('should handle response with no text field', () => {
      const mockResponse = [{
        question: 'test',
        chatId: 'chat123'
      }];

      const result = parseFlowiseResponse(mockResponse);

      expect(result.parte1).to.include('Error');
    });

    it('should convert literal \\n strings to actual newlines', () => {
      const mockResponse = [{
        text: JSON.stringify({
          parte1: '¿Te vendrían bien las siguientes horas?',
          parte2: '📅 Mañana a las 10:00 AM\\n📅 Mañana a las 11:00 AM\\n📅 Mañana a las 12:00 PM',
          parte3: '¿Cuál te viene mejor?'
        })
      }];

      const result = parseFlowiseResponse(mockResponse);

      expect(result.parte1).to.equal('¿Te vendrían bien las siguientes horas?');
      expect(result.parte2).to.equal('📅 Mañana a las 10:00 AM\n📅 Mañana a las 11:00 AM\n📅 Mañana a las 12:00 PM');
      expect(result.parte3).to.equal('¿Cuál te viene mejor?');

      // Verificar que contiene saltos de línea reales, no strings literales
      expect(result.parte2).to.not.include('\\n');
      expect(result.parte2.split('\n').length).to.equal(3);
    });
  });
});
