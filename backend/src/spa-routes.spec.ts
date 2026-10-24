import { isRouteExcluded } from '@nestjs/serve-static/dist/utils/is-route-excluded.util';
import { SPA_EXCLUDED_ROUTES } from './spa-routes';

const excluded = (url: string) => isRouteExcluded({ originalUrl: url } as any, SPA_EXCLUDED_ROUTES);

describe('Exclusiones del fallback de la SPA', () => {
  it.each(['/api/payments', '/uploads/a.jpg', '/uploads', '/health', '/health/db', '/realtime/x?EIO=4'])(
    'no sirve index.html en %s',
    (url) => expect(excluded(url)).toBe(true),
  );

  it.each(['/', '/login', '/movements', '/panel/transferencias?tab=1'])(
    'deja a la SPA las rutas del frontend (%s)',
    (url) => expect(excluded(url)).toBe(false),
  );
});
