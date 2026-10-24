const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = process.cwd();
const releaseBuildDir = path.join(repoRoot, 'release-build');
const winUnpackedDir = path.join(releaseBuildDir, 'win-unpacked');
const backendDir = path.join(repoRoot, 'backend');
const packagedBackendDir = path.join(repoRoot, '.packaging', 'backend');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableFsError = (err) => {
  const code = String(err?.code || '');
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
};

const runPowerShell = (script) => {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'inherit',
    windowsHide: true,
  });
};

const runCommand = (command, args) => {
  return spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: repoRoot,
  });
};

const packagedBackendReady = () => {
  return fs.existsSync(path.join(packagedBackendDir, 'dist', 'main.js'))
    && fs.existsSync(path.join(packagedBackendDir, 'node_modules'));
};

const ensureBackendPackage = () => {
  if (packagedBackendReady()) return;

  process.stdout.write('backend_package:missing, preparing...\n');
  const backendBuild = runCommand('npm', ['--prefix', 'backend', 'run', 'build:prod']);
  if (backendBuild.status !== 0) {
    console.error('Failed to build backend production dist before installer.');
    process.exit(1);
  }

  const packagePrepare = runCommand('node', ['scripts/prepare-backend-package.cjs']);
  if (packagePrepare.status !== 0 || !packagedBackendReady()) {
    console.error('Failed to prepare .packaging/backend before installer.');
    process.exit(1);
  }
};

const stopProcessesUsingWinUnpacked = () => {
  if (process.platform !== 'win32') return;

  const escapedTarget = winUnpackedDir.replace(/'/g, "''");
  const script = `
$target = '${escapedTarget}'
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      Write-Host "killed_pid:$($_.ProcessId)"
    } catch {
      Write-Host "kill_failed_pid:$($_.ProcessId)"
    }
  }
`;
  runPowerShell(script);
};

const cleanDirWithRetries = async (dir) => {
  const retries = 15;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      process.stdout.write(`prepared:${dir}\n`);
      return;
    } catch (err) {
      if (attempt === retries || !isRetryableFsError(err)) throw err;
      process.stdout.write(`retry_clean:${attempt}\n`);
      await sleep(350 * attempt);
    }
  }
};

(async () => {
  try {
    if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
      console.error('Frontend dist missing. Run `npm run build:desktop:app` before installer.');
      process.exit(1);
    }
    if (!fs.existsSync(backendDir)) {
      console.error('Backend folder missing.');
      process.exit(1);
    }

    ensureBackendPackage();

    // ── PWA fix: copy frontend dist/ into .packaging/backend/public/
    // so the NestJS backend can serve the PWA to mobile devices on the LAN.
    const frontendDist = path.join(repoRoot, 'dist');
    const frontendDest = path.join(packagedBackendDir, 'public');
    if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
      fs.cpSync(frontendDist, frontendDest, { recursive: true });
      process.stdout.write(`frontend_copied_to:${frontendDest}\n`);
    } else {
      process.stdout.write(`WARNING: frontend dist/ missing. Mobile PWA will not work.\n`);
    }

    fs.mkdirSync(releaseBuildDir, { recursive: true });
    stopProcessesUsingWinUnpacked();
    await sleep(500);
    await cleanDirWithRetries(winUnpackedDir);
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(1);
  }
})();
