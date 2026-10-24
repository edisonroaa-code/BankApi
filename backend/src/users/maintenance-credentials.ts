type Environment = Record<string, string | undefined>;

export type MaintenanceAction = 'CREATE_INITIAL_ADMIN' | 'RESET_ONE_ADMIN_PASSWORD';

export type MaintenanceCredentials = {
  username: string;
  password: string;
  operator: string;
  reason: string;
};

const requireValue = (env: Environment, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio para mantenimiento de credenciales`);
  return value;
};

/**
 * Maintenance commands read only process environment variables. They must
 * never take a password from source code, CLI arguments, or a local .env file.
 */
export const readMaintenanceCredentials = (
  env: Environment,
  action: MaintenanceAction,
): MaintenanceCredentials => {
  const host = requireValue(env, 'DB_HOST');
  const database = requireValue(env, 'DB_DATABASE');
  requireValue(env, 'DB_USERNAME');

  if (requireValue(env, 'MAINTENANCE_TARGET_HOST') !== host ||
      requireValue(env, 'MAINTENANCE_TARGET_DATABASE') !== database) {
    throw new Error('MAINTENANCE_TARGET_HOST/MAINTENANCE_TARGET_DATABASE no coinciden con la base destino');
  }
  if (env.MAINTENANCE_CONFIRM !== action) {
    throw new Error(`MAINTENANCE_CONFIRM debe ser ${action}`);
  }

  const managed = env.NODE_ENV === 'production' || env.DB_SSL === 'true' || /\.neon\.tech$/i.test(host);
  if (managed) {
    if (env.MAINTENANCE_ALLOW_MANAGED !== 'YES') {
      throw new Error('MAINTENANCE_ALLOW_MANAGED=YES es obligatorio para una base administrada o producción');
    }
    requireValue(env, 'MAINTENANCE_BACKUP_REFERENCE');
  }

  const username = requireValue(env, 'MAINTENANCE_USERNAME');
  if (username.length > 60) throw new Error('MAINTENANCE_USERNAME supera 60 caracteres');
  const password = env.MAINTENANCE_PASSWORD;
  if (!password?.trim()) throw new Error('MAINTENANCE_PASSWORD es obligatorio');
  if (password.length !== 6) {
    throw new Error('MAINTENANCE_PASSWORD debe tener seis caracteres');
  }

  return {
    username,
    password,
    operator: requireValue(env, 'MAINTENANCE_OPERATOR'),
    reason: requireValue(env, 'MAINTENANCE_REASON'),
  };
};
