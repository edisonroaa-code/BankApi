const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, ipcMain, shell, safeStorage, Tray, Menu, nativeImage } = require('electron');

let backendProcess = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let autoStartState = {
  enabled: true,
  running: false,
  done: false,
  ok: null,
  message: 'Pendiente',
  at: null,
  details: null,
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    app.whenReady().then(async () => {
      if (!mainWindow) await createWindow();
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  });
}

const credentialsFilePath = () => path.join(app.getPath('userData'), 'credentials.json');
const connectionFilePath = () => path.join(app.getPath('userData'), 'connection.json');

const readCredentialsFile = () => {
  try {
    const p = credentialsFilePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      username: typeof parsed.username === 'string' ? parsed.username : null,
      passwordEnc: typeof parsed.passwordEnc === 'string' ? parsed.passwordEnc : null,
    };
  } catch {
    return null;
  }
};

const writeCredentialsFile = (data) => {
  const p = credentialsFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
};

const normalizeServerUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const readConnectionFile = () => {
  try {
    const p = connectionFilePath();
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const serverUrl = normalizeServerUrl(parsed?.serverUrl);
    return /^https?:\/\//i.test(serverUrl) ? serverUrl : null;
  } catch {
    return null;
  }
};

const writeConnectionFile = (serverUrl) => {
  const normalized = normalizeServerUrl(serverUrl);
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('La URL del servidor debe comenzar con http:// o https://.');
  }
  const p = connectionFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ serverUrl: normalized }, null, 2), 'utf8');
  return normalized;
};

const resolveBackendDir = () => {
  // Dev: repo root. Packaged server: versioned runtime extracted from backend.tar.
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

  const archivePath = path.join(process.resourcesPath || '', 'backend.tar');
  if (!fs.existsSync(archivePath)) return null;

  const runtimeRoot = path.join(app.getPath('userData'), 'backend-runtime');
  const runtimeDir = path.join(runtimeRoot, app.getVersion());
  const runtimeMain = path.join(runtimeDir, 'dist', 'main.js');
  if (fs.existsSync(runtimeMain)) return runtimeDir;

  try {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    const extracted = spawnSync(
      'tar.exe',
      ['-xf', archivePath, '-C', runtimeDir],
      { windowsHide: true, timeout: 5 * 60 * 1000 },
    );
    if (extracted.status === 0 && fs.existsSync(runtimeMain)) return runtimeDir;
  } catch {
    // The caller reports a concise backend-not-found error.
  }
  return null;
};

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

const getListeningPidByPort = async (port) => {
  const script = `try { (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess) } catch { }`;
  const res = await runCommand('powershell.exe', ['-NoProfile', '-Command', script]);
  const val = (res.stdout || '').trim();
  if (!val) return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isAutoStartEnabled = () => {
  const env = String(process.env.BANKAPI_AUTOSTART_BACKEND || '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off' || env === 'no') return false;
  return true;
};

// Determines if this PC is the main server (requires a physical file in the app dir or repo root)
const isMainServer = () => {
  const candidates = [
    path.join(process.cwd(), 'server.marker'),
    path.join(path.dirname(app.getAppPath()), 'server.marker'), // When packaged, this is next to the .exe
    path.join(process.resourcesPath || '', 'server.marker'),
    path.join(app.getPath('userData'), 'server.marker'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return true;
  }
  return false;
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

let lastDockerCheckAt = 0;
let lastDockerOk = false;

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
    } catch {
      // ignore
    }
  }

  const start = Date.now();
  while (Date.now() - start < 120 * 1000) { // Wait up to 120s for Docker daemon to turn on
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

const spawnBackendProcess = async () => {
  const alreadyPid = await getListeningPidByPort(3000);
  if (alreadyPid) return { ok: true, alreadyListening: true, pid: alreadyPid };

  if (backendProcess && backendProcess.exitCode === null) {
    return { ok: true, alreadyRunning: true, pid: backendProcess.pid };
  }

  const backendDir = resolveBackendDir();
  if (!backendDir) return { ok: false, error: 'No se encontró el backend (carpeta backend/dist/main.js).' };

  const mainPath = path.join(backendDir, 'dist', 'main.js');
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'backend.log');

  const out = fs.createWriteStream(logPath, { flags: 'a' });
  out.write(`\n\n=== Backend start ${new Date().toISOString()} (${os.userInfo().username}) ===\n`);

  backendProcess = spawn(process.execPath, [mainPath], {
    cwd: backendDir,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FRONTEND_DIST_PATH: path.join(backendDir, 'public'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout.on('data', (d) => out.write(d));
  backendProcess.stderr.on('data', (d) => out.write(d));
  backendProcess.on('close', (code) => {
    out.write(`\n=== Backend exit code ${code} ${new Date().toISOString()} ===\n`);
  });

  return { ok: true, pid: backendProcess.pid, logPath };
};

const waitForApiPort = async (timeoutMs = 25000, pollMs = 500) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = await getListeningPidByPort(3000);
    if (pid) return { ok: true, pid };
    await sleep(pollMs);
  }
  return { ok: false, error: 'Timeout esperando puerto 3000.' };
};

const stopSpawnedBackendIfAny = async () => {
  if (!backendProcess || backendProcess.exitCode !== null) return;
  const pid = backendProcess.pid;
  try {
    await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    try {
      backendProcess.kill();
    } catch {
      // ignore
    }
  }
};

const ensureBackendReady = async (opts = {}) => {
  const startAll = !!opts.startAll;
  const timeoutMs = Number(opts.timeoutMs || 25000);

  const alreadyPid = await getListeningPidByPort(3000);
  if (alreadyPid) return { ok: true, alreadyListening: true, pid: alreadyPid };

  const backendDir = resolveBackendDir();
  if (!backendDir) return { ok: false, error: 'No se encontró el backend (carpeta backend/dist/main.js).' };

  if (startAll) {
    const composeFile = path.join(backendDir, 'docker-compose.yml');
    if (!fs.existsSync(composeFile)) return { ok: false, error: 'No se encontró docker-compose.yml en backend.' };
    
    // Explicitly wait for Docker Desktop to boot
    const dockerOk = await ensureDockerReady();
    if (!dockerOk) return { ok: false, error: 'Docker Desktop no está instalado, apagado, o falló al iniciar.' };

    const db = await runCommand('docker', ['compose', '--env-file', '.env', 'up', '-d', 'db'], { cwd: backendDir });
    if (db.code !== 0) return { ok: false, error: 'No se pudo iniciar DB.', db };
  }

  const first = await spawnBackendProcess();
  if (!first.ok) return first;

  const ready = await waitForApiPort(timeoutMs);
  if (ready.ok) return { ok: true, ...first, ready };

  // One controlled restart attempt for flaky startups.
  await stopSpawnedBackendIfAny();
  await sleep(700);
  const second = await spawnBackendProcess();
  if (!second.ok) return second;
  const ready2 = await waitForApiPort(timeoutMs);
  if (ready2.ok) return { ok: true, ...second, ready: ready2, retried: true };

  return { ok: false, error: 'Backend no respondió en puerto 3000 tras reintento.', first, second, ready, ready2 };
};

const runBackendAutoStart = async () => {
  autoStartState = {
    enabled: isAutoStartEnabled(),
    running: true,
    done: false,
    ok: null,
    message: 'Inicializando autoarranque...',
    at: new Date().toISOString(),
    details: null,
  };

  if (!autoStartState.enabled) {
    autoStartState = {
      ...autoStartState,
      running: false,
      done: true,
      ok: true,
      message: 'Autoarranque desactivado por BANKAPI_AUTOSTART_BACKEND.',
      details: null,
    };
    return autoStartState;
  }

  const result = await ensureBackendReady({ startAll: true, timeoutMs: 30000 });
  autoStartState = {
    ...autoStartState,
    running: false,
    done: true,
    ok: !!result?.ok,
    message: result?.ok
      ? result?.alreadyListening
        ? `Backend ya activo (PID ${result.pid}).`
        : `Backend iniciado (PID ${result.pid || 'n/a'}).`
      : String(result?.error || 'Error al autoarrancar backend.'),
    details: result || null,
  };

  return autoStartState;
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

const createTray = () => {
  if (!app.isPackaged) return null;
  if (tray) return tray;

  tray = new Tray(resolveTrayIcon());
  tray.setToolTip('BankApi');

  const showMainWindow = async () => {
    if (!mainWindow) await createWindow();
    mainWindow.show();
    mainWindow.focus();
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showMainWindow());

  return tray;
};

const createWindow = async () => {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep the app running in background for notifications (minimize-to-tray).
  if (app.isPackaged) {
    mainWindow.on('close', (e) => {
      if (isQuitting) return;
      e.preventDefault();
      mainWindow.hide();
    });
  }

  const isDev = !app.isPackaged;
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
};

app.whenReady().then(async () => {
  app.on('before-quit', () => {
    isQuitting = true;
    if (backendProcess && backendProcess.exitCode === null) {
      try {
        runCommand('taskkill', ['/PID', String(backendProcess.pid), '/T', '/F']);
      } catch {
        // ignore
      }
    }
  });

  ipcMain.handle('bankapi:getAppVersion', async () => {
    try {
      return app.getVersion();
    } catch {
      return null;
    }
  });

  ipcMain.handle('bankapi:connection:get', async () => {
    try {
      return { ok: true, serverUrl: readConnectionFile() };
    } catch (e) {
      return { ok: false, serverUrl: null, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('bankapi:connection:save', async (_evt, payload) => {
    try {
      return { ok: true, serverUrl: writeConnectionFile(payload?.serverUrl) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('bankapi:connection:clear', async () => {
    try {
      const p = connectionFilePath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('bankapi:services:status', async () => {
    const backendDir = resolveBackendDir();
    const apiPid = await getListeningPidByPort(3000);
    const dbPid = await getListeningPidByPort(5433);
    return {
      backend: {
        available: !!backendDir,
        running: !!backendProcess && backendProcess.exitCode === null,
        pid: backendProcess?.pid || null,
        backendDir,
      },
      ports: {
        api3000: { listening: !!apiPid, pid: apiPid },
        db5433: { listening: !!dbPid, pid: dbPid },
      },
      autoStart: autoStartState,
    };
  });

  ipcMain.handle('bankapi:services:autoStartStatus', async () => autoStartState);

  ipcMain.handle('bankapi:services:startDb', async () => {
    const backendDir = resolveBackendDir();
    if (!backendDir) return { ok: false, error: 'No se encontró el backend (carpeta backend/dist/main.js).' };

    const composeFile = path.join(backendDir, 'docker-compose.yml');
    if (!fs.existsSync(composeFile)) return { ok: false, error: 'No se encontró docker-compose.yml en backend.' };

    const dockerOk = await ensureDockerReady();
    if (!dockerOk) return { ok: false, error: 'Docker Desktop no disponible.' };

    const res = await runCommand('docker', ['compose', '--env-file', '.env', 'up', '-d', 'db'], { cwd: backendDir });
    return { ok: res.code === 0, ...res };
  });

  ipcMain.handle('bankapi:services:stopDb', async () => {
    const backendDir = resolveBackendDir();
    if (!backendDir) return { ok: false, error: 'No se encontró el backend (carpeta backend/dist/main.js).' };

    const res = await runCommand('docker', ['compose', '--env-file', '.env', 'down'], { cwd: backendDir });
    return { ok: res.code === 0, ...res };
  });

  ipcMain.handle('bankapi:services:startBackend', async () => {
    return ensureBackendReady({ startAll: false, timeoutMs: 25000 });
  });

  ipcMain.handle('bankapi:services:stopBackend', async () => {
    if (!backendProcess || backendProcess.exitCode !== null) return { ok: true, alreadyStopped: true };

    const pid = backendProcess.pid;
    try {
      // Ensure child + subtree exits on Windows.
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      try {
        backendProcess.kill();
      } catch {
        // ignore
      }
    }

    return { ok: true };
  });

  ipcMain.handle('bankapi:services:startAll', async () => {
    return ensureBackendReady({ startAll: true, timeoutMs: 30000 });
  });

  ipcMain.handle('bankapi:services:setMainServer', async () => {
    try {
      const p = path.join(app.getPath('userData'), 'server.marker');
      fs.writeFileSync(p, 'true', 'utf8');
      runBackendAutoStart().catch(() => { });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('bankapi:credentials:isAvailable', async () => {
    try {
      return { ok: true, available: !!safeStorage?.isEncryptionAvailable?.() };
    } catch {
      return { ok: true, available: false };
    }
  });

  ipcMain.handle('bankapi:credentials:get', async () => {
    try {
      const file = readCredentialsFile();
      if (!file) return { ok: true, username: null, password: null };

      let password = null;
      if (file.passwordEnc && safeStorage?.isEncryptionAvailable?.()) {
        try {
          const buf = Buffer.from(file.passwordEnc, 'base64');
          password = safeStorage.decryptString(buf);
        } catch {
          password = null;
        }
      }

      return { ok: true, username: file.username, password };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('bankapi:credentials:save', async (_evt, payload) => {
    try {
      const username = String(payload?.username || '').trim();
      const password = String(payload?.password || '');

      if (!username) return { ok: false, error: 'Usuario requerido.' };
      if (!safeStorage?.isEncryptionAvailable?.()) {
        return { ok: false, error: 'No hay cifrado disponible en este equipo.' };
      }

      const passwordEnc = safeStorage.encryptString(password).toString('base64');
      writeCredentialsFile({ username, passwordEnc });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('bankapi:credentials:clear', async () => {
    try {
      const p = credentialsFilePath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  await createWindow();
  if (app.isPackaged) createTray();
  if (app.isPackaged) {
    // Only attempt auto-start if this PC is marked as the Server
    if (isMainServer()) {
      runBackendAutoStart().catch(() => {
        autoStartState = {
          ...autoStartState,
          running: false,
          done: true,
          ok: false,
          message: 'Fallo en autoarranque del backend.',
        };
      });
    } else {
      // Mark auto-start as inapplicable for Collector Clients
      autoStartState = {
        enabled: false,
        running: false,
        done: true,
        ok: true,
        message: 'Modo Cliente Cobrador: Auto-arranque de servidor omitido.',
        at: new Date().toISOString(),
        details: null,
      };
    }
  }

  app.on('activate', async () => {
    if (!mainWindow) await createWindow();
    mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  // On Windows/Linux we keep the app alive in the tray. On macOS, close fully.
  if (process.platform === 'darwin') app.quit();
});
