// src/stores/player.ts REAL (con dobles de sesión/cliente/audio-viz, ver tests/_helpers) y un <audio> falso: una pista PRIVADA con
// sesión nunca emite una solicitud anónima; pública o de visibilidad desconocida conservan la URL directa.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./_helpers/player-loader.mjs', import.meta.url);

const memory = new Map();
globalThis.window = { location: { origin: 'http://localhost:3000' } };
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
};

const { authState } = await import('./_helpers/stubs/auth.mjs');
const { resetRateLimitGate, noteRateLimit, rateLimitRemainingMs } = await import('../src/lib/api/resilience.ts');

// ── dobles ──
class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.srcLog = [];
    this._src = '';
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.preload = '';
    this.crossOrigin = null;
    this.playCalls = 0;
    this.currentSrc = ''; // recurso que el elemento tiene realmente conectado (HTML: sobrevive a removeAttribute('src'))
    this.ops = []; // pause / removeAttribute / load, en orden
    this.playedLog = []; // currentSrc en cada play(): permite comprobar que nunca suena una fuente anterior
    this.loadCalls = 0;
  }
  // Asignar src ejecuta el algoritmo de carga: el elemento pasa a la fuente nueva.
  set src(v) { this._src = v; this.currentSrc = v; this.srcLog.push(v); }
  get src() { return this._src; }
  getAttribute(name) { return name === 'src' && this._src ? this._src : null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  // HTML: quitar el atributo NO reinicia el elemento ni cambia currentSrc.
  removeAttribute(name) { if (name === 'src') { this._src = ''; this.srcLog.push(null); this.ops.push('removeAttribute'); } }
  // load() vuelve a ejecutar la selección de recurso: sin src queda vacío.
  load() { this.loadCalls += 1; this.currentSrc = this._src; this.ops.push('load'); }
  async play() { this.playCalls += 1; this.paused = false; this.playedLog.push(this.currentSrc); }
  pause() { this.paused = true; this.ops.push('pause'); }
}

let fetchCalls;
let blobsCreated;
let blobsRevoked;
const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

/** fetch controlado: cada solicitud queda pendiente hasta que la prueba la resuelva (o responde enseguida si hay `auto`). */
let auto = null; // (url) => { status, body } | undefined
function installDoubles() {
  fetchCalls = [];
  blobsCreated = [];
  blobsRevoked = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const call = {
      url: String(url),
      headers: init.headers ?? {},
      signal: init.signal,
      respond: (status = 200, body = 'audio', headers = {}) => resolve(new Response(status === 204 || status === 304 ? null : body, { status, headers })),
      fail: reject,
    };
    fetchCalls.push(call);
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' })));
    const immediate = auto?.(call.url, init);
    if (immediate === 'network') call.fail(new TypeError('fetch failed'));
    else if (immediate) call.respond(immediate.status, immediate.body, immediate.headers);
  });
  URL.createObjectURL = (blob) => { const u = realCreate.call(URL, blob); blobsCreated.push(u); return u; };
  URL.revokeObjectURL = (u) => { blobsRevoked.push(u); realRevoke.call(URL, u); };
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 6; i += 1) await tick(); }

const track = (id, extra = {}) => ({ id, title: `Tema ${id}`, artist: 'Vos', coverUrl: null, audioUrl: `http://localhost:4000/api/files/${id}/stream`, ...extra });
const authHeader = (call) => call.headers.Authorization;

let n = 0;
/** Instancia nueva del store (módulo con query distinta) con un <audio> falso ya montado. */
async function freshStore({ session } = {}) {
  memory.clear();
  if (session) memory.set('melodya.player.session', JSON.stringify({ ...session, savedAt: new Date().toISOString() }));
  n += 1;
  const mod = await import(`../src/stores/player.ts?case=${n}`);
  const el = new FakeAudio();
  return { store: mod.usePlayerStore, el, mod };
}

test.beforeEach(() => { authState.accessToken = 'tok-123'; auto = null; resetRateLimitGate(); installDoubles(); });
test.afterEach(() => { globalThis.fetch = realFetch; URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });

// ───────────────────────── play() ─────────────────────────

test('PRIVADA con sesión: play() no asigna la URL directa ni emite ninguna solicitud sin Authorization; reproduce el blob', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 200, body: 'wav' });
  const t = track('f1', { isPublic: false });

  store.getState().play(t);
  await settle();

  assert.equal(fetchCalls.length, 1);
  assert.equal(authHeader(fetchCalls[0]), 'Bearer tok-123', 'toda solicitud de audio lleva Authorization');
  assert.ok(el.srcLog.every((s) => s !== t.audioUrl), 'nunca se asignó la URL directa al <audio>');
  assert.match(el.src, /^blob:/);
  assert.equal(el.playCalls, 1);
  assert.equal(store.getState().isPlaying, true);
  assert.equal(store.getState().playbackError, null);
});

test('PÚBLICA: reproducción directa por URL, sin descarga', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const t = track('f2', { isPublic: true });
  store.getState().play(t);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl]);
  assert.equal(fetchCalls.length, 0);
  assert.equal(el.playCalls, 1);
});

test('visibilidad DESCONOCIDA (isPublic undefined): URL directa como hasta ahora; el reintento autenticado sigue disponible', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 200, body: 'wav' });
  const t = track('f3');
  store.getState().play(t);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl]);
  assert.equal(fetchCalls.length, 0);

  // el stream directo falló (p. ej. era privada): el fallback existente descarga con Authorization, una sola vez
  // (antes se sondea con 1 byte para saber POR QUÉ falló; recién entonces la descarga completa)
  await store.getState().retryWithAuth();
  await store.getState().retryWithAuth();
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].headers.Range, 'bytes=0-0');
  assert.equal(authHeader(fetchCalls[0]), 'Bearer tok-123');
  assert.equal(fetchCalls[1].headers.Range, undefined);
  assert.equal(authHeader(fetchCalls[1]), 'Bearer tok-123');
  assert.match(el.src, /^blob:/);
});

test('PRIVADA sin sesión: se conserva el comportamiento actual (URL directa)', async () => {
  authState.accessToken = null;
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const t = track('f4', { isPublic: false });
  store.getState().play(t);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl]);
  assert.equal(fetchCalls.length, 0);
});

// ───────────────────────── restauración y remontaje ─────────────────────────

test('RESTAURACIÓN de una pista privada tras recargar: descarga autenticada, sin solicitud anónima, en pausa y en la posición guardada', async () => {
  const t = track('f5', { isPublic: false });
  auto = () => ({ status: 200, body: 'wav' });
  const { store, el } = await freshStore({ session: { track: t, queue: [t], position: 42, duration: 200 } });
  store.getState().setAudio(el);
  await settle();

  assert.equal(fetchCalls.length, 1);
  assert.equal(authHeader(fetchCalls[0]), 'Bearer tok-123');
  assert.ok(el.srcLog.every((s) => s !== t.audioUrl), 'no se asignó la URL directa');
  assert.match(el.src, /^blob:/);
  assert.equal(el.playCalls, 0, 'la restauración nunca reproduce sola');
  assert.equal(store.getState().track.id, 'f5');
  assert.equal(store.getState().isPlaying, false);
  // la posición guardada se aplica cuando hay metadata
  el.duration = 200;
  el.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(el.currentTime, 42);
});

test('RESTAURACIÓN de una pista pública: URL directa (sin descarga)', async () => {
  const t = track('f6', { isPublic: true });
  const { store, el } = await freshStore({ session: { track: t, queue: [t], position: 10, duration: 100 } });
  store.getState().setAudio(el);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl]);
  assert.equal(fetchCalls.length, 0);
});

test('REMONTAJE con la pista privada ya descargada: reutiliza el blob vigente, sin ninguna solicitud nueva', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().play(track('f7', { isPublic: false }));
  await settle();
  const blob = el.src;
  assert.equal(fetchCalls.length, 1);

  const remounted = new FakeAudio();
  store.getState().setAudio(remounted);
  await settle();
  assert.equal(remounted.src, blob);
  assert.equal(fetchCalls.length, 1, 'ni anónima ni autenticada: se reutiliza el blob');
  assert.ok(remounted.srcLog.every((s) => !String(s).includes('/api/files/')), 'ningún intento con la URL directa');
});

test('REMONTAJE con la descarga todavía pendiente: el audio nuevo recibe el blob cuando llega; el viejo no', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('f8', { isPublic: false }));
  await settle();
  assert.equal(fetchCalls.length, 1);

  const remounted = new FakeAudio();
  store.getState().setAudio(remounted);
  fetchCalls[0].respond(200, 'wav');
  await settle();

  assert.match(remounted.src, /^blob:/);
  assert.ok(!/^blob:/.test(el.src), 'el elemento anterior no recibe el blob');
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls.every((c) => authHeader(c)), 'ninguna solicitud anónima');
});

test('REMONTAJE de una pista privada sin blob (sesión restaurada que aún no descargó): descarga autenticada, no anónima', async () => {
  const t = track('f9', { isPublic: false });
  authState.accessToken = null; // la restauración ocurre sin sesión: URL directa, como hoy
  const { store, el } = await freshStore({ session: { track: t, queue: [t], position: 0, duration: 100 } });
  store.getState().setAudio(el);
  await settle();
  authState.accessToken = 'tok-123'; // luego inicia sesión
  const remounted = new FakeAudio();
  auto = () => ({ status: 200, body: 'wav' });
  // sin blob vigente y con sesión, el remontaje no vuelve a pedir la URL directa
  store.getState().setAudio(remounted);
  await settle();
  assert.ok(remounted.srcLog.every((s) => s !== t.audioUrl));
  assert.equal(authHeader(fetchCalls[0]), 'Bearer tok-123');
});

// ───────────────────────── cambios de pista y limpieza ─────────────────────────

test('cambiar de pista: la respuesta vieja no reemplaza al audio nuevo, no crea blob y su solicitud se aborta', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const a = track('a', { isPublic: false });
  const b = track('b', { isPublic: false });
  store.getState().play(a);
  await settle();
  store.getState().play(b);
  await settle();
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].signal.aborted, true, 'la descarga de A se abortó');

  fetchCalls[1].respond(200, 'audio-b');
  await settle();
  const srcB = el.src;
  assert.match(srcB, /^blob:/);

  fetchCalls[0].respond(200, 'audio-a'); // llega tarde
  await settle();
  assert.equal(el.src, srcB, 'el audio de B sigue siendo el vigente');
  assert.equal(blobsCreated.length, 1, 'solo se creó el blob de B');
  assert.equal(store.getState().track.id, 'b');
});

test('privada → pública con la descarga pendiente: se reproduce la pública y la respuesta tardía se descarta', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const priv = track('p', { isPublic: false });
  const pub = track('q', { isPublic: true });
  store.getState().play(priv);
  await settle();
  store.getState().play(pub);
  await settle();
  assert.equal(el.src, pub.audioUrl);
  fetchCalls[0].respond(200, 'tarde');
  await settle();
  assert.equal(el.src, pub.audioUrl);
  assert.equal(blobsCreated.length, 0);
});

test('limpieza: cambiar de pista, stop() y hardReset() revocan el blob vigente y abortan lo pendiente', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 200, body: 'wav' });

  store.getState().play(track('c1', { isPublic: false }));
  await settle();
  const first = el.src;
  store.getState().play(track('c2', { isPublic: false }));
  await settle();
  assert.deepEqual(blobsRevoked, [first], 'al cambiar de pista se revoca el blob anterior');

  const second = el.src;
  store.getState().stop();
  assert.deepEqual(blobsRevoked, [first, second], 'stop() revoca el vigente');

  auto = null;
  store.getState().play(track('c3', { isPublic: false })); // queda pendiente
  await settle();
  const pending = fetchCalls.at(-1);
  store.getState().hardReset();
  assert.equal(pending.signal.aborted, true, 'hardReset() aborta la descarga pendiente');
  pending.respond(200, 'tarde');
  await settle();
  assert.equal(blobsCreated.length, 2, 'la respuesta tardía no creó un tercer blob');
  assert.equal(store.getState().track, null);
});

// ───────────────────────── errores ─────────────────────────

for (const [status, re] of [[401, /sesión expiró/], [403, /permiso/], [500, /No pudimos cargar el audio/]]) {
  test(`error ${status} en la descarga autenticada: se informa su motivo en playbackError (no se oculta ni se vuelve genérico) y no queda reproduciendo`, async () => {
    const { store, el } = await freshStore();
    store.getState().setAudio(el);
    auto = () => ({ status, body: 'x' });
    store.getState().play(track(`e${status}`, { isPublic: false }));
    await settle();
    assert.match(store.getState().playbackError, re);
    assert.equal(store.getState().isPlaying, false);
    assert.equal(el.playCalls, 0);
    assert.equal(blobsCreated.length, 0);
    // al reproducir otra pista el error anterior se limpia
    auto = () => ({ status: 200, body: 'ok' });
    store.getState().play(track('ok1', { isPublic: false }));
    await settle();
    assert.equal(store.getState().playbackError, null);
  });
}

// ───────────────────────── samples y voces (biblioteca) ─────────────────────────

/** Forma EXACTA de la pista que arman SamplesTab/VoicesTab al tocar play (audioUrl ya resuelta por apiFileUrl hacia el backend). */
const sampleTrack = (fileId, extra = {}) => ({
  id: `sample-${fileId}`,
  title: 'sample grande',
  artist: 'Sample',
  coverUrl: null,
  audioUrl: `http://localhost:4000/api/files/${fileId}/stream`,
  durationSec: 255,
  isPublic: false,
  ...extra,
});

test('SAMPLE/VOZ de la biblioteca (isPublic: false): ninguna solicitud anónima al /stream; la ÚNICA solicitud lleva Authorization y reproduce el blob', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 200, body: 'wav-grande' });
  const t = sampleTrack('30da2e47-1231-4914-a508-f1125f272667');

  store.getState().play(t);
  await settle();

  const streamCalls = fetchCalls.filter((c) => c.url === t.audioUrl);
  assert.equal(streamCalls.length, 1, 'una sola solicitud al /stream (no hay intento directo + reintento)');
  assert.equal(authHeader(streamCalls[0]), 'Bearer tok-123', 'esa solicitud lleva Authorization desde el primer intento');
  assert.ok(fetchCalls.every((c) => authHeader(c)), 'no hubo ninguna solicitud sin Authorization');
  assert.ok(el.srcLog.every((s) => s !== t.audioUrl), 'la URL del /stream nunca se asignó al <audio> (un <audio src> iría sin token → 403)');
  assert.match(el.src, /^blob:/);
  assert.equal(el.playCalls, 1);
  assert.equal(store.getState().playbackError, null);
});

test('SAMPLE/VOZ: sin el flag (comportamiento anterior) la URL iba directa al <audio> — este es el primer 403 que se eliminó', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const t = sampleTrack('f-anterior', { isPublic: undefined });
  store.getState().play(t);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl], 'sin isPublic:false el <audio> pedía la URL directa, sin Authorization');
  assert.equal(fetchCalls.length, 0);
});

test('SAMPLE/VOZ restaurado desde la sesión guardada (recarga con Ctrl+F5): tampoco hay solicitud anónima', async () => {
  const t = sampleTrack('f-sesion');
  const { store, el } = await freshStore({ session: { track: t, queue: [t], position: 0, duration: 255 } });
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().setAudio(el);
  await settle();
  assert.ok(el.srcLog.every((s) => s !== t.audioUrl), 'al restaurar no se asigna la URL directa');
  assert.ok(fetchCalls.every((c) => authHeader(c)), 'toda solicitud del restaurado lleva Authorization');
});

test('las pistas de samples y muestras de voz de la biblioteca declaran isPublic: false (SamplesTab ×1, VoicesTab ×1: las voces clonadas no se reproducen)', () => {
  const expected = { 'SamplesTab.tsx': 1, 'VoicesTab.tsx': 1 };
  for (const [file, count] of Object.entries(expected)) {
    const src = readFileSync(new URL(`../src/features/library/${file}`, import.meta.url), 'utf8');
    // Las pistas se arman en el prop `track` de <SamplePlayButton> (botón compartido que luego llama a getState().play).
    const blocks = [...src.matchAll(/track=\{\(\) => \(\{[\s\S]*?\n\s*\}\)\}/g)].map((m) => m[0]).filter((b) => b.includes('sample.fileUrl'));
    assert.equal(blocks.length, count, `${file}: pistas armadas con sample.fileUrl`);
    for (const b of blocks) assert.match(b, /isPublic:\s*false/, `${file}: falta isPublic: false`);
  }
});


// ═════════════ HTTP 429 y audio: sin descargas completas por un rate limit, errores distinguidos ═════════════

const rangeOf = (call) => call.headers.Range;
const isProbe = (call) => rangeOf(call) === 'bytes=0-0';

test('429 en la carga directa de una pista PÚBLICA: el sondeo (1 byte) lo detecta y NO se descarga el archivo completo como blob', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const t = track('r1', { isPublic: true });
  store.getState().play(t);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl], 'streaming directo (el navegador hace los Range)');

  auto = () => ({ status: 429, body: '{}', headers: { 'Retry-After': '25' } });
  await store.getState().retryWithAuth(); // el <audio> falló: onError
  assert.equal(fetchCalls.length, 1, 'una sola solicitud: el sondeo');
  assert.ok(isProbe(fetchCalls[0]));
  assert.equal(blobsCreated.length, 0, 'ningún blob / descarga completa');
  assert.ok(el.srcLog.every((s) => s === t.audioUrl || s === null), 'el audio no se reemplaza por un blob');
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);
  assert.equal(store.getState().isPlaying, false);
  const wait = rateLimitRemainingMs('files');
  assert.ok(wait > 20_000 && wait <= 25_000, `pausa del alcance de archivos (${wait} ms)`);
  assert.equal(rateLimitRemainingMs('api'), 0, 'la API general no se bloquea');
  assert.equal(rateLimitRemainingMs('refresh'), 0, 'ni el refresh');
});

test('durante la pausa de archivos no se hace NINGUNA solicitud de audio (ni sondeo ni descarga), pública o privada; al terminar la pausa se puede volver a intentar', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  noteRateLimit(30_000, 'files');
  const pub = track('r2', { isPublic: true });
  store.getState().play(pub);
  await settle();
  await store.getState().retryWithAuth();
  assert.equal(fetchCalls.length, 0);
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);

  // pista privada: su descarga autenticada tampoco sale durante la pausa
  const priv = track('r3', { isPublic: false });
  store.getState().play(priv);
  await settle();
  assert.equal(fetchCalls.length, 0);
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);

  // terminó la pausa: el usuario reproduce otra pista privada y su descarga autenticada funciona
  resetRateLimitGate();
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().play(track('r3b', { isPublic: false }));
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.match(el.src, /^blob:/);
});

test('un 429 en la descarga autenticada de una pista PRIVADA se informa como límite de solicitudes (no «sesión» ni genérico), registra la pausa y no reintenta', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 429, body: '{}', headers: { 'Retry-After': '12' } });
  store.getState().play(track('r4', { isPublic: false }));
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);
  assert.ok(rateLimitRemainingMs('files') > 10_000);
  await store.getState().retryWithAuth();
  assert.equal(fetchCalls.length, 1, 'sin reintentos automáticos');
});

test('el fallback autenticado se conserva cuando de verdad hace falta: el sondeo responde 206 ⇒ recién ahí se descarga el archivo con Authorization', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('r5'));
  await settle();
  auto = (_url, init) => (init?.headers?.Range === 'bytes=0-0' ? { status: 206, body: 'x' } : { status: 200, body: 'wav' });
  await store.getState().retryWithAuth();
  assert.equal(fetchCalls.length, 2);
  assert.ok(isProbe(fetchCalls[0]));
  assert.equal(rangeOf(fetchCalls[1]), undefined);
  assert.equal(authHeader(fetchCalls[1]), 'Bearer tok-123');
  assert.match(el.src, /^blob:/);
  assert.equal(store.getState().playbackError, null);
});

for (const [status, pattern, permanent] of [[401, /sesión expiró/, true], [403, /No tenés permiso/, true], [404, /No encontramos el audio/, true], [503, /No pudimos cargar el audio/, false]]) {
  test(`el sondeo distingue el motivo (${status}): mensaje propio, sin descarga completa${permanent ? ' y sin más intentos' : ' y permitiendo reintentar'}`, async () => {
    const { store, el } = await freshStore();
    store.getState().setAudio(el);
    store.getState().play(track(`r6-${status}`));
    await settle();
    auto = () => ({ status, body: '{}' });
    await store.getState().retryWithAuth();
    assert.equal(blobsCreated.length, 0);
    assert.match(store.getState().playbackError, pattern);
    assert.equal(rateLimitRemainingMs('files'), 0, 'solo un 429 activa la pausa');
    await store.getState().retryWithAuth();
    assert.equal(fetchCalls.length, permanent ? 1 : 2, permanent ? 'un fallo de permisos no se repite' : 'un fallo transitorio sí admite otro intento');
  });
}

test('red caída al sondear: mensaje de conexión (no de permisos), sin descarga completa, admite reintento', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('r7'));
  await settle();
  auto = () => 'network';
  await store.getState().retryWithAuth();
  assert.match(store.getState().playbackError, /No pudimos conectar/);
  assert.equal(blobsCreated.length, 0);
  await store.getState().retryWithAuth();
  assert.equal(fetchCalls.length, 2);
});

test('la pausa de la API general o del refresh NO frena el audio (alcances independientes)', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  noteRateLimit(120_000, 'api');
  noteRateLimit(120_000, 'refresh');
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().play(track('r8', { isPublic: false }));
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.match(el.src, /^blob:/);
  assert.equal(rateLimitRemainingMs('files'), 0);
});

test('la reproducción normal por streaming (200/206) no cambia: URL directa, ninguna solicitud propia, reproducción inmediata', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const t = track('r9', { isPublic: true });
  store.getState().play(t);
  await settle();
  assert.deepEqual(el.srcLog, [t.audioUrl]);
  assert.equal(fetchCalls.length, 0);
  assert.equal(el.playCalls, 1);
  assert.equal(store.getState().playbackError, null);
});

test('cambio de pista durante el sondeo: la respuesta tardía no pisa la pista nueva ni crea blobs', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('r10', { isPublic: true }));
  await settle();
  const retry = store.getState().retryWithAuth(); // sondeo pendiente
  await tick();
  store.getState().play(track('r11', { isPublic: true }));
  await settle();
  fetchCalls[0].respond(206, 'x');
  await retry;
  await settle();
  assert.equal(blobsCreated.length, 0);
  assert.equal(fetchCalls.length, 1, 'la respuesta del sondeo viejo no dispara la descarga');
  assert.equal(store.getState().track.id, 'r11');
});


// ═════════════ <audio> limpio y reintento de la misma pista privada (defecto previo: el elemento conservaba la pista anterior) ═════════════

const privateTrack = (id) => track(id, { isPublic: false });
const rateLimitedAuto = (retryAfter = '25') => () => ({ status: 429, body: '{}', headers: { 'Retry-After': retryAfter } });

test('pista PÚBLICA → PRIVADA con error de carga: el <audio> no conserva la fuente anterior ni reproduce audio equivocado', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const pub = track('a1', { isPublic: true });
  store.getState().play(pub);
  await settle();
  assert.equal(el.currentSrc, pub.audioUrl, 'sonando la pública (URL directa)');
  assert.equal(el.playedLog.length, 1);

  auto = rateLimitedAuto();
  store.getState().play(privateTrack('a2'));
  await settle();
  assert.equal(fetchCalls.length, 1, 'una sola solicitud: la descarga autenticada');
  assert.equal(el.getAttribute('src'), null, 'sin atributo src');
  assert.equal(el.currentSrc, '', 'currentSrc de la pista anterior NO sobrevive');
  assert.deepEqual(el.ops.slice(-3), ['pause', 'removeAttribute', 'load']);
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);
  assert.equal(store.getState().isPlaying, false);
  assert.equal(el.playedLog.length, 1, 'no volvió a sonar nada (ni la pista anterior)');
});

test('limpieza mediante load(): pause → removeAttribute → load, en ese orden, y el elemento queda vacío', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('b1', { isPublic: true }));
  await settle();
  const loadsBefore = el.loadCalls;
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().play(privateTrack('b2'));
  await settle();
  assert.ok(el.loadCalls > loadsBefore, 'se llamó a load() al pasar a la pista privada');
  const i = el.ops.indexOf('removeAttribute');
  assert.deepEqual(el.ops.slice(i - 1, i + 2), ['pause', 'removeAttribute', 'load']);
  assert.match(el.src, /^blob:/, 'y la pista privada se cargó con su blob');
  assert.equal(el.currentSrc, el.src);
});

test('segundo clic en la MISMA pista privada durante la pausa por 429: ninguna solicitud, mensaje de límite y no se llama a el.play()', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('c1', { isPublic: true }));
  await settle();
  const priv = privateTrack('c2');
  auto = rateLimitedAuto('30');
  store.getState().play(priv);
  await settle();
  assert.equal(fetchCalls.length, 1);
  const plays = el.playCalls;

  store.getState().play(priv); // 2.º clic, misma pista, durante la pausa
  await settle();
  assert.equal(fetchCalls.length, 1, 'ninguna solicitud adicional (ni sondeo ni descarga)');
  assert.equal(el.playCalls, plays, 'no se llamó a el.play(): no hay nada que reproducir');
  assert.equal(el.currentSrc, '', 'tampoco se reanuda la pista anterior');
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);
  assert.equal(store.getState().isPlaying, false);
  assert.ok(rateLimitRemainingMs('files') > 20_000);
  store.getState().play(priv);
  await settle();
  assert.equal(fetchCalls.length, 1, 'y tampoco con más clics');
});

test('terminada la pausa, el mismo clic reintenta: descarga autenticada, reproduce la pista CORRECTA y limpia el error', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const pub = track('d1', { isPublic: true });
  store.getState().play(pub);
  await settle();
  const priv = privateTrack('d2');
  auto = rateLimitedAuto('30');
  store.getState().play(priv);
  await settle();
  assert.equal(fetchCalls.length, 1);

  resetRateLimitGate(); // terminó la pausa
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().play(priv);
  await settle();
  assert.equal(fetchCalls.length, 2, 'ahora sí sale la descarga');
  assert.equal(authHeader(fetchCalls[1]), 'Bearer tok-123');
  assert.equal(rangeOf(fetchCalls[1]), undefined, 'descarga completa autenticada (sin Range)');
  assert.match(el.src, /^blob:/);
  assert.equal(el.currentSrc, el.src);
  assert.notEqual(el.playedLog[el.playedLog.length - 1], pub.audioUrl, 'la última reproducción NO es la pista anterior');
  assert.equal(el.playedLog[el.playedLog.length - 1], el.src);
  assert.equal(store.getState().playbackError, null);
  assert.equal(store.getState().isPlaying, true);
});

test('un clic repetido mientras la descarga autenticada sigue en curso NO duplica la solicitud', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const priv = privateTrack('e1');
  store.getState().play(priv); // la solicitud queda pendiente (sin auto)
  await settle();
  assert.equal(fetchCalls.length, 1);
  store.getState().play(priv);
  store.getState().play(priv);
  store.getState().toggle();
  await settle();
  assert.equal(fetchCalls.length, 1, 'no se lanza otra descarga ni se cancela la vigente');
  assert.ok(el.playedLog.every((s) => s === ''), 'el.play() pendiente sobre un elemento limpio: nunca suena una fuente anterior');
});

test('stop(): deja el <audio> vacío (load) y la pista anterior no puede volver a sonar', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const pub = track('f1', { isPublic: true });
  store.getState().play(pub);
  await settle();
  assert.equal(el.currentSrc, pub.audioUrl);
  store.getState().stop();
  assert.equal(el.getAttribute('src'), null);
  assert.equal(el.currentSrc, '', 'sin recurso conectado');
  assert.deepEqual(el.ops.slice(-3), ['pause', 'removeAttribute', 'load']);
  assert.equal(store.getState().track, null);
});

test('hardReset(): deja el <audio> vacío (load) igual que stop()', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const pub = track('g1', { isPublic: true });
  store.getState().play(pub);
  await settle();
  store.getState().hardReset();
  assert.equal(el.getAttribute('src'), null);
  assert.equal(el.currentSrc, '');
  assert.deepEqual(el.ops.slice(-3), ['pause', 'removeAttribute', 'load']);
});

test('reproducción normal: pública (URL directa) y privada (blob) siguen igual; pausa y reanudación de una pista YA cargada usan el.play() sin nuevas solicitudes', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const pub = track('h1', { isPublic: true });
  store.getState().play(pub);
  await settle();
  assert.deepEqual(el.srcLog, [pub.audioUrl]);
  assert.equal(fetchCalls.length, 0);
  store.getState().play(pub); // pausa
  await settle();
  assert.equal(store.getState().isPlaying, false);
  store.getState().play(pub); // reanuda con el.play()
  await settle();
  assert.equal(store.getState().isPlaying, true);
  assert.equal(fetchCalls.length, 0, 'la pública nunca pide por su cuenta');

  auto = () => ({ status: 200, body: 'wav' });
  const priv = privateTrack('h2');
  store.getState().play(priv);
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.match(el.src, /^blob:/);
  assert.equal(store.getState().isPlaying, true);
  const plays = el.playCalls;
  store.getState().play(priv); // pausa
  await settle();
  assert.equal(store.getState().isPlaying, false);
  store.getState().play(priv); // reanuda: el blob sigue conectado → el.play(), sin otra descarga
  await settle();
  assert.equal(fetchCalls.length, 1, 'la pista privada ya cargada NO vuelve a descargarse');
  assert.equal(el.playCalls, plays + 1);
  assert.equal(store.getState().isPlaying, true);
  assert.equal(el.getAttribute('src'), el.src);
});

// El botón de reproducir del reproductor, de las tarjetas y de MediaSession llama a toggle(): es el camino real del «segundo clic».

test('toggle() sobre una pista privada SIN fuente válida durante la pausa por 429: ninguna solicitud, mensaje de límite y sin el.play()', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  store.getState().play(track('t1', { isPublic: true }));
  await settle();
  auto = rateLimitedAuto('30');
  store.getState().play(privateTrack('t2'));
  await settle();
  assert.equal(fetchCalls.length, 1);
  const plays = el.playCalls;

  store.getState().toggle(); // botón de reproducir (barra, tarjeta o MediaSession)
  await settle();
  assert.equal(fetchCalls.length, 1, 'ninguna solicitud adicional durante la pausa');
  assert.equal(el.playCalls, plays, 'no se llamó a el.play()');
  assert.equal(el.currentSrc, '', 'ni se reanuda la pista anterior');
  assert.match(store.getState().playbackError, /muchas solicitudes de audio/);
  assert.equal(store.getState().isPlaying, false);
  store.getState().toggle();
  store.getState().toggle();
  await settle();
  assert.equal(fetchCalls.length, 1, 'y tampoco con más clics');
});

test('toggle() terminada la pausa: reintenta por el flujo autenticado y reproduce la pista correcta', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  const pub = track('t3', { isPublic: true });
  store.getState().play(pub);
  await settle();
  auto = rateLimitedAuto('30');
  store.getState().play(privateTrack('t4'));
  await settle();
  resetRateLimitGate();
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().toggle();
  await settle();
  assert.equal(fetchCalls.length, 2);
  assert.equal(authHeader(fetchCalls[1]), 'Bearer tok-123');
  assert.match(el.src, /^blob:/);
  assert.equal(el.playedLog[el.playedLog.length - 1], el.src, 'suena el blob de la pista correcta');
  assert.notEqual(el.playedLog[el.playedLog.length - 1], pub.audioUrl);
  assert.equal(store.getState().playbackError, null);
  assert.equal(store.getState().isPlaying, true);
});

test('toggle() sobre una pista privada YA cargada pausa y reanuda con el.play(), sin nuevas descargas; y la pública no se ve afectada', async () => {
  const { store, el } = await freshStore();
  store.getState().setAudio(el);
  auto = () => ({ status: 200, body: 'wav' });
  store.getState().play(privateTrack('t5'));
  await settle();
  assert.equal(fetchCalls.length, 1);
  store.getState().toggle(); // pausa
  await settle();
  assert.equal(store.getState().isPlaying, false);
  const plays = el.playCalls;
  store.getState().toggle(); // reanuda: el blob sigue conectado
  await settle();
  assert.equal(fetchCalls.length, 1, 'sin otra descarga');
  assert.equal(el.playCalls, plays + 1, 'el.play() normal');
  assert.equal(store.getState().isPlaying, true);

  store.getState().play(track('t6', { isPublic: true }));
  await settle();
  store.getState().toggle();
  await settle();
  const before = el.playCalls;
  store.getState().toggle();
  await settle();
  assert.equal(el.playCalls, before + 1, 'la pública reanuda con el.play() como siempre');
  assert.equal(fetchCalls.length, 1);
});
