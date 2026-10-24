const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = join(__dirname, "bank-claim-policy.ts");
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
const { canDirectlyClaimBankTransfer, isSupportedBankCurrency } = loadedModule.exports;

test("only cashier and admin can directly claim a free bank movement", () => {
  assert.equal(canDirectlyClaimBankTransfer("CAJERO"), true);
  assert.equal(canDirectlyClaimBankTransfer("ADMIN"), true);
  assert.equal(canDirectlyClaimBankTransfer("COBRADOR"), false);
  assert.equal(canDirectlyClaimBankTransfer("SUPERVISOR"), false);
});

test("unsupported currencies stay visible but cannot be claimed by this PYG-only product", () => {
  assert.equal(isSupportedBankCurrency("PYG"), true);
  assert.equal(isSupportedBankCurrency("pyg"), true);
  assert.equal(isSupportedBankCurrency("USD"), false);
  assert.equal(isSupportedBankCurrency(null), false);
});

test("bank transfer panel wires every direct-claim entry point to the role policy", () => {
  const panel = readFileSync(
    join(__dirname, "..", "views", "BankTransfersPanel.tsx"),
    "utf8",
  );
  assert.match(panel, /canDirectlyClaimBankTransfer/);
  assert.match(panel, /isSupportedBankCurrency/);
  assert.match(
    panel,
    /const canDirectlyClaim = canDirectlyClaimBankTransfer\(user\.role\)/,
  );
  assert.match(panel, /if \(!canDirectlyClaim \|\| !isOpen\(t\) \|\| !isSupportedBankCurrency\(t\.currency\)\)/);
  assert.match(
    panel,
    /onDoubleClick=\{\(\) => canDirectlyClaim && claimable && tryTake\(t\)\}/,
  );
  assert.ok(
    (panel.match(/\{canDirectlyClaim && claimable && \(/g) || []).length >= 2,
  );
});

test("reconciliation controls do not offer an unsupported currency", () => {
  const detail = readFileSync(join(__dirname, "..", "components", "bank", "TransferDetailModal.tsx"), "utf8");
  const admin = readFileSync(join(__dirname, "..", "views", "AdminDashboard.tsx"), "utf8");
  const panel = readFileSync(join(__dirname, "..", "views", "BankTransfersPanel.tsx"), "utf8");
  assert.match(detail, /isSupportedBankCurrency\(transfer\.currency\)\s*&&\s*available > 0/);
  assert.match(admin, /t\.availableAmount > 0 && isSupportedBankCurrency\(t\.currency\)/);
  assert.match(panel, /isCollector && claimable/);
});
