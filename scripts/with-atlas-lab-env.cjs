#!/usr/bin/env node
/**
 * Ejecuta un comando con las credenciales bancarias del laboratorio (`tools/bank-api-lab`) en el entorno,
 * SIN copiarlas a la raíz ni imprimir valores.
 *
 *   BANK_FEED_ACCOUNT=<cuenta> node scripts/with-atlas-lab-env.cjs npm --prefix backend run atlas:probe
 *
 * Toma solo las variables ATLAS_* del `.env` del laboratorio y resuelve las rutas de las claves
 * respecto de esa carpeta. Lo que ya esté definido en el entorno tiene prioridad.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Lee las variables ATLAS_* de un .env, con rutas de claves relativas a `labDir`. */
const parseLabEnv = (text, labDir) => {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    const key = trimmed.slice(0, i).trim();
    if (!/^ATLAS_[A-Z0-9_]+$/.test(key)) continue;
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/_PATH$/.test(key) && value && !path.isAbsolute(value)) value = path.join(labDir, value);
    vars[key] = value;
  }
  return vars;
};

const main = () => {
  const defaultLabDir = path.resolve(__dirname, '..', 'tools', 'bank-api-lab');
  const labDir = (process.env.ATLAS_LAB_DIR || defaultLabDir).trim();
  const command = process.argv.slice(2);
  if (!labDir || command.length === 0) {
    console.error('Uso: [ATLAS_LAB_DIR=<carpeta>] node scripts/with-atlas-lab-env.cjs <comando...>');
    process.exit(2);
  }
  const envFile = path.join(labDir, '.env');
  if (!fs.existsSync(envFile)) {
    console.error(`No se encontro ${envFile}.`);
    process.exit(2);
  }
  const lab = parseLabEnv(fs.readFileSync(envFile, 'utf8'), labDir);
  const env = { ...lab, ...process.env };
  console.error(`Credenciales Atlas tomadas del laboratorio (${Object.keys(lab).length} variables, valores ocultos).`);
  const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
};

if (require.main === module) main();

module.exports = { parseLabEnv };
