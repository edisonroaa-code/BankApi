const fs = require('fs');
const path = require('path');

const [srcDir, destDir] = process.argv.slice(2);
if (!srcDir || !destDir) {
  console.error('Usage: node scripts/copy-electron-artifacts.cjs <srcDir> <destDir>');
  process.exit(1);
}

const src = path.resolve(process.cwd(), srcDir);
const dest = path.resolve(process.cwd(), destDir);
fs.mkdirSync(dest, { recursive: true });

const artifacts = [
  'BankApi Setup.exe',
  'BankApi Setup.exe.blockmap',
  'builder-debug.yml',
];

let copied = 0;
for (const name of artifacts) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) continue;
  const to = path.join(dest, name);
  fs.copyFileSync(from, to);
  copied += 1;
}

if (copied === 0) {
  console.error(`No artifacts found in: ${src}`);
  process.exit(1);
}

process.stdout.write(`copied:${copied}\n`);
