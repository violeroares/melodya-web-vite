/**
 * MELODYA WEB (Vite) — Servidor de producción/preview con Open Graph dinámico.
 *
 *   npm run build && npm start        (puerto 3100 por defecto)
 *
 *  • Sirve `dist/` con URLs limpias (fallback a index.html para cualquier ruta de la SPA, sin `#`).
 *  • Para /songs/:id y /user/:id inyecta <title>, description y Open Graph/Twitter en el HTML INICIAL
 *    consultando el backend público (ver server/og.mjs). Para el resto, entrega el index.html tal cual.
 *  • No guarda estado ni credenciales; solo hace GET públicos al backend.
 *
 * Variables (solo del servidor, nunca llegan al navegador): PORT, OG_API_BASE_URL (o VITE_API_BASE_URL), OG_PUBLIC_ORIGIN.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTtlCache, injectMeta, matchOgRoute, resolveMeta } from './og.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 3100);
const apiBase = (process.env.OG_API_BASE_URL || process.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const publicOrigin = (process.env.OG_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No existe dist/index.html. Ejecutá `npm run build` primero.');
  process.exit(1);
}
const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const cache = createTtlCache();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function requestOrigin(req) {
  if (publicOrigin) return publicOrigin; // recomendado en producción (no depende de cabeceras del cliente)
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? `localhost:${port}`}`;
}

/** «bytes=a-b» / «bytes=a-» / «bytes=-n» → {start,end} o null (sin rango válido). Un solo rango: es lo que piden los navegadores para audio y video. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isFinite(start) || start < 0 || start > end || start >= size) return { invalid: true };
  return { start, end };
}

function sendStatic(req, res, filePath, immutable) {
  // El archivo de iOS Universal Links no tiene extensión y DEBE servirse como JSON, sin redirecciones.
  const type = path.basename(filePath) === 'apple-app-site-association' ? TYPES['.json'] : (TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  const headers = {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };
  // Audio y video (landing pública) necesitan peticiones por rango: Safari no los reproduce sin 206, y sin ellos no se puede avanzar.
  if (type.startsWith('video/') || type.startsWith('audio/')) {
    const size = fs.statSync(filePath).size;
    const range = parseRange(req.headers.range, size);
    if (range?.invalid) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end();
      return;
    }
    if (range) {
      res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // 1) Archivos estáticos (con protección contra path traversal).
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const filePath = path.resolve(dist, rel);
    if (rel && filePath.startsWith(dist + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile() && rel !== 'index.html') {
      sendStatic(req, res, filePath, rel.startsWith('assets/'));
      return;
    }
    // Un archivo con extensión que no existe es un 404 real (no devolvemos HTML en su lugar).
    if (/\.[a-z0-9]{2,5}$/i.test(pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    // 2) Páginas de la SPA: index.html, con metadatos dinámicos en canciones y perfiles públicos.
    let html = indexHtml;
    const route = matchOgRoute(pathname);
    if (route && apiBase) {
      const origin = requestOrigin(req);
      const meta = await resolveMeta(route, { apiBase, origin, cache });
      // Canción privada / inexistente / backend caído: 200 con los metadatos genéricos (la SPA decide qué mostrar al dueño).
      if (meta) html = injectMeta(html, meta, { fallbackImage: `${origin}/icon-512.png` });
    }
    res.writeHead(200, {
      'content-type': TYPES['.html'],
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Error interno');
  }
});

server.listen(port, () => {
  console.log(`Melodya (Vite + OG) en http://localhost:${port}  ·  backend OG: ${apiBase || '(sin configurar: OG dinámico desactivado)'}`);
});
