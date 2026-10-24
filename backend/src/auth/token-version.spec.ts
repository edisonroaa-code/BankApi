import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { UserRole } from '../users/entities/user.entity';

describe('JWT session version', () => {
  const activeUser = {
    id: 'user-1', username: 'cashier', name: 'Cashier', role: UserRole.CAJERO,
    isActive: true, tokenVersion: 3,
  };

  it('signs the persistent token version at login', async () => {
    const jwt = { sign: jest.fn().mockReturnValue('signed-test-token') };
    const auth = new AuthService({} as any, jwt as any);

    await auth.login(activeUser);

    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1', tokenVersion: 3 }));
  });

  it('accepts only the current version of an active user', async () => {
    const users = { findOneById: jest.fn().mockResolvedValue(activeUser) };
    const strategy = new JwtStrategy({ get: () => 'test-signing-secret' } as any, users as any);

    await expect(strategy.validate({ sub: activeUser.id, tokenVersion: 3 }))
      .resolves.toMatchObject({ userId: activeUser.id, role: UserRole.CAJERO });
    await expect(strategy.validate({ sub: activeUser.id, tokenVersion: 2 }))
      .rejects.toThrow(UnauthorizedException);
  });

  it('rejects pre-migration JWTs without a version even when the user is active', async () => {
    const users = { findOneById: jest.fn().mockResolvedValue({ ...activeUser, tokenVersion: 0 }) };
    const strategy = new JwtStrategy({ get: () => 'test-signing-secret' } as any, users as any);

    await expect(strategy.validate({ sub: activeUser.id })).rejects.toThrow(UnauthorizedException);
  });
});
