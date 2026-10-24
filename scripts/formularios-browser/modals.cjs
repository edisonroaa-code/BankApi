const fs = require("fs"),
  path = require("path"),
  assert = require("node:assert/strict"),
  { chromium } = require("playwright");
const output = path.resolve(__dirname, "../.runtime/formularios-browser");
fs.mkdirSync(output, { recursive: true });
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
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    if (process.argv[2] !== "reconcile")
      for (const version of process.env.FORMS_COMPARE_BASELINE === "1"
        ? ["baseline", "candidate"]
        : ["candidate"]) {
        await control({ drop: false });
        const ctx = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
        await ctx.addInitScript(() =>
          localStorage.setItem(
            "bankapi_session_v1",
            JSON.stringify({
              access_token: "fixture-only",
              user: {
                id: "fixture-cashier",
                username: "caja-prueba",
                name: "Caja de prueba",
                role: "CAJERO",
              },
            }),
          ),
        );
        const p = await ctx.newPage();
        p.setDefaultTimeout(6000);
        await p.goto(cfg[version]);
        await p
          .getByRole("button", { name: "Tomar", exact: true })
          .first()
          .click();
        await p
          .getByPlaceholder("Ej: 4512", { exact: true })
          .fill("TICKET-SIN-ENVIAR");
        await control({ drop: true });
        await p.waitForTimeout(700);
        const open = await p
          .getByRole("heading", {
            name: "¿Desea tomar este pago?",
            exact: true,
          })
          .count();
        assert.equal(open, version === "baseline" ? 0 : 1);
        if (open)
          assert.equal(
            await p.getByPlaceholder("Ej: 4512", { exact: true }).inputValue(),
            "TICKET-SIN-ENVIAR",
          );
        results.push({
          name: version + ": actualizar página sin la fila",
          modalAbierto: !!open,
          ticketConservado: !!open,
        });
        console.log(JSON.stringify(results.at(-1)));
        if (version === "candidate") {
          await control({ taken: true });
          await p.waitForTimeout(500);
          assert.match(
            await p.locator("body").innerText(),
            /ya no está disponible|ya fue tomada|otro usuario|sin saldo/i,
          );
          console.log(
            "AVISO " + (await p.locator("body").innerText()).slice(-1300),
          );
        }
        await ctx.close();
      }
    await control({ drop: false });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const p = await ctx.newPage();
    p.setDefaultTimeout(6000);
    await p.goto(cfg.candidate);
    await p.getByRole("button", { name: "Conciliación", exact: true }).click();
    console.log(
      "RECONCILIACION " + (await p.locator("body").innerText()).slice(-2600),
    );
    const choice = p.getByRole("button").filter({ hasText: "REF-ENVIADA" });
    await choice.click();
    await p.waitForTimeout(400);
    const before = await state();
    await control({ reconnect: true });
    await p.waitForTimeout(2500);
    const after = await state();
    assert.equal(after.bankReads, before.bankReads);
    results.push({
      name: "candidate: reconectar no relee banco mientras hay selección",
      bankReadsAntes: before.bankReads,
      bankReadsDespues: after.bankReads,
    });
    console.log(JSON.stringify(results.at(-1)));
    await ctx.close();
  } finally {
    await browser.close();
    fs.writeFileSync(
      path.join(output, "modal-results.json"),
      JSON.stringify(results, null, 2),
    );
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
