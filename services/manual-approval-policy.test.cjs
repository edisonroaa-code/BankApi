const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = join(__dirname, 'manual-approval-policy.ts');
const compiledSource = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loadedModule = { exports: {} };
new Function('exports', 'require', 'module', compiledSource)(loadedModule.exports, require, loadedModule);
const { assessManualApproval, canBeginManualApproval } = loadedModule.exports;

const candidate = (id, evidence, claims = []) => ({ id, match: { evidence }, claims });
const activeClaim = { status: 'ACTIVA' };

test('a partially bank-allocated consultation cannot be approved manually', () => {
  const risk = assessManualApproval({ allocatedAmount: 100 }, []);
  assert.equal(risk.partialBankAllocation, true);
});

test('bank operation reference or concept evidence blocks manual approval even if unclaimed', () => {
  const risk = assessManualApproval({ allocatedAmount: 0 }, [
    candidate('reference', ['REFERENCIA']),
    candidate('concept', ['CONCEPTO'], [activeClaim]),
  ]);
  assert.deepEqual(risk.blockingMatches.map((match) => match.id), ['reference', 'concept']);
});

test('only relevant identity evidence warns about a claimed transfer; amount alone does not', () => {
  const risk = assessManualApproval({ allocatedAmount: 0 }, [
    candidate('account', ['CUENTA_CONOCIDA', 'MONTO'], [activeClaim]),
    candidate('amount', ['MONTO'], [activeClaim]),
  ]);
  assert.equal(risk.blockingMatches.length, 0);
  assert.deepEqual(risk.claimedNonBlockingMatches.map((match) => match.id), ['account']);
});

test('BNF deposits are independent from the Atlas receiving account even with the same reference', () => {
  const risk = assessManualApproval({ allocatedAmount: 0, isAtlasAccount: false }, [
    candidate('reference', ['REFERENCIA', 'MONTO'], [activeClaim]),
  ]);
  assert.equal(risk.blockingMatches.length, 0);
  assert.equal(risk.claimedNonBlockingMatches.length, 0);
});

test('a contradictory bank is explained without a duplicate warning', () => {
  const transfer = candidate('other-bank', ['NOMBRE', 'MONTO'], [activeClaim]);
  transfer.match.conflicts = ['BANCO'];
  const risk = assessManualApproval({ allocatedAmount: 0 }, [transfer]);
  assert.equal(risk.claimedNonBlockingMatches.length, 0);
});

test('voided claims and no matches do not warn or block manual approval', () => {
  const risk = assessManualApproval({ allocatedAmount: 0 }, [candidate('voided', ['MONTO'], [{ status: 'ANULADA' }])]);
  assert.equal(risk.partialBankAllocation, false);
  assert.equal(risk.blockingMatches.length, 0);
  assert.equal(risk.claimedNonBlockingMatches.length, 0);
});

test('manual approval stays disabled while bank matches load or fail', () => {
  assert.equal(canBeginManualApproval({ allocatedAmount: 0, isAtlasAccount: false }, null, null), false);
  assert.equal(canBeginManualApproval({ allocatedAmount: 0, isAtlasAccount: false }, null, 'Banco no disponible'), false);
  assert.equal(canBeginManualApproval({ allocatedAmount: 0, isAtlasAccount: false }, [], null), true);
  assert.equal(canBeginManualApproval({ allocatedAmount: 0, isAtlasAccount: false }, [candidate('linked', ['REFERENCIA'])], null), true);
});

test('Atlas and unclassified consultations cannot begin manual approval', () => {
  assert.equal(canBeginManualApproval({ allocatedAmount: 0, isAtlasAccount: true }, [], null), false);
  assert.equal(canBeginManualApproval({ allocatedAmount: 0, isAtlasAccount: null }, [], null), false);
  assert.equal(canBeginManualApproval({ allocatedAmount: 0 }, [], null), false);
});

test('reconciliation does not submit from a global Enter key listener', () => {
  const source = readFileSync(join(__dirname, '..', 'views', 'ReconciliationView.tsx'), 'utf8');
  assert.doesNotMatch(source, /window\.addEventListener\(['"]keydown['"]\s*,\s*onKey\)/);
  assert.match(source, /onClick=\{\(\) => void confirm\(\)\}/);
});

test('take modal opens the receipt of the exact newly created claim', () => {
  const source = readFileSync(join(__dirname, '..', 'components', 'bank', 'TakeTransferModal.tsx'), 'utf8');
  assert.match(source, /openBankReceipt\(transfer\.id,\s*newClaim\.id\)/);
  assert.doesNotMatch(source, /openBankReceipt\(transfer\.id\)/);
});
