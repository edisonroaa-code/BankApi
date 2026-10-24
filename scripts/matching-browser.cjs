// Aplicación real y evaluación compilada con datos sintéticos; todas las API quedan en loopback.
const { fork } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { assessMatch } = require('../backend/dist/bank/bank-match.js');
const output = path.join(__dirname, '.runtime/coincidencias');
fs.mkdirSync(output, { recursive: true });

async function main() {
  const fixture = fork(path.join(__dirname, 'formularios-browser/server.cjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let browser;
  let page;
  try {
    const cfg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No arrancó la prueba aislada')), 30000);
      fixture.once('message', (message) => { clearTimeout(timer); resolve(message); });
      fixture.once('error', reject);
      fixture.once('exit', (code) => reject(new Error(`Prueba aislada terminó: ${code}`)));
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('bankapi_session_v1', JSON.stringify({
      access_token: 'fixture-only', user: { id: 'fixture-a', role: 'ADMIN', username: 'operador-prueba', name: 'Operador de prueba' },
    })));
    let payment = {
      id: 'fixture-payment', amount: 200000, allocatedAmount: 0, currency: 'PYG',
      clientName: 'Ana Prueba Centro', clientCode: '7999', paymentRef: '72631',
      sourceBank: 'UENO BANK', isAtlasAccount: false, status: 'PENDIENTE_VERIFICACION',
      createdAt: new Date().toISOString(), createdById: 'fixture-a',
      createdBy: { name: 'Cobrador de prueba' },
    };
    const transfer = (id, patch = {}) => ({
      id, source: 'MOCK', amount: 200000, allocatedAmount: 0, availableAmount: 200000,
      currency: 'PYG', movementAt: new Date().toISOString(), status: 'DISPONIBLE',
      senderName: 'ANA PRUEBA CENTRO', senderBankName: 'UENO BANK SOCIEDAD ANONIMA',
      senderAccount: 'cuenta-sintetica', bankDocNumber: id, claims: [], ...patch,
    });
    const transfers = [
      transfer('IDENTIDAD-CONTEXTO'),
      transfer('SOLO-MONTO', { senderName: 'Otra Persona Prueba' }),
      transfer('BANCO-DIFERENTE', { senderBankName: 'ITAU' }),
    ];
    let approvals = 0, dialogs = 0;
    await context.route('**/api/**', async (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
      let body = [];
      if (p === '/health' || p === '/health/db') body = { status: 'ok', db: 'ok' };
      else if (p === '/payments/paged') body = { items: [payment], page: 1, pageSize: 50, total: 1, totalPages: 1 };
      else if (p === '/payments/kpis') body = { counts: {}, collectors: [], managers: [] };
      else if (p === '/bank-transfers/matches') body = payment.isAtlasAccount === false ? [] : transfers.map((t) => ({ ...t, match: assessMatch(t, payment) }));
      else if (p === '/bank-transfers/page') body = {
        items: transfers, page: 1, pageSize: 25, total: 3, counts: { DISPONIBLES: 3, TOMADAS: 0, REVISAR: 0, TODAS: 3 }, pendingOtherMonths: [],
      };
      else if (p === '/payments/fixture-payment/claim-review' || p === '/payments/fixture-payment') body = payment;
      else if (p === '/payments/fixture-payment/confirm-manual') {
        assert.deepEqual(route.request().postDataJSON(), {});
        approvals++;
        payment = { ...payment, status: 'CONFIRMADO_MANUAL' };
        body = payment;
      }
      else if (p === '/bank-feed/status') body = {
        mode: 'mock', state: 'EN_VIVO', lastSuccessAt: new Date().toISOString(), serverTime: new Date().toISOString(), intervalSeconds: 5,
      };
      await route.fulfill({ json: body });
    });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
    await page.goto(cfg.candidate);
    await page.getByRole('button', { name: 'Mi panel', exact: true }).click();
    await page.getByRole('button', { name: 'Revisar', exact: true }).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'APROBAR' && !b.disabled));
    assert.doesNotMatch(await page.locator('body').innerText(), /transferencias tomadas de monto similar|No usar esta transferencia/);
    await page.screenshot({ path: path.join(output, 'bnf-sin-falsa-alerta.png'), fullPage: true });
    await page.getByRole('button', { name: 'APROBAR', exact: true }).click();
    await page.getByText('Ingreso aprobado.', { exact: true }).waitFor();
    assert.equal(approvals, 1);
    assert.equal(dialogs, 0);
    payment = { ...payment, isAtlasAccount: true, status: 'PENDIENTE_VERIFICACION' };
    await page.getByRole('button', { name: 'Conciliación', exact: true }).click();
    await page.getByRole('button').filter({ hasText: 'Cód. 7999' }).click();
    await page.getByText('Datos distintos', { exact: true }).waitFor();
    const bank = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Transferencias del banco', exact: true }) });
    const options = bank.getByRole('button');
    assert.match(await options.first().innerText(), /IDENTIDAD-CONTEXTO/);
    assert.match(await options.filter({ hasText: 'SOLO-MONTO' }).innerText(), /Sin vínculo/);
    assert.match(await options.filter({ hasText: 'BANCO-DIFERENTE' }).innerText(), /banco de origen es diferente/);
    assert.match(await options.first().innerText(), /nombre del remitente.*monto.*fecha/);
    await page.screenshot({ path: path.join(output, 'conciliacion-evidencia.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'conciliacion-movil.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
    const result = { approvalWithoutFalseWarning: true, approvals, dialogs, contextualMatchFirst: true, bankConflictVisible: true, mobileWithoutOverflow: true, errors };
    fs.writeFileSync(path.join(output, 'resultados.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, 'fallo.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(output, 'fallo.txt'), await page.locator('body').innerText().catch(() => ''));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    fixture.kill();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
