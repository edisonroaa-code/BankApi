// Run with: node --test tests/test_frontend_regressions.js
// All requests and DOM nodes are synthetic; these tests never contact Atlas.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const htmlTemplate = fs.readFileSync(path.join(__dirname, "..", "templates", "index.html"), "utf8");

function createNode() {
  const listeners = new Map();
  const classes = new Set();
  return {
    value: "", checked: false, disabled: false, textContent: "", innerHTML: "",
    children: [], dataset: {}, className: "",
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      toggle(value, active) { if (active) classes.add(value); else classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener(event, callback) { listeners.set(event, callback); },
    dispatch(event, details = {}) { return listeners.get(event)?.({ preventDefault() {}, target: this, ...details }); },
    appendChild(child) { this.children.push(child); },
    remove() {}, setAttribute() {}, querySelectorAll() { return []; },
  };
}

function harness(replies = {}) {
  const nodes = new Map();
  const requests = [];
  const storageWrites = [];
  const intervals = [];
  const documentListeners = new Map();
  const getNode = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, createNode());
    return nodes.get(selector);
  };
  const context = {
    Intl, URLSearchParams, Date, Set, Object, String, Number, Error, console,
    document: {
      title: "Synthetic Atlas screen", querySelector: getNode,
      querySelectorAll() { return []; }, addEventListener(event, callback) { documentListeners.set(event, callback); }, createElement: createNode,
    },
    localStorage: {
      removeItem() {},
      getItem() { return JSON.stringify({ account: "123456", detailed: true }); },
      setItem(key, value) { storageWrites.push({ key, value }); },
    },
    window: { setInterval(callback) { intervals.push(callback); }, setTimeout() {} },
    bootstrap: { Offcanvas: { getInstance() { return null; } } },
    async fetch(url, options) {
      requests.push({ url, options });
      const reply = await (typeof replies === "function" ? replies(url) : replies[url.includes("/saldo/") ? "balance" : "movements"]);
      if (!reply) throw new Error("No synthetic response configured");
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, async json() { return reply.payload; } };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  getNode("#autoRefresh").checked = true;
  return { nodes, requests, storageWrites, intervals, getNode, dispatchDocument: (event) => documentListeners.get(event)?.(), run: (code) => vm.runInContext(code, context) };
}

const balance = {
  nroCuenta: "123456", saldo: 10, saldoDisponible: 8, moneda: "PYG",
  producto: { codigo: 1, descripcion: "Synthetic account" }, infoAdicional: {},
};
const movement = {
  numeroCuenta: "123456", monto: 1, moneda: "PYG", concepto: "Synthetic movement",
  tipoMovimiento: "CREDITO", fechaMovimiento: "2026-10-03T00:00:00-03:00", infoAdicional: {},
};
const success = () => ({ balance: { status: 200, payload: balance }, movements: { status: 200, payload: { listaMovimiento: [movement] } } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("unknown movement type does not become a credit", () => {
  const ui = harness();
  ui.run(`renderMovements([${JSON.stringify({ ...movement, tipoMovimiento: "UNKNOWN" })}])`);
  const html = ui.getNode("#movementsTable").innerHTML;
  assert.ok(html.includes("No informado"));
  assert.ok(!html.includes("Crédito"));
  assert.ok(!html.includes("text-success"));
});

test("invalid currencies and non-numeric amounts never render plausible money", () => {
  const ui = harness();
  assert.equal(ui.run("formatMoney(1, 'NOT_A_CURRENCY')"), "Dato inválido");
  for (const value of ["true", "'12'", "Infinity", "NaN", "{}"])
    assert.equal(ui.run(`formatMoney(${value}, 'PYG')`), "Dato inválido");
  assert.equal(ui.run("formatMoney(null, 'PYG')"), "--");
  assert.notEqual(ui.run("formatMoney(0, 'PYG')"), "--");
});

test("invalid dates are explicitly invalid instead of fabricated dates", () => {
  const ui = harness();
  for (const value of ["'not-a-date'", "true", "1", "'2026-02-30T00:00:00-03:00'"])
    assert.equal(ui.run(`formatDate(${value})`), "Dato inválido");
  assert.notEqual(ui.run("formatDate('2026-10-03T00:00:00-03:00')"), "Dato inválido");
});

test("distinct Bancard identifiers count as distinct new movements", () => {
  const ui = harness();
  ui.run(`trackNewMovements([${JSON.stringify({ ...movement, nroTransaccionBancard: 100 })}])`);
  ui.run(`trackNewMovements([${JSON.stringify({ ...movement, nroTransaccionBancard: 101 })}])`);
  assert.equal(ui.getNode("#newCount").textContent, "1 nuevo");
});

test("loading a remembered account makes no automatic financial request", () => {
  const ui = harness(success());
  ui.intervals[0]();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.getNode("#countdown").textContent, "--");
});

test("successful manual consultation refreshes at 15 seconds, never at 14 seconds", async () => {
  const ui = harness(success());
  await ui.run("refresh(false)");
  assert.equal(ui.requests.length, 2);
  for (let i = 0; i < 14; i++) ui.intervals[0]();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.getNode("#countdown").textContent, "1s");
  ui.intervals[0]();
  assert.equal(ui.requests.length, 4);
  await flush();
  assert.equal(ui.getNode("#serviceStatus").textContent, "Al día");
});

test("15-second automatic refresh never overlaps a pending consultation", async () => {
  const replies = success();
  const ui = harness(replies);
  await ui.run("refresh(false)");
  const pendingBalance = deferred();
  const pendingMovements = deferred();
  replies.balance = pendingBalance.promise;
  replies.movements = pendingMovements.promise;
  try {
    for (let i = 0; i < 15; i++) ui.intervals[0]();
    assert.equal(ui.requests.length, 4);
    assert.equal(ui.run("isFetching"), true);
    for (let i = 0; i < 60; i++) ui.intervals[0]();
    await ui.run("refresh(true)");
    assert.equal(ui.requests.length, 4);
    assert.notEqual(ui.getNode("#serviceStatus").textContent, "Al día");
  } finally {
    pendingBalance.resolve(success().balance);
    pendingMovements.resolve(success().movements);
    await flush();
  }
  assert.equal(ui.run("isFetching"), false);
  Object.assign(replies, success());
  for (let i = 0; i < 14; i++) ui.intervals[0]();
  assert.equal(ui.requests.length, 4);
  ui.intervals[0]();
  assert.equal(ui.requests.length, 6);
  await flush();
});

test("a rejected 15-second automatic consultation pauses polling immediately", async () => {
  const replies = success();
  const ui = harness(replies);
  await ui.run("refresh(false)");
  const pendingBalance = deferred();
  replies.balance = pendingBalance.promise;
  replies.movements = { status: 401, payload: { code: "cm1057", message: "Synthetic rejection" } };
  try {
    for (let i = 0; i < 15; i++) ui.intervals[0]();
    await flush();
    assert.equal(ui.requests.length, 4);
    assert.equal(ui.run("queryActivated"), false);
    assert.equal(ui.getNode("#countdown").textContent, "--");
    assert.ok(!ui.getNode("#movementsTable").innerHTML.includes("Synthetic movement"));
    for (let i = 0; i < 45; i++) ui.intervals[0]();
    assert.equal(ui.requests.length, 4);
  } finally {
    pendingBalance.resolve(success().balance);
    await flush();
  }
  assert.equal(ui.run("queryActivated"), false);
  for (let i = 0; i < 45; i++) ui.intervals[0]();
  assert.equal(ui.requests.length, 4);
});

test("internal adapter key is sent only when operator provides it and is never persisted", async () => {
  const ui = harness(success());
  await ui.run("fetchJson('/api/saldo/123456')");
  assert.equal(ui.requests[0].options.headers["X-Internal-ApiKey"], undefined);
  ui.getNode("#internalApiKey").value = "SYNTHETIC_INTERNAL_KEY";
  await ui.run("fetchJson('/api/saldo/123456')");
  assert.equal(ui.requests[1].options.headers["X-Internal-ApiKey"], "SYNTHETIC_INTERNAL_KEY");
  ui.run("saveConfig(readForm())");
  assert.ok(!JSON.stringify(ui.storageWrites).includes("SYNTHETIC_INTERNAL_KEY"));
  assert.ok(ui.requests.every((request) => !request.options.method || request.options.method === "GET"));
});

test("local unauthorized response guides operator and is distinct from bank error", async () => {
  const ui = harness({ balance: { status: 401, payload: { code: "UNAUTHORIZED", message: "X-Internal-ApiKey ausente o inválida." } } });
  await assert.rejects(ui.run("fetchJson('/api/saldo/123456')"), (error) => {
    assert.equal(error.code, "UNAUTHORIZED");
    assert.ok(error.message.includes("Clave interna"));
    assert.ok(error.message.includes("Opciones"));
    assert.ok(!error.message.includes("Banco Atlas rechazó"));
    return true;
  });
});

test("bank unauthorized code remains internal while the operator sees a friendly message", async () => {
  const ui = harness({ balance: { status: 401, payload: { code: "cm1057", message: "Banco Atlas rechazó la solicitud (401)." } } });
  await assert.rejects(ui.run("fetchJson('/api/saldo/123456')"), (error) => {
    assert.equal(error.code, "cm1057");
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes("cm1057"));
    assert.ok(!error.message.includes("401"));
    assert.ok(!error.message.includes("Clave interna"));
    return true;
  });
});

test("successful balance remains visible when movements are rejected, with polling stopped", async () => {
  const replies = success();
  replies.movements = { status: 401, payload: { code: "cm1057", message: "Bank rejection" } };
  const ui = harness(replies);
  await ui.run("refresh(false)");
  assert.notEqual(ui.getNode("#availableBalance").textContent, "--");
  assert.equal(ui.getNode("#serviceStatus").textContent, "Consulta parcial");
  assert.ok(ui.getNode("#movementsTable").innerHTML.includes("El banco no autorizó"));
  assert.equal(ui.run("queryActivated"), false);
});

test("successful movements remain visible when balance fails", async () => {
  const replies = success();
  replies.balance = { status: 502, payload: { code: "ATLAS_CONTRACT_ERROR", message: "Synthetic contract error" } };
  const ui = harness(replies);
  await ui.run("refresh(false)");
  assert.equal(ui.getNode("#availableBalance").textContent, "--");
  assert.ok(ui.getNode("#movementsTable").innerHTML.includes("Synthetic movement"));
  assert.equal(ui.getNode("#serviceStatus").textContent, "Consulta parcial");
});

test("failed refresh removes old current-looking data and stops polling on 4xx", async () => {
  const replies = success();
  const ui = harness(replies);
  await ui.run("refresh(false)");
  assert.equal(ui.run("queryActivated"), true);
  replies.balance = { status: 401, payload: { code: "cm1057", message: "Bank rejection" } };
  replies.movements = replies.balance;
  await ui.run("refresh(true)");
  assert.equal(ui.getNode("#availableBalance").textContent, "--");
  assert.ok(!ui.getNode("#movementsTable").innerHTML.includes("Synthetic movement"));
  assert.equal(ui.run("queryActivated"), false);
  const before = ui.requests.length;
  for (let i = 0; i < 120; i++) ui.intervals[0]();
  assert.equal(ui.requests.length, before);
});

test("malformed successful data does not activate polling or claim up-to-date", async () => {
  const replies = success();
  replies.balance.payload = { ...balance, saldo: true };
  replies.movements.payload = { listaMovimiento: [{ ...movement, tipoMovimiento: "UNKNOWN" }] };
  const ui = harness(replies);
  await ui.run("refresh(false)");
  assert.equal(ui.run("queryActivated"), false);
  assert.notEqual(ui.getNode("#serviceStatus").textContent, "Al día");
  assert.equal(ui.getNode("#availableBalance").textContent, "--");
  assert.ok(!ui.getNode("#movementsTable").innerHTML.includes("Crédito"));
});

test("movement rejection clears stale rows immediately while balance is still pending", async () => {
  const replies = success();
  const ui = harness(replies);
  await ui.run("refresh(false)");
  const pendingBalance = deferred();
  replies.balance = pendingBalance.promise;
  replies.movements = { status: 401, payload: { code: "cm1057", message: "Bank rejection" } };
  const pendingRefresh = ui.run("refresh(true)");
  try {
    await flush();
    assert.ok(!ui.getNode("#movementsTable").innerHTML.includes("Synthetic movement"));
    assert.ok(ui.getNode("#movementsTable").innerHTML.includes("El banco no autorizó"));
    assert.notEqual(ui.getNode("#serviceStatus").textContent, "Al día");
    assert.equal(ui.run("queryActivated"), false);
  } finally {
    pendingBalance.resolve(success().balance);
    await pendingRefresh;
  }
});

test("old successful requests cannot reactivate polling after internal key changes", async () => {
  const pendingBalance = deferred();
  const pendingMovements = deferred();
  const replies = { balance: pendingBalance.promise, movements: pendingMovements.promise };
  const ui = harness(replies);
  ui.getNode("#internalApiKey").value = "SYNTHETIC_OLD_KEY";
  const pendingRefresh = ui.run("refresh(false)");
  ui.getNode("#internalApiKey").value = "SYNTHETIC_NEW_KEY";
  ui.getNode("#internalApiKey").dispatch("input");
  pendingBalance.resolve(success().balance);
  pendingMovements.resolve(success().movements);
  await pendingRefresh;
  assert.equal(ui.run("queryActivated"), false);
  assert.equal(ui.getNode("#availableBalance").textContent, "--");
  assert.ok(ui.requests.every((request) => request.options.headers["X-Internal-ApiKey"] === "SYNTHETIC_OLD_KEY"));
  const before = ui.requests.length;
  for (let i = 0; i < 120; i++) ui.intervals[0]();
  await flush();
  assert.equal(ui.requests.length, before);
  Object.assign(replies, success());
  ui.getNode("#queryForm").dispatch("submit");
  await flush();
  assert.equal(ui.run("queryActivated"), true);
  assert.ok(ui.requests.slice(before).every((request) => request.options.headers["X-Internal-ApiKey"] === "SYNTHETIC_NEW_KEY"));
});

test("editing query parameters invalidates in-flight results until a new manual submit", async () => {
  const pendingBalance = deferred();
  const pendingMovements = deferred();
  const replies = { balance: pendingBalance.promise, movements: pendingMovements.promise };
  const ui = harness(replies);
  const pendingRefresh = ui.run("refresh(false)");
  ui.getNode("#startDate").value = "2026-10-02";
  ui.getNode("#queryForm").dispatch("input", { target: ui.getNode("#startDate") });
  pendingBalance.resolve(success().balance);
  pendingMovements.resolve(success().movements);
  await pendingRefresh;
  assert.equal(ui.run("queryActivated"), false);
  assert.equal(ui.getNode("#availableBalance").textContent, "--");
  assert.ok(!ui.getNode("#movementsTable").innerHTML.includes("Synthetic movement"));
  Object.assign(replies, success());
  const before = ui.requests.length;
  ui.getNode("#queryForm").dispatch("submit");
  await flush();
  assert.equal(ui.run("queryActivated"), true);
  assert.ok(ui.requests.slice(before).some((request) => request.url.includes("fecInicio=2026-10-02")));
});

test("completion of invalidated requests cannot unlock a newer pending query", async () => {
  const oldBalance = deferred();
  const oldMovements = deferred();
  const newBalance = deferred();
  const newMovements = deferred();
  const replies = { balance: oldBalance.promise, movements: oldMovements.promise };
  const ui = harness(replies);
  const oldRefresh = ui.run("refresh(false)");
  ui.getNode("#internalApiKey").value = "SYNTHETIC_NEW_KEY";
  ui.getNode("#internalApiKey").dispatch("input");
  replies.balance = newBalance.promise;
  replies.movements = newMovements.promise;
  ui.getNode("#queryForm").dispatch("submit");
  oldBalance.resolve(success().balance);
  oldMovements.resolve(success().movements);
  await oldRefresh;
  try {
    assert.equal(ui.run("isFetching"), true);
    assert.equal(ui.getNode("#submitButton").disabled, true);
    assert.equal(ui.run("queryActivated"), false);
    assert.equal(ui.getNode("#availableBalance").textContent, "--");
  } finally {
    newBalance.resolve(success().balance);
    newMovements.resolve(success().movements);
    await flush();
  }
  assert.equal(ui.run("isFetching"), false);
  assert.equal(ui.run("queryActivated"), true);
});

test("operational screen has no environment banner or API version labels", async () => {
  assert.ok(!htmlTemplate.includes("preproductionNotice"));
  assert.ok(!/Modo preproducción|modo producción|v1\.1/i.test(htmlTemplate));
  assert.ok(!htmlTemplate.includes("Débito (D)"));
  assert.ok(!htmlTemplate.includes("Crédito (C)"));
  const ui = harness(success());
  ui.dispatchDocument("DOMContentLoaded");
  await flush();
  assert.equal(ui.requests.length, 0);
  await ui.run("refresh(false)");
  assert.ok(!ui.getNode("#movementEndpointType").textContent.includes("v1.1"));
  const url = ui.run("buildMovementsUrl({...config, movementType: 'D'})");
  assert.ok(url.includes("tipoMovimiento=D"));
});

test("technical API error details are never displayed but remain available internally", async () => {
  const raw = { code: "ATLAS_CONTRACT_ERROR", message: "HTTP 502 infoAdicional.cod_tra_padre \u0000", details: { field: "infoAdicional.cod_tra_padre" } };
  const ui = harness({ balance: { status: 502, payload: raw }, movements: { status: 502, payload: raw } });
  await assert.rejects(ui.run("fetchJson('/api/saldo/123456')"), (error) => {
    assert.equal(error.code, "ATLAS_CONTRACT_ERROR");
    assert.equal(error.status, 502);
    assert.ok(!/ATLAS_CONTRACT_ERROR|infoAdicional|cod_tra_padre|HTTP|502/.test(error.message));
    return true;
  });
  await ui.run("refresh(false)");
  const visible = ui.getNode("#movementsTable").innerHTML + ui.getNode("#alertHost").children.map((child) => child.textContent).join(" ");
  assert.ok(!/ATLAS_CONTRACT_ERROR|infoAdicional|cod_tra_padre|HTTP|502/.test(visible));
  assert.notEqual(ui.getNode("#serviceStatus").textContent, "Al día");
});

test("movement details show readable business fields and omit opaque audit metadata", () => {
  const item = { ...movement, nroDocumento: 123, nroTransaccionBancard: 456, monedaDetalle: { iso: "PYG", nombre: "Guaraníes", codigo: 6900 }, infoAdicional: { nom_remitente: "Álvaro", nro_doc_remitente: "123-A", nro_cta_remitente: "654321", concepto: "Depósito", des_transaccion: "Transferencia recibida", reversado: "N", cod_tra_padre: 388, cod_transaccion: 602, cod_usuario: "OPAQUE_OPERATOR", estado: "OPAQUE_STATE" } };
  const ui = harness();
  ui.run(`currentMovements = [${JSON.stringify(item)}]; openDetailModal(0)`);
  const html = ui.getNode("#modalContent").innerHTML;
  assert.ok(html.includes("Remitente") && html.includes("Álvaro") && html.includes("Transferencia recibida"));
  assert.ok(html.includes("456") && html.includes("123-A"));
  assert.ok(html.includes("Reversado") && html.includes(">No<"));
  assert.ok(!/info:|cod_tra_padre|cod_transaccion|cod_usuario|OPAQUE_|monedaDetalle|&quot;iso&quot;/.test(html));
  assert.equal(ui.run("JSON.stringify(currentMovements[0])"), JSON.stringify(item));
});

test("display removes control and invisible characters, preserving accents, references and escaping", () => {
  const item = { ...movement, concepto: "Depó\u0000sito\u001b \u200BÁlvaro\u0085 <img src=x onerror=alert(1)>", nroDocumento: 123, nroTransaccionBancard: 456 };
  const ui = harness();
  ui.run(`renderMovements([${JSON.stringify(item)}]); renderBalance(${JSON.stringify({ ...balance, producto: { descripcion: "Cuenta\u0000 Ágil\u200B", descripcionCorta: "OPAQUE_PRODUCT" } })})`);
  const html = ui.getNode("#movementsTable").innerHTML;
  assert.ok(html.includes("Depósito Álvaro"));
  assert.ok(html.includes("&lt;img") && !html.includes("<img"));
  assert.ok(html.includes("123") && html.includes("456"));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f]/.test(html));
  assert.equal(ui.getNode("#productBadge").textContent, "Cuenta Ágil");
});

test("alias result shows labels and names instead of internal codes or raw JSON", async () => {
  const payload = { nroCuenta: "123456", denominacion: "Cuenta sintética", entidad: { codigo: "OPAQUE_BANK_CODE", descripcion: "Banco sintético" }, tipoDocumento: { codigo: "OPAQUE_DOCUMENT_CODE", descripcion: "Cédula" }, nroDocumento: "123-A", moneda: { nombre: "Guaraníes", codigo: 6900 } };
  const ui = harness(() => ({ status: 200, payload }));
  ui.run("openTool('alias')");
  ui.getNode("#aliasTipo").value = "CI";
  ui.getNode("#aliasValor").value = "synthetic";
  await ui.getNode("#aliasForm").dispatch("submit");
  const html = ui.getNode("#toolResult").innerHTML;
  assert.ok(html.includes("Banco sintético") && html.includes("Guaraníes"));
  assert.ok(!/OPAQUE_|&quot;nombre&quot;|&quot;codigo&quot;/.test(html));
});

test("catalog entries display descriptions rather than opaque catalog codes", () => {
  const ui = harness();
  const html = ui.run(`renderCatalog(${JSON.stringify({ listaDatos: [{ codigo: "OPAQUE_CODE", descripcion: "Banco sintético" }] })}, 'Entidad')`);
  assert.ok(html.includes("Banco sintético"));
  assert.ok(!html.includes("OPAQUE_CODE"));
});

test("transfer status displays readable fields and no raw enum keys or metadata JSON", async () => {
  const payload = { nroReferencia: 123, clasificacion: "INDETERMINADO", situacion: "V", estado: "S", monto: 1, moneda: { iso: "PYG", nombre: "Guaraníes", codigo: 6900 }, concepto: "Transferencia sintética", nomBeneficiario: "Álvaro", codSwiPteBeneficiario: "OPAQUE_SWIFT", unknownMetadata: { secret: "OPAQUE_METADATA" } };
  const ui = harness(() => ({ status: 200, payload }));
  ui.run("openTool('sipap')");
  ui.getNode("#sipapRef").value = "123";
  await ui.getNode("#sipapForm").dispatch("submit");
  const html = ui.getNode("#toolResult").innerHTML;
  assert.ok(html.includes("Álvaro") && html.includes("Transferencia sintética"));
  assert.ok(/Pendiente|por confirmar|no confirmado/i.test(html));
  assert.ok(!/INDETERMINADO|situacion|clasificacion|codSwi|unknownMetadata|OPAQUE_|&quot;iso&quot;/.test(html));
});

test("valid operation currency without optional ISO retains its amount", () => {
  const ui = harness();
  for (const moneda of [
    { nombre: "Guaraníes", codigo: 6900, abreviatura: "GS" },
    { nombre: "Dólares Americanos", codigo: 1, abreviatura: "USD" },
  ]) {
    const payload = { clasificacion: "OK", moneda, monto: 12, nroReferencia: 123 };
    const html = ui.run(`renderSipapResult(${JSON.stringify(payload)})`);
    assert.ok(!html.includes("Dato inválido"));
    assert.ok(html.includes("12"));
    assert.ok(html.includes(moneda.nombre));
  }
});

test("unmapped valid currency uses its readable name without inventing an ISO code", () => {
  const ui = harness();
  const moneda = { nombre: "Moneda sintética", codigo: 987, abreviatura: "MS" };
  assert.equal(ui.run(`formatOperationMoney(12.5, ${JSON.stringify(moneda)})`), "12,5 Moneda sintética");
  for (const value of ["true", "'12.5'", "Infinity", "NaN"])
    assert.equal(ui.run(`formatOperationMoney(${value}, ${JSON.stringify(moneda)})`), "Dato inválido");
  assert.equal(ui.run("formatOperationMoney(12, {nombre: 'Guaraníes', codigo: true, abreviatura: 'GS'})"), "Dato inválido");
});

test("operation money never repairs an invalid or contradictory present currency", () => {
  const ui = harness();
  const valid = { nombre: "Guaraníes", codigo: 6900, abreviatura: "GS" };
  for (const currency of [
    { ...valid, iso: "NOT_A_CURRENCY" },
    { ...valid, iso: "" },
    { ...valid, iso: true },
    { ...valid, iso: "USD" },
    { ...valid, abreviatura: "USD" },
    { ...valid, codigo: "6900" },
    { ...valid, codigo: Infinity },
    { ...valid, nombre: {} },
    { ...valid, nombre: " " },
    { ...valid, abreviatura: {} },
  ]) {
    const literal = JSON.stringify(currency); // Infinity becomes null, also invalid.
    assert.equal(ui.run(`formatOperationMoney(12, ${literal})`), "Dato inválido");
  }
  assert.notEqual(ui.run(`formatOperationMoney(12, ${JSON.stringify({ ...valid, iso: null })})`), "Dato inválido");
  assert.equal(ui.run(`formatOperationMoney(NaN, ${JSON.stringify(valid)})`), "Dato inválido");
  assert.equal(ui.run(`formatOperationMoney(Infinity, ${JSON.stringify(valid)})`), "Dato inválido");
});

test("transfer details preserve motive, rejection detail and external operation references", () => {
  const ui = harness();
  const payload = { clasificacion: "ERROR", motivo: "Pago de servicios", tipRechazo: "Cuenta cerrada", nroOperacion: 456, nroRefExterna: "EXT-SYNTHETIC", codMotivo: "OPAQUE_MOTIVE", codTipRechazo: "OPAQUE_REJECTION" };
  const html = ui.run(`renderSipapResult(${JSON.stringify(payload)})`);
  assert.ok(html.includes("Motivo") && html.includes("Pago de servicios"));
  assert.ok(html.includes("Detalle del rechazo") && html.includes("Cuenta cerrada"));
  assert.ok(html.includes("Número de operación") && html.includes("456"));
  assert.ok(html.includes("Referencia externa") && html.includes("EXT-SYNTHETIC"));
  assert.ok(!/tipRechazo|nroOperacion|nroRefExterna|codMotivo|OPAQUE_/.test(html));
});

test("pending and unconfirmed transfers retain the no-reversal and minimum-wait instructions", () => {
  const ui = harness();
  for (const classification of ["INTERMEDIO", "INDETERMINADO"]) {
    const html = ui.run(`renderClasificacion({clasificacion: '${classification}'})`);
    assert.ok(/no revers/i.test(html));
    assert.ok(/al menos 60 segundos/i.test(html));
    assert.ok(!html.includes(classification));
  }
});

test("movement details preserve both distinct transaction and category descriptions", () => {
  const ui = harness();
  const item = { ...movement, infoAdicional: { des_transaccion: "Transferencia recibida", des_tra_padre: "Ingresos por transferencia" } };
  ui.run(`currentMovements = [${JSON.stringify(item)}]; openDetailModal(0)`);
  const html = ui.getNode("#modalContent").innerHTML;
  assert.ok(html.includes("Transferencia recibida") && html.includes("Ingresos por transferencia"));
  assert.ok(html.includes("Categoría de la operación"));
  ui.run(`currentMovements[0].infoAdicional.des_tra_padre = 'Transferencia recibida'; openDetailModal(0)`);
  assert.equal((ui.getNode("#modalContent").innerHTML.match(/Transferencia recibida/g) || []).length, 1);
});

test("catalog entries preserve both readable long and short descriptions without their code", () => {
  const ui = harness();
  const html = ui.run(`renderCatalog(${JSON.stringify({ listaDatos: [{ codigo: "OPAQUE_CODE", descripcion: "Cédula de identidad", descripcionCorta: "CI" }] })}, 'Documento')`);
  assert.ok(html.includes("Cédula de identidad") && html.includes("CI"));
  assert.ok(!html.includes("OPAQUE_CODE"));
  const same = ui.run(`renderCatalog(${JSON.stringify({ listaDatos: [{ descripcion: "Cédula", descripcionCorta: "Cédula" }] })}, 'Documento')`);
  assert.equal((same.match(/Cédula/g) || []).length, 1);
});
