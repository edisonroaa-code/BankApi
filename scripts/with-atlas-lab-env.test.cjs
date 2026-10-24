const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { parseLabEnv } = require("./with-atlas-lab-env.cjs");

const labDir = path.resolve("lab");

test("toma solo las variables ATLAS_* del laboratorio", () => {
  const vars = parseLabEnv(
    ["# comentario", "ATLAS_API_KEY=abc", "DB_PASSWORD=no-debe-pasar", "OTRA=1", "ATLAS_JWT_ISS='CENTER'", ""].join("\n"),
    labDir,
  );
  assert.deepEqual(Object.keys(vars).sort(), ["ATLAS_API_KEY", "ATLAS_JWT_ISS"]);
  assert.equal(vars.ATLAS_JWT_ISS, "CENTER");
});

test("resuelve las rutas de las claves respecto de la carpeta del laboratorio", () => {
  const vars = parseLabEnv("ATLAS_PRIVATE_KEY_PATH=./keys/pv_key.txt\r\nATLAS_BANK_PUBLIC_KEY_PATH=", labDir);
  assert.equal(vars.ATLAS_PRIVATE_KEY_PATH, path.join(labDir, "keys", "pv_key.txt"));
  assert.equal(vars.ATLAS_BANK_PUBLIC_KEY_PATH, "");
});

test("no confunde un signo igual dentro del valor", () => {
  const vars = parseLabEnv("ATLAS_ACCOUNT_AUTH_TOKEN=a=b@c", labDir);
  assert.equal(vars.ATLAS_ACCOUNT_AUTH_TOKEN, "a=b@c");
});
