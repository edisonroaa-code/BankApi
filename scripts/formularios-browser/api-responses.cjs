const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const output = path.resolve(__dirname, "../.runtime/formularios-browser");
fs.mkdirSync(output, { recursive: true });
const { chromium } = require("playwright");
const cfg = JSON.parse(fs.readFileSync(path.join(output, "runtime.json")));
const control = async (data) =>
  fetch(cfg.api + "/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
const state = async () => (await fetch(cfg.api + "/__control")).json();
async function fill(page) {
  await page.getByRole("button", { name: "Mi panel", exact: true }).click();
  for (const [placeholder, value] of [
    ["0", "123456"],
    ["Ej. 123456", "REF-API"],
    ["Ej. Itaú", "BANCO SINTETICO"],
    ["Ej. CLI-001", "CLI-API"],
    ["Razón social / nombre", "Cliente sintético"],
  ])
    await page.getByPlaceholder(placeholder, { exact: true }).fill(value);
  await page.getByRole("radio").first().check();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "comprobante-sintetico.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nPrueba sin datos reales\n%%EOF"),
    });
}
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await control({
      drop: false,
      health: true,
      failSend: false,
      postDelayMs: 6000,
    });
    const ctx = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      }),
      page = await ctx.newPage();
    await ctx.route("**/*", (r) =>
      ["127.0.0.1", "localhost"].includes(new URL(r.request().url()).hostname)
        ? r.continue()
        : r.abort(),
    );
    page.setDefaultTimeout(6000);
    await page.goto(cfg.candidate);
    await fill(page);
    const code = page.getByPlaceholder("Ej. CLI-001", { exact: true });
    if (process.argv[2] === "pending") {
      const sent = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/payments") && r.request().method() === "POST",
        { timeout: 12000 },
      );
      await page.getByRole("button", { name: /enviar/i }).click();
      console.log("inputDisabledWhilePending=" + (await code.isDisabled()));
      assert.equal(
        await code.isDisabled(),
        true,
        "no aceptar datos nuevos durante un envío pendiente",
      );
      if (!(await code.isDisabled()))
        await code.fill("CLIENTE-NUEVO-MIENTRAS-ENVIA");
      await sent;
      await page.waitForTimeout(300);
      console.log(
        "codeAfterResponse=" + JSON.stringify(await code.inputValue()),
      );
      assert.equal(await code.inputValue(), "");
      assert.equal(await code.isDisabled(), false);
    } else {
      const assertDraft = async (label) => {
        assert.equal(await code.inputValue(), "CLI-API");
        assert.equal(
          await page.getByPlaceholder("0", { exact: true }).inputValue(),
          "123.456",
        );
        assert.equal(
          await page
            .getByText("comprobante-sintetico.pdf", { exact: true })
            .count(),
          1,
        );
        console.log("OK " + label);
      };
      const initial = (await state()).paymentDetailReads;
      await control({ approval: true });
      await page
        .getByText("Consulta aprobada: ENVIADA-1", { exact: true })
        .waitFor();
      await assertDraft(
        "respuesta de aprobación y avisos conservan formulario",
      );
      await control({ health: false });
      await page.waitForTimeout(33000);
      assert.equal(
        await page
          .getByRole("heading", {
            name: "Sin conexión al servidor",
            exact: true,
          })
          .count(),
        1,
      );
      await assertDraft("API caída conserva formulario");
      await control({ health: true });
      await page.waitForTimeout(33000);
      assert.equal(
        await page
          .getByRole("heading", {
            name: "Sin conexión al servidor",
            exact: true,
          })
          .count(),
        0,
      );
      await assertDraft("API recuperada conserva formulario");
      assert.ok((await state()).paymentDetailReads > initial);
      console.log("OK llegaron nuevas lecturas y eventos de API");
    }
    await ctx.close();
  } finally {
    await control({ health: true, postDelayMs: 0 });
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
