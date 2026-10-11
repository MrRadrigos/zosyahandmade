// Локальный сервер: собирает сайт и показывает его на http://localhost:5173
// Админка — http://localhost:5173/admin/ — сохраняет изменения прямо в папку проекта
// и сразу пересобирает сайт. Сервер доступен только с этого компьютера.
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { build, ROOT, validate } from './lib/build.mjs';

const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 5173;
const MAX_BODY = 200 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif'
};

// Путь внутри папки base; null, если пытаются выйти за её пределы
function inside(base, rel) {
  const p = join(base, normalize(rel).replace(/^([/\\])+/, ''));
  return p === base || p.startsWith(base + sep) ? p : null;
}
const isUploadPath = p => /^images\/uploads\/[\w.-]+\.(jpe?g|png|webp)$/i.test(p);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, data) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));

async function serveFile(res, file) {
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    const page = await readFile(join(DIST, '404.html')).catch(() => '404');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  }
}

let saving = Promise.resolve();

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/content' && req.method === 'GET') {
      const [artworks, settings] = await Promise.all(['artworks', 'settings'].map(async n => JSON.parse(await readFile(join(ROOT, 'content', n + '.json'), 'utf8'))));
      return json(res, 200, { artworks, settings });
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      const file = rel.startsWith('images/') && inside(ROOT, rel);
      if (!file) return json(res, 403, { error: 'forbidden' });
      return serveFile(res, file);
    }
    if (url.pathname === '/api/save' && req.method === 'POST') {
      const job = saving.then(async () => {
        const { artworks, settings, uploads = [], deletes = [] } = JSON.parse(await readBody(req));
        validate(artworks, settings);
        for (const u of uploads) if (!isUploadPath(u.path)) throw new Error('Недопустимый путь файла: ' + u.path);
        for (const d of deletes) if (!isUploadPath(d)) throw new Error('Недопустимый путь файла: ' + d);
        for (const u of uploads) {
          const file = inside(ROOT, u.path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, Buffer.from(u.base64, 'base64'));
        }
        await writeFile(join(ROOT, 'content', 'artworks.json'), JSON.stringify(artworks, null, 2) + '\n');
        await writeFile(join(ROOT, 'content', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
        for (const d of deletes) await rm(inside(ROOT, d), { force: true });
        await build({ log: m => console.log('  ' + m) });
      });
      saving = job.catch(() => {});
      try { await job; return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    const file = inside(DIST, decodeURIComponent(url.pathname));
    if (!file) return res.writeHead(403).end();
    return serveFile(res, file);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}).listen(PORT, '127.0.0.1', async () => {
  try { await build(); } catch (e) { console.error('Ошибка сборки: ' + e.message); }
  console.log(`Сайт:    http://localhost:${PORT}`);
  console.log(`Админка: http://localhost:${PORT}/admin/`);
});
