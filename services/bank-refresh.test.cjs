const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = join(__dirname, "bank-refresh.ts");
const compiledSource = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const loadedModule = { exports: {} };
new Function("exports", "require", "module", compiledSource)(
  loadedModule.exports,
  require,
  loadedModule,
);
const { refreshRemainingMs, serverClockOffsetMs, refreshRejectionMessage, withClockOffset, feedChangedSince } = loadedModule.exports;

test("la lista se lee despues del contador: un aviso perdido durante la carga no se da por recibido", async () => {
  let answerStatus;
  const rows = [];
  let listReads = 0;
  const snapshot = loadedModule.exports.readBankFeedSnapshot(
    () => new Promise((resolve) => { answerStatus = resolve; }),
    async () => { listReads++; return [...rows]; },
  );
  assert.equal(listReads, 0);
  rows.push({ id: 'segundo-deposito' });
  answerStatus({ changeCount: 1 });
  assert.deepEqual(await snapshot, { status: { changeCount: 1 }, list: [{ id: 'segundo-deposito' }] });
});

test("el sondeo automatico continuo no impide pulsar Actualizar para recuperar la lista", () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const componentModule = { exports: {} };
  const componentCode = ts.transpileModule(readFileSync(join(__dirname, '../components/bank/BankRefreshButton.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  new Function('exports', 'require', 'module', componentCode)(componentModule.exports, (name) => {
    if (name === '../../services/bank-refresh') return loadedModule.exports;
    if (name === '../../services/bankTransfers') return {};
    return require(name);
  }, componentModule);
  const markup = renderToStaticMarkup(React.createElement(componentModule.exports.BankRefreshButton, {
    status: { lastPollAt: new Date().toISOString(), lastRefreshBy: null, refreshCooldownSeconds: 5 },
    onStatus() {}, onReload() {}, showToast() {},
  }));
  assert.doesNotMatch(markup, /<button[^>]*\sdisabled(?:=|\s|>)/);
  assert.match(markup, /aria-label="Actualizar"/);
});

test("si el servidor registro transferencias que esta pantalla no recibio, hay que releer la lista", () => {
  assert.equal(feedChangedSince(null, 3), false, "la primera vez solo se toma nota");
  assert.equal(feedChangedSince(3, 3), false);
  assert.equal(feedChangedSince(3, 4), true);
  assert.equal(feedChangedSince(7, 0), true, "un reinicio del servidor vuelve a contar desde cero");
  assert.equal(feedChangedSince(3, undefined), false, "un servidor anterior no manda el contador");
});

test("el estado guarda la diferencia de reloj: una PC atrasada no muestra 'hace 0 s' para siempre", () => {
  const status = withClockOffset({ serverTime: "2026-10-12T20:00:00.000Z" }, Date.parse("2026-10-12T19:58:00.000Z"));
  assert.equal(status.clockOffsetMs, 120000);
  assert.equal(withClockOffset({}, 0).clockOffsetMs, 0);
});

const lastPollAt = "2026-10-07T15:00:00.000Z";
const at = (seconds) => Date.parse(lastPollAt) + seconds * 1000;

test("la espera compartida de 5 s respeta el tiempo del servidor y conserva compatibilidad con 10 s", () => {
  assert.equal(refreshRemainingMs({ lastPollAt, refreshCooldownSeconds: 5 }, at(4)), 1000);
  assert.equal(refreshRemainingMs({ lastPollAt, refreshCooldownSeconds: 5 }, at(5)), 0);
  assert.equal(refreshRemainingMs({ lastPollAt }, at(4)), 1000);
  assert.equal(refreshRemainingMs({ lastPollAt, refreshCooldownSeconds: 10 }, at(5)), 5000);
});

test("tras una actualizacion, el boton espera 10 s en todas las pantallas", () => {
  const clock = { lastPollAt, refreshCooldownSeconds: 10 };
  assert.equal(refreshRemainingMs(clock, at(0)), 10000);
  assert.equal(refreshRemainingMs(clock, at(7)), 3000);
  assert.equal(refreshRemainingMs(clock, at(10)), 0);
  assert.equal(refreshRemainingMs(clock, at(25)), 0);
});

test("sin consultas previas el boton esta disponible", () => {
  assert.equal(refreshRemainingMs(null, at(0)), 0);
  assert.equal(refreshRemainingMs({ lastPollAt: null }, at(0)), 0);
  assert.equal(refreshRemainingMs({ lastPollAt: "no es fecha" }, at(0)), 0);
});

test("una PC con la hora atrasada no saltea la espera", () => {
  // El reloj de esta PC va 30 s atrasado respecto del servidor.
  const pcNow = at(2) - 30000;
  const offset = serverClockOffsetMs(new Date(at(2)).toISOString(), pcNow);
  assert.equal(offset, 30000);
  assert.equal(refreshRemainingMs({ lastPollAt, refreshCooldownSeconds: 10 }, pcNow, offset), 8000);
  // Sin corregir el reloj, mostraria 38 s de espera.
  assert.equal(refreshRemainingMs({ lastPollAt, refreshCooldownSeconds: 10 }, pcNow), 38000);
});

test("si otra pantalla acaba de actualizar no se molesta al usuario con un aviso", () => {
  assert.equal(refreshRejectionMessage("RECIENTE"), null);
  assert.match(refreshRejectionMessage("EN_CURSO"), /curso/);
  assert.match(refreshRejectionMessage("DETENIDO"), /administrador/);
  assert.match(refreshRejectionMessage("FUERA_DE_HORARIO"), /horario/);
});
