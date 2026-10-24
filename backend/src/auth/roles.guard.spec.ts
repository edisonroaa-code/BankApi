import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { UserRole } from '../users/entities/user.entity';

const makeContext = (opts: { metadata?: Record<string, unknown>; user?: any; type?: string }) => {
  const handler = () => undefined;
  for (const [key, value] of Object.entries(opts.metadata ?? {})) {
    Reflect.defineMetadata(key, value, handler);
  }
  return {
    getType: () => opts.type ?? 'http',
    getHandler: () => handler,
    getClass: () => class Dummy { },
    switchToHttp: () => ({ getRequest: () => ({ user: opts.user }) }),
  } as any;
};

describe('RolesGuard (denegacion por defecto)', () => {
  const guard = new RolesGuard(new Reflector());

  it('permite endpoints marcados como publicos sin usuario', () => {
    expect(guard.canActivate(makeContext({ metadata: { [IS_PUBLIC_KEY]: true } }))).toBe(true);
  });

  it('rechaza un endpoint sin roles declarados aunque haya sesion', () => {
    const ctx = makeContext({ user: { role: UserRole.ADMIN } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rechaza un rol que no esta en la lista', () => {
    const ctx = makeContext({
      metadata: { [ROLES_KEY]: [UserRole.ADMIN, UserRole.SUPERVISOR] },
      user: { role: UserRole.COBRADOR },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('permite un rol incluido', () => {
    const ctx = makeContext({
      metadata: { [ROLES_KEY]: [UserRole.ADMIN, UserRole.SUPERVISOR] },
      user: { role: UserRole.SUPERVISOR },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('no interviene fuera de HTTP (el gateway autentica al conectar)', () => {
    expect(guard.canActivate(makeContext({ type: 'ws' }))).toBe(true);
  });
});
