const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8');
const config = readFileSync(join(__dirname, '..', 'vite.config.ts'), 'utf8');
const sourceFile = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const activation = sourceFile.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'activateWaitingPwaUpdate');

function makeActivation(window, navigator) {
  assert.ok(activation, 'Falta la activación explícita de la actualización PWA');
  const compiled = ts.transpileModule(activation.getText(sourceFile), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('window', 'navigator', `${compiled}\nreturn activateWaitingPwaUpdate;`)(window, navigator);
}

test('la PWA deja la actualización en espera y no fuerza recargas en otras pestañas', () => {
  assert.match(config, /registerType:\s*'prompt'/);
  assert.match(config, /injectRegister:\s*(?:null|false)/);
  assert.match(config, /clientsClaim:\s*true/);
  assert.doesNotMatch(source, /virtual:pwa-register/);
  assert.match(source, /registration\.waiting/);
  assert.match(source, /updatefound/);
  assert.ok(activation);
  assert.doesNotMatch(source.replace(activation.getText(sourceFile), ''), /window\.location\.reload\(/);
  assert.match(source, /no-print/);
});

test('rechazar la actualización conserva el borrador y no activa el worker', () => {
  const calls = [];
  const worker = { postMessage: (message) => calls.push(message) };
  const navigator = { serviceWorker: { addEventListener: () => calls.push('listener') } };
  const window = { confirm: () => false, location: { reload: () => calls.push('reload') } };
  const activate = makeActivation(window, navigator);

  assert.equal(activate(worker), false);
  assert.deepEqual(calls, []);
});

test('aceptar la actualización activa el worker y recarga solo la pestaña que aceptó', () => {
  const calls = [];
  let controllerChange;
  const worker = { postMessage: (message) => calls.push(message) };
  const navigator = { serviceWorker: { addEventListener: (_event, listener, options) => {
    controllerChange = listener;
    assert.deepEqual(options, { once: true });
  } } };
  const window = { confirm: () => true, location: { reload: () => calls.push('reload') } };
  const activate = makeActivation(window, navigator);

  assert.equal(activate(worker), true);
  assert.deepEqual(calls, [{ type: 'SKIP_WAITING' }]);
  assert.equal(typeof controllerChange, 'function');
  controllerChange();
  assert.deepEqual(calls, [{ type: 'SKIP_WAITING' }, 'reload']);
});

test('una pestaña que pospuso puede actualizarse después de que otra activó el worker', () => {
  const calls = [];
  const worker = { state: 'activated', postMessage: (message) => calls.push(message) };
  const navigator = { serviceWorker: { addEventListener: () => calls.push('listener') } };
  const window = { confirm: () => true, location: { reload: () => calls.push('reload') } };
  const activate = makeActivation(window, navigator);

  assert.equal(activate(worker), true);
  assert.deepEqual(calls, ['reload']);
});
