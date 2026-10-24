const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const output = path.resolve(__dirname, "../.runtime/formularios-browser");
fs.mkdirSync(output, { recursive: true });
const { chromium } = require("playwright");
const cfg = JSON.parse(fs.readFileSync(path.join(output, "runtime.json"))),
  results = [];
const control = async (data) =>
  (
    await fetch(cfg.api + "/__control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    })
  ).json();
const state = async () => (await fetch(cfg.api + "/__control")).json();
const proof = {
  name: "comprobante-sintetico.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\nDocumento sintético sin datos reales\n%%EOF"),
};
const log = (name, detail) => {
  results.push({ name, ok: true, detail });
  console.log("OK " + name + (detail ? " " + JSON.stringify(detail) : ""));
};
const fill = async (page) => {
  await page.getByRole("button", { name: "Mi panel", exact: true }).click();
  await page.getByPlaceholder("0", { exact: true }).fill("123456");
  await page
    .getByPlaceholder("Ej. 123456", { exact: true })
    .fill("REF-BORRADOR");
  await page
    .getByPlaceholder("Ej. Itaú", { exact: true })
    .fill("BANCO SINTETICO");
  await page
    .getByPlaceholder("Ej. CLI-001", { exact: true })
    .fill("CLI-BORRADOR");
  await page
    .getByPlaceholder("Razón social / nombre", { exact: true })
    .fill("Cliente de prueba");
  await page.getByRole("radio").first().check();
  await page.locator("input[type=file]").first().setInputFiles(proof);
  await page.getByPlaceholder("Ej. CLI-001", { exact: true }).focus();
};
const fields = async (page) => ({
  amount: await page.getByPlaceholder("0", { exact: true }).inputValue(),
  ref: await page.getByPlaceholder("Ej. 123456", { exact: true }).inputValue(),
  code: await page
    .getByPlaceholder("Ej. CLI-001", { exact: true })
    .inputValue(),
  proof: await page.getByText(proof.name, { exact: true }).count(),
});
const expected = {
  amount: "123.456",
  ref: "REF-BORRADOR",
  code: "CLI-BORRADOR",
  proof: 1,
};
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const version of process.argv[2]
      ? [process.argv[2]]
      : process.env.FORMS_COMPARE_BASELINE === "1"
        ? ["baseline", "candidate"]
        : ["candidate"]) {
      await control({ drop: false, health: true, failSend: false });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      await context.route("**/*", (route) => {
        const u = new URL(route.request().url());
        return ["127.0.0.1", "localhost"].includes(u.hostname) ||
          ["data:", "blob:"].includes(u.protocol)
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      page.on("pageerror", (e) => console.log("PAGEERROR " + e.message));
      await page.goto(cfg[version]);
      await fill(page);
      const ticks = (await state()).ticks;
      await page.waitForTimeout(11000);
      assert.deepEqual(await fields(page), expected);
      assert.ok((await state()).ticks >= ticks + 2);
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("placeholder"),
        ),
        "Ej. CLI-001",
      );
      log(
        version +
          ": dos ciclos automáticos y avisos conservan datos, archivo y foco",
      );
      await page
        .getByRole("button", { name: "Conciliación", exact: true })
        .click();
      await page.getByRole("button", { name: "Mi panel", exact: true }).click();
      const afterNav = await fields(page);
      if (version === "baseline") {
        assert.equal(afterNav.code, "");
        assert.equal(afterNav.proof, 0);
        log("baseline: cambiar de pantalla reproduce pérdida del formulario");
        await fill(page);
        await page.reload();
        await page
          .getByRole("button", { name: "Mi panel", exact: true })
          .click();
        assert.equal((await fields(page)).code, "");
        log("baseline: F5 reproduce pérdida");
      } else {
        assert.deepEqual(afterNav, expected);
        log("candidate: cambiar y volver conserva datos y PDF");
        await page.reload();
        await page
          .getByRole("button", { name: "Mi panel", exact: true })
          .click();
        await page.getByText(proof.name, { exact: true }).waitFor();
        assert.deepEqual(await fields(page), expected);
        log("candidate: recargar conserva datos y PDF");
        await control({ reconnect: true });
        await page.waitForTimeout(2500);
        assert.deepEqual(await fields(page), expected);
        log("candidate: reconexión conserva formulario");
        await control({ failSend: true });
        await page.getByRole("button", { name: /enviar/i }).click();
        await page.waitForTimeout(500);
        assert.deepEqual(await fields(page), expected);
        log("candidate: envío fallido conserva formulario");
        await control({ failSend: false });
        await page.getByRole("button", { name: /enviar/i }).click();
        await page.waitForTimeout(500);
        assert.equal((await fields(page)).code, "");
        await page.reload();
        await page
          .getByRole("button", { name: "Mi panel", exact: true })
          .click();
        assert.equal((await fields(page)).proof, 0);
        log("candidate: enviar elimina borrador y PDF");
        await fill(page);
        await page
          .getByRole("button", { name: "Limpiar", exact: true })
          .click();
        await page.reload();
        await page
          .getByRole("button", { name: "Mi panel", exact: true })
          .click();
        assert.equal((await fields(page)).code, "");
        assert.equal((await fields(page)).proof, 0);
        log("candidate: limpiar elimina borrador y PDF");
        await fill(page);
        await page.screenshot({
          path: path.join(output, "formulario-antes.png"),
        });
        await page
          .getByRole("button", { name: "Conciliación", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Mi panel", exact: true })
          .click();
        await page.screenshot({
          path: path.join(output, "formulario-retomado.png"),
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
