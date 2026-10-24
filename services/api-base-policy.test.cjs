const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, 'api-base-policy.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { isApiBaseOverrideAllowed } = mod.exports;

test('cloud PWA never accepts a custom API origin', () => {
  assert.equal(isApiBaseOverrideAllowed(true, false, false), false);
  assert.equal(isApiBaseOverrideAllowed(false, false, false), true);
  assert.equal(isApiBaseOverrideAllowed(true, true, false), true);
});

test('axios keeps even an absolute request URL on the configured cloud API origin', () => {
  const axios = require('axios');
  const client = axios.create({ baseURL: 'https://api.example', allowAbsoluteUrls: false });
  const uri = client.getUri({ url: 'https://attacker.example/collect' });
  assert.equal(new URL(uri).origin, 'https://api.example');
});

test('the API and login screen use the same override gate', () => {
  const apiSource = fs.readFileSync(path.join(__dirname, 'api.ts'), 'utf8');
  const loginSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'LoginView.tsx'), 'utf8');
  assert.match(apiSource, /if \(!canOverrideApiBaseURL\) return envUrl/);
  assert.match(apiSource, /if \(!canOverrideApiBaseURL\) return;/);
  assert.match(apiSource, /allowAbsoluteUrls: canOverrideApiBaseURL/);
  assert.match(loginSource, /showServerConfig = canOverrideApiBaseURL/);
});
