const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

test('database migration script never embeds a PostgreSQL credential', () => {
  const source = readFileSync(join(__dirname, 'migrate-images-to-cloudinary.ts'), 'utf8');

  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i);
  assert.doesNotMatch(source, /api_secret\s*:\s*['"][^'"]+['"]/i);
  assert.match(source, /DATABASE_URL/);
  assert.match(source, /CLOUDINARY_(?:URL|API_SECRET)/);
});
