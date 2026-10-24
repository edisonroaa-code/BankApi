import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { UserRole } from '../users/entities/user.entity';

type Route = { controller: string; handler: string; method: string; path: string; roles?: UserRole[]; isPublic: boolean };

const findControllerFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return findControllerFiles(full);
    return entry.endsWith('.controller.ts') ? [full] : [];
  });

// Descubre todos los controladores del backend: un controlador nuevo entra solo en la verificacion.
const collectRoutes = (): Route[] => {
  const routes: Route[] = [];
  for (const file of findControllerFiles(join(__dirname, '..'))) {
    const exported = require(file);
    for (const candidate of Object.values(exported)) {
      if (typeof candidate !== 'function') continue;
      const basePath = Reflect.getMetadata(PATH_METADATA, candidate);
      if (basePath === undefined) continue;
      const proto = (candidate as any).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const routePath = Reflect.getMetadata(PATH_METADATA, handler);
        if (routePath === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
        routes.push({
          controller: (candidate as any).name,
          handler: name,
          method,
          path: `/${[basePath, routePath].filter((p) => p && p !== '/').join('/')}`,
          roles: Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, candidate),
          isPublic: !!(Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, candidate)),
        });
      }
    }
  }
  return routes;
};

describe('Politica de rutas', () => {
  const routes = collectRoutes();
  const find = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path);

  it('descubre los controladores', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it('todo endpoint declara roles o es publico de forma explicita', () => {
    const undeclared = routes
      .filter((r) => !r.isPublic && !(r.roles && r.roles.length > 0))
      .map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`);
    expect(undeclared).toEqual([]);
  });

  it('solo login y health son publicos', () => {
    const publicRoutes = routes.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`).sort();
    expect(publicRoutes).toEqual(['GET /health', 'GET /health/db', 'POST /auth/login']);
  });

  it('ya no existe la carga de extractos ni la conciliacion por extracto', () => {
    const removed = routes.filter((r) => r.path.startsWith('/movements') || /^\/payments\/(match|match-preview|:id\/confirm-match)$/.test(r.path));
    expect(removed).toEqual([]);
  });

  it('las decisiones sobre pagos quedan fuera del alcance de cobradores', () => {
    for (const path of ['/payments/:id/confirm-manual', '/payments/:id/reject', '/payments/:id/undo-decision']) {
      const route = find('POST', path);
      expect(route).toBeDefined();
      expect(route!.roles).not.toContain(UserRole.COBRADOR);
    }
  });

  it('caja y admin toman transferencias contra un ticket; solo el admin anula y libera', () => {
    expect(find('POST', '/bank-transfers/:id/claim')!.roles).toEqual([UserRole.CAJERO, UserRole.ADMIN]);
    for (const path of ['/bank-transfers/:id/void', '/bank-transfers/:id/release', '/bank-transfers/:id/history']) {
      expect(find(path.endsWith('history') ? 'GET' : 'POST', path)!.roles).toEqual([UserRole.ADMIN]);
    }
  });

  it('el cobrador concilia, pero nunca anula ni decide sobre pagos ajenos', () => {
    // Puede conciliar: el servicio limita cada conciliacion a las consultas que el mismo cargo.
    expect(find('POST', '/bank-transfers/:id/reconcile')!.roles).toEqual([UserRole.ADMIN, UserRole.COBRADOR]);
    for (const path of ['/bank-transfers/:id/void', '/bank-transfers/:id/release']) {
      expect(find('POST', path)!.roles).not.toContain(UserRole.COBRADOR);
    }
  });

  it('el supervisor solo mira el banco: lee el panel y las candidatas, nunca toma, concilia ni anula', () => {
    for (const [method, path] of [
      ['GET', '/bank-transfers'],
      ['GET', '/bank-transfers/page'],
      ['GET', '/bank-transfers/:id'],
      ['GET', '/bank-transfers/:id/candidate-payments'],
      ['GET', '/bank-transfers/matches'],
      ['GET', '/bank-feed/status'],
    ]) {
      expect(find(method, path)!.roles).toContain(UserRole.SUPERVISOR);
    }
    for (const path of ['/bank-transfers/:id/claim', '/bank-transfers/:id/reconcile', '/bank-transfers/:id/void', '/bank-transfers/:id/release', '/bank-transfers/:id/print', '/bank-transfers/:id/print-preview', '/bank-transfers/:id/review']) {
      expect(find('POST', path)!.roles).not.toContain(UserRole.SUPERVISOR);
    }
  });

  it('marcar revisada una conciliacion de la cola es solo del admin', () => {
    expect(find('POST', '/bank-transfers/:id/review')!.roles).toEqual([UserRole.ADMIN]);
  });

  it('todos los que miran el panel pueden pedir "Actualizar" (la espera la pone el servidor)', () => {
    expect(find('POST', '/bank-feed/refresh')!.roles).toEqual(
      expect.arrayContaining([UserRole.CAJERO, UserRole.COBRADOR, UserRole.SUPERVISOR, UserRole.ADMIN]),
    );
  });

  it('solo el admin crea, edita y elimina usuarios; el supervisor solo ve la lista', () => {
    for (const [method, path] of [['POST', '/users'], ['PATCH', '/users/:id'], ['DELETE', '/users/:id']]) {
      expect(find(method, path)!.roles).toEqual([UserRole.ADMIN]);
    }
    expect(find('GET', '/users')!.roles).toEqual(expect.arrayContaining([UserRole.ADMIN, UserRole.SUPERVISOR]));
  });

  it('el saldo de la cuenta del banco es solo del admin', () => {
    expect(find('GET', '/bank-feed/balance')!.roles).toEqual([UserRole.ADMIN]);
  });

  it('el cajero no accede a consultas de cobradores, usuarios ni reportes', () => {
    const cashierRoutes = routes
      .filter((r) => r.roles?.includes(UserRole.CAJERO))
      .map((r) => r.path)
      .filter((path) => !path.startsWith('/bank-transfers') && !path.startsWith('/bank-feed'));
    expect(cashierRoutes).toEqual([]);
  });
});
