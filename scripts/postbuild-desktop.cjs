const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const releaseDir = path.join(repoRoot, 'release');
const maxInstallerMb = Number(process.env.MAX_INSTALLER_MB || '180');

const copyIfExists = (from, to) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
};

fs.mkdirSync(releaseDir, { recursive: true });
const installers = fs.readdirSync(releaseDir)
  .filter((name) => name.endsWith(' Setup.exe'));

if (installers.length === 0) {
  console.error(`No installers found in: ${releaseDir}`);
  process.exit(1);
}

for (const installerName of installers) {
  const installerPath = path.join(releaseDir, installerName);
  const installerSizeMb = fs.statSync(installerPath).size / (1024 * 1024);
  process.stdout.write(`${installerName}: ${installerSizeMb.toFixed(2)} MB\n`);
  if (installerSizeMb > maxInstallerMb) {
    process.stdout.write(
      `warning: installer exceeds target (${installerSizeMb.toFixed(2)} MB > ${maxInstallerMb} MB)\n`,
    );
  }
}

for (const tempPackaging of [
  path.join(repoRoot, '.packaging', 'backend'),
  path.join(repoRoot, '.packaging', 'backend.tar'),
  path.join(repoRoot, '.packaging', 'server.marker'),
]) {
  fs.rmSync(tempPackaging, { recursive: true, force: true });
}
process.stdout.write('postbuild:temp-cleaned\n');
