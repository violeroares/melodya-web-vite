// Contrato de enlaces compartibles + Open Graph en el HTML inicial (server/og.mjs).
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absoluteFileUrl, buildProfileMeta, buildSongMeta, clip, createTtlCache, escapeHtml, injectMeta, isValidId, matchOgRoute, renderMetaBlock, resolveMeta,
} from '../server/og.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ctx = { apiBase: 'https://api.melodya.test/api', origin: 'https://app.melodya.test' };

test('rutas con metadatos dinámicos: solo /songs/:id y /user/:id con ids válidos', () => {
  assert.deepEqual(matchOgRoute('/songs/abc123'), { type: 'song', id: 'abc123' });
  assert.deepEqual(matchOgRoute('/user/u_1-2/'), { type: 'profile', id: 'u_1-2' });
  for (const bad of ['/songs', '/songs/', '/songs/a/b', '/community', '/songs/..%2Fadmin', '/songs/a%00b', '/user/<script>', '/songs/%E0%A4%A']) {
    assert.equal(matchOgRoute(bad), null, bad);
  }
  assert.equal(isValidId('x'.repeat(65)), false);
});

test('el contenido de usuarios se escapa (no se puede inyectar HTML en <head>)', () => {
  assert.equal(escapeHtml(`"><script>alert(1)</script>&'`), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;');
  const meta = buildSongMeta({ id: 's1', title: '"><script>x</script>', author: { name: '<b>Ana</b>' }, description: 'a\nb', coverUrl: '/api/files/c/stream' }, ctx);
  const html = injectMeta(indexHtml, meta, {});
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(!html.includes('<b>Ana</b>'));
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test('canción: título, creador, portada real absoluta e identidad de Melodya en el HTML inicial', () => {
  const meta = buildSongMeta({ id: 's1', title: 'Mi canción', author: { name: 'Ana' }, coverUrl: '/api/files/cov1/stream', genre: 'Pop' }, ctx);
  const html = injectMeta(indexHtml, meta, {});
  assert.match(html, /<title>Mi canción — Ana · Melodya<\/title>/);
  assert.match(html, /<meta property="og:title" content="Mi canción — Ana" \/>/);
  assert.match(html, /<meta property="og:site_name" content="Melodya" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.melodya\.test\/api\/files\/cov1\/stream" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/app\.melodya\.test\/songs\/s1" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/app\.melodya\.test\/songs\/s1" \/>/);
  assert.equal((html.match(/property="og:title"/g) ?? []).length, 1, 'el bloque genérico se reemplaza, no se duplica');
  assert.match(html, /<div id="root"><\/div>/, 'el resto del documento no cambia');
});

test('perfil: avatar, nombre y descripción pública', () => {
  const meta = buildProfileMeta({ id: 'u1', name: 'Ana', bio: 'Hago   música\nde prueba', avatarUrl: '/api/files/av/stream' }, ctx);
  const html = injectMeta(indexHtml, meta, {});
  assert.match(html, /<title>Ana · Melodya<\/title>/);
  assert.match(html, /<meta property="og:description" content="Hago música de prueba" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.melodya\.test\/api\/files\/av\/stream" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/app\.melodya\.test\/user\/u1" \/>/);
  assert.match(html, /<meta property="og:type" content="profile" \/>/);
});

test('sin imagen propia se usa la identidad de Melodya (nunca un og:image vacío)', () => {
  const meta = buildSongMeta({ id: 's1', title: 'Sin portada', author: { name: 'Ana' }, coverUrl: null }, ctx);
  const block = renderMetaBlock(meta, { fallbackImage: 'https://app.melodya.test/icon-512.png' });
  assert.match(block, /og:image" content="https:\/\/app\.melodya\.test\/icon-512\.png"/);
  assert.ok(!renderMetaBlock(meta, {}).includes('og:image"'));
});

test('utilidades: clip y URLs absolutas', () => {
  assert.equal(clip('  a   b  ', 10), 'a b');
  assert.equal(clip('x'.repeat(20), 10).length, 10);
  assert.equal(absoluteFileUrl('/api/files/1/stream', 'http://localhost:4000/api'), 'http://localhost:4000/api/files/1/stream');
  assert.equal(absoluteFileUrl('https://cdn.x/y.png', 'http://localhost:4000/api'), 'https://cdn.x/y.png');
  assert.equal(absoluteFileUrl(null, 'http://x/api'), null);
});

test('resolveMeta: consulta el backend público, cachea y degrada a null sin lanzar', async () => {
  let calls = 0;
  const fetchOk = async (url) => {
    calls++;
    assert.equal(url, 'https://api.melodya.test/api/community/songs/s1', 'solo GET público, id validado');
    return { ok: true, status: 200, json: async () => ({ data: { id: 's1', title: 'T', author: { name: 'A' } } }) };
  };
  const cache = createTtlCache();
  const route = { type: 'song', id: 's1' };
  const a = await resolveMeta(route, { ...ctx, fetchImpl: fetchOk, cache });
  const b = await resolveMeta(route, { ...ctx, fetchImpl: fetchOk, cache });
  assert.equal(a.ogTitle, 'T — A');
  assert.equal(calls, 1, 'la segunda consulta sale de la caché');

  const notFound = await resolveMeta({ type: 'song', id: 'zz' }, { ...ctx, fetchImpl: async () => ({ ok: false, status: 404 }), cache: createTtlCache() });
  assert.equal(notFound, null);
  const down = await resolveMeta({ type: 'profile', id: 'u1' }, { ...ctx, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, cache: createTtlCache() });
  assert.equal(down, null);
});

test('la caché respeta TTL y tope', () => {
  const c = createTtlCache({ max: 2 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.get('a'), undefined, 'se expulsa el más viejo');
  assert.equal(c.get('c'), 3);
  c.set('x', 1, -1);
  assert.equal(c.get('x'), undefined, 'expirada');
});

test('enlaces compartibles: contrato /songs/:id y /user/:id, sin # y sin dominio fijo', async () => {
  process.env.VITE_PUBLIC_ORIGIN = 'https://app.melodya.test/';
  const links = await import('../src/lib/links.ts');
  assert.equal(links.songUrl('abc'), 'https://app.melodya.test/songs/abc');
  assert.equal(links.userUrl('u 1'), 'https://app.melodya.test/user/u%201');
  assert.equal(links.radioUrl('newest', 'rock & roll'), 'https://app.melodya.test/community?radio=newest&genre=rock%20%26%20roll');
  const srcDir = path.join(root, 'src');
  const offenders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        // Se ignoran comentarios: solo importa el código ejecutable.
        const s = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/app\.melodya\.com\.ar/.test(s)) offenders.push(`${p}: dominio de producción incrustado`);
        if (/location\.hash|HashChangeEvent|hashchange/.test(s) && !p.endsWith('links.ts')) offenders.push(`${p}: usa hash`);
        if (/from ['"](next|next-auth|next-intl|next-themes)([/'"])/.test(s)) offenders.push(`${p}: importa Next`);
      }
    }
  })(srcDir);
  assert.deepEqual(offenders, []);
});

test('recuperación de contraseña: formatos de token aceptados', async () => {
  const links = await import('../src/lib/links.ts');
  assert.equal(links.extractResetToken(new URLSearchParams(''), '#token=abc_DEF-1'), 'abc_DEF-1');
  assert.equal(links.extractResetToken(new URLSearchParams('token=q1'), ''), 'q1');
  assert.equal(links.extractResetToken(new URLSearchParams(''), ''), '');
  assert.equal(links.extractResetToken(new URLSearchParams(''), '#/otra-cosa'), '');
});

test('el proyecto no depende de Next.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const bad = Object.keys(all).filter((n) => n === 'next' || /^next-/.test(n) || n === 'eslint-config-next');
  assert.deepEqual(bad, []);
  assert.ok(all['react-router-dom'] && all.vite && all.react.startsWith('^19'));
});
