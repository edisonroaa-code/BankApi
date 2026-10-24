import { join } from 'path';
import type { DataSourceOptions } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Movement } from '../movements/entities/movement.entity';
import { AuditLog } from '../payments/entities/audit-log.entity';
import { BankTransfer } from '../bank/entities/bank-transfer.entity';
import { BankTransferClaim } from '../bank/entities/bank-transfer-claim.entity';

type EnvReader = (key: string) => string | undefined;

export const ENTITIES = [User, Payment, Movement, AuditLog, BankTransfer, BankTransferClaim];
// En dist solo .js (el build de desarrollo emite tambien .d.ts); con ts-node, .ts.
export const MIGRATIONS_GLOB = join(__dirname, '..', 'migrations', __filename.endsWith('.ts') ? '*.ts' : '*.js');

const MANAGED_HOST_PATTERN = /\.neon\.tech$/i;

export const isManagedDatabase = (host: string | undefined, ssl: boolean) =>
  ssl || MANAGED_HOST_PATTERN.test((host || '').trim());

/**
 * `synchronize` altera el esquema segun las entidades y puede eliminar columnas.
 * Solo se admite contra una base local de desarrollo; produccion y cualquier base
 * administrada (Neon) se actualizan exclusivamente con migraciones versionadas.
 */
export const assertSafeSynchronize = (opts: {
  synchronize: boolean;
  host: string | undefined;
  ssl: boolean;
  nodeEnv: string | undefined;
}) => {
  if (!opts.synchronize) return;
  if (opts.nodeEnv === 'production' || isManagedDatabase(opts.host, opts.ssl)) {
    throw new Error(
      'DB_SYNCHRONIZE=true no esta permitido en produccion ni contra una base administrada (Neon/SSL). ' +
        'Usar migraciones: npm run migration:run.',
    );
  }
};

export const buildTypeOrmOptions = (env: EnvReader): DataSourceOptions => {
  const nodeEnv = env('NODE_ENV');
  const host = env('DB_HOST');
  const ssl = (env('DB_SSL') ?? 'false') === 'true';
  const synchronize = (env('DB_SYNCHRONIZE') ?? (nodeEnv === 'production' ? 'false' : 'true')) === 'true';

  assertSafeSynchronize({ synchronize, host, ssl, nodeEnv });
  if (MANAGED_HOST_PATTERN.test((host || '').trim()) && !ssl) {
    throw new Error('DB_SSL=true es obligatorio para conectar con Neon.');
  }

  return {
    type: 'postgres',
    host,
    port: Number(env('DB_PORT')) || 5432,
    username: env('DB_USERNAME'),
    password: env('DB_PASSWORD'),
    database: env('DB_DATABASE'),
    entities: ENTITIES,
    migrations: [MIGRATIONS_GLOB],
    migrationsRun: false,
    synchronize,
    // Neon (y otros PostgreSQL en la nube) exigen SSL.
    // Neon presenta un certificado TLS valido; no desactivar la autenticacion del servidor.
    ssl: ssl ? { rejectUnauthorized: true } : false,
  };
};
