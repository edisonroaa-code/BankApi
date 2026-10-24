const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = join(__dirname, 'health-readiness.ts');
const compiledSource = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const loadedModule = { exports: {} };
new Function('exports', 'require', 'module', '__filename', '__dirname', compiledSource)(
  loadedModule.exports,
  require,
  loadedModule,
  sourcePath,
  __dirname,
);

const {
  DB_READINESS_PATH,
  ignoreFailure,
  parseDbReadinessError,
  parseDbReadinessPayload,
} = loadedModule.exports;

test('diagnostic probes the database readiness endpoint, not process liveness', () => {
  assert.equal(DB_READINESS_PATH, '/health/db');
});

test('database readiness response is represented as operational', () => {
  assert.deepEqual(
    parseDbReadinessPayload({
      status: 'ok',
      db: 'ok',
      uptimeSec: 42,
      responseMs: 15,
      time: '2026-08-26T12:00:00.000Z',
    }),
    {
      status: 'ok',
      db: 'ok',
      uptimeSec: 42,
      responseMs: 15,
      time: '2026-08-26T12:00:00.000Z',
    },
  );
});

test('HTTP 503 readiness body is represented as database down, not API down', () => {
  assert.deepEqual(
    parseDbReadinessError({
      message: 'Request failed with status code 503',
      response: {
        data: {
          status: 'degraded',
          db: 'down',
          uptimeSec: 43,
          responseMs: 18,
          time: '2026-08-26T12:01:00.000Z',
          error: 'database_unavailable',
        },
      },
    }),
    {
      status: 'ok',
      db: 'down',
      uptimeSec: 43,
      responseMs: 18,
      time: '2026-08-26T12:01:00.000Z',
      error: 'database_unavailable',
    },
  );
});

test('network failure is represented as API down', () => {
  assert.deepEqual(parseDbReadinessError({ message: 'Network Error' }), {
    status: 'down',
    error: 'Network Error',
  });
});

test('malformed successful response is represented as an invalid API contract', () => {
  assert.deepEqual(parseDbReadinessPayload('<!doctype html>'), {
    status: 'down',
    error: 'Respuesta invalida del backend',
  });
});

test('failure of an optional local bridge does not reject the cloud health check', async () => {
  assert.equal(await ignoreFailure(Promise.resolve('running')), 'running');
  assert.equal(await ignoreFailure(Promise.reject(new Error('bridge unavailable'))), null);
});
