// Сжатие фото при сборке: из исходника в images/ делаем несколько размеров WebP
// для сайта и один JPEG для превью в Pinterest / соцсетях (og:image).
// Готовые файлы кэшируются в .cache/img, поэтому повторная сборка быстрая.
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const WIDTHS = [480, 800, 1200, 1800];
const OG_WIDTH = 1200;
const VERSION = 'v1'; // поменяйте, чтобы пересоздать все размеры

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function processImages(photos, { root, dist }) {
  const cacheDir = join(root, '.cache', 'img');
  const outDir = join(dist, 'img');
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const result = new Map();
  for (const photo of new Set(photos.filter(Boolean))) {
    const src = join(root, 'images', photo);
    let buf;
    try { buf = await readFile(src); } catch {
      console.warn(`  ! Фото не найдено: images/${photo} — будет показана заглушка`);
      continue;
    }
    const hash = createHash('sha1').update(VERSION).update(buf).digest('hex').slice(0, 8);
    const name = photo.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const base = `${name}-${hash}`;

    const meta = await sharp(buf).metadata();
    const rotated = (meta.orientation || 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    const max = Math.min(width, WIDTHS[WIDTHS.length - 1]);
    const widths = [...new Set([...WIDTHS.filter(w => w < max), max])];

    const files = [
      ...widths.map(w => ({ file: `${base}-${w}.webp`, make: p => sharp(buf).rotate().resize({ width: w }).webp({ quality: 80 }).toFile(p) })),
      { file: `${base}-og.jpg`, make: p => sharp(buf).rotate().resize({ width: OG_WIDTH, withoutEnlargement: true }).flatten({ background: '#FAF8F4' }).jpeg({ quality: 82, mozjpeg: true }).toFile(p) }
    ];
    for (const { file, make } of files) {
      const cached = join(cacheDir, file);
      if (!(await exists(cached))) await make(cached);
      await copyFile(cached, join(outDir, file));
    }
    result.set(photo, { base, widths, ratio: width / height });
  }
  return result;
}
