// Local-only browser regression harness. No API, credentials or application data.
// Run: node --test services/pwa-two-tab.test.cjs
// Local Chrome; CI installs isolated Chromium. No production services are contacted.
const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile, writeFile, mkdir, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, extname } = require('node:path');
const { createServer } = require('node:http');
const ts = require('typescript');
const { generateSW } = require('workbox-build');

// Use the app's actual panel import declarations, with harmless fixture views.
// This exercises the deploy/cache/module-loading boundary without a real login or bank call.
function panelDeclarations(source) {
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const panels = ['CobradorDashboard', 'AdminDashboard', 'WorkPanelView', 'BankTransfersPanel', 'ReconciliationView'];
  return panels.map((name) => {
    const declaration = file.statements.find((node) => {
      if (ts.isImportDeclaration(node)) return node.importClause?.namedBindings?.elements?.some((item) => item.name.text === name);
      return ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(file) === name);
    });
    assert.ok(declaration, `No se encontró el panel ${name} en App.tsx`);
    return declaration.getText(file);
  });
}

test('otra pestaña activa la PWA: la que pospone conserva borrador/archivo y abre todos los paneles', { timeout: 90000 }, async (context) => {
  const { chromium } = require(process.env.PWA_BROWSER_MODULE || 'playwright');
  const { build } = await import('vite');
  const workspace = resolve(__dirname, '..');
  const source = await readFile(join(workspace, 'App.tsx'), 'utf8');
  const declarations = panelDeclarations(source).join('\n');
  const config = await readFile(join(workspace, 'vite.config.ts'), 'utf8');
  assert.match(config, /clientsClaim:\s*true/);
  assert.match(config, /cleanupOutdatedCaches:\s*true/);
  const temporary = await mkdtemp(join(tmpdir(), 'bankapi-pwa-two-tab-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = join(temporary, 'fixture');
  await mkdir(join(fixture, 'views'), { recursive: true });
  await writeFile(join(fixture, 'index.html'), '<!doctype html><html lang="es"><meta charset="utf-8"><title>PWA actualización local</title><body><h1>Formulario sintético</h1><label>Borrador <input id="draft"></label><label>Adjunto <input type="file" id="attachment"></label><p id="screen">Sin abrir paneles</p><button id="open">Abrir paneles</button><script type="module" src="/main.js"></script></body></html>');
  await writeFile(join(fixture, 'main.js'), `
    const React = { lazy: (load) => load };
    ${declarations}
    const panels = [CobradorDashboard, AdminDashboard, WorkPanelView, BankTransfersPanel, ReconciliationView];
    document.querySelector('#open').onclick = async () => {
      try {
        const loaded = await Promise.all(panels.map(async (panel) => {
          const value = typeof panel === 'function' ? await panel() : panel;
          return value.default || value;
        }));
        document.querySelector('#screen').textContent = loaded.map((panel) => panel.name).join(',');
      } catch (error) {
        document.querySelector('#screen').textContent = 'ERROR: ' + error.message;
      }
    };
    window.fixtureReady = navigator.serviceWorker.register('/sw.js').then(async (registration) => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((done) => navigator.serviceWorker.addEventListener('controllerchange', done, { once: true }));
      }
      window.fixtureRegistration = registration;
    });
  `);
  for (const version of ['A', 'B']) {
    for (const name of ['CobradorDashboard', 'AdminDashboard', 'WorkPanelView', 'BankTransfersPanel', 'ReconciliationView']) {
      await writeFile(join(fixture, 'views', `${name}.js`), `export const ${name} = { name: '${name}-${version}' };`);
    }
    const outDir = join(temporary, version);
    await build({ configFile: false, root: fixture, logLevel: 'error', build: { outDir, emptyOutDir: true, minify: false } });
    await generateSW({
      globDirectory: outDir, globPatterns: ['**/*.{js,html}'], swDest: join(outDir, 'sw.js'),
      clientsClaim: true, cleanupOutdatedCaches: true, skipWaiting: false,
    });
  }
  let publishedVersion = 'A';
  const missingAssets = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (relative.includes('..')) { response.writeHead(400).end(); return; }
    try {
      const body = await readFile(join(temporary, publishedVersion, relative));
      response.writeHead(200, { 'content-type': extname(relative) === '.js' ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      missingAssets.push(relative);
      response.writeHead(404).end('No existe en la versión publicada');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  context.after(() => new Promise((done) => server.close(done)));
  const browser = await chromium.launch({ headless: true, ...(process.env.CI ? {} : { channel: 'chrome' }) });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const accepting = await browserContext.newPage();
  const postponing = await browserContext.newPage();
  const address = `http://127.0.0.1:${server.address().port}`;
  await accepting.goto(address);
  await accepting.evaluate(() => window.fixtureReady);
  await postponing.goto(address);
  await postponing.evaluate(() => window.fixtureReady);
  await postponing.locator('#draft').fill('Borrador sin enviar de la pestaña que pospuso');
  await postponing.locator('#attachment').setInputFiles({ name: 'comprobante-sintetico.txt', mimeType: 'text/plain', buffer: Buffer.from('Archivo de prueba sin datos reales') });
  publishedVersion = 'B';
  await accepting.evaluate(async () => { await window.fixtureRegistration.update(); });
  await accepting.waitForFunction(() => Boolean(window.fixtureRegistration.waiting));
  const controllerChange = postponing.evaluate(() => new Promise((done) => navigator.serviceWorker.addEventListener('controllerchange', done, { once: true })));
  await accepting.evaluate(() => window.fixtureRegistration.waiting.postMessage({ type: 'SKIP_WAITING' }));
  await controllerChange;
  // Activation resolves only after Workbox has removed the old revision entries.
  await accepting.waitForFunction(() => window.fixtureRegistration.active?.state === 'activated');
  await accepting.reload();
  await accepting.evaluate(() => window.fixtureReady);
  await accepting.locator('#open').click();
  await accepting.waitForFunction(() => document.querySelector('#screen').textContent.includes('ReconciliationView-B'));
  await postponing.locator('#open').click();
  await postponing.waitForFunction(() => document.querySelector('#screen').textContent !== 'Sin abrir paneles');
  assert.equal(await postponing.locator('#screen').textContent(), 'CobradorDashboard-A,AdminDashboard-A,WorkPanelView-A,BankTransfersPanel-A,ReconciliationView-A', `La pestaña pospuesta perdió sus módulos antiguos. Assets ausentes: ${missingAssets.join(', ')}`);
  assert.equal(await postponing.locator('#draft').inputValue(), 'Borrador sin enviar de la pestaña que pospuso');
  assert.equal(await postponing.locator('#attachment').evaluate((input) => input.files[0].name), 'comprobante-sintetico.txt');
});
