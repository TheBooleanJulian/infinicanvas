// Minimal PNG → RGBA decoder for the timelapse (replaces Jimp, which doesn't run on Workers).
// Handles what canvas.toDataURL('image/png') produces: 8-bit, non-interlaced, colour type 6 (RGBA) or 2 (RGB).
// Inflate uses the platform's DecompressionStream ('deflate' = zlib, which is what PNG's IDAT holds).

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(bytes) {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`unsupported PNG (depth ${bitDepth}, colour ${colorType}, interlace ${interlace})`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = await inflate(concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[i] = v & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < pixels.length; p += 3, q += 4) {
    rgba[q] = pixels[p]; rgba[q + 1] = pixels[p + 1]; rgba[q + 2] = pixels[p + 2]; rgba[q + 3] = 255;
  }
  return { width, height, data: rgba };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
