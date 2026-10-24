const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = join(__dirname, 'payment-destination.ts');
const compiledSource = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loadedModule = { exports: {} };
new Function('exports', 'require', 'module', compiledSource)(loadedModule.exports, require, loadedModule);
const { canUseApiFlow, canUseManualFlow, DEPOSIT_BANK_OPTIONS, destinationLabel, isDepositBankChosen, ticketVerificationLabel } = loadedModule.exports;

test('destination label never guesses account type from the source bank', () => {
  assert.equal(destinationLabel(true), 'Atlas · API');
  assert.equal(destinationLabel(false), 'BNF · manual');
  assert.equal(destinationLabel(null), 'Banco de depósito sin elegir');
  assert.equal(destinationLabel(undefined), 'Banco de depósito sin elegir');
});

test('the deposit bank is a choice between Atlas and BNF, never a default', () => {
  assert.deepEqual(DEPOSIT_BANK_OPTIONS.map((o) => [o.label, o.isAtlasAccount]), [['Atlas', true], ['BNF', false]]);
  assert.equal(isDepositBankChosen(true), true);
  assert.equal(isDepositBankChosen(false), true);
  assert.equal(isDepositBankChosen(null), false);
  assert.equal(isDepositBankChosen(undefined), false);
});

test('only consultations explicitly classified as another bank can enter manual approval', () => {
  assert.equal(canUseManualFlow(true), false);
  assert.equal(canUseManualFlow(null), false);
  assert.equal(canUseManualFlow(undefined), false);
  assert.equal(canUseManualFlow(false), true);
});

test('only consultations explicitly classified as Atlas can enter API reconciliation', () => {
  assert.equal(canUseApiFlow(true), true);
  assert.equal(canUseApiFlow(false), false);
  assert.equal(canUseApiFlow(null), false);
  assert.equal(canUseApiFlow(undefined), false);
});

test('ticket verification wording follows the recorded state and amount, not the declared destination alone', () => {
  assert.equal(ticketVerificationLabel({ status: 'CONFIRMADO_MANUAL', isAtlasAccount: false, allocatedAmount: 0 }), 'APROBACIÓN MANUAL');
  assert.equal(ticketVerificationLabel({ status: 'CONFIRMADO', isAtlasAccount: true, allocatedAmount: 1000 }), 'CONCILIACIÓN CON MOVIMIENTO');
  assert.equal(ticketVerificationLabel({ status: 'CONFIRMADO', isAtlasAccount: true, allocatedAmount: 0 }), 'CONFIRMACIÓN REGISTRADA');
  assert.equal(ticketVerificationLabel({ status: 'CONFIRMADO', isAtlasAccount: null, allocatedAmount: 0 }), 'CONFIRMACIÓN REGISTRADA');
  assert.equal(ticketVerificationLabel({ status: 'PENDIENTE_VERIFICACION', isAtlasAccount: true, allocatedAmount: 0 }), 'SIN CONFIRMACIÓN');
});

test('printed consultation differentiates declared destination from bank of origin', () => {
  const source = readFileSync(join(__dirname, '..', 'components', 'ui.tsx'), 'utf8');
  const ticket = source.slice(source.indexOf('export const PrintableTicket ='));
  assert.match(ticket, /BANCO ORIGEN:/);
  assert.match(ticket, /DESTINO DECLARADO:/);
  assert.match(ticket, /ticketVerificationLabel\(payment\)/);
});

test('collector form blocks saving until Atlas or BNF is chosen, and sends that choice', () => {
  const source = readFileSync(join(__dirname, '..', 'views', 'CobradorDashboard.tsx'), 'utf8');
  // El formulario arranca y se reinicia sin banco elegido: no hay un valor por defecto que olvidar.
  assert.doesNotMatch(source, /isAtlasAccount: false/);
  // El formulario vacío (y el borrador) vienen de services/consulta-draft.ts.
  assert.match(source, /useState\(initialDraft \?\? EMPTY_CONSULTA_DRAFT\)/);
  const draft = readFileSync(join(__dirname, 'consulta-draft.ts'), 'utf8');
  assert.match(draft.slice(draft.indexOf('export const EMPTY_CONSULTA_DRAFT')), /^[^;]*isAtlasAccount: null,/);
  assert.match(source, /isDepositBankChosen\(paymentState\.isAtlasAccount\) &&/);
  assert.match(source, /if \(!isDepositBankChosen\(isAtlasAccount\)\) \{\s*showToast\('error', DEPOSIT_BANK_REQUIRED\);\s*return;/);
  assert.match(source, /type="radio"\s+name="depositBank"\s+required/);
  assert.match(source, /formData\.append\('isAtlasAccount', String\(isAtlasAccount\)\)/);
  assert.doesNotMatch(source, /type="checkbox"/);
});

test('admin can explicitly classify a historical consultation already in review', () => {
  const source = readFileSync(join(__dirname, '..', 'views', 'AdminDashboard.tsx'), 'utf8');
  assert.match(source, /api\.patch\(`\/payments\/\$\{payment\.id\}`\s*,\s*\{ isAtlasAccount \}\)/);
  assert.match(source, /Se depositó en Atlas/);
  assert.match(source, /Se depositó en BNF/);
});
