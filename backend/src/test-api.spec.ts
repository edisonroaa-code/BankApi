import { readLocalSmokeConfig } from './test-api';

describe('local API smoke configuration', () => {
  it('requires operator-provided credentials', () => {
    expect(() => readLocalSmokeConfig({})).toThrow(/TEST_API_USERNAME/);
    expect(() => readLocalSmokeConfig({ TEST_API_USERNAME: 'admin' })).toThrow(/TEST_API_PASSWORD/);
  });

  it('refuses non-local API destinations', () => {
    expect(() => readLocalSmokeConfig({
      TEST_API_USERNAME: 'admin',
      TEST_API_PASSWORD: 'unique-test-secret',
      TEST_API_BASE_URL: 'https://production.example.com',
    })).toThrow(/local/i);
  });

  it('accepts a loopback URL without hardcoded credentials', () => {
    expect(readLocalSmokeConfig({
      TEST_API_USERNAME: 'test-admin',
      TEST_API_PASSWORD: 'unique-test-secret',
      TEST_API_BASE_URL: 'http://127.0.0.1:3000',
    })).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      username: 'test-admin',
      password: 'unique-test-secret',
    });
  });
});
