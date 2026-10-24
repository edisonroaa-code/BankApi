const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = process.cwd();
const src = path.join(repoRoot, 'backend');
const dest = path.join(repoRoot, '.packaging', 'backend');

const ensureFile = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

const copyIfExists = (from, to) => {
  if (!ensureFile(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
};

const copyDir = (from, to) => {
  if (!ensureFile(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
};

const removeIfExists = (targetPath) => {
  if (!ensureFile(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
};

const runNpm = (args, cwd) => {
  return spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
};

const stripDistArtifacts = (dir) => {
  if (!ensureFile(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripDistArtifacts(fullPath);
      continue;
    }
    if (
      entry.name.endsWith('.map')
      || entry.name.endsWith('.d.ts')
      || entry.name.endsWith('.tsbuildinfo')
    ) {
      fs.rmSync(fullPath, { force: true });
    }
  }
};

if (!ensureFile(src)) {
  console.error('backend/ not found');
  process.exit(1);
}

try {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
} catch (err) {
  console.error(String(err?.message || err));
  process.exit(1);
}

const distOk = copyDir(path.join(src, 'dist'), path.join(dest, 'dist'));
if (!distOk) {
  console.error('backend/dist not found. Run backend build first.');
  process.exit(1);
}

copyIfExists(path.join(src, 'package.json'), path.join(dest, 'package.json'));
copyIfExists(path.join(src, 'package-lock.json'), path.join(dest, 'package-lock.json'));
copyIfExists(path.join(src, '.env'), path.join(dest, '.env'));
copyIfExists(path.join(src, 'docker-compose.yml'), path.join(dest, 'docker-compose.yml'));

const install = runNpm(
  ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'],
  dest,
);

if (install.status !== 0) {
  const installFallback = runNpm(
    ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'],
    dest,
  );
  if (installFallback.status === 0) {
    process.stdout.write('npm install fallback ok\n');
  } else {
    // Last fallback for offline builds: reuse existing node_modules and prune dev deps.
    const sourceModules = path.join(src, 'node_modules');
    if (ensureFile(sourceModules)) {
      process.stdout.write('npm install failed, falling back to pruning existing node_modules...\n');
      copyDir(sourceModules, path.join(dest, 'node_modules'));
      const prune = runNpm(
        ['prune', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'],
        dest,
      );
      if (prune.status === 0) {
        process.stdout.write('prune ok\n');
      } else {
        console.error('Prune failed; backend package would include non-production modules.');
        process.exit(1);
      }
    } else {
      console.error('Failed to install backend production dependencies.');
      process.exit(1);
    }
  }
}

if (!ensureFile(path.join(dest, 'node_modules'))) {
  console.error('backend package preparation failed: node_modules not found.');
  process.exit(1);
}

stripDistArtifacts(path.join(dest, 'dist'));

for (const target of [
  path.join(dest, 'node_modules', '.bin'),
  path.join(dest, 'node_modules', '@types'),
  path.join(dest, 'node_modules', 'typescript'),
  path.join(dest, 'node_modules', 'ts-node'),
]) {
  removeIfExists(target);
}

const backendArchive = path.join(repoRoot, '.packaging', 'backend.tar');
removeIfExists(backendArchive);
const archive = spawnSync(
  'tar.exe',
  ['-cf', backendArchive, '-C', dest, '.'],
  { cwd: repoRoot, stdio: 'inherit', windowsHide: true },
);
if (archive.status !== 0 || !ensureFile(backendArchive)) {
  console.error('Failed to create backend.tar.');
  process.exit(1);
}

fs.writeFileSync(path.join(repoRoot, '.packaging', 'server.marker'), 'server\n', 'utf8');
process.stdout.write(`prepared:${dest}\n`);
process.stdout.write(`archive:${backendArchive}\n`);
