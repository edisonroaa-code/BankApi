const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const compiled = ts.transpileModule(readFileSync(join(__dirname, 'audit-format.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded);
const { AUDIT_ACTION_GROUPS, auditActionLabel, auditActor, auditStateChange, auditSubject, describeAudit } = loaded.exports;

// Registros tal como aparecían en la auditoría de producción del 13/10.
const real = {
  approved: { action: 'PAYMENT_CONFIRMED_MANUAL', beforeState: 'PENDIENTE_VERIFICACION', afterState: 'CONFIRMADO_MANUAL', metadata: '{"reason":null,"amount":"319000","isAtlasAccount":false,"claimedAmountMatch":false}' },
  proof: { action: 'PAYMENT_PROOF_VIEWED', metadata: '{"amount":"319000","clientCode":"345","ref":"5318","bank":"FAMILIAR","createdById":"b063d477-a1b2-4c3d-9ea5-0ff577df0000"}' },
  claimed: { action: 'PAYMENT_REVIEW_CLAIMED', beforeState: 'PENDIENTE_VERIFICACION', afterState: 'PENDIENTE_VERIFICACION', metadata: '{"expiresAt":"2026-10-13T20:41:35.548Z"}' },
  reviewed: { action: 'BANK_CLAIM_REVIEWED', metadata: '{"claimId":"bd2daf75-9ef3-4410-aa94-bfaa650f7fe9","receiptNumber":"TR-000010"}' },
  receipt: { action: 'BANK_TRANSFER_RECEIPT_PRINTED', metadata: '{"receiptNumber":"TR-000010","printCount":1}' },
  cash: { action: 'PAYMENT_CASH_PAID', beforeState: 'CONFIRMADO', afterState: 'CONFIRMADO' },
  printed: { action: 'PAYMENT_PRINTED', beforeState: 'CONFIRMADO_MANUAL', afterState: 'CONFIRMADO_MANUAL' },
};

test('los registros reales se leen como frases con datos concretos', () => {
  assert.equal(describeAudit(real.approved), 'Aprobó el ingreso a mano por Gs. 319.000, depósito en BNF.');
  assert.equal(describeAudit(real.proof), 'Abrió el comprobante que adjuntó el cobrador (enviado desde FAMILIAR).');
  assert.equal(describeAudit(real.claimed), 'Tomó la consulta para revisarla (reservada hasta las 17:41).');
  assert.equal(describeAudit(real.reviewed), 'Revisó la conciliación TR-000010 y la dio por buena, sin anular nada.');
  assert.equal(describeAudit(real.receipt), 'Comprobante TR-000010 impreso.');
  assert.equal(describeAudit(real.cash), 'Marcó el pago en caja.');
});

test('ninguna frase muestra JSON, identificadores internos ni códigos', () => {
  for (const log of Object.values(real)) {
    const text = describeAudit(log);
    assert.doesNotMatch(text, /[{}"]|claimId|createdById|[0-9a-f]{8}-[0-9a-f]{4}/, text);
    assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z_]+/, text);
  }
});

test('el estado se muestra solo si cambió, con nombres de estado', () => {
  assert.equal(auditStateChange(real.approved), 'Pendiente → Ingreso (manual)');
  assert.equal(auditStateChange(real.cash), null);
  assert.equal(auditStateChange(real.printed), null);
});

test('una edición dice qué cambió y de qué a qué', () => {
  const log = { action: 'PAYMENT_UPDATED', metadata: JSON.stringify({
    before: { amount: 100000, paymentRef: '123', clientCode: '345', isAtlasAccount: null, observation: 'x' },
    after: { amount: 120000, paymentRef: '123', isAtlasAccount: false },
  }) };
  assert.equal(describeAudit(log), 'Cambió monto: Gs. 100.000 → Gs. 120.000; banco de depósito: sin elegir → BNF.');
});

test('banco: tomas, conflictos, anulaciones y conciliaciones con su motivo', () => {
  assert.equal(
    describeAudit({ action: 'BANK_TRANSFER_CLAIMED', metadata: '{"receiptNumber":"TR-000004","referenceType":"TICKET","referenceValue":"5521","amount":300000,"transferAmount":500000,"partial":true}' }),
    'Tomó Gs. 300.000 de una transferencia de Gs. 500.000 para el ticket N° 5521; comprobante TR-000004.',
  );
  assert.equal(
    describeAudit({ action: 'BANK_TRANSFER_CLAIM_CONFLICT', metadata: '{"reason":"TOMADA","referenceType":"CLIENTE","referenceValue":"647"}' }),
    'Quiso tomar la transferencia para el cliente N° 647 y no pudo: ya estaba tomada.',
  );
  assert.equal(
    describeAudit({ action: 'BANK_TRANSFER_CLAIM_VOIDED', metadata: '{"reason":"Ticket equivocado","receiptNumber":"TR-000006","amount":1000,"claimedBy":"cajero","referenceType":"TICKET","referenceValue":"12"}' }),
    'Anuló la toma TR-000006 de cajero (Gs. 1.000, el ticket N° 12). Motivo: «Ticket equivocado».',
  );
  assert.equal(
    describeAudit({ action: 'PAYMENT_BANK_RECONCILED', metadata: '{"receiptNumber":"TR-000010","amount":1000000,"pendingAfter":0,"bankDocNumber":"25895","matchStrength":"FUERTE","matchEvidence":["REFERENCIA","MONTO"]}' }),
    'Concilió Gs. 1.000.000 con la transferencia del banco (doc. 25895), comprobante TR-000010. Coincidencia fuerte (referencia, monto). La consulta quedó cubierta.',
  );
});

test('usuarios: qué se modificó sin mostrar la clave', () => {
  assert.equal(describeAudit({ action: 'USER_UPDATED', metadata: '{"fields":["password","role"]}' }), 'Modificó la clave, el rol.');
  assert.equal(describeAudit({ action: 'USER_CREATED', metadata: '{"username":"rosa","role":"CAJERO"}' }), 'Creó el usuario rosa con rol caja.');
  assert.equal(describeAudit({ action: 'USER_DELETED', metadata: '{"username":"luis","name":"Luis","role":"COBRADOR"}' }), 'Eliminó al usuario luis (Luis, cobrador).');
});

test('sin metadatos (pago ajeno para un cobrador) igual dice qué pasó', () => {
  assert.equal(describeAudit({ action: 'PAYMENT_REJECTED', metadata: null }), 'Marcó que no ingresó.');
});

test('una acción nueva sin etiqueta se lee sin guiones bajos', () => {
  assert.equal(auditActionLabel('SOME_NEW_EVENT'), 'Some new event');
  assert.equal(auditActionLabel('BANK_CLAIM_REVIEWED'), 'Conciliación revisada');
});

test('sobre qué: la consulta con cliente, referencia, monto, cobrador y banco de depósito', () => {
  const subject = auditSubject({ payment: { id: 'p', amount: 319000, clientCode: '345', paymentRef: '5318', clientName: 'Cliente Uno', collectorName: 'Matias', isAtlasAccount: false } });
  assert.deepEqual(subject, { main: 'Cód. 345 · ref. 5318 · Gs. 319.000', detail: 'Cliente Uno · cargada por Matias · depósito BNF' });
  assert.equal(auditSubject({ bankTransfer: { id: 't', amount: 1000, bankDocNumber: '25895' } }).main, 'Transferencia Gs. 1.000');
  assert.deepEqual(auditSubject({ targetUserName: 'Hugo Caja' }), { main: 'Usuario Hugo Caja', detail: null });
  assert.equal(auditSubject({}), null);
});

test('quién: nombre completo, usuario aparte, y "Sistema" para lo automático', () => {
  assert.deepEqual(auditActor({ userId: 'u1', actorUsername: 'edison', actorName: 'Edison Roa' }), { name: 'Edison Roa', username: 'edison' });
  assert.deepEqual(auditActor({ userId: 'system' }), { name: 'Sistema', username: null });
});

test('el filtro cubre todas las acciones con etiqueta, sin repetir', () => {
  const all = AUDIT_ACTION_GROUPS.flatMap((g) => g.actions);
  assert.equal(new Set(all).size, all.length);
  for (const code of all) assert.notEqual(auditActionLabel(code), code);
});

test('las pantallas de auditoría usan el formateador común, no códigos ni JSON crudos', () => {
  for (const file of ['views/admin/AuditView.tsx', 'components/PaymentTimelineModal.tsx', 'views/AdminDashboard.tsx']) {
    const source = readFileSync(join(__dirname, '..', file), 'utf8');
    assert.match(source, /describeAudit\(log\)/, file);
  }
  const audit = readFileSync(join(__dirname, '..', 'views', 'admin', 'AuditView.tsx'), 'utf8');
  assert.doesNotMatch(audit, /paymentId\.slice\(0, 8\)/);
});
