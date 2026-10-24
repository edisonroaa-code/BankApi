const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = join(__dirname, 'receipt-registration.ts');
const compiledSource = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loadedModule = { exports: {} };
new Function('exports', 'require', 'module', compiledSource)(loadedModule.exports, require, loadedModule);
const { bankReceiptSourceLabel, bankReceiptTitle, claimIdForPayment, registerAndDisplayReceipt } = loadedModule.exports;

test('bank receipt labels distinguish an Atlas API movement from mock data or missing legacy source', () => {
  assert.equal(bankReceiptSourceLabel('ATLAS'), 'ATLAS CONNECT · API');
  assert.equal(bankReceiptSourceLabel('MOCK'), 'DATOS DE PRUEBA · MOCK');
  assert.equal(bankReceiptSourceLabel(undefined), 'FUENTE NO INFORMADA');
});

test('bank receipt title distinguishes consultation reconciliation from direct take', () => {
  assert.equal(bankReceiptTitle('CONSULTA'), 'CONSULTA CONCILIADA');
  assert.equal(bankReceiptTitle('TICKET'), 'TRANSFERENCIA TOMADA');
  assert.equal(bankReceiptTitle('CLIENTE'), 'TRANSFERENCIA TOMADA');
});

test('printed bank receipt uses source and claim type from the DTO', () => {
  const source = readFileSync(join(__dirname, '..', 'components', 'BankTransferReceipt.tsx'), 'utf8');
  assert.match(source, /bankReceiptSourceLabel\(receipt\.source\)/);
  assert.match(source, /bankReceiptTitle\(receipt\.referenceType\)/);
});

test('displays only the receipt returned by a successful print registration', async () => {
  const displayed = [];
  const receipt = { receiptNumber: 'TC-2', printCount: 1 };
  const result = await registerAndDisplayReceipt(async () => receipt, (value) => displayed.push(value));
  assert.equal(result, receipt);
  assert.deepEqual(displayed, [receipt]);
});

test('does not display a receipt when print registration fails', async () => {
  const displayed = [];
  await assert.rejects(
    registerAndDisplayReceipt(async () => { throw new Error('Registro de impresión falló'); }, (value) => displayed.push(value)),
    /Registro de impresión falló/,
  );
  assert.deepEqual(displayed, []);
});

test('reconciliation print selects the claim for the exact payment', () => {
  const transfer = { claims: [
    { id: 'first', paymentId: 'payment-1', status: 'ACTIVA' },
    { id: 'second', paymentId: 'payment-2', status: 'ACTIVA' },
  ] };
  assert.equal(claimIdForPayment(transfer, 'payment-2'), 'second');
});

test('reconciliation print fails closed when the payment claim is missing', () => {
  assert.throws(() => claimIdForPayment({ claims: [{ id: 'other', paymentId: 'payment-1', status: 'ACTIVA' }] }, 'payment-2'), /No se encontró/);
});

test('admin ticket print does not invoke browser print after audit endpoint fails', () => {
  const source = readFileSync(join(__dirname, '..', 'views', 'AdminDashboard.tsx'), 'utf8');
  const handler = source.slice(source.indexOf('const handlePrintTicket ='), source.indexOf('const summaryCount ='));
  const failedBranch = handler.slice(handler.indexOf('} catch (e: any)'));
  assert.ok(!/window\.print\(/.test(failedBranch));
});

test('admin prints the shared consultation ticket, not a hidden duplicate template', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const admin = readFileSync(join(__dirname, '..', 'views', 'AdminDashboard.tsx'), 'utf8');
  const printHandler = admin.slice(admin.indexOf('const handlePrintTicket ='), admin.indexOf('const summaryCount ='));

  assert.match(app, /<AdminDashboard[^>]*onPrintPayment=\{showPaymentTicket\}/);
  assert.match(printHandler, /onPrintPayment\(\{\s*\.\.\.data,\s*reprint:\s*previouslyPrinted\s*\}\)/);
  assert.doesNotMatch(admin, /id="printable-ticket"/);
});

test('closing the print dialog asks whether it printed instead of counting it', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const printEffects = app.slice(app.indexOf('const [printingPayment'), app.indexOf('// La caja tiene un panel'));

  assert.match(printEffects, /addEventListener\('afterprint', dialogClosed\)/);
  assert.match(printEffects, /matchMedia\('print'\)/);
  assert.match(printEffects, /if \(!event\.matches\) dialogClosed\(\)/);
  assert.match(printEffects, /const dialogClosed = \(\) => setAskPrinted\(true\)/);
  assert.doesNotMatch(printEffects, /window\.print\(\);\s*setPrinting(?:Payment|Receipt)\(null\)/);
  assert.match(printEffects, /showPaymentTicket[\s\S]*?setPrintingReceipt\(null\);\s*setPrintingPayment\(payment\)/);
  assert.match(printEffects, /showBankReceipt[\s\S]*?setPrintingPayment\(null\);\s*setPrintingReceipt\(receipt\)/);
  // Solo el "Sí, salió impreso" registra; "No se imprimió" no llama al servidor.
  const confirm = app.slice(app.indexOf('const confirmPrinted'), app.indexOf('const notPrinted'));
  assert.match(confirm, /confirmBankReceiptPrint\(printingReceipt\.transferId, printingReceipt\.claimId\)/);
  assert.match(confirm, /confirmPaymentTicketPrint\(printingPayment\.id\)/);
  const notPrinted = app.slice(app.indexOf('const notPrinted'), app.indexOf('const printAgain'));
  assert.doesNotMatch(notPrinted, /confirm|api\./);
});

test('only the confirmation step marks tickets as printed; screens only open the dialog', () => {
  const services = readFileSync(join(__dirname, 'bankTransfers.ts'), 'utf8');
  const payments = readFileSync(join(__dirname, 'payments.ts'), 'utf8');
  assert.match(services, /openBankReceipt[\s\S]*?\/print-preview`/);
  assert.match(payments, /openPaymentTicket[\s\S]*?\/print-preview`/);
  const screens = ['views/AdminDashboard.tsx', 'views/CobradorDashboard.tsx', 'views/BankTransfersPanel.tsx', 'views/ReconciliationView.tsx',
    'views/WorkPanelView.tsx', 'components/bank/TakeTransferModal.tsx', 'components/bank/TransferDetailModal.tsx', 'components/bank/MyClaimsList.tsx'];
  for (const file of screens) {
    const source = readFileSync(join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /\/print`/, `${file} no debe registrar impresiones por su cuenta`);
  }
});

// Carga un .ts/.tsx del proyecto con sus imports relativos, para renderizar componentes reales.
const loadTs = (file, cache = new Map()) => {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const { dirname } = require('node:path');
  const { existsSync } = require('node:fs');
  const localRequire = (name) => {
    if (!name.startsWith('.')) return require(name);
    const base = join(dirname(file), name);
    const found = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
    return found ? loadTs(found, cache) : {};
  };
  new Function('exports', 'require', 'module', code)(mod.exports, localRequire, mod);
  return mod.exports;
};

test('the reconciliation receipt always prints the client code, or a dash if it is missing', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { BankTransferReceipt } = loadTs(join(__dirname, '..', 'components', 'BankTransferReceipt.tsx'));
  const receipt = {
    transferId: 't', claimId: 'c', receiptNumber: 'TR-000012', source: 'ATLAS', claimedAt: '2026-10-13T20:00:00Z',
    claimedByName: 'Taty', claimedByUsername: 'taty', claimedByRole: 'COBRADOR', referenceType: 'CONSULTA',
    referenceValue: 'payment-1', paymentRef: '5318', clientName: 'Cliente Uno', clientCode: '345', collectorName: 'Taty',
    amount: 319000, transferAmount: 319000, currency: 'PYG', senderName: 'REMITENTE', bankDocNumber: '25895',
    movementAt: '2026-10-13T19:59:00Z', printCount: 1, voided: false,
  };
  const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(renderToStaticMarkup(React.createElement(BankTransferReceipt, { receipt }))), /CÓD\. CLIENTE: 345/);
  assert.match(text(renderToStaticMarkup(React.createElement(BankTransferReceipt, { receipt: { ...receipt, clientCode: null } }))), /CÓD\. CLIENTE: —/);
  // La toma de caja por ticket no tiene cliente: no inventa la línea.
  const cashier = { ...receipt, referenceType: 'TICKET', referenceValue: '77', clientCode: null, clientName: null };
  assert.doesNotMatch(text(renderToStaticMarkup(React.createElement(BankTransferReceipt, { receipt: cashier }))), /CÓD\. CLIENTE/);
});
