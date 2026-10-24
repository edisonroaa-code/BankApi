// Sonda opt-in: PNG y PDF sintéticos, sin pagos ni escrituras en Neon.
// Se retira únicamente el objeto nuevo que devuelve esta misma carga.
function syntheticPdf() {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A6', margin: 20 });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.font('Helvetica').fontSize(10).text('Prueba sintetica de almacenamiento. Sin datos reales.');
    document.end();
  });
}

async function main() {
  if (process.env.CLOUDINARY_PROBE_ON_DEPLOY !== 'true') return;
  require('reflect-metadata');
  const { StorageService } = require('../dist/storage/storage.service');
  const storage = new StorageService();
  const fixtures = [
    { extension: 'png', mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgV8AAAAASUVORK5CYII=', 'base64') },
    { extension: 'pdf', mimeType: 'application/pdf', bytes: await syntheticPdf() },
  ];
  for (const { extension, mimeType, bytes } of fixtures) {
    const privateReference = new RegExp(`^cld-auth-raw:transferencias/[a-f0-9-]{36}\\.${extension}$`);
    let reference;
    try {
      reference = await storage.saveFile({ buffer: bytes, size: bytes.length, mimetype: mimeType, originalname: `release-probe.${extension}` });
      if (!privateReference.test(reference)) throw new Error('Almacenamiento no privado');
      const result = await storage.readFile(reference);
      if (!result.buffer.equals(bytes) || result.mimeType !== mimeType) throw new Error('Lectura no coincidente');
      console.log(`OK Cloudinary ${extension.toUpperCase()}: carga privada y lectura autenticada coinciden; sin escrituras en la base.`);
    } finally {
      if (reference && privateReference.test(reference)) {
        await storage.deleteNewFile(reference);
        console.log(`OK Cloudinary ${extension.toUpperCase()}: retirado exclusivamente el archivo sintetico de esta prueba.`);
      }
    }
  }
}
main().catch(() => {
  console.error('FALLA Cloudinary: no se confirmo la carga/lectura privada o su limpieza. No se habilita la publicacion.');
  process.exitCode = 1;
});
