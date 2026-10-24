const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = readFileSync(join(__dirname, '..', 'views', 'CobradorDashboard.tsx'), 'utf8');
const sourceFile = ts.createSourceFile('CobradorDashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const initializer = node.initializer;
    callbacks.set(node.name.text, ts.isCallExpression(initializer) && initializer.expression.getText(sourceFile) === 'useCallback'
      ? initializer.arguments[0].getText(sourceFile)
      : initializer.getText(sourceFile));
  }
  if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'socket.on'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'payments:changed') {
    callbacks.set('paymentsChanged', node.arguments[1].getText(sourceFile));
  }
  ts.forEachChild(node, visit);
};
visit(sourceFile);

const deferred = () => {
  let resolve;
  const promise = new Promise((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
};

const page = (status) => ({
  items: [{ id: 'payment-1', createdById: 'collector-1', status }],
  page: 1,
  totalPages: 1,
  total: 1,
});

const evaluateCallback = (name, scope) => {
  const arrow = callbacks.get(name);
  assert.ok(arrow, `Falta el callback ${name}`);
  // Shared refs used by a future request-order guard must retain identity across callbacks.
  for (const match of arrow.matchAll(/\b([A-Za-z_$][\w$]*)\.current\b/g)) {
    if (!(match[1] in scope)) scope[match[1]] = { current: 0 };
  }
  const compiled = ts.transpileModule(`const callback = ${arrow};`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('scope', `with (scope) { ${compiled}\nreturn callback; }`)(scope);
};

const makePaymentsScope = (fetchPaymentsPage) => {
  const state = { payments: [] };
  const scope = {
    fetchPaymentsPage,
    setPayments(next) { state.payments = typeof next === 'function' ? next(state.payments) : next; },
    setHistoryPage() {},
    setHistoryTotalPages() {},
    setHistoryTotal() {},
    setInitialLoad() {},
    setPaymentsLoadError() {},
  };
  return { state, scope };
};

const listStart = source.indexOf('LIST TAB: Payment history with search');
const listEnd = source.indexOf('RANK TAB', listStart);
const listSource = source.slice(listStart, listEnd);
const refreshButton = (listSource.match(/<button\b[\s\S]*?<\/button>/g) || [])
  .find((button) => /\bActualizar\b/.test(button.slice(button.indexOf('>') + 1)));

test('Mis pagos offers a visible, non-submitting manual refresh button', () => {
  assert.ok(listStart >= 0 && listEnd > listStart, 'La lista Mis pagos debe existir');
  assert.ok(refreshButton, 'La lista Mis pagos debe tener un botón visible Actualizar');
  assert.match(refreshButton, /\btype="button"/);
  assert.match(refreshButton, /\bdisabled=\{/);
  assert.match(refreshButton, /\bonClick=\{[A-Za-z_$][\w$]*\}/);
});

test('manual refresh and pull-to-refresh share the same read-only list refresh without clearing an in-progress form or search', () => {
  assert.ok(refreshButton, 'Primero debe existir el botón Actualizar en Mis pagos');
  const callbackName = refreshButton.match(/\bonClick=\{([A-Za-z_$][\w$]*)\}/)?.[1];
  assert.ok(callbackName, 'El botón debe invocar un callback de actualización compartido');

  const refreshCallback = callbacks.get(callbackName);
  const pullCallback = callbacks.get('handleTouchEnd');
  assert.ok(refreshCallback, 'El callback de actualización debe estar definido');
  assert.ok(pullCallback, 'El gesto de arrastrar para refrescar debe seguir disponible');
  assert.match(refreshCallback, /fetchPayments\(historyPage\)/);
  assert.match(pullCallback, new RegExp(`\\b${callbackName}\\(\\)`));
  assert.doesNotMatch(refreshCallback, /cancelEdit\(|setPaymentState\(|setFile\(|setSearchQuery\(|location\.reload\(|api\.(?:post|patch|put|delete)\(/);
});

test('a delayed earlier list response cannot replace a newer manual refresh result', async () => {
  const older = deferred();
  const newer = deferred();
  let calls = 0;
  const { state, scope } = makePaymentsScope(() => (++calls === 1 ? older.promise : newer.promise));
  const fetchPayments = evaluateCallback('fetchPayments', scope);

  const first = fetchPayments(1);
  const manual = fetchPayments(1);
  newer.resolve(page('CONFIRMADO'));
  await manual;
  older.resolve(page('PENDIENTE_VERIFICACION'));
  await first;

  assert.equal(state.payments[0].status, 'CONFIRMADO');
});

test('a delayed list response cannot undo a newer websocket confirmation', async () => {
  const older = deferred();
  const { state, scope } = makePaymentsScope(() => older.promise);
  Object.assign(scope, {
    user: { id: 'collector-1' },
    lastNotifiedRef: { current: {} },
    getUserId: (value) => typeof value === 'string' ? value : value?.id || '',
    fetchPaymentDetail: async () => page('CONFIRMADO').items[0],
    upsertPayment: (items, payment) => [payment, ...items.filter((item) => item.id !== payment.id)],
    getDecisionReason: () => '',
    showToast() {},
    PaymentState: {
      CONFIRMADO: 'CONFIRMADO',
      CONFIRMADO_MANUAL: 'CONFIRMADO_MANUAL',
      RECHAZADO: 'RECHAZADO',
      PENDIENTE_VERIFICACION: 'PENDIENTE_VERIFICACION',
    },
  });
  const fetchPayments = evaluateCallback('fetchPayments', scope);
  const onPaymentsChanged = evaluateCallback('paymentsChanged', scope);

  const first = fetchPayments(1);
  await onPaymentsChanged({ paymentId: 'payment-1', type: 'PAYMENT_AUTO_CONFIRMED', targetUserId: 'collector-1' });
  older.resolve(page('PENDIENTE_VERIFICACION'));
  await first;

  assert.equal(state.payments[0].status, 'CONFIRMADO');
});

test('PAYMENT_UPDATED refresca una consulta parcialmente conciliada sin anunciar una decisión', async () => {
  const state = { payments: [{ id: 'payment-1', status: 'PENDIENTE_VERIFICACION', allocatedAmount: 0 }], toasts: [] };
  const scope = {
    user: { id: 'collector-1' },
    lastNotifiedRef: { current: {} },
    getUserId: (value) => typeof value === 'string' ? value : value?.id || '',
    fetchPaymentDetail: async () => ({
      id: 'payment-1', createdById: 'collector-1', status: 'PENDIENTE_VERIFICACION', allocatedAmount: 500,
    }),
    setPayments(next) { state.payments = typeof next === 'function' ? next(state.payments) : next; },
    upsertPayment: (items, payment) => [payment, ...items.filter((item) => item.id !== payment.id)],
    getDecisionReason: () => '',
    showToast(type, message) { state.toasts.push({ type, message }); },
    PaymentState: {
      CONFIRMADO: 'CONFIRMADO',
      CONFIRMADO_MANUAL: 'CONFIRMADO_MANUAL',
      RECHAZADO: 'RECHAZADO',
      PENDIENTE_VERIFICACION: 'PENDIENTE_VERIFICACION',
    },
  };
  const onPaymentsChanged = evaluateCallback('paymentsChanged', scope);

  await onPaymentsChanged({ paymentId: 'payment-1', type: 'PAYMENT_UPDATED', targetUserId: 'collector-1' });

  assert.equal(state.payments[0].allocatedAmount, 500);
  assert.deepEqual(state.toasts, []);
  assert.deepEqual(scope.lastNotifiedRef.current, {});
});

test('manual refresh finishes after list load even if KPI request does not settle', async () => {
  const stuckKpi = deferred();
  const state = { busy: false, toasts: [] };
  const scope = {
    refreshInFlightRef: { current: false },
    setIsRefreshing(value) { state.busy = value; },
    fetchPayments: async () => true,
    fetchKpis: () => stuckKpi.promise,
    historyPage: 1,
    showToast(type, message) { state.toasts.push({ type, message }); },
  };
  const refreshConsultations = evaluateCallback('refreshConsultations', scope);
  const refresh = refreshConsultations();
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(state.busy, false, 'El botón no debe quedar bloqueado por un KPI ajeno a Mis pagos');
    assert.deepEqual(state.toasts, [{ type: 'success', message: 'Consultas actualizadas.' }]);
  } finally {
    stuckKpi.resolve();
    await refresh;
  }
});
