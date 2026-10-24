const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const storageSource = readFileSync(join(__dirname, 'deploy-storage-preflight.cjs'), 'utf8');
const readonlySource = readFileSync(join(__dirname, 'deploy-readonly-preflight.cjs'), 'utf8');
const syntheticReference = 'cld-auth-raw:transferencias/0ea3ca5f-0f3a-43d5-9c4b-9fbe2c7db530.png';
const syntheticPdfReference = 'cld-auth-raw:transferencias/8808393e-f6ef-4903-9401-ff767b4c816d.pdf';

async function storageProbe(options = {}) {
  const calls = [];
  const logs = [];
  let uploadedBytes;
  let uploadedMimeType;
  const process = { env: { CLOUDINARY_PROBE_ON_DEPLOY: 'true', ...options.env } };
  class StorageService {
    async saveFile(file) {
      calls.push(['save', file]);
      uploadedBytes = file.buffer;
      uploadedMimeType = file.mimetype;
      if (options.uploadError && (!options.failMimeType || options.failMimeType === file.mimetype)) throw new Error(options.uploadError);
      return options.reference ?? (file.mimetype === 'application/pdf' ? syntheticPdfReference : syntheticReference);
    }
    async readFile(reference) {
      calls.push(['read', reference]);
      const failThisFile = !options.failMimeType || options.failMimeType === uploadedMimeType;
      if (options.readError && failThisFile) throw new Error(options.readError);
      return { buffer: (failThisFile && options.bytes) || Buffer.from(uploadedBytes), mimeType: (failThisFile && options.mimeType) || uploadedMimeType };
    }
    async deleteNewFile(reference) {
      calls.push(['delete', reference]);
      if (options.cleanupError && (!options.failMimeType || options.failMimeType === uploadedMimeType)) throw new Error(options.cleanupError);
    }
  }
  const sandbox = {
    process, Buffer,
    console: { log: (message) => logs.push(message), error: (message) => logs.push(message) },
    require: (name) => {
      calls.push(['require', name]);
      if (name === 'reflect-metadata') return {};
      if (name === '../dist/storage/storage.service') return { StorageService };
      if (name === 'pdfkit') return require(name);
      throw new Error(`Dependencia inesperada: ${name}`);
    },
  };
  // Capture the entrypoint's own promise; execute its actual catch and finally.
  vm.runInNewContext(storageSource.replace(/\bmain\(\)\.catch\(/, 'globalThis.pending = main().catch('), sandbox);
  await sandbox.pending;
  return { calls, logs, exitCode: process.exitCode };
}

function readonlyProbe(env, outcomes = []) {
  const calls = [];
  const process = { env, execPath: '/synthetic-node' };
  vm.runInNewContext(readonlySource, {
    process, __dirname,
    console: { error: () => {} },
    require: (name) => {
      if (name === 'node:path') return require(name);
      assert.equal(name, 'node:child_process', 'El wrapper no debe cargar Neon ni servicios bancarios directamente');
      return { spawnSync: (executable, args, options) => {
        calls.push({ executable, args, options });
        return outcomes.shift();
      } };
    },
  });
  return { calls, exitCode: process.exitCode };
}

test('la sonda de almacenamiento queda inactiva sin el true explícito y no carga servicios', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    const result = await storageProbe({ env: { CLOUDINARY_PROBE_ON_DEPLOY: value } });
    assert.deepEqual(result.calls, []);
    assert.equal(result.exitCode, undefined);
  }
});

test('la prueba carga PNG y PDF sintéticos y limpia cada referencia recién devuelta', async () => {
  const result = await storageProbe();
  const savedFile = result.calls.find(([operation]) => operation === 'save')[1];
  assert.equal(savedFile.mimetype, 'image/png');
  assert.equal(savedFile.originalname, 'release-probe.png');
  assert.equal(savedFile.size, savedFile.buffer.length);
  assert.equal(savedFile.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const savedFiles = result.calls.filter(([operation]) => operation === 'save').map(([, file]) => file);
  assert.equal(savedFiles.length, 2);
  assert.equal(savedFiles[1].mimetype, 'application/pdf');
  assert.equal(savedFiles[1].originalname, 'release-probe.pdf');
  assert.equal(savedFiles[1].size, savedFiles[1].buffer.length);
  assert.equal(savedFiles[1].buffer.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(result.calls.filter(([operation]) => ['read', 'delete'].includes(operation)), [
    ['read', syntheticReference], ['delete', syntheticReference],
    ['read', syntheticPdfReference], ['delete', syntheticPdfReference],
  ]);
  assert.equal(result.exitCode, undefined);
});

test('una lectura PDF fallida limpia ese PDF y el PNG anterior ya fue retirado', async () => {
  const result = await storageProbe({ readError: 'Fallo PDF', failMimeType: 'application/pdf' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.calls.filter(([operation]) => operation === 'delete'), [
    ['delete', syntheticReference], ['delete', syntheticPdfReference],
  ]);
});

test('un PDF con bytes o MIME diferentes no permite publicar y limpia sus dos cargas', async () => {
  for (const mismatch of [{ bytes: Buffer.from('%PDF-distinto') }, { mimeType: 'image/png' }]) {
    const result = await storageProbe({ ...mismatch, failMimeType: 'application/pdf' });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.calls.filter(([operation]) => operation === 'delete'), [
      ['delete', syntheticReference], ['delete', syntheticPdfReference],
    ]);
  }
});

test('una limpieza PDF fallida impide publicar aunque el PNG haya pasado', async () => {
  const result = await storageProbe({ cleanupError: 'Fallo PDF', failMimeType: 'application/pdf' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.calls.filter(([operation]) => operation === 'delete'), [
    ['delete', syntheticReference], ['delete', syntheticPdfReference],
  ]);
});

test('la sonda nunca lee ni elimina una referencia histórica, pública o externa', async () => {
  for (const reference of [
    'https://res.cloudinary.com/demo/image/upload/historico.png',
    '/uploads/comprobante-historico.png',
    'cld-auth-raw:otra-carpeta/0ea3ca5f-0f3a-43d5-9c4b-9fbe2c7db530.png',
    'cld-auth-raw:transferencias/../../historico.png',
  ]) {
    const result = await storageProbe({ reference });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.calls.filter(([operation]) => ['read', 'delete'].includes(operation)), []);
  }
});

test('un fallo de lectura conserva el fallo y limpia el nuevo objeto antes de terminar', async () => {
  const result = await storageProbe({ readError: 'Fallo simulado con secreto NO_PUBLICAR' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.calls.filter(([operation]) => operation === 'delete'), [['delete', syntheticReference]]);
  assert.doesNotMatch(result.logs.join('\n'), /NO_PUBLICAR/);
});

test('bytes o MIME diferentes impiden publicar y también compensan la nueva carga', async () => {
  for (const mismatch of [{ bytes: Buffer.from('incorrecto') }, { mimeType: 'text/html' }]) {
    const result = await storageProbe(mismatch);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.calls.filter(([operation]) => operation === 'delete'), [['delete', syntheticReference]]);
  }
});

test('una limpieza fallida hace fallar el preflight y no anuncia que el objeto fue retirado', async () => {
  const result = await storageProbe({ cleanupError: 'Fallo simulado NO_PUBLICAR' });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.logs.join('\n'), /retirado exclusivamente|NO_PUBLICAR/);
});

test('una carga fallida no intenta borrar ninguna referencia ni oculta el fallo', async () => {
  const result = await storageProbe({ uploadError: 'NO_PUBLICAR' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.calls.filter(([operation]) => ['read', 'delete'].includes(operation)), []);
  assert.doesNotMatch(result.logs.join('\n'), /NO_PUBLICAR/);
});

test('el wrapper general es opt-in y propaga credenciales solo por entorno, sin shell', () => {
  assert.deepEqual(readonlyProbe({}).calls, []);
  const env = { CLOUDINARY_PROBE_ON_DEPLOY: 'true', SYNTHETIC_ONLY: 'no-secret' };
  const result = readonlyProbe(env, [{ status: 0 }]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].executable, '/synthetic-node');
  assert.equal(result.calls[0].args.length, 1);
  assert.match(result.calls[0].args[0], /deploy-storage-preflight\.cjs$/);
  assert.equal(result.calls[0].options.env, env);
  assert.equal(result.calls[0].options.shell, false);
  assert.equal(result.calls[0].options.stdio, 'inherit');
  assert.equal(result.exitCode, undefined);
});

test('Cloudinary fallido, no iniciado o terminado por señal impide continuar el build', () => {
  for (const outcome of [{ status: 1 }, { status: null, error: new Error('spawn failed') }, { status: null, signal: 'SIGTERM' }]) {
    assert.equal(readonlyProbe({ CLOUDINARY_PROBE_ON_DEPLOY: 'true' }, [outcome]).exitCode, 1);
  }
});

test('una sonda Cloudinary exitosa no borra un fallo anterior de Atlas', () => {
  const result = readonlyProbe({ ATLAS_PROBE_ON_DEPLOY: 'true', CLOUDINARY_PROBE_ON_DEPLOY: 'true' }, [{ status: 7 }, { status: 0 }]);
  assert.equal(result.calls.length, 2);
  assert.equal(result.exitCode, 7);
});

test('Atlas exitoso no oculta el fallo posterior de Cloudinary', () => {
  const result = readonlyProbe({ ATLAS_PROBE_ON_DEPLOY: 'true', CLOUDINARY_PROBE_ON_DEPLOY: 'true' }, [{ status: 0 }, { status: 1 }]);
  assert.equal(result.exitCode, 1);
});
