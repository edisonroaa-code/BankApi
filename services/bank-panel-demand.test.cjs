const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// realtime.ts depende de socket.io-client y de la API: acá solo se prueba trackBankPanelDemand,
// con un socket y un navegador simulados.
const compiled = ts.transpileModule(readFileSync(join(__dirname, 'realtime.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stubs = { 'socket.io-client': { io: () => null }, './api': { getApiBaseURL: () => '' } };
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, (name) => stubs[name] ?? require(name), loaded);
const { trackBankPanelDemand } = loaded.exports;

const makeBrowser = ({ visibility = 'visible', focus = true } = {}) => {
  const listeners = { document: {}, window: {} };
  const on = (target) => (type, fn) => ((listeners[target][type] ??= new Set()).add(fn));
  const off = (target) => (type, fn) => listeners[target][type]?.delete(fn);
  const state = { visibility, focus };
  global.document = {
    get visibilityState() { return state.visibility; },
    hasFocus: () => state.focus,
    addEventListener: on('document'),
    removeEventListener: off('document'),
  };
  global.window = { addEventListener: on('window'), removeEventListener: off('window') };
  const fire = (target, type) => [...(listeners[target][type] ?? [])].forEach((fn) => fn());
  return { state, fire };
};

const makeSocket = (connected = true) => {
  const handlers = {};
  const emitted = [];
  return {
    connected,
    emitted,
    on: (type, fn) => ((handlers[type] ??= new Set()).add(fn)),
    off: (type, fn) => handlers[type]?.delete(fn),
    emit: (type) => emitted.push(type),
    reconnect() {
      this.connected = true;
      [...(handlers.connect ?? [])].forEach((fn) => fn());
    },
  };
};

test('una ventana tapada pero con el foco sigue contando como panel a la vista', () => {
  makeBrowser({ visibility: 'hidden', focus: true });
  const socket = makeSocket();
  trackBankPanelDemand(socket);
  assert.deepEqual(socket.emitted, ['bank-panel:open']);
});

test('sin foco y oculta no consulta; un clic en el panel lo vuelve a avisar y relee la lista', () => {
  const browser = makeBrowser({ visibility: 'hidden', focus: false });
  const socket = makeSocket();
  let reloads = 0;
  trackBankPanelDemand(socket, () => reloads++);
  assert.deepEqual(socket.emitted, ['bank-panel:close']);

  // El navegador sigue diciendo "oculta" (no llegó visibilitychange), pero alguien hizo clic.
  browser.state.focus = true;
  browser.fire('window', 'pointerdown');
  assert.deepEqual(socket.emitted, ['bank-panel:close', 'bank-panel:open']);
  assert.equal(reloads, 1);

  // Más clics no repiten el aviso.
  browser.fire('window', 'pointerdown');
  browser.fire('window', 'keydown');
  assert.equal(socket.emitted.length, 2);
});

test('perder el foco con la pestaña visible no corta la consulta; ocultarse sí', () => {
  const browser = makeBrowser();
  const socket = makeSocket();
  trackBankPanelDemand(socket);
  browser.state.focus = false;
  browser.fire('window', 'blur');
  assert.deepEqual(socket.emitted, ['bank-panel:open']);
  browser.state.visibility = 'hidden';
  browser.fire('document', 'visibilitychange');
  assert.deepEqual(socket.emitted, ['bank-panel:open', 'bank-panel:close']);
});

test('tras una reconexión vuelve a avisar aunque nada haya cambiado', () => {
  makeBrowser();
  const socket = makeSocket(false);
  trackBankPanelDemand(socket);
  assert.deepEqual(socket.emitted, []);
  socket.reconnect();
  socket.reconnect();
  assert.deepEqual(socket.emitted, ['bank-panel:open', 'bank-panel:open']);
});

test('al cerrar el panel avisa y deja de escuchar', () => {
  const browser = makeBrowser();
  const socket = makeSocket();
  const stop = trackBankPanelDemand(socket);
  stop();
  assert.deepEqual(socket.emitted, ['bank-panel:open', 'bank-panel:close']);
  browser.state.visibility = 'hidden';
  browser.fire('document', 'visibilitychange');
  browser.fire('window', 'pointerdown');
  assert.equal(socket.emitted.length, 2);
});

test('el botón Actualizar consulta al servidor aunque el tiempo real esté caído y relee la lista al final', () => {
  const source = readFileSync(join(__dirname, '..', 'components', 'bank', 'BankRefreshButton.tsx'), 'utf8');
  assert.doesNotMatch(source, /connected/);
  assert.match(source, /const result = await requestBankRefresh\(\);/);
  assert.match(source, /finally \{\s*try \{\s*await onReload\(\);/);
});
