const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const compiled = ts.transpileModule(readFileSync(join(__dirname, 'bank-month.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { currentMonthKey, formatDayTime, monthKeyOf, monthLabel, pageWindow } = loaded.exports;

test('el mes se calcula en hora de Paraguay, no en UTC', () => {
  // 1/10 a las 01:30 UTC todavía es 30/09 a las 22:30 en Paraguay.
  assert.equal(monthKeyOf('2026-10-01T01:30:00Z'), '2026-09');
  assert.equal(monthKeyOf('2026-10-01T03:00:00Z'), '2026-10');
  assert.equal(currentMonthKey(new Date('2026-10-14T15:00:00Z')), '2026-10');
});

test('nombres de mes y fecha corta para la lista', () => {
  assert.equal(monthLabel('2026-09'), 'septiembre 2026');
  assert.equal(monthLabel('2026-10'), 'octubre 2026');
  assert.equal(formatDayTime('2026-10-13T20:30:02Z'), '13/10 17:30');
});

test('paginación: rango visible y cantidad de páginas', () => {
  assert.deepEqual(pageWindow(1, 25, 60), { page: 1, pages: 3, from: 1, to: 25 });
  assert.deepEqual(pageWindow(3, 25, 60), { page: 3, pages: 3, from: 51, to: 60 });
  assert.deepEqual(pageWindow(5, 25, 60), { page: 3, pages: 3, from: 51, to: 60 }, 'una página que ya no existe va a la última');
  assert.deepEqual(pageWindow(1, 25, 0), { page: 1, pages: 1, from: 0, to: 0 });
});

test('el panel muestra el mes para todos los roles, también la caja, y pide la lista paginada al servidor', () => {
  const panel = readFileSync(join(__dirname, '..', 'views', 'BankTransfersPanel.tsx'), 'utf8');
  assert.match(panel, /type="month"/);
  assert.doesNotMatch(panel, /\(filter === 'MIAS' \|\| !isCashier\)/, 'la caja no puede quedar sin selector');
  assert.match(panel, /fetchBankTransfersPage\(\{ month: monthRef\.current, view, page: pageRef\.current, pageSize: PAGE_SIZE/);
  assert.match(panel, /Sin tomar en otros meses/);
  assert.doesNotMatch(panel, /fetchBankTransfers\(\{ date/);
  const recon = readFileSync(join(__dirname, '..', 'views', 'ReconciliationView.tsx'), 'utf8');
  assert.match(recon, /type="month"/);
  assert.doesNotMatch(recon, /fetchBankTransfers\(\{ date/);
});
