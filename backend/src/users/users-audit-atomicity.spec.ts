import { AuditLog } from '../payments/entities/audit-log.entity';
import { User, UserRole } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('user mutation and audit atomicity', () => {
  const makeHarness = (failAudit: boolean) => {
    let committedUsers = new Map<string, Partial<User>>([
      ['actor-1', { id: 'actor-1', name: 'Admin', username: 'admin', role: UserRole.ADMIN, isActive: true, deletedAt: null }],
      ['target-1', { id: 'target-1', name: 'Original', username: 'collector', role: UserRole.COBRADOR, isActive: true, deletedAt: null }],
    ]);
    let committedAudit: Partial<AuditLog>[] = [];
    const accessEvents = { emitAccessRevoked: jest.fn() };
    const repository = {
      manager: {
        transaction: jest.fn(async (work) => {
          const stagedUsers = new Map([...committedUsers].map(([id, user]) => [id, { ...user }]));
          const stagedAudit = [...committedAudit];
          const users = {
            findOne: jest.fn(async ({ where }: any) => {
              const found = where.id
                ? stagedUsers.get(where.id)
                : [...stagedUsers.values()].find((user) => user.username === where.username);
              return found ? { ...found } : null;
            }),
            count: jest.fn(async () => stagedUsers.size),
            create: jest.fn((value) => ({ ...value })),
            save: jest.fn(async (value) => {
              const saved = { ...value, id: 'new-user-1' };
              stagedUsers.set(saved.id, saved);
              return saved;
            }),
            update: jest.fn(async (id, values) => {
              const current = stagedUsers.get(id);
              if (!current) return { affected: 0 };
              stagedUsers.set(id, { ...current, ...values });
              return { affected: 1 };
            }),
            increment: jest.fn(async (where, field, amount) => {
              const current = stagedUsers.get(where.id);
              if (!current) return { affected: 0 };
              stagedUsers.set(where.id, { ...current, [field]: Number(current[field] || 0) + amount });
              return { affected: 1 };
            }),
          };
          const audit = {
            create: jest.fn((value) => ({ ...value })),
            save: jest.fn(async (value) => {
              if (failAudit) throw new Error('audit unavailable');
              stagedAudit.push(value);
              return value;
            }),
          };
          const manager = {
            query: jest.fn(),
            getRepository: jest.fn((entity) => entity === User ? users : entity === AuditLog ? audit : undefined),
          };
          const result = await work(manager);
          committedUsers = stagedUsers;
          committedAudit = stagedAudit;
          return result;
        }),
      },
    };
    const controller = new UsersController(new UsersService(repository as any), accessEvents as any);
    const request = { user: { userId: 'actor-1', username: 'admin', role: UserRole.ADMIN } };
    return {
      controller, request, accessEvents,
      getUser: (id: string) => committedUsers.get(id),
      getAudit: () => committedAudit,
    };
  };

  it('rolls back user creation when its audit insert fails', async () => {
    const h = makeHarness(true);

    await expect(h.controller.create({
      name: 'New Cashier', username: 'newcashier', role: UserRole.CAJERO, password: 'unique-test-password',
    }, h.request)).rejects.toThrow('audit unavailable');

    expect(h.getUser('new-user-1')).toBeUndefined();
    expect(h.getAudit()).toHaveLength(0);
  });

  it('rolls back a role change when its audit insert fails and emits no revocation', async () => {
    const h = makeHarness(true);

    await expect(h.controller.update('target-1', { role: UserRole.CAJERO }, h.request))
      .rejects.toThrow('audit unavailable');

    expect(h.getUser('target-1')?.role).toBe(UserRole.COBRADOR);
    expect(h.getAudit()).toHaveLength(0);
    expect(h.accessEvents.emitAccessRevoked).not.toHaveBeenCalled();
  });

  it('rolls back deletion when its audit insert fails and emits no revocation', async () => {
    const h = makeHarness(true);

    await expect(h.controller.remove('target-1', h.request)).rejects.toThrow('audit unavailable');

    expect(h.getUser('target-1')?.isActive).toBe(true);
    expect(h.getAudit()).toHaveLength(0);
    expect(h.accessEvents.emitAccessRevoked).not.toHaveBeenCalled();
  });

  it('commits the audit with a successful role change before emitting revocation', async () => {
    const h = makeHarness(false);

    await h.controller.update('target-1', { role: UserRole.CAJERO }, h.request);

    expect(h.getUser('target-1')?.role).toBe(UserRole.CAJERO);
    expect(h.getAudit()).toMatchObject([{ action: 'USER_UPDATED', targetUserId: 'target-1' }]);
    expect(h.accessEvents.emitAccessRevoked).toHaveBeenCalledWith('target-1');
  });

  it('commits deletion and its audit before emitting revocation', async () => {
    const h = makeHarness(false);

    await h.controller.remove('target-1', h.request);

    expect(h.getUser('target-1')?.isActive).toBe(false);
    expect(h.getAudit()).toMatchObject([{ action: 'USER_DELETED', targetUserId: 'target-1' }]);
    expect(h.accessEvents.emitAccessRevoked).toHaveBeenCalledWith('target-1');
  });
});
