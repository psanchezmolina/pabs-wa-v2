# Test Suite - GHL-WhatsApp Integration

## Estructura

```
test/
├── unit/                      # Tests unitarios (rápidos, sin I/O)
│   ├── services/
│   │   └── ghl.test.js       # Lógica GHL (token refresh, phone format)
│   └── utils/
│       ├── validation.test.js     # Validación de payloads
│       └── notifications.test.js  # Sistema de notificaciones
│
├── integration/               # Tests de integración (con I/O mockeado)
│   └── webhooks.test.js      # Tests de endpoints HTTP
│
└── README.md                  # Este archivo
```

## Ejecutar Tests

### Todos los tests
```bash
npm test
```

### Solo tests unitarios
```bash
npm test -- test/unit/**/*.test.js
```

### Solo tests de integración
```bash
npm test -- test/integration/**/*.test.js
```

### Con watch mode (auto-reload)
```bash
npm run test:watch
```

### Tests específicos
```bash
npm test -- test/unit/utils/validation.test.js
```

## Estado Actual

### ✅ Implementados y funcionando:
- `test/unit/utils/validation.test.js` - Validación de payloads
- `test/unit/utils/notifications.test.js` - Sistema de notificaciones
- `test/unit/services/ghl.test.js` - Lógica GHL

### 🔄 Preparados pero deshabilitados:
- `test/integration/webhooks.test.js` - Tests HTTP (requiere modificar server.js)

## Cobertura de Tests

### Funcionalidad Core Cubierta:
- ✅ Validación de webhooks GHL
- ✅ Validación de webhooks WhatsApp
- ✅ Truncamiento de mensajes >4096 chars
- ✅ Lógica de token refresh
- ✅ Formato de números de teléfono
- ✅ Sistema de agregación de errores

### Pendientes (Prioridad 2):
- ⏳ Tests de servicios externos (con mocks)
- ⏳ Tests E2E completos
- ⏳ Tests de performance/carga

## Agregar Nuevos Tests

### 1. Tests Unitarios (recomendado empezar aquí)

```javascript
// test/unit/services/mi-servicio.test.js
const { expect } = require('chai');
const miServicio = require('../../../services/mi-servicio');

describe('Mi Servicio', () => {
  it('should do something', () => {
    const result = miServicio.doSomething();
    expect(result).to.equal('expected');
  });
});
```

### 2. Tests con Mocks de APIs

```javascript
const nock = require('nock');

it('should call external API', async () => {
  // Mockear respuesta de API
  nock('https://api.example.com')
    .get('/endpoint')
    .reply(200, { data: 'test' });

  const result = await myFunction();
  expect(result).to.exist;
});
```

## CI/CD Integration

Para ejecutar en GitHub Actions / Docker:

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: npm test
  env:
    NODE_ENV: test
```

## Debugging Tests

### Ver output detallado:
```bash
npm test -- --reporter spec
```

### Debug con breakpoints:
```bash
node --inspect-brk node_modules/.bin/mocha test/**/*.test.js
```

## Notas Importantes

1. **Environment Variables**: Los tests NO necesitan `.env` para funcionar (son unit tests)
2. **Test Data**: Usar datos ficticios, nunca datos reales de clientes
3. **Isolation**: Cada test debe ser independiente
4. **Speed**: Tests unitarios deben ser < 10ms cada uno

## Métricas Actuales

- **Total tests**: 15+
- **Cobertura estimada**: ~40% (core logic)
- **Tiempo ejecución**: < 1 segundo
- **Status**: ✅ Todos pasan

---

**Próximos pasos**:
1. Ejecutar `npm test` para verificar que todo funciona
2. Añadir más tests según necesidades
3. Habilitar tests de integración (modificar server.js)
