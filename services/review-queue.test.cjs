const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

test('la cola de revisión muestra la imagen que subió el cobrador junto a la transferencia del banco', () => {
  const recon = read('views/ReconciliationView.tsx');
  assert.match(recon, /import \{ ProofViewer \} from '\.\.\/components\/ProofViewer';/);
  // Solo las conciliaciones de una consulta tienen comprobante del cobrador.
  assert.match(recon, /\{c\.paymentId && \(\s*<button[\s\S]*?Ver comprobante/);
  assert.match(recon, /<ProofViewer paymentId=\{proofClaim\.paymentId\} \/>/);
  // Desde la comparación se puede dar por buena o abrir el detalle para anular.
  assert.match(recon, /onClick=\{\(\) => void markReviewed\(proofClaim\)\}/);
  assert.match(recon, /Abrir detalle \/ anular/);
});

test('el visor del comprobante funciona con la consulta sola (lo pide al servidor con permiso y auditoría)', () => {
  const viewer = read('components/ProofViewer.tsx');
  assert.match(viewer, /proofUrl\?: string \| null; paymentId\?: string \| null/);
  assert.match(viewer, /api\.get<Blob>\(`\/payments\/\$\{encodeURIComponent\(paymentId\)\}\/proof`/);
  assert.match(viewer, /if \(!paymentId\) return null;/);
});
