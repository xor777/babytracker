#!/usr/bin/env node
/**
 * Генератор иконок PWA. Чистый node: PNG кодируется вручную через zlib,
 * зависимостей нет — набор можно пересобрать в любой момент и в CI.
 *
 *   node tools/make-icons.mjs
 *
 * Мотив взят у иконки навыка Алисы (docs/assets/alice-icon-224.png): тёмный фон,
 * циановый полумесяц, две звёздочки, дуга-колыбель снизу. Это один продукт,
 * и на домашнем экране он должен узнаваться.
 *
 * Рисуем в единичном квадрате [0..1] с суперсэмплингом — так одна геометрия
 * даёт любой размер без отдельных исходников.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba длина = w*h*4 */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // фильтр None
    rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (w * 4 + 1) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ рисунок

const BG = [0x05, 0x09, 0x0c];
const CYAN = [0x3f, 0xe9, 0xff];
const CYAN_SOFT = [0x8f, 0xf3, 0xff];

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

/** Наложить цвет с альфой на аккумулятор. */
function over(acc, color, a) {
  if (a <= 0) return;
  const k = Math.min(1, a);
  acc[0] = acc[0] * (1 - k) + color[0] * k;
  acc[1] = acc[1] * (1 - k) + color[1] * k;
  acc[2] = acc[2] * (1 - k) + color[2] * k;
}

/**
 * Цвет одной точки. s — масштаб рисунка относительно холста (для maskable
 * рисунок ужимается в безопасную зону, фон остаётся во весь квадрат).
 */
function sample(x, y, s) {
  // перевод в координаты рисунка
  const px = 0.5 + (x - 0.5) / s;
  const py = 0.5 + (y - 0.5) / s;

  const acc = [BG[0], BG[1], BG[2]];

  const moonC = [0.455, 0.5];
  const moonR = 0.3;
  const cutC = [0.575, 0.415];
  const cutR = 0.275;

  // мягкое свечение вокруг полумесяца
  const dm = dist(px, py, moonC[0], moonC[1]);
  const glow = Math.exp(-(((dm - moonR * 0.92) / 0.085) ** 2));
  over(acc, CYAN, glow * 0.3);

  // дуга-колыбель снизу
  const dc = dist(px, py, 0.5, 0.5);
  const ang = Math.atan2(py - 0.5, px - 0.5); // y вниз: (0..π) — низ
  if (ang > 0.2 && ang < Math.PI - 0.2) {
    const band = 1 - Math.min(1, Math.abs(dc - 0.405) / 0.014);
    over(acc, CYAN, Math.max(0, band));
  }

  // сам полумесяц
  const inMoon = moonR - dm;
  const outCut = dist(px, py, cutC[0], cutC[1]) - cutR;
  const edge = 0.004;
  const aMoon = Math.min(1, Math.max(0, inMoon / edge)) * Math.min(1, Math.max(0, outCut / edge));
  over(acc, CYAN, aMoon);

  // звёздочки: четырёхлучевая «астроида»
  for (const [sx, sy, sr, tone] of [
    [0.735, 0.295, 0.062, CYAN_SOFT],
    [0.815, 0.425, 0.034, CYAN],
  ]) {
    const ux = Math.abs(px - sx) / sr;
    const uy = Math.abs(py - sy) / sr;
    const v = Math.sqrt(ux) + Math.sqrt(uy);
    over(acc, tone, Math.min(1, Math.max(0, (1.25 - v) / 0.18)));
  }

  return acc;
}

function render(size, { scale = 1, ss = 3 } = {}) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, scale);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = 255; // всегда непрозрачно: iOS не любит альфу в apple-touch-icon
    }
  }
  return out;
}

const JOBS = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  // maskable: система обрежет углы, поэтому рисунок ужимаем в безопасную зону
  ['icon-maskable-192.png', 192, 0.72],
  ['icon-maskable-512.png', 512, 0.72],
  ['apple-touch-icon.png', 180, 1],
  ['favicon-32.png', 32, 1],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, scale] of JOBS) {
  const png = encodePng(size, size, render(size, { scale, ss: size > 256 ? 2 : 4 }));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`${name.padEnd(26)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} КБ`);
}
