const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const compiled = ts.transpileModule(readFileSync(join(__dirname, 'print-events.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { notifyPaymentPrinted, onPaymentPrinted } = loaded.exports;
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

test('confirmar la impresión avisa a todas las pantallas abiertas, y una con error no frena a las demás', () => {
  const seen = [];
  const stopBroken = onPaymentPrinted(() => { throw new Error('pantalla rota'); });
  const stopA = onPaymentPrinted((p) => seen.push(`a:${p.id}`));
  const stopB = onPaymentPrinted((p) => seen.push(`b:${p.id}`));
  notifyPaymentPrinted({ id: 'p1', printedAt: '2026-10-14T15:00:00Z' });
  stopA();
  notifyPaymentPrinted({ id: 'p2' });
  stopB();
  stopBroken();
  assert.deepEqual(seen, ['a:p1', 'b:p1', 'b:p2']);
});

test('App avisa con la consulta ya marcada impresa (BNF a mano y conciliadas de Atlas)', () => {
  const app = read('App.tsx');
  const confirm = app.slice(app.indexOf('const confirmPrinted'), app.indexOf('const notPrinted'));
  assert.match(confirm, /notifyPaymentPrinted\(await confirmPaymentTicketPrint\(printingPayment\.id\)\)/);
  assert.match(confirm, /fetchPaymentDetail\(paymentId\)\.then\(notifyPaymentPrinted\)/);
});

test('Mi panel, el panel del admin y el panel de trabajo se actualizan al confirmar', () => {
  for (const file of ['views/CobradorDashboard.tsx', 'views/AdminDashboard.tsx', 'views/WorkPanelView.tsx']) {
    assert.match(read(file), /onPaymentPrinted\(/, file);
  }
  // El detalle abierto del admin también: de ahí sale "Marcar Pago en Caja".
  const admin = read('views/AdminDashboard.tsx');
  assert.match(admin, /if \(reviewSelectionRef\.current === printed\.id\) setSelectedPayment\(printed\)/);
  assert.match(admin, /if \(reviewSelectionRef\.current === payment\.id\) setSelectedPayment\(payment\)/);
});

test('Mi panel escucha "impreso" y "pago en caja" del servidor sin repetir el aviso de aprobada', () => {
  const panel = read('views/CobradorDashboard.tsx');
  const types = panel.slice(panel.indexOf('const refreshTypes = new Set(['), panel.indexOf(']);', panel.indexOf('const refreshTypes')));
  assert.match(types, /'PAYMENT_PRINTED'/);
  assert.match(types, /'PAYMENT_CASH_PAID'/);
  assert.match(panel, /if \(evt\.type === 'PAYMENT_UPDATED' \|\| evt\.type === 'PAYMENT_PRINTED' \|\| evt\.type === 'PAYMENT_CASH_PAID'\) return;/);
});
