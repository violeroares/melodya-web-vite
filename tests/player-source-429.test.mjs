// Fuente de audio autenticada (src/stores/player-source.ts, módulo puro): errores con su motivo, 429 con Retry-After, red y sondeo de 1 byte.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSourceError, audioErrorMessage, fetchAudioBlob, isTransientAudioError, probeAudioAccess } from '../src/stores/player-source.ts';

const res = (status, headers = {}, body = 'x') => async () => new Response(status === 204 ? null : body, { status, headers });
const network = async () => { throw new TypeError('fetch failed'); };
const signal = new AbortController().signal;

test('audioErrorMessage: cada motivo tiene su mensaje (429 y red no se confunden con permisos)', () => {
  assert.match(audioErrorMessage(new AudioSourceError(401, 'x')), /sesión expiró/);
  assert.match(audioErrorMessage(new AudioSourceError(403, 'x')), /No tenés permiso/);
  assert.match(audioErrorMessage(new AudioSourceError(404, 'x')), /No encontramos el audio/);
  assert.match(audioErrorMessage(new AudioSourceError(429, 'x')), /muchas solicitudes de audio/);
  assert.match(audioErrorMessage(new AudioSourceError(0, 'x')), /No pudimos conectar/);
  assert.match(audioErrorMessage(new AudioSourceError(500, 'x')), /No pudimos cargar el audio/);
  assert.match(audioErrorMessage(new Error('otro')), /No pudimos cargar el audio/);
});

test('isTransientAudioError: red, 429 y 5xx permiten otro intento; permisos y 404, no', () => {
  for (const s of [0, 429, 500, 503]) assert.equal(isTransientAudioError(new AudioSourceError(s, 'x')), true, String(s));
  for (const s of [401, 403, 404]) assert.equal(isTransientAudioError(new AudioSourceError(s, 'x')), false, String(s));
});

test('fetchAudioBlob: un 429 rechaza con AudioSourceError(429) y su Retry-After; sin cabecera legible no hay retryAfterMs', async () => {
  const e1 = await fetchAudioBlob('u', 't', signal, res(429, { 'Retry-After': '25' })).catch((e) => e);
  assert.ok(e1 instanceof AudioSourceError);
  assert.equal(e1.status, 429);
  assert.equal(e1.retryAfterMs, 25_000);
  assert.equal((await fetchAudioBlob('u', 't', signal, res(429, { 'Retry-After': 'mañana' })).catch((e) => e)).retryAfterMs, undefined);
  assert.equal((await fetchAudioBlob('u', 't', signal, res(429)).catch((e) => e)).retryAfterMs, undefined);
  assert.equal((await fetchAudioBlob('u', 't', signal, res(429, { 'Retry-After': '999999' })).catch((e) => e)).retryAfterMs, 15 * 60_000, 'acotado a 15 min');
  assert.equal((await fetchAudioBlob('u', 't', signal, res(403, { 'Retry-After': '9' })).catch((e) => e)).retryAfterMs, undefined, 'solo el 429 lleva espera');
});

test('fetchAudioBlob: la red caída es AudioSourceError(0); un AbortError se propaga tal cual; el éxito devuelve el blob', async () => {
  const e = await fetchAudioBlob('u', 't', signal, network).catch((x) => x);
  assert.ok(e instanceof AudioSourceError);
  assert.equal(e.status, 0);
  const abort = async () => { throw Object.assign(new Error('abortado'), { name: 'AbortError' }); };
  assert.equal((await fetchAudioBlob('u', 't', signal, abort).catch((x) => x)).name, 'AbortError');
  assert.equal(await (await fetchAudioBlob('u', null, signal, res(200, {}, 'wav'))).text(), 'wav');
});

test('probeAudioAccess: pide UN byte con Range y Authorization; 200/206 es accesible; el resto se distingue; nunca lee el cuerpo', async () => {
  let seen;
  const spy = (status, headers) => async (url, init) => { seen = { url, init }; return new Response('x', { status, headers }); };
  assert.deepEqual(await probeAudioAccess('http://x/api/files/a/stream', 'tok', signal, spy(206)), { ok: true });
  assert.equal(seen.init.headers.Range, 'bytes=0-0');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(await probeAudioAccess('u', 'tok', signal, spy(200)), { ok: true });
  const rate = await probeAudioAccess('u', 'tok', signal, spy(429, { 'Retry-After': '12' }));
  assert.equal(rate.ok, false);
  assert.equal(rate.error.status, 429);
  assert.equal(rate.error.retryAfterMs, 12_000);
  for (const status of [401, 403, 404, 500]) assert.equal((await probeAudioAccess('u', 'tok', signal, spy(status))).error.status, status);
  const down = await probeAudioAccess('u', 'tok', signal, network);
  assert.equal(down.ok, false);
  assert.equal(down.error.status, 0);
  const anon = await probeAudioAccess('u', null, signal, spy(206));
  assert.equal(anon.ok, true);
  assert.equal(seen.init.headers.Authorization, undefined, 'sin sesión no se manda Authorization');
});
