import dataSource from './database/data-source';
import { readMaintenanceCredentials } from './users/maintenance-credentials';
import { createInitialAdmin } from './users/maintenance-operations';

/**
 * Explicit one-time bootstrap for a migrated, empty database. Unlike the old
 * seed, this command never creates sample users or reads a local .env file.
 * Use only after identifying the exact DB target and arranging recovery.
 */
export const provisionInitialAdmin = async () => {
  const credentials = readMaintenanceCredentials(process.env, 'CREATE_INITIAL_ADMIN');
  await dataSource.initialize();
  try {
    await createInitialAdmin(dataSource, credentials);
  } finally {
    await dataSource.destroy();
  }
};

if (require.main === module) {
  provisionInitialAdmin()
    .then(() => console.info('Administrador inicial provisionado.'))
    .catch(() => {
      // Database/driver exceptions may contain connection details: never print them here.
      console.error('Provisionamiento rechazado o fallido; revisar destino, autorización y estado de la base.');
      process.exitCode = 1;
    });
}
