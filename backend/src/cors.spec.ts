import { isOriginAllowed, parseAllowedOrigins } from './cors';

describe('CORS', () => {
  it('normaliza la lista de origenes', () => {
    expect(parseAllowedOrigins(' https://a.example.com/ , ,https://b.example.com ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('sin configuracion mantiene el comportamiento historico', () => {
    expect(isOriginAllowed('https://cualquiera.example.com', [])).toBe(true);
  });

  it('sin configuracion falla cerrado en produccion', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(isOriginAllowed('https://cualquiera.example.com', [])).toBe(false);
      expect(isOriginAllowed(undefined, [])).toBe(true);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('con configuracion solo acepta los origenes listados', () => {
    const allowed = ['https://bankapi-web.onrender.com'];
    expect(isOriginAllowed('https://bankapi-web.onrender.com/', allowed)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
  });

  it('acepta peticiones sin cabecera Origin (no son CORS)', () => {
    expect(isOriginAllowed(undefined, ['https://a.example.com'])).toBe(true);
  });
});
