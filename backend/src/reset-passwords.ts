import dataSource from './database/data-source';
import { readMaintenanceCredentials } from './users/maintenance-credentials';
import { resetOneAdminPassword } from './users/maintenance-operations';

/**
 * Explicit break-glass operation for one named, active admin. Never resets a
 * group of accounts and never reactivates an account. Read the target and new
 * secret from process environment only (not CLI arguments or .env files).
 */
export const resetNamedAdminPassword = async () => {
  const credentials = readMaintenanceCredentials(process.env, 'RESET_ONE_ADMIN_PASSWORD');
  await dataSource.initialize();
  try {
    await resetOneAdminPassword(dataSource, credentials);
  } finally {
    await dataSource.destroy();
  }
};

if (require.main === module) {
  resetNamedAdminPassword()
    .then(() => console.info('Clave del administrador indicado actualizada.'))
    .catch(() => {
      // Avoid printing database or driver errors, which may contain sensitive data.
      console.error('Restablecimiento rechazado o fallido; revisar destino, autorización y usuario.');
      process.exitCode = 1;
    });
}
