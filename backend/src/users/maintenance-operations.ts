import * as bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { User, UserRole } from './entities/user.entity';
import type { MaintenanceCredentials } from './maintenance-credentials';

/** One-time setup only. Even an inactive or soft-deleted user means this is not a new database. */
export const createInitialAdmin = async (
  source: DataSource,
  credentials: MaintenanceCredentials,
): Promise<void> => {
  await source.transaction(async (manager) => {
    // Serialize concurrent provisioners and user creation before checking emptiness.
    await manager.query('LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE');
    const users = manager.getRepository(User);
    if (await users.count() !== 0) {
      throw new Error('La base ya contiene usuarios; no se permite provisionamiento inicial');
    }

    const user = await users.save(users.create({
      name: 'Administrador inicial',
      username: credentials.username,
      password: await bcrypt.hash(credentials.password, 12),
      role: UserRole.ADMIN,
      isActive: true,
    }));
    const audit = manager.getRepository(AuditLog);
    await audit.save(audit.create({
      action: 'INITIAL_ADMIN_PROVISIONED',
      userId: 'system',
      actorUsername: credentials.operator,
      targetUserId: user.id,
      metadata: JSON.stringify({ reason: credentials.reason }),
    }));
  });
};

/** Break-glass operation for exactly one existing, active admin. No reactivation or mass reset. */
export const resetOneAdminPassword = async (
  source: DataSource,
  credentials: MaintenanceCredentials,
): Promise<void> => {
  await source.transaction(async (manager) => {
    const users = manager.getRepository(User);
    const user = await users.findOne({
      where: { username: credentials.username },
      select: ['id', 'role', 'isActive', 'deletedAt'],
      lock: { mode: 'pessimistic_write' },
    });
    if (!user || user.role !== UserRole.ADMIN || !user.isActive || user.deletedAt) {
      throw new Error('El usuario indicado no es un administrador activo');
    }

    const result = await users.update(user.id, {
      password: await bcrypt.hash(credentials.password, 12),
    });
    if (result.affected !== 1) {
      throw new Error('No se pudo actualizar el administrador indicado');
    }
    const incremented = await users.increment({ id: user.id }, 'tokenVersion', 1);
    if (incremented.affected !== 1) {
      throw new Error('No se pudo invalidar la sesión anterior del administrador');
    }

    const audit = manager.getRepository(AuditLog);
    await audit.save(audit.create({
      action: 'ADMIN_PASSWORD_MAINTENANCE_RESET',
      userId: 'system',
      actorUsername: credentials.operator,
      targetUserId: user.id,
      metadata: JSON.stringify({ reason: credentials.reason }),
    }));
  });
};
