import { BadRequestException } from '@nestjs/common';

export const MAX_PROOF_BYTES = 10 * 1024 * 1024;

export type ProofKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff' | 'heif' | 'pdf';

export const extensionForProofKind = (kind: ProofKind): string => ({
  jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', tiff: '.tif', heif: '.heic', pdf: '.pdf',
})[kind];

const detectProofKind = (buffer: Buffer): ProofKind | null => {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'gif';
  if (buffer.length >= 4 && (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0])) || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 0x2a])))) return 'tiff';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(buffer.toString('ascii', 8, 12))) return 'heif';
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
};

const MIME_BY_KIND: Record<ProofKind, readonly string[]> = {
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  tiff: ['image/tiff', 'image/tif'],
  heif: ['image/heic', 'image/heif'],
  pdf: ['application/pdf'],
};

/** El MIME de salida se deriva de los bytes, nunca del nombre ni de Cloudinary. */
export const inspectStoredProof = (buffer: Buffer): { kind: ProofKind; mimeType: string } | null => {
  if (!buffer.length || buffer.length > MAX_PROOF_BYTES) return null;
  const kind = detectProofKind(buffer);
  return kind ? { kind, mimeType: MIME_BY_KIND[kind][0] } : null;
};

export const validateProofFile = (file: Express.Multer.File): ProofKind => {
  if (!file?.buffer?.length || file.size > MAX_PROOF_BYTES || file.buffer.length > MAX_PROOF_BYTES) {
    throw new BadRequestException('El comprobante debe ser un archivo de hasta 10 MB.');
  }
  const kind = detectProofKind(file.buffer);
  if (!kind || !MIME_BY_KIND[kind].includes(file.mimetype?.toLowerCase())) {
    throw new BadRequestException('El comprobante debe ser una imagen o PDF válido.');
  }
  return kind;
};

const jpegDimensions = (buffer: Buffer): { width: number; height: number } | null => {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
};

/** Jimp decodifica toda la imagen; solo procesamos JPEG/PNG con dimensiones acotadas. */
export const shouldComputeProofDhash = (file: Express.Multer.File, kind: ProofKind): boolean => {
  if (file.buffer.length > 2 * 1024 * 1024) return false;
  const dimensions = kind === 'png' && file.buffer.length >= 24
    ? { width: file.buffer.readUInt32BE(16), height: file.buffer.readUInt32BE(20) }
    : kind === 'jpeg' ? jpegDimensions(file.buffer) : null;
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16_000_000;
};
