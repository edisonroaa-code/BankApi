const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const compiled = ts.transpileModule(readFileSync(join(__dirname, 'consulta-draft.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const {
  CONSULTA_DRAFT_MAX_AGE_MS,
  EMPTY_CONSULTA_DRAFT,
  clearConsultaDraft,
  consultaDraftKey,
  isConsultaDraftEmpty,
  loadConsultaDraftFields,
  loadConsultaDraftFile,
  parseConsultaDraft,
  saveConsultaDraftFields,
  saveConsultaDraftFile,
  serializeConsultaDraft,
} = loaded.exports;
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

const fakeStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

const draft = { amount: '150.000', client: '', clientCode: 'CLI-777', refNum: 'REF-1', sourceBank: 'Itaú', isAtlasAccount: false };

test('el borrador de cada cobrador se guarda y se retoma tal cual, incluido el banco de depósito', (t) => {
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  t.after(() => delete globalThis.localStorage);

  saveConsultaDraftFields('taty', draft);
  assert.deepEqual(loadConsultaDraftFields('taty'), draft);
  assert.equal(loadConsultaDraftFields('luis'), null, 'otro usuario del mismo equipo no ve el borrador ajeno');

  // Formulario vacío = sin borrador (enviado o descartado).
  saveConsultaDraftFields('taty', EMPTY_CONSULTA_DRAFT);
  assert.equal(storage.data.has(consultaDraftKey('taty')), false);

  saveConsultaDraftFields('taty', draft);
  clearConsultaDraft('taty');
  assert.equal(loadConsultaDraftFields('taty'), null);
});

test('un borrador vencido, roto o vacío no se retoma', () => {
  const now = Date.parse('2026-10-20T15:00:00Z');
  assert.deepEqual(parseConsultaDraft(serializeConsultaDraft(draft, now - 60_000), now), draft);
  assert.equal(parseConsultaDraft(serializeConsultaDraft(draft, now - CONSULTA_DRAFT_MAX_AGE_MS - 1), now), null);
  assert.equal(parseConsultaDraft('{no es json', now), null);
  assert.equal(parseConsultaDraft(JSON.stringify({ v: 2, savedAt: now, fields: draft }), now), null);
  assert.equal(parseConsultaDraft(serializeConsultaDraft(EMPTY_CONSULTA_DRAFT, now), now), null);
  // Un valor extraño en el banco de depósito vuelve a "sin elegir": nunca se elige solo.
  const odd = parseConsultaDraft(JSON.stringify({ v: 1, savedAt: now, fields: { ...draft, isAtlasAccount: 'true' } }), now);
  assert.equal(odd.isAtlasAccount, null);
  assert.equal(isConsultaDraftEmpty({ ...EMPTY_CONSULTA_DRAFT, isAtlasAccount: true }), false);
});

test('sin almacenamiento disponible el formulario sigue funcionando, solo que sin borrador', async (t) => {
  globalThis.localStorage = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('lleno'); }, removeItem: () => {} };
  t.after(() => delete globalThis.localStorage);
  assert.doesNotThrow(() => saveConsultaDraftFields('taty', draft));
  assert.equal(loadConsultaDraftFields('taty'), null);
  // Sin IndexedDB (como en Node) el comprobante simplemente no se retoma.
  assert.equal(await loadConsultaDraftFile('taty'), null);
});

test('elegir otro comprobante y limpiar respetan el orden aunque IndexedDB abra lento', async (t) => {
  const records = new Map();
  let opens = 0;
  globalThis.indexedDB = {
    open() {
      const delay = ++opens === 1 ? 25 : 0;
      const db = { close() {}, transaction() {
        const tx = { objectStore: () => ({
          put(value, key) { const request = { result: key }; records.set(key, value); queueMicrotask(() => tx.oncomplete()); return request; },
          delete(key) { const request = { result: undefined }; records.delete(key); queueMicrotask(() => tx.oncomplete()); return request; },
          get(key) { const request = { result: records.get(key) }; queueMicrotask(() => tx.oncomplete()); return request; },
        }) };
        return tx;
      } };
      const request = { result: db };
      setTimeout(() => request.onsuccess(), delay);
      return request;
    },
  };
  t.after(() => delete globalThis.indexedDB);
  const first = new File(['primero'], 'primero.pdf', { type: 'application/pdf' });
  const last = new File(['ultimo'], 'ultimo.pdf', { type: 'application/pdf' });
  await Promise.all([saveConsultaDraftFile('orden-prueba', first), saveConsultaDraftFile('orden-prueba', last)]);
  assert.equal((await loadConsultaDraftFile('orden-prueba'))?.name, 'ultimo.pdf');
  opens = 0;
  const pending = saveConsultaDraftFile('orden-prueba', first);
  clearConsultaDraft('orden-prueba');
  // Una recarga inmediata también debe esperar a que el borrado termine.
  assert.equal(await loadConsultaDraftFile('orden-prueba'), null);
  await pending;
  assert.equal(await loadConsultaDraftFile('orden-prueba'), null, 'un guardado anterior no resucita un borrador descartado');
});

test('Mi panel arranca con el borrador guardado y lo borra solo al enviar o descartar', () => {
  const panel = read('views/CobradorDashboard.tsx');
  assert.match(panel, /useState\(\(\) => loadConsultaDraftFields\(user\.id\)\)/);
  assert.match(panel, /if \(!editingId\) saveConsultaDraftFields\(user\.id, paymentState\)/);
  // El comprobante guardado se lee antes de poder pisarlo.
  assert.match(panel, /if \(editingId \|\| !proofDraftReady \|\| file === savedProofRef\.current\) return;/);
  const submit = panel.slice(panel.indexOf('const handleSubmit'), panel.indexOf('const handlePrintRequest'));
  assert.match(submit, /if \(isEditing\) cancelEdit\(\);\s*else startNewConsulta\(\);/);
  // Un error de red deja el formulario y su borrador como estaban.
  const failure = submit.slice(submit.indexOf('} catch'));
  assert.doesNotMatch(failure, /startNewConsulta|clearConsultaDraft/);
});

test('releer Transferencias no cierra el cuadro de tomar ni el detalle', () => {
  const panel = read('views/BankTransfersPanel.tsx');
  assert.doesNotMatch(panel, /items\.find\(\(t\) => t\.id === takingId\)/);
  assert.doesNotMatch(panel, /items\.find\(\(t\) => t\.id === detailId\)/);
  const load = panel.slice(panel.indexOf('const load = useCallback'), panel.indexOf('const scheduleLoad'));
  assert.match(load, /setItems\(rows\);\s*refreshOpen\(rows\);/);
});

test('Conciliación no mueve las listas con una pareja a medio armar al volver a la ventana', () => {
  const view = read('views/ReconciliationView.tsx');
  assert.match(view, /trackBankPanelDemand\(socket, reloadUnlessPairing\)/);
  assert.match(view, /if \(hasConnected\.current\) reloadUnlessPairing\(\);/);
});

test('tirar hacia abajo no recarga la página (Chrome lo toma de html)', () => {
  assert.match(read('index.css'), /html \{\s*overscroll-behavior-y: contain;/);
});
