import { assertSafeSynchronize, buildTypeOrmOptions } from './typeorm-options';

const envOf = (values: Record<string, string>) => (key: string) => values[key];

describe('Configuracion de TypeORM', () => {
  it('rechaza synchronize contra Neon aunque NODE_ENV no sea production', () => {
    expect(() =>
      buildTypeOrmOptions(envOf({ DB_HOST: 'ep-example-123-pooler.us-east-1.aws.neon.tech', DB_SYNCHRONIZE: 'true' })),
    ).toThrow(/DB_SYNCHRONIZE=true no esta permitido/);
  });

  it('rechaza synchronize con SSL o en produccion', () => {
    expect(() => assertSafeSynchronize({ synchronize: true, host: 'db.local', ssl: true, nodeEnv: 'development' })).toThrow();
    expect(() => assertSafeSynchronize({ synchronize: true, host: 'localhost', ssl: false, nodeEnv: 'production' })).toThrow();
  });

  it('permite synchronize solo en una base local de desarrollo', () => {
    const options = buildTypeOrmOptions(envOf({ DB_HOST: 'localhost', DB_PORT: '48543' }));
    expect(options.synchronize).toBe(true);
    expect((options as any).port).toBe(48543);
  });

  it('en produccion synchronize queda apagado por defecto y nunca corre migraciones solo', () => {
    const options = buildTypeOrmOptions(
      envOf({ NODE_ENV: 'production', DB_HOST: 'ep-x.neon.tech', DB_SSL: 'true' }),
    );
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
    expect((options as any).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('rechaza una conexion Neon sin TLS', () => {
    expect(() => buildTypeOrmOptions(envOf({
      NODE_ENV: 'production', DB_HOST: 'ep-x.neon.tech', DB_SSL: 'false',
    }))).toThrow(/DB_SSL=true/);
  });
});
