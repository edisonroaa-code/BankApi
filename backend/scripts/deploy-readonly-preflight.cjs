// Opt-in de la ventana de despliegue: nunca migra datos ni escribe en el banco.
// El CI y las publicaciones normales no necesitan credenciales bancarias.
if (process.env.ATLAS_PROBE_ON_DEPLOY === 'true') {
  const { spawnSync } = require('node:child_process');
  const { join } = require('node:path');
  const result = spawnSync(process.execPath, [join(__dirname, '../dist/bank/atlas-probe.js')], {
    env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.error) console.error('No se pudo ejecutar la prueba de lectura Atlas.');
  process.exitCode = result.status ?? 1;
}
if (process.env.CLOUDINARY_PROBE_ON_DEPLOY === 'true') {
  const { spawnSync } = require('node:child_process');
  const { join } = require('node:path');
  const result = spawnSync(process.execPath, [join(__dirname, 'deploy-storage-preflight.cjs')], {
    env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.error) console.error('No se pudo ejecutar la prueba de almacenamiento privado.');
  if (result.status !== 0) process.exitCode = 1;
}
