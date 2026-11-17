import { fileOperation } from './tool-sandbox.js';

export function sandboxedReadOperations(policy) {
  const readFile = file => fileOperation(policy, 'read', file);
  const readHead = (file, length = 64) => fileOperation(policy, 'read_head', file, undefined, { length });
  return {
    readFile,
    access: async file => { await fileOperation(policy, 'access', file); },
    detectImageMimeType: async file => {
      const b = await readHead(file, 64);
      if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 && b[3] !== 247) return 'image/jpeg';
      if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
      if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
      if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
      if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM') {
        const size = b.readUInt32LE(2), pixels = b.readUInt32LE(10), dib = b.readUInt32LE(14);
        const planesOffset = dib === 12 ? 22 : dib >= 40 && dib <= 124 ? 26 : -1;
        if (planesOffset >= 0 && b.length >= planesOffset + 4 &&
            (size === 0 || size >= 26) && pixels >= 14 + dib &&
            (size === 0 || pixels < size) && b.readUInt16LE(planesOffset) === 1 &&
            [1, 4, 8, 16, 24, 32].includes(b.readUInt16LE(planesOffset + 2))) return 'image/bmp';
      }
      return undefined;
    },
  };
}
