// Imágenes autenticadas (src/lib/auth-image.ts REAL, con dobles de sesión y de cliente HTTP): un 429 de archivos pausa SOLO el alcance «files»,
// no marca la imagen como denegada, no se insiste durante la pausa y se recupera al terminar; no frena la API general ni el refresh.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_helpers/auth-image-loader.mjs', import.meta.url);

const memory = new Map();
globalThis.window = { location: { origin: 'http://localhost:3000' } };
globalThis.sessionStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, String(v)), removeItem: (k) => void memory.delete(k) };

const { authState } = await import('./_helpers/stubs/auth.mjs');
const { authImageObjectUrl, clearAuthImageCache } = await import('../src/lib/auth-image.ts');
const { noteRateLimit, rateLimitRemainingMs, resetRateLimitGate } = await import('../src/lib/api/resilience.ts');

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
let calls;
/** respuestas por URL: { status, headers?, body? }; sin entrada → 200 con una imagen. */
let responses;
let seq = 0;

test.beforeEach(() => {
  memory.clear();
  calls = [];
  responses = {};
  authState.accessToken = 'tok-1';
  resetRateLimitGate();
  clearAuthImageCache();
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization });
    const r = responses[url] ?? { status: 200 };
    return new Response(r.status === 200 ? new Blob(['png-bytes'], { type: 'image/png' }) : 'x', { status: r.status, headers: r.headers ?? {} });
  };
  URL.createObjectURL = () => `blob:test/${++seq}`;
  URL.revokeObjectURL = () => {};
});
test.afterEach(() => { globalThis.fetch = realFetch; URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });

const IMG = (n) => `http://localhost:4000/api/files/${n}/stream`;

test('descarga autenticada: UNA solicitud con Bearer y object URL cacheado', async () => {
  const a = await authImageObjectUrl(IMG('a'));
  assert.match(a, /^blob:/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, 'Bearer tok-1');
  assert.equal(await authImageObjectUrl(IMG('a')), a, 'la segunda vez sale de la caché');
  assert.equal(calls.length, 1);
});

test('429 en una imagen: sin objeto, SIN marcarla denegada, pausa del alcance «files» (Retry-After) y sin tocar la API ni el refresh', async () => {
  responses[IMG('a')] = { status: 429, headers: { 'retry-after': '20' } };
  assert.equal(await authImageObjectUrl(IMG('a')), null);
  const left = rateLimitRemainingMs('files');
  assert.ok(left > 19_000 && left <= 20_000, `pausa de archivos ≈ Retry-After (${left})`);
  assert.equal(rateLimitRemainingMs('api'), 0, 'un 429 de imágenes NO bloquea las consultas normales');
  assert.equal(rateLimitRemainingMs('refresh'), 0, 'ni el refresh');
});

test('429 sin Retry-After legible: pausa por defecto de 30 s en «files»', async () => {
  responses[IMG('a')] = { status: 429 };
  await authImageObjectUrl(IMG('a'));
  assert.ok(rateLimitRemainingMs('files') > 29_000);
  assert.equal(rateLimitRemainingMs('api'), 0);
});

test('durante la pausa NO se piden más imágenes (ni la misma ni otras): sin reintentos agresivos', async () => {
  responses[IMG('a')] = { status: 429, headers: { 'retry-after': '30' } };
  await authImageObjectUrl(IMG('a'));
  assert.equal(calls.length, 1);
  assert.equal(await authImageObjectUrl(IMG('a')), null);
  assert.equal(await authImageObjectUrl(IMG('b')), null);
  assert.equal(await authImageObjectUrl(IMG('c')), null);
  assert.equal(calls.length, 1, 'ninguna solicitud más mientras dura la pausa');
});

test('las imágenes se RECUPERAN al terminar la pausa: la imagen no quedó marcada como denegada', async () => {
  responses[IMG('a')] = { status: 429, headers: { 'retry-after': '30' } };
  await authImageObjectUrl(IMG('a'));
  resetRateLimitGate(); // fin de la pausa
  delete responses[IMG('a')];
  const obj = await authImageObjectUrl(IMG('a'));
  assert.match(obj, /^blob:/, 'ahora sí se descarga');
  assert.equal(calls.length, 2);
});

test('401 / 403 / 404 SÍ se recuerdan como denegadas (no se vuelve a pedir en cada montaje); el 429 no', async () => {
  for (const status of [401, 403, 404]) {
    calls = [];
    clearAuthImageCache();
    responses[IMG('d')] = { status };
    assert.equal(await authImageObjectUrl(IMG('d')), null);
    assert.equal(await authImageObjectUrl(IMG('d')), null);
    assert.equal(calls.length, 1, `${status}: una sola solicitud`);
  }
});

test('una pausa de la API general o del refresh NO frena las imágenes (alcances independientes)', async () => {
  noteRateLimit(60_000, 'api');
  noteRateLimit(60_000, 'refresh');
  assert.match(await authImageObjectUrl(IMG('a')), /^blob:/);
  assert.equal(calls.length, 1);
});

test('un error de red no activa ninguna pausa (no es un rate limit)', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await authImageObjectUrl(IMG('a')), null);
  assert.equal(rateLimitRemainingMs('files') + rateLimitRemainingMs('api') + rateLimitRemainingMs('refresh'), 0);
});

test('seguridad: siempre se manda el token de la sesión vigente y no hay credenciales cacheadas', async () => {
  await authImageObjectUrl(IMG('a'));
  authState.accessToken = 'tok-2';
  clearAuthImageCache();
  await authImageObjectUrl(IMG('a'));
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer tok-1', 'Bearer tok-2']);
});
