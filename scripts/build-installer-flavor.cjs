const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const flavor = String(process.argv[2] || 'client').toLowerCase();
if (!['client', 'server'].includes(flavor)) {
  console.error('Usage: node scripts/build-installer-flavor.cjs <client|server>');
  process.exit(1);
}

const root = process.cwd();
const outputDir = path.join(root, 'release-build', flavor);
const artifactName = flavor === 'server'
  ? 'BankApi Servidor Setup.exe'
  : 'BankApi Cliente Setup.exe';

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('Frontend dist missing. Run the desktop frontend build first.');
  process.exit(1);
}

if (flavor === 'server') {
  const backendArchive = path.join(root, '.packaging', 'backend.tar');
  if (!fs.existsSync(backendArchive)) {
    console.error('Packaged backend archive missing for server installer.');
    process.exit(1);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const electronBuilder = path.join(
  root,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
);

const result = spawnSync(
  process.execPath,
  [electronBuilder, '--publish', 'never', '--config', 'electron-builder.config.cjs'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      BANKAPI_DISTRIBUTION: flavor,
      ELECTRON_BUILDER_COMPRESSION_LEVEL: flavor === 'server' ? '0' : '7',
    },
    shell: false,
  },
);

if (result.status !== 0) process.exit(result.status || 1);

const installerPath = path.join(outputDir, artifactName);
if (!fs.existsSync(installerPath)) {
  console.error(`Installer not found: ${installerPath}`);
  process.exit(1);
}

const releaseDir = path.join(root, 'release');
fs.mkdirSync(releaseDir, { recursive: true });
fs.copyFileSync(installerPath, path.join(releaseDir, artifactName));

const blockmapPath = `${installerPath}.blockmap`;
if (fs.existsSync(blockmapPath)) {
  fs.copyFileSync(blockmapPath, path.join(releaseDir, `${artifactName}.blockmap`));
}

const sizeMb = fs.statSync(installerPath).size / 1024 / 1024;
process.stdout.write(`${flavor}_installer_size_mb:${sizeMb.toFixed(2)}\n`);
