const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const root = resolve(__dirname, '..');

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((rel) => Boolean(rel) && existsSync(join(root, rel)));
}

test('ningún archivo del repositorio contiene credenciales embebidas ni llaves privadas RSA', () => {
  const files = listTrackedFiles();
  for (const rel of files) {
    assert.doesNotMatch(rel, /(^|\/)\.env($|\.(?!example$))/i, `Archivo .env prohibido en Git: ${rel}`);
    assert.doesNotMatch(rel, /\.(pem|key|p12|pfx)$/i, `Llave privada prohibida en Git: ${rel}`);

    if (/\.(png|ico|jpg|jpeg|webp|woff2?|ttf|lock)$/i.test(rel)) continue;
    if (rel === 'scripts/repo-security-audit.test.cjs') continue;
    if (/\.spec\.ts$|\.test\.cjs$/.test(rel)) continue;

    const content = readFileSync(join(root, rel), 'utf8');
    assert.doesNotMatch(
      content,
      /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i,
      `Credencial PostgreSQL embebida detectada en ${rel}`,
    );
    assert.doesNotMatch(
      content,
      /-----BEGIN (?:RSA )?PRIVATE KEY-----(?!\\n\.\.\.)/,
      `Llave privada RSA real detectada en ${rel}`,
    );
  }
});

test('los puertos por defecto de BankApi usan numeración dedicada de 5 dígitos sin colisiones estándar', () => {
  const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  const backendMain = readFileSync(join(root, 'backend', 'src', 'main.ts'), 'utf8');
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');

  assert.match(viteConfig, /port:\s*48517\b/);
  assert.match(viteConfig, /http:\/\/localhost:48300/);
  assert.match(backendMain, /48300/);
  assert.match(compose, /48300\}?:48300/);
  assert.match(compose, /48543\}?:5432/);
});
