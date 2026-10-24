const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { app, Menu, Tray, nativeImage, shell } = require('electron');

const APP_ID = 'com.bankapi.server';
const APP_NAME = 'BankApi Server';

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

const state = {
  dockerOk: false,
  dbListening: false,
  apiListening: false,
  health: null,
  backendPid: null,
  lastError: null,
  nextRetryAt: null,
};

const config = {
  autoStartDb: true,
  autoStartBackend: true,
  backendMode: 'prod',
  dockerWaitSeconds: 120,
  dbWaitSeconds: 60,
  apiWaitSeconds: 30,
  healthTimeoutMs: 2000,
  retryMinMs: 4000,
  retryMaxMs: 60000,
};

let tray = null;
let backendProcess = null;
let retryTimer = null;
let retryDelayMs = config.retryMinMs;
let lastDockerCheckAt = 0;
let lastDockerOk = false;

const logPath = path.join(app.getPath('userData'), 'server-agent.log');
const pidPath = path.join(app.getPath('userData'), 'backend.pid');
const configPath = path.join(app.getPath('userData'), 'server-agent.config.json');

const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {
    // ignore
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runCommand = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => (stdout += d.toString()));
    if (child.stderr) child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: String(err?.message || err) });
    });
  });

const parseEnvFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const out = {};
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    });
    return out;
  } catch {
    return {};
  }
};

const resolveBackendDir = () => {
  const candidates = [
    path.join(process.cwd(), 'backend'),
    path.join(app.getAppPath(), 'backend'),
    path.join(process.resourcesPath || '', 'backend'),
  ];
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'dist', 'main.js'))) return dir;
    } catch {
      // ignore
    }
  }
  return null;
};

const loadConfig = () => {
  try {
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    Object.assign(config, parsed || {});
  } catch {
    // ignore
  }
};

const getPorts = () => {
  const backendDir = resolveBackendDir();
  const envCandidates = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), 'backend', '.env'),
    backendDir ? path.join(backendDir, '.env') : null,
  ].filter(Boolean);
  const merged = {};
  envCandidates.forEach((p) => Object.assign(merged, parseEnvFile(p)));
  const apiPort = Number(merged.PORT || merged.API_PORT || 48300) || 48300;
  const dbPort = Number(merged.DB_PORT || 48543) || 48543;
  return { apiPort, dbPort };
};

const checkPort = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });

const httpGetJson = (url, timeoutMs) =>
  new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });

const isPidRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = () => {
  try {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

const writePid = (pid) => {
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(pid), 'ascii');
  } catch {
    // ignore
  }
};

const clearPid = () => {
  try {
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
};

const getListeningPidByPort = async (port) => {
  const script = `try { (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess) } catch { }`;
  const res = await runCommand('powershell.exe', ['-NoProfile', '-Command', script], { timeoutMs: 5000 });
  const val = (res.stdout || '').trim();
  if (!val) return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const findDockerDesktopExe = () => {
  const candidates = [
    path.join(process.env.ProgramW6432 || '', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env.ProgramFiles || '', 'Docker', 'Docker', 'Docker Desktop.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
};

const ensureDockerReady = async () => {
  const now = Date.now();
  if (now - lastDockerCheckAt < 15000) return lastDockerOk;

  lastDockerCheckAt = now;
  const res = await runCommand('docker', ['version'], { timeoutMs: 8000 });
  if (res.code === 0) {
    lastDockerOk = true;
    return true;
  }

  const exe = findDockerDesktopExe();
  if (exe) {
    try {
      spawn(exe, [], { detached: true, windowsHide: true });
      log('Docker Desktop launched.');
    } catch {
      // ignore
    }
  }

  const start = Date.now();
  while (Date.now() - start < config.dockerWaitSeconds * 1000) {
    const check = await runCommand('docker', ['version'], { timeoutMs: 8000 });
    if (check.code === 0) {
      lastDockerOk = true;
      return true;
    }
    await sleep(750);
  }

  lastDockerOk = false;
  return false;
};

const composeUp = async () => {
  const backendDir = resolveBackendDir();
  if (!backendDir) {
    log('Backend dir not found for docker compose.');
    return false;
  }

  const envFile = path.join(backendDir, '.env');
  const args = ['compose'];
  if (fs.existsSync(envFile)) {
    args.push('--env-file', '.env');
  }
  args.push('up', '-d');

  const res = await runCommand('docker', args, { cwd: backendDir, timeoutMs: 120000 });
  if (res.code !== 0) {
    log(`docker compose up failed: ${res.stderr || res.stdout || res.code}`);
    return false;
  }
  return true;
};

const composeDown = async () => {
  const backendDir = resolveBackendDir();
  if (!backendDir) {
    log('Backend dir not found for docker compose down.');
    return false;
  }

  const envFile = path.join(backendDir, '.env');
  const args = ['compose'];
  if (fs.existsSync(envFile)) {
    args.push('--env-file', '.env');
  }
  args.push('down');

  const res = await runCommand('docker', args, { cwd: backendDir, timeoutMs: 60000 });
  if (res.code !== 0) {
    log(`docker compose down failed: ${res.stderr || res.stdout || res.code}`);
    return false;
  }
  return true;
};

const startBackend = async () => {
  if (backendProcess && backendProcess.exitCode === null) return true;

  const backendDir = resolveBackendDir();
  if (!backendDir) {
    log('Backend dir not found.');
    return false;
  }

  const ports = getPorts();
  const mainPath = path.join(backendDir, 'dist', 'main.js');
  if (config.backendMode === 'prod' && !fs.existsSync(mainPath)) {
    log(`Backend build missing: ${mainPath}`);
    return false;
  }

  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const backendLog = path.join(logDir, 'backend.log');

  log('Starting backend...');
  if (config.backendMode === 'dev') {
    backendProcess = spawn('cmd.exe', ['/c', 'npm run start:dev'], {
      cwd: backendDir,
      windowsHide: true,
      env: {
        ...process.env,
        FRONTEND_DIST_PATH: path.join(backendDir, 'public'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    backendProcess = spawn('node', [mainPath], {
      cwd: backendDir,
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(ports.apiPort),
        FRONTEND_DIST_PATH: path.join(backendDir, 'public'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  backendProcess.stdout.on('data', (d) => fs.appendFileSync(backendLog, d));
  backendProcess.stderr.on('data', (d) => fs.appendFileSync(backendLog, d));
  backendProcess.on('close', (code) => {
    log(`Backend exited with code ${code}`);
  });

  writePid(backendProcess.pid);
  state.backendPid = backendProcess.pid;
  return true;
};

const stopBackend = async () => {
  const ports = getPorts();
  const pid = backendProcess?.pid || readPid();
  if (!pid) {
    log('No backend pid to stop.');
    return false;
  }

  const listeningPid = await getListeningPidByPort(ports.apiPort);
  if (listeningPid && listeningPid !== pid) {
    log(`Skip stop: port ${ports.apiPort} owned by another pid ${listeningPid}.`);
    return false;
  }

  try {
    await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 });
  } catch {
    try {
      process.kill(pid);
    } catch {
      // ignore
    }
  }

  clearPid();
  state.backendPid = null;
  return true;
};

const waitForPort = async (port, timeoutSeconds) => {
  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    if (await checkPort(port)) return true;
    await sleep(1000);
  }
  return false;
};

const refreshStatus = async () => {
  const ports = getPorts();
  state.dbListening = await checkPort(ports.dbPort);
  state.apiListening = await checkPort(ports.apiPort);
  if (state.apiListening) {
    const baseUrl = `http://localhost:${ports.apiPort}`;
    state.health = await httpGetJson(`${baseUrl}/health`, config.healthTimeoutMs);
  } else {
    state.health = null;
  }

  const pid = readPid();
  state.backendPid = pid && isPidRunning(pid) ? pid : null;
};

const updateTray = () => {
  if (!tray) return;
  const ports = getPorts();
  const health = state.health;
  const healthLabel = health
    ? `${health.status || 'unknown'} / db:${health.db || 'unknown'} / ${health.responseMs || '--'}ms`
    : 'down';

  tray.setToolTip(`${APP_NAME} | API:${ports.apiPort} ${state.apiListening ? 'up' : 'down'} | DB:${ports.dbPort} ${state.dbListening ? 'up' : 'down'}`);

  const menu = Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    { label: `Docker: ${state.dockerOk ? 'OK' : 'DOWN'}`, enabled: false },
    { label: `DB ${ports.dbPort}: ${state.dbListening ? 'OK' : 'DOWN'}`, enabled: false },
    { label: `API ${ports.apiPort}: ${state.apiListening ? 'OK' : 'DOWN'}`, enabled: false },
    { label: `Health: ${healthLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Start all', click: () => startAll(true) },
    { label: 'Start backend', click: () => startAll(false) },
    { label: 'Stop backend', click: () => stopBackend() },
    { label: 'Start DB', click: () => startDbOnly() },
    { label: 'Stop DB', click: () => composeDown() },
    { type: 'separator' },
    { label: 'Open health', click: () => shell.openExternal(`http://localhost:${ports.apiPort}/health`) },
    { label: 'Open log', click: () => shell.openPath(logPath) },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => toggleAutoStart(item.checked),
    },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
};

const toggleAutoStart = (enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    log(`Auto-start ${enabled ? 'enabled' : 'disabled'}.`);
  } catch {
    log('Failed to update auto-start settings.');
  }
};

const startDbOnly = async () => {
  const ports = getPorts();
  state.lastError = null;
  const dockerOk = await ensureDockerReady();
  state.dockerOk = dockerOk;
  if (!dockerOk) {
    state.lastError = 'Docker not ready';
    log('Docker not ready.');
    return false;
  }
  const ok = await composeUp();
  if (!ok) return false;
  const dbOk = await waitForPort(ports.dbPort, config.dbWaitSeconds);
  state.dbListening = dbOk;
  if (!dbOk) log('DB did not open port in time.');
  return dbOk;
};

const startAll = async (includeDb) => {
  const ports = getPorts();
  state.lastError = null;
  if (includeDb && config.autoStartDb) {
    const dbOk = await startDbOnly();
    if (!dbOk) {
      scheduleRetry('db');
      return false;
    }
  }

  if (config.autoStartBackend) {
    const ok = await startBackend();
    if (!ok) {
      scheduleRetry('backend-start');
      return false;
    }
    const apiOk = await waitForPort(ports.apiPort, config.apiWaitSeconds);
    state.apiListening = apiOk;
    if (!apiOk) {
      log('API did not open port in time.');
      scheduleRetry('api-port');
      return false;
    }
  }
  retryDelayMs = config.retryMinMs;
  state.nextRetryAt = null;
  return true;
};

const scheduleRetry = (reason) => {
  if (retryTimer) return;
  const delay = Math.min(retryDelayMs, config.retryMaxMs);
  retryDelayMs = Math.min(retryDelayMs * 2, config.retryMaxMs);
  state.nextRetryAt = Date.now() + delay;
  log(`Retry scheduled in ${Math.round(delay / 1000)}s (${reason}).`);
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    await autoStart();
  }, delay);
};

const autoStart = async () => {
  await refreshStatus();
  state.dockerOk = await ensureDockerReady();

  if (config.autoStartDb && !state.dbListening) {
    const dbOk = await startDbOnly();
    if (!dbOk) {
      scheduleRetry('db');
      updateTray();
      return;
    }
  }

  if (config.autoStartBackend && !state.apiListening) {
    const ok = await startBackend();
    if (!ok) {
      scheduleRetry('backend');
      updateTray();
      return;
    }
  }

  await refreshStatus();
  updateTray();
};

const resolveTrayIcon = () => {
  const candidates = [
    path.join(process.cwd(), 'resources', 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(process.resourcesPath || '', 'resources', 'icon.png'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return nativeImage.createFromPath(p);
    } catch {
      // ignore
    }
  }
  return nativeImage.createEmpty();
};

app.whenReady().then(async () => {
  loadConfig();
  tray = new Tray(resolveTrayIcon());
  updateTray();
  log('Server tray started.');
  await autoStart();

  setInterval(async () => {
    await refreshStatus();
    updateTray();
  }, 5000);
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
