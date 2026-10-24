import Jimp from 'jimp';

const toHex64 = (value: bigint) => value.toString(16).padStart(16, '0');

const popCount64 = (value: bigint) => {
  let v = value;
  let count = 0;
  while (v > 0n) {
    count += Number(v & 1n);
    v >>= 1n;
  }
  return count;
};

export const hammingDistanceHex64 = (a: string, b: string) => {
  const av = BigInt(`0x${a}`);
  const bv = BigInt(`0x${b}`);
  return popCount64(av ^ bv);
};

const pixelLuma = (rgba: { r: number; g: number; b: number }) => (rgba.r + rgba.g + rgba.b) / 3;

/**
 * Difference hash (dHash) 64-bit, output as 16 hex chars.
 * Robust to resize and some compression; helps detect "same photo" even if WhatsApp recompressed.
 */
export const computeDhash64FromBuffer = async (buffer: Buffer) => {
  const img = await Jimp.read(buffer);

  // 9x8 produces 8 comparisons per row => 64 bits.
  img.resize(9, 8).grayscale();

  let bits = 0n;
  let bitIndex = 0;

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = pixelLuma(Jimp.intToRGBA(img.getPixelColor(x, y)));
      const right = pixelLuma(Jimp.intToRGBA(img.getPixelColor(x + 1, y)));
      const isOne = left > right;
      if (isOne) {
        bits |= 1n << BigInt(63 - bitIndex);
      }
      bitIndex += 1;
    }
  }

  return toHex64(bits);
};

