// Decisión y descarga autenticada del audio (src/stores/player-source.ts): módulo puro, sin DOM.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';

import { usesAuthenticatedSource, createAuthSource, fetchAudioBlob, audioErrorMessage, AudioSourceError } from '../src/stores/player-source.ts';

const url = 'http://localhost:4000/api/files/f1/stream';

test('decisión: solo una pista con isPublic === false y sesión se descarga con Authorization', () => {
  assert.equal(usesAuthenticatedSource({ audioUrl: url, isPublic: false }, true), true);
  assert.equal(usesAuthenticatedSource({ audioUrl: url, isPublic: true }, true), false, 'pública: URL directa');
  assert.equal(usesAuthenticatedSource({ audioUrl: url }, true), false, 'visibilidad desconocida: comportamiento actual');
  assert.equal(usesAuthenticatedSource({ audioUrl: url, isPublic: false }, false), false, 'sin sesión: comportamiento actual');
  assert.equal(usesAuthenticatedSource({ audioUrl: 'blob:http://x/1', isPublic: false }, true), false, 'un blob ya es local');
  assert.equal(usesAuthenticatedSource({ audioUrl: 'data:audio/wav;base64,AAAA', isPublic: false }, true), false);
  assert.equal(usesAuthenticatedSource({ audioUrl: '', isPublic: false }, true), false);
  assert.equal(usesAuthenticatedSource(null, true), false);
});

function fakeDeps() {
  const created = [];
  const revoked = [];
  const pending = [];
  return {
    created,
    revoked,
    pending,
    deps: {
      fetchBlob: (u, signal) => new Promise((resolve, reject) => {
        const entry = { url: u, signal, resolve: (b = new Blob([u])) => resolve(b), reject };
        signal.addEventListener('abort', () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' })));
        pending.push(entry);
      }),
      createObjectURL: () => { const id = `blob:test/${created.length + 1}`; created.push(id); return id; },
      revokeObjectURL: (u) => revoked.push(u),
    },
  };
}

test('load: descarga, crea UNA URL blob y la expone como vigente', async () => {
  const f = fakeDeps();
  const source = createAuthSource(f.deps);
  const p = source.load(url);
  f.pending[0].resolve();
  assert.deepEqual(await p, { status: 'ready', url: 'blob:test/1' });
  assert.equal(source.blobUrl, 'blob:test/1');
  assert.deepEqual(f.revoked, []);
});

test('cargar otra pista revoca el blob anterior; reset revoca el vigente y no deja nada', async () => {
  const f = fakeDeps();
  const source = createAuthSource(f.deps);
  let p = source.load('a'); f.pending[0].resolve(); await p;
  p = source.load('b'); f.pending[1].resolve(); await p;
  assert.deepEqual(f.revoked, ['blob:test/1']);
  source.reset();
  assert.deepEqual(f.revoked, ['blob:test/1', 'blob:test/2']);
  assert.equal(source.blobUrl, null);
});

test('una respuesta vieja (se pidió otra pista) se descarta SIN crear blob y su solicitud se aborta', async () => {
  const f = fakeDeps();
  const source = createAuthSource(f.deps);
  const first = source.load('vieja');
  const second = source.load('nueva');
  assert.equal(f.pending[0].signal.aborted, true, 'la descarga anterior se aborta');
  f.pending[1].resolve();
  assert.deepEqual(await second, { status: 'ready', url: 'blob:test/1' });
  f.pending[0].resolve(); // llega tarde (si no se hubiese abortado)
  assert.deepEqual(await first, { status: 'stale' });
  assert.deepEqual(f.created, ['blob:test/1'], 'la respuesta vieja no creó ninguna URL blob');
  assert.equal(source.blobUrl, 'blob:test/1');
});

test('cancel y reset invalidan la descarga pendiente: stale, sin blob', async () => {
  const f = fakeDeps();
  const source = createAuthSource(f.deps);
  const p = source.load('x');
  source.reset();
  f.pending[0].resolve();
  assert.deepEqual(await p, { status: 'stale' });
  assert.deepEqual(f.created, []);
  assert.equal(f.pending[0].signal.aborted, true);
});

test('un error real de la descarga se propaga (no se oculta) y no deja blob', async () => {
  const f = fakeDeps();
  const source = createAuthSource(f.deps);
  const p = source.load('x');
  f.pending[0].reject(new AudioSourceError(403, 'stream 403'));
  await assert.rejects(p, (e) => e instanceof AudioSourceError && e.status === 403);
  assert.equal(source.blobUrl, null);
  assert.deepEqual(f.created, []);
});

test('fetchAudioBlob: envía Authorization, y un error HTTP rechaza con AudioSourceError(status)', async () => {
  const seen = [];
  const ok = async (u, init) => { seen.push({ u, init }); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  const blob = await fetchAudioBlob(url, 'tok', new AbortController().signal, ok);
  assert.equal(blob.size, 3);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
  assert.ok(seen[0].init.signal);

  const denied = async () => new Response('x', { status: 403 });
  await assert.rejects(fetchAudioBlob(url, 'tok', new AbortController().signal, denied), (e) => e.status === 403);
  const noToken = async (u, init) => { seen.push({ u, init }); return new Response('x', { status: 401 }); };
  await assert.rejects(fetchAudioBlob(url, null, new AbortController().signal, noToken), (e) => e.status === 401);
  assert.equal('Authorization' in seen.at(-1).init.headers, false);
});

test('mensajes: los errores de autenticación y permiso se distinguen del fallo genérico', () => {
  assert.match(audioErrorMessage(new AudioSourceError(401, 'x')), /sesión expiró/);
  assert.match(audioErrorMessage(new AudioSourceError(403, 'x')), /permiso/);
  assert.match(audioErrorMessage(new AudioSourceError(404, 'x')), /No encontramos/);
  assert.match(audioErrorMessage(new AudioSourceError(500, 'x')), /No pudimos cargar el audio/);
  assert.match(audioErrorMessage(new Error('red')), /No pudimos cargar el audio/);
});

test('isLoading: informa la descarga en curso de esa URL (para no duplicarla al remontar) y se limpia al terminar o cancelar', async () => {
  const f = fakeDeps();
  const source = createAuthSource(f.deps);
  assert.equal(source.isLoading('a'), false);
  const p = source.load('a');
  assert.equal(source.isLoading('a'), true);
  assert.equal(source.isLoading('b'), false);
  f.pending[0].resolve();
  await p;
  assert.equal(source.isLoading('a'), false);
  const q = source.load('b');
  assert.equal(source.isLoading('b'), true);
  source.cancel();
  assert.equal(source.isLoading('b'), false);
  f.pending[1].resolve();
  await q;
});
