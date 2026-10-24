import { BadRequestException } from '@nestjs/common';
import { extensionForProofKind, MAX_PROOF_BYTES, shouldComputeProofDhash, validateProofFile } from './proof-file-policy';

const proof = (buffer: Buffer, mimetype: string) => ({ buffer, size: buffer.length, mimetype }) as Express.Multer.File;

describe('comprobantes recibidos', () => {
  it('acepta un PDF con firma y tipo coherentes', () => {
    expect(validateProofFile(proof(Buffer.from('%PDF-1.7\n'), 'application/pdf'))).toBe('pdf');
    expect(extensionForProofKind('pdf')).toBe('.pdf');
  });

  it('rechaza contenido ajeno o tipo declarado que no coincide', () => {
    expect(() => validateProofFile(proof(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml'))).toThrow(BadRequestException);
    expect(() => validateProofFile(proof(Buffer.from('%PDF-1.7\n'), 'image/png'))).toThrow(BadRequestException);
  });

  it('rechaza un archivo vacío o superior al límite', () => {
    expect(() => validateProofFile(proof(Buffer.alloc(0), 'application/pdf'))).toThrow(BadRequestException);
    expect(() => validateProofFile(proof(Buffer.alloc(MAX_PROOF_BYTES + 1), 'application/pdf'))).toThrow(BadRequestException);
  });

  it('no pasa imágenes enormes al decodificador de huella perceptual', () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(100_000, 16);
    png.writeUInt32BE(100_000, 20);
    const file = proof(png, 'image/png');
    expect(validateProofFile(file)).toBe('png');
    expect(shouldComputeProofDhash(file, 'png')).toBe(false);
  });
});
