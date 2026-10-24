import { ForbiddenException } from '@nestjs/common';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { User, UserRole } from './entities/user.entity';
import { UsersService } from './users.service';

describe('last active admin protection', () => {
  const makeService = (otherActiveAdmins: number) => {
    const users = {
      findOne: jest.fn().mockResolvedValue({
        id: 'admin-1', username: 'admin-one', name: 'Admin', role: UserRole.ADMIN, isActive: true,
      }),
      count: jest.fn().mockResolvedValue(otherActiveAdmins),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const audit = { create: jest.fn((value) => value), save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity) => entity === User ? users : entity === AuditLog ? audit : undefined),
    };
    const repository = {
      manager: { transaction: jest.fn((work) => work(manager)) },
      findOne: users.findOne,
      count: users.count,
      update: users.update,
    };
    return { service: new UsersService(repository as any), users, manager };
  };

  it('rejects deactivating the last active admin', async () => {
    const { service, users } = makeService(0);

    await expect(service.update('admin-1', { isActive: false }, {
      userId: 'admin-1', role: UserRole.ADMIN,
    })).rejects.toThrow(ForbiddenException);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('rejects downgrading the last active admin', async () => {
    const { service, users } = makeService(0);

    await expect(service.update('admin-1', { role: UserRole.COBRADOR }, {
      userId: 'admin-1', role: UserRole.ADMIN,
    })).rejects.toThrow(ForbiddenException);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('allows deactivation when another active admin exists', async () => {
    const { service, users, manager } = makeService(1);

    await service.update('admin-1', { isActive: false }, { userId: 'admin-1', role: UserRole.ADMIN });

    expect(manager.query).toHaveBeenCalled();
    expect(users.update).toHaveBeenCalledWith('admin-1', { isActive: false });
  });

  it('rejects deleting the last active admin under the same DB lock', async () => {
    const { service, users, manager } = makeService(0);

    await expect(service.softDeleteUser('admin-1', {
      userId: 'admin-2', role: UserRole.ADMIN,
    })).rejects.toThrow(ForbiddenException);
    expect(manager.query).toHaveBeenCalled();
    expect(users.update).not.toHaveBeenCalled();
  });

  it('increments the persistent session version for a password change', async () => {
    const { service, users } = makeService(1);

    await service.update('admin-1', { password: 'hashed-new-test-secret' }, {
      userId: 'admin-1', role: UserRole.ADMIN,
    });

    expect(users.increment).toHaveBeenCalledWith({ id: 'admin-1' }, 'tokenVersion', 1);
  });

  it('does not increment the session version for a name-only change', async () => {
    const { service, users } = makeService(1);

    await service.update('admin-1', { name: 'New Name' }, {
      userId: 'admin-1', role: UserRole.ADMIN,
    });

    expect(users.increment).not.toHaveBeenCalled();
  });

  it('increments the session version when an account is soft-deleted', async () => {
    const { service, users } = makeService(1);

    await service.softDeleteUser('admin-1', { userId: 'admin-2', role: UserRole.ADMIN });

    expect(users.increment).toHaveBeenCalledWith({ id: 'admin-1' }, 'tokenVersion', 1);
  });
});
