const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = readFileSync(join(__dirname, 'my-bank-claims.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { ownClaimRows, canReprintOwnClaim, ownClaimsAffectedByTransfer } = loaded.exports;

test('Mis tomas conserva una toma anulada aunque el movimiento volvió a disponible', () => {
  const transfer = {
    id: 'movement-1', status: 'DISPONIBLE', claims: [
      { id: 'old-claim', claimedById: 'cashier-1', status: 'ANULADA', voidReason: 'Ticket incorrecto', voidedByName: 'ADMIN' },
    ],
  };
  assert.deepEqual(ownClaimRows([transfer], 'cashier-1').map((row) => row.claim.id), ['old-claim']);
  assert.equal(canReprintOwnClaim(transfer.claims[0], 'cashier-1'), false);
});

test('Mis tomas no mezcla colaboradores y conserva varias tomas del mismo movimiento', () => {
  const transfer = {
    id: 'movement-1', claims: [
      { id: 'first', claimedById: 'cashier-1', status: 'ACTIVA' },
      { id: 'second', claimedById: 'cashier-1', status: 'ANULADA' },
      { id: 'foreign', claimedById: 'cashier-2', status: 'ACTIVA' },
    ],
  };
  assert.deepEqual(ownClaimRows([transfer], 'cashier-1').map((row) => row.claim.id), ['first', 'second']);
  assert.equal(canReprintOwnClaim(transfer.claims[0], 'cashier-1'), true);
  assert.equal(canReprintOwnClaim(transfer.claims[2], 'cashier-1'), false);
});

// La lista del historial propio vive en un componente que comparten "Mis tomas" (caja/admin)
// y "Mis conciliadas" (cobrador, dentro de Conciliacion) desde el 2026-10-07.
const myClaimsList = () => readFileSync(join(__dirname, '..', 'components', 'bank', 'MyClaimsList.tsx'), 'utf8');

test('el panel usa el historial propio y muestra motivo, autor y fecha sin reimpresión de anuladas', () => {
  const panel = readFileSync(join(__dirname, '..', 'views', 'BankTransfersPanel.tsx'), 'utf8');
  assert.match(panel, /fetchMyClaimsByMonth\(/);
  assert.match(panel, /filter === 'MIAS'/);
  assert.match(panel, /<MyClaimsList/);
  const list = myClaimsList();
  assert.match(list, /claim\.status === 'ANULADA'/);
  assert.match(list, /claim\.voidReason/);
  assert.match(list, /claim\.voidedByName/);
  assert.match(list, /claim\.voidedAt/);
  assert.match(list, /canReprintOwnClaim\(claim, userId(?:, role)?\)/);
});

test('el cobrador ve su historial dentro de Conciliación, con la misma lista y reimpresión', () => {
  const recon = readFileSync(join(__dirname, '..', 'views', 'ReconciliationView.tsx'), 'utf8');
  assert.match(recon, /fetchMyClaimsByMonth\(/);
  assert.match(recon, /<MyClaimsList/);
  assert.match(recon, /'Mis conciliadas'/);
  assert.match(recon, /request === myClaimsRequest\.current/);
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  // Transferencias ya no aparece en el menu del cobrador: Conciliacion lo cubre.
  assert.doesNotMatch(app.match(/const canSeeBankTransfers = [^;]+;/)[0], /COBRADOR/);
});

test('una anulación identifica exactamente la toma, no otra que quede activa después', () => {
  const service = readFileSync(join(__dirname, 'bankTransfers.ts'), 'utf8');
  const detail = readFileSync(join(__dirname, '..', 'components', 'bank', 'TransferDetailModal.tsx'), 'utf8');
  assert.match(service, /voidBankClaim = async \(id: string, reason: string, claimId: string\)/);
  assert.match(service, /`\/bank-transfers\/\$\{id\}\/void`, \{ reason, claimId \}/);
  assert.match(detail, /setVoidClaimId\(claim\.id\)/);
  assert.match(detail, /voidBankClaim\(transfer\.id, reason\.trim\(\), voidClaimId\)/);
});

test('si falla el historial propio no presenta tomas de otra fecha como actuales', () => {
  const panel = readFileSync(join(__dirname, '..', 'views', 'BankTransfersPanel.tsx'), 'utf8');
  assert.match(panel, /setMyClaimsError\(apiErrorMessage\(/);
  assert.match(panel, /error=\{myClaimsError\}/);
  assert.match(panel, /onRetry=\{\(\) => void loadMyClaims\(\)\}/);
  // El historial propio es del mes elegido: mientras no llega el de ese mes, no se muestra otro.
  assert.match(panel, /myClaimsLoadedMonth !== month/);
  const list = myClaimsList();
  assert.match(list, /if \(error\)/);
  assert.match(list, /onClick=\{onRetry\}/);
});

test('el mensaje de anulación no dice disponible cuando el banco reversó o bloqueó el movimiento', () => {
  const detail = readFileSync(join(__dirname, '..', 'components', 'bank', 'TransferDetailModal.tsx'), 'utf8');
  assert.match(detail, /updated\.status === BankTransferStatus\.REVERSADA/);
  assert.match(detail, /updated\.status === BankTransferStatus\.BLOQUEADA/);
});

test('el feed solo recarga Mis tomas si el movimiento afecta al usuario o figura en su historial visible', () => {
  assert.equal(ownClaimsAffectedByTransfer({ id: 'other', claims: [] }, [{ id: 'mine' }], 'user-1'), false);
  assert.equal(ownClaimsAffectedByTransfer({ id: 'mine', claims: [] }, [{ id: 'mine' }], 'user-1'), true);
  assert.equal(ownClaimsAffectedByTransfer({ id: 'new', claims: [{ claimedById: 'user-1' }] }, [], 'user-1'), true);
  assert.equal(ownClaimsAffectedByTransfer({ id: 'new', claims: [{ claimedById: 'user-2' }] }, [], 'user-1'), false);
  const panel = readFileSync(join(__dirname, '..', 'views', 'BankTransfersPanel.tsx'), 'utf8');
  assert.match(panel, /ownClaimsAffectedByTransfer\(t, myClaimItemsRef\.current, user\.id\)/);
});

test('el modal advierte al admin sobre un comprobante cuya impresión fue registrada antes de anular', () => {
  const detail = readFileSync(join(__dirname, '..', 'components', 'bank', 'TransferDetailModal.tsx'), 'utf8');
  assert.match(detail, /voidClaim\.printCount > 0/);
  assert.match(detail, /solicitud de impresión/);
});
