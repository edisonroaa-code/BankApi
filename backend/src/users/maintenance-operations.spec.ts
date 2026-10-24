import * as bcrypt from 'bcrypt';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { User, UserRole } from './entities/user.entity';
import { createInitialAdmin, resetOneAdminPassword } from './maintenance-operations';

describe('credential maintenance operations', () => {
  const credentials = {
    username: 'specific-admin',
    password: 'only-for-this-test-password',
    operator: 'test-operator',
    reason: 'Approved recovery test',
  };

  const fakeSource = (existingUsers: number, target?: Partial<User>) => {
    const users = {
      count: jest.fn().mockResolvedValue(existingUsers),
      findOne: jest.fn().mockResolvedValue(target ?? null),
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn((value) => Promise.resolve({ ...value, id: 'new-admin-id' })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const audit = { create: jest.fn((value) => value), save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity) => entity === User ? users : entity === AuditLog ? audit : undefined),
    };
    const source = {
      transaction: jest.fn((work) => work(manager)),
    };
    return { source: source as any, users, audit };
  };

  it('refuses initial provisioning if any user already exists, including an inactive user', async () => {
    const { source, users, audit } = fakeSource(1);

    await expect(createInitialAdmin(source, credentials)).rejects.toThrow(/base.*usuarios/i);

    expect(users.create).not.toHaveBeenCalled();
    expect(users.save).not.toHaveBeenCalled();
    expect(audit.save).not.toHaveBeenCalled();
  });

  it('provisions one admin only on an empty database and audits the change', async () => {
    const { source, users, audit } = fakeSource(0);

    await createInitialAdmin(source, credentials);

    expect(users.save).toHaveBeenCalledTimes(1);
    const created = users.create.mock.calls[0][0];
    expect(created).toMatchObject({ username: credentials.username, role: UserRole.ADMIN, isActive: true });
    expect(await bcrypt.compare(credentials.password, created.password)).toBe(true);
    expect(audit.save).toHaveBeenCalledTimes(1);
    expect(audit.create.mock.calls[0][0]).toMatchObject({
      action: 'INITIAL_ADMIN_PROVISIONED',
      targetUserId: 'new-admin-id',
      actorUsername: credentials.operator,
    });
  });

  it('refuses to reset a non-admin or inactive account', async () => {
    const { source, users } = fakeSource(1, { id: 'collector-1', role: UserRole.COBRADOR, isActive: true });

    await expect(resetOneAdminPassword(source, credentials)).rejects.toThrow(/administrador activo/i);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('resets only the named active admin and records an audit event', async () => {
    const { source, users, audit } = fakeSource(1, {
      id: 'admin-1',
      username: credentials.username,
      role: UserRole.ADMIN,
      isActive: true,
      deletedAt: null,
    });

    await resetOneAdminPassword(source, credentials);

    expect(users.update).toHaveBeenCalledTimes(1);
    const [id, update] = users.update.mock.calls[0];
    expect(id).toBe('admin-1');
    expect(await bcrypt.compare(credentials.password, update.password)).toBe(true);
    expect(users.increment).toHaveBeenCalledWith({ id: 'admin-1' }, 'tokenVersion', 1);
    expect(audit.create.mock.calls[0][0]).toMatchObject({
      action: 'ADMIN_PASSWORD_MAINTENANCE_RESET',
      targetUserId: 'admin-1',
      actorUsername: credentials.operator,
    });
  });
});
