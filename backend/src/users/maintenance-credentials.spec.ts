import { readMaintenanceCredentials } from './maintenance-credentials';

describe('credential maintenance configuration', () => {
  const validLocalEnv = {
    DB_HOST: '127.0.0.1',
    DB_DATABASE: 'transfers_disposable',
    DB_USERNAME: 'operator',
    MAINTENANCE_TARGET_HOST: '127.0.0.1',
    MAINTENANCE_TARGET_DATABASE: 'transfers_disposable',
    MAINTENANCE_OPERATOR: 'test-operator',
    MAINTENANCE_REASON: 'Initial lab setup',
    MAINTENANCE_USERNAME: 'newadmin',
    MAINTENANCE_PASSWORD: 'Lab6#x',
    MAINTENANCE_CONFIRM: 'CREATE_INITIAL_ADMIN',
  };

  it('refuses to run without explicit confirmation', () => {
    expect(() => readMaintenanceCredentials({ ...validLocalEnv, MAINTENANCE_CONFIRM: '' }, 'CREATE_INITIAL_ADMIN'))
      .toThrow(/MAINTENANCE_CONFIRM/);
  });

  it('refuses a database or host that differs from the declared target', () => {
    expect(() => readMaintenanceCredentials({ ...validLocalEnv, DB_DATABASE: 'other' }, 'CREATE_INITIAL_ADMIN'))
      .toThrow(/MAINTENANCE_TARGET/);
    expect(() => readMaintenanceCredentials({ ...validLocalEnv, DB_HOST: 'other' }, 'CREATE_INITIAL_ADMIN'))
      .toThrow(/MAINTENANCE_TARGET/);
  });

  it('requires an environment-supplied six-character secret', () => {
    expect(() => readMaintenanceCredentials({ ...validLocalEnv, MAINTENANCE_PASSWORD: '' }, 'CREATE_INITIAL_ADMIN'))
      .toThrow(/MAINTENANCE_PASSWORD/);
    expect(() => readMaintenanceCredentials({ ...validLocalEnv, MAINTENANCE_PASSWORD: 'too-short' }, 'CREATE_INITIAL_ADMIN'))
      .toThrow(/MAINTENANCE_PASSWORD/);
  });

  it('requires an additional approval and backup reference for managed databases', () => {
    const managed = {
      ...validLocalEnv,
      DB_HOST: 'example.neon.tech',
      MAINTENANCE_TARGET_HOST: 'example.neon.tech',
      DB_SSL: 'true',
    };
    expect(() => readMaintenanceCredentials(managed, 'CREATE_INITIAL_ADMIN')).toThrow(/MAINTENANCE_ALLOW_MANAGED/);
    expect(() => readMaintenanceCredentials({ ...managed, MAINTENANCE_ALLOW_MANAGED: 'YES' }, 'CREATE_INITIAL_ADMIN'))
      .toThrow(/MAINTENANCE_BACKUP_REFERENCE/);
  });

  it('does not let the initial provisioning confirmation authorize a reset', () => {
    expect(() => readMaintenanceCredentials(validLocalEnv, 'RESET_ONE_ADMIN_PASSWORD'))
      .toThrow(/MAINTENANCE_CONFIRM/);
  });

  it('accepts an explicit, targeted initial provisioning request', () => {
    expect(readMaintenanceCredentials(validLocalEnv, 'CREATE_INITIAL_ADMIN')).toEqual({
      username: 'newadmin',
      password: validLocalEnv.MAINTENANCE_PASSWORD,
      operator: 'test-operator',
      reason: 'Initial lab setup',
    });
  });

  it('does not silently trim the operator-supplied password', () => {
    const supplied = ' ab#c ';
    expect(readMaintenanceCredentials({
      ...validLocalEnv,
      MAINTENANCE_PASSWORD: supplied,
    }, 'CREATE_INITIAL_ADMIN').password).toBe(supplied);
  });
});
