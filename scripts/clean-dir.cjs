const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/clean-dir.cjs <dir>');
  process.exit(1);
}

const resolved = path.resolve(process.cwd(), target);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableFsError = (err) => {
  const code = String(err?.code || '');
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
};

const resetDir = async (dir) => {
  const retries = 5;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      return;
    } catch (err) {
      if (attempt === retries || !isRetryableFsError(err)) throw err;
      await sleep(300 * attempt);
    }
  }
};

(async () => {
  try {
    await resetDir(resolved);
    process.stdout.write(`cleaned:${resolved}\n`);
  } catch (err) {
    console.error(String(err?.message || err));
    process.exit(1);
  }
})();
