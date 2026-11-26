import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Pure-Node RGBA PNG generator (no native canvas deps)
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.46;

  // Transit hub nodes (normalized coords)
  const hub = [0.5, 0.5];
  const spokes = [
    { x: 0.22, y: 0.28, color: [56, 189, 248] },  // sky blue
    { x: 0.80, y: 0.26, color: [52, 211, 153] },  // emerald
    { x: 0.78, y: 0.76, color: [251, 191, 36] },  // amber
    { x: 0.24, y: 0.76, color: [244, 114, 182] }, // pink
  ];

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const nx = x / (size - 1);
      const ny = y / (size - 1);

      // Rounded-square / circle badge background
      const dCenter = Math.hypot(x - cx, y - cy);
      if (dCenter > radius + 0.75) {
        buf[idx + 3] = 0;
        continue;
      }

      const bgAlpha = Math.max(0, Math.min(1, radius + 0.75 - dCenter));
      // Deep slate-emerald gradient background
      let r = Math.round(15 + ny * 12);
      let g = Math.round(42 + ny * 28);
      let b = Math.round(62 + nx * 24);

      // Draw transit spoke lines
      const lineWidth = Math.max(0.045, 1.3 / size);
      for (const s of spokes) {
        const d = distToSeg(nx, ny, hub[0], hub[1], s.x, s.y);
        if (d < lineWidth) {
          r = s.color[0];
          g = s.color[1];
          b = s.color[2];
        }
      }

      // Draw spoke end nodes
      const nodeR = Math.max(0.085, 2.0 / size);
      for (const s of spokes) {
        const d = Math.hypot(nx - s.x, ny - s.y);
        if (d < nodeR) {
          r = 255;
          g = 255;
          b = 255;
        } else if (d < nodeR + 0.03) {
          r = s.color[0];
          g = s.color[1];
          b = s.color[2];
        }
      }

      // Draw central selected stop hub
      const hubR = Math.max(0.12, 2.4 / size);
      const dHub = Math.hypot(nx - hub[0], ny - hub[1]);
      if (dHub < hubR) {
        r = 255;
        g = 255;
        b = 255;
      } else if (dHub < hubR + 0.045) {
        r = 16;
        g = 185;
        b = 129;
      }

      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = Math.round(bgAlpha * 255);
    }
  }
  return encodePng(size, size, buf);
}

const outDir = path.resolve('icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), drawIcon(size));
}
console.log('Generated icons/icon-{16,48,128}.png');
