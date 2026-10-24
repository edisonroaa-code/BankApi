import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { User } from './entities/user.entity';
import { UserRole } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('user update authorization at the mutation boundary', () => {
  const makeController = (actorRoleAtMutation: UserRole, targetRoleAtMutation: UserRole) => {
    const staleTarget = {
      id: 'target-1', name: 'Target', username: 'target', role: UserRole.COBRADOR, isActive: true,
    };
    const users = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.id === 'actor-1') {
          return { id: 'actor-1', role: actorRoleAtMutation, isActive: true, deletedAt: null };
        }
        return { ...staleTarget, role: targetRoleAtMutation };
      }),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((value) => value),
      save: jest.fn((value) => Promise.resolve({ ...value, id: 'created-1' })),
    };
    const auditRepo = { create: jest.fn((value) => value), save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn(),
      getRepository: jest.fn((entity) => entity === User ? users : entity === AuditLog ? auditRepo : undefined),
    };
    const repository = {
      manager: { transaction: jest.fn((work) => work(manager)) },
      findOne: jest.fn().mockResolvedValue(staleTarget),
      create: users.create,
      save: users.save,
    };
    const accessEvents = { emitAccessRevoked: jest.fn() };
    const controller = new UsersController(new UsersService(repository as any), accessEvents as any);
    return { controller, users, auditRepo, accessEvents };
  };

  it('rejects a supervisor when the target becomes an admin after the stale pre-read', async () => {
    const { controller, users, auditRepo } = makeController(UserRole.SUPERVISOR, UserRole.ADMIN);

    await expect(controller.update('target-1', { name: 'Modified' }, {
      user: { userId: 'actor-1', username: 'supervisor', role: UserRole.SUPERVISOR },
    })).rejects.toThrow(ForbiddenException);

    expect(users.update).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('rejects an actor whose admin role was revoked before the transaction', async () => {
    const { controller, users, auditRepo } = makeController(UserRole.SUPERVISOR, UserRole.ADMIN);

    await expect(controller.update('target-1', { name: 'Modified' }, {
      user: { userId: 'actor-1', username: 'former-admin', role: UserRole.ADMIN },
    })).rejects.toThrow(ForbiddenException);

    expect(users.update).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('allows a current admin and audits only the successful change', async () => {
    const { controller, users, auditRepo } = makeController(UserRole.ADMIN, UserRole.COBRADOR);

    await controller.update('target-1', { name: 'Modified' }, {
      user: { userId: 'actor-1', username: 'admin', role: UserRole.ADMIN },
    });

    expect(users.update).toHaveBeenCalledWith('target-1', { name: 'Modified' });
    expect(auditRepo.save).toHaveBeenCalledTimes(1);
  });

  it('does not create or audit a user after the actor loses ADMIN', async () => {
    const { controller, users, auditRepo } = makeController(UserRole.SUPERVISOR, UserRole.COBRADOR);

    await expect(controller.create({
      name: 'New cashier', username: 'new-cashier', role: UserRole.CAJERO, password: 'unique-test-password',
    }, { user: { userId: 'actor-1', username: 'former-admin', role: UserRole.ADMIN } }))
      .rejects.toThrow(ForbiddenException);

    expect(users.save).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('does not delete or audit a user after the actor loses ADMIN', async () => {
    const { controller, users, auditRepo } = makeController(UserRole.SUPERVISOR, UserRole.COBRADOR);

    await expect(controller.remove('target-1', {
      user: { userId: 'actor-1', username: 'former-admin', role: UserRole.ADMIN },
    })).rejects.toThrow(ForbiddenException);

    expect(users.update).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('el supervisor ya no edita a nadie: ni la clave de un cajero (decision del 2026-10-07)', async () => {
    const { controller, users, auditRepo } = makeController(UserRole.SUPERVISOR, UserRole.CAJERO);

    await expect(controller.update('target-1', { password: 'Clave-Puesta-Por-Supervisor' }, {
      user: { userId: 'actor-1', username: 'supervisor', role: UserRole.SUPERVISOR },
    })).rejects.toThrow(ForbiddenException);

    expect(users.update).not.toHaveBeenCalled();
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('un usuario repetido responde 409 con un mensaje claro, no un error interno', async () => {
    const { controller, users } = makeController(UserRole.ADMIN, UserRole.COBRADOR);

    await expect(controller.create({
      name: 'Otro', username: 'target', role: UserRole.CAJERO, password: 'unique-test-password-1',
    }, { user: { userId: 'actor-1', username: 'admin', role: UserRole.ADMIN } })).rejects.toThrow('El nombre de usuario ya existe');

    expect(users.save).not.toHaveBeenCalled();
  });

  it('el nombre de un usuario eliminado queda reservado para la auditoria', async () => {
    const { controller, users } = makeController(UserRole.ADMIN, UserRole.COBRADOR);
    users.findOne.mockImplementation(async ({ where }: any) =>
      where.id === 'actor-1'
        ? { id: 'actor-1', role: UserRole.ADMIN, isActive: true, deletedAt: null }
        : { id: 'old-user', deletedAt: new Date('2026-09-30T00:00:00Z') },
    );

    const error = await controller.create({
      name: 'Hugo nuevo', username: 'hugo', role: UserRole.CAJERO, password: 'unique-test-password-1',
    }, { user: { userId: 'actor-1', username: 'admin', role: UserRole.ADMIN } }).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toMatch(/eliminado/);
    expect(users.save).not.toHaveBeenCalled();
  });
});
