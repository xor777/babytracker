#!/usr/bin/env node
/**
 * Генератор иконок PWA. Чистый node: PNG кодируется вручную через zlib,
 * зависимостей нет — набор можно пересобрать в любой момент и в CI.
 *
 *   node tools/make-icons.mjs
 *
 * Мотив — цветик-семицветик на белом: то же самое, что висит в шапке
 * приложения. Приложение чёрно-белое, и цветок в нём — единственное место,
 * где цветов больше одного; на домашнем экране он и опознаётся.
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

const BG = [0xff, 0xff, 0xff];
const CORE = [0xff, 0xff, 0xff];

/**
 * Семь лепестков, семь цветов — те же, что в шапке приложения.
 * Порядок по кругу подобран так, чтобы рядом не стояли два соседа по спектру.
 */
const PETALS = [
  [0xf5, 0xc4, 0x00], // жёлтый
  [0xe8, 0x40, 0x2a], // красный
  [0x2f, 0x6f, 0xd0], // синий
  [0x2f, 0x9e, 0x5b], // зелёный
  [0xf2, 0x82, 0x0c], // оранжевый
  [0x8a, 0x4f, 0xc4], // фиолетовый
  [0x49, 0xbd, 0xe0], // голубой
];

/** Геометрия цветка в долях холста: вынос лепестка от центра и его полуоси. */
const OFFSET = 0.198; // центр лепестка от центра холста
const ALONG = 0.152; // полуось вдоль луча
const ACROSS = 0.094; // полуось поперёк
const CORE_R = 0.076; // белая сердцевина

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
 * e — ширина сглаживания края в долях холста: зависит от размера картинки,
 * иначе на 512 край выходит ватным, а на 32 — рваным.
 */
function sample(x, y, s, e) {
  // перевод в координаты рисунка
  const dx = (x - 0.5) / s;
  const dy = (y - 0.5) / s;

  const acc = [BG[0], BG[1], BG[2]];

  for (let k = 0; k < PETALS.length; k++) {
    const phi = (k * 2 * Math.PI) / PETALS.length;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);

    // луч лепестка смотрит вверх и поворачивается на phi (y растёт вниз)
    const vx = dx - OFFSET * sin;
    const vy = dy + OFFSET * cos;
    const along = vx * sin - vy * cos;
    const across = vx * cos + vy * sin;

    // f = 1 на границе эллипса; градиент по f переводим в доли холста
    const f = Math.hypot(along / ALONG, across / ACROSS);
    over(acc, PETALS[k], Math.min(1, Math.max(0, (1 - f) / (e / ACROSS))));
  }

  // сердцевина: лепестки сходятся в центре, и без неё там каша
  const dc = Math.hypot(dx, dy);
  over(acc, CORE, Math.min(1, Math.max(0, (CORE_R - dc) / e)));

  return acc;
}

function render(size, { scale = 1, ss = 3 } = {}) {
  // край шириной примерно в полтора пикселя холста
  const edge = 1.5 / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(
            (x + (sx + 0.5) / ss) / size,
            (y + (sy + 0.5) / ss) / size,
            scale,
            edge,
          );
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
  // maskable: система обрежет углы. Цветок и так занимает 70 % холста —
  // это внутри безопасного круга (80 %), ужимать его нечего, наоборот,
  // при 0.72 на экране оставалось бы бледное пятнышко посреди белого.
  ['icon-maskable-192.png', 192, 1.05],
  ['icon-maskable-512.png', 512, 1.05],
  ['apple-touch-icon.png', 180, 1],
  // на 32 px семь лепестков сливаются с краем — рисунок чуть крупнее
  ['favicon-32.png', 32, 1.12],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, scale] of JOBS) {
  const png = encodePng(size, size, render(size, { scale, ss: size > 256 ? 2 : 4 }));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`${name.padEnd(26)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} КБ`);
}
