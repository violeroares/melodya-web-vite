// Conteo de reproducciones del reproductor (src/stores/player.ts REAL con dobles, ver tests/_helpers):
//  • toda canción PÚBLICA cuenta (POST /songs/:id/play) aunque quien la armó no pase un gancho (Biblioteca, Inicio, historial);
//  • las privadas no cuentan; un `onPlayed` explícito tiene prioridad;
//  • pausar y reanudar NO suma; cambiar de canción y volver, o terminar una, sí;
//  • la sesión restaurada tras recargar recupera el conteo (una vez) y no lo repite si ya se había contado.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_helpers/player-loader.mjs', import.meta.url);

const memory = new Map();
globalThis.window = { location: { origin: 'http://localhost:3000' } };
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
};

const { authState } = await import('./_helpers/stubs/auth.mjs');
const { registerPlayCalls } = await import('./_helpers/stubs/api.mjs');

class FakeAudio extends EventTarget {
  constructor() {
    super();
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
  }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  removeAttribute(name) { if (name === 'src') this._src = ''; }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 6; i += 1) await tick(); }

const track = (id, extra = {}) => ({ id, title: `Canción ${id}`, artist: 'Vos', coverUrl: null, audioUrl: `http://localhost:4000/api/files/${id}/stream`, ...extra });

let n = 0;
async function freshStore({ session } = {}) {
  memory.clear();
  if (session) memory.set('melodya.player.session', JSON.stringify({ ...session, savedAt: new Date().toISOString() }));
  n += 1;
  const mod = await import(`../src/stores/player.ts?case=${n}`);
  const el = new FakeAudio();
  mod.usePlayerStore.getState().setAudio(el);
  return { store: mod.usePlayerStore, el };
}

test.beforeEach(() => { authState.accessToken = null; registerPlayCalls.length = 0; });

test('PÚBLICA sin gancho propio (p. ej. una canción propia desde Biblioteca): play() cuenta una reproducción', async () => {
  const { store } = await freshStore();
  store.getState().play(track('a', { isPublic: true }));
  await settle();
  assert.deepEqual(registerPlayCalls, ['a']);
});

test('PRIVADA o de visibilidad desconocida: no se cuenta (el backend respondería 404)', async () => {
  const { store } = await freshStore();
  store.getState().play(track('p', { isPublic: false }));
  store.getState().play(track('u'));
  await settle();
  assert.deepEqual(registerPlayCalls, []);
});

test('un onPlayed explícito tiene prioridad: no se agrega el conteo por defecto', async () => {
  const { store } = await freshStore();
  let own = 0;
  store.getState().play(track('c', { isPublic: true, onPlayed: () => { own += 1; } }));
  await settle();
  assert.equal(own, 1);
  assert.deepEqual(registerPlayCalls, [], 'no se duplica con el conteo por defecto');
});

test('pausar y reanudar la misma canción NO suma (por play() ni por toggle())', async () => {
  const { store } = await freshStore();
  const t = track('a', { isPublic: true });
  store.getState().play(t);
  await settle();
  store.getState().play(t);   // pausa
  store.getState().play(t);   // reanuda
  store.getState().toggle();  // pausa
  store.getState().toggle();  // reanuda
  await settle();
  assert.deepEqual(registerPlayCalls, ['a']);
});

test('cambiar a otra canción y volver cuenta cada una; las canciones de la cola también', async () => {
  const { store } = await freshStore();
  const a = track('a', { isPublic: true });
  const b = track('b', { isPublic: true });
  store.getState().play(a, [a, b]);
  store.getState().play(b, [a, b]);
  store.getState().play(a, [a, b]);
  await settle();
  assert.deepEqual(registerPlayCalls, ['a', 'b', 'a']);
});

test('al terminar una canción pasa a la siguiente (cuenta) y escuchar de nuevo la primera vuelve a contar', async () => {
  const { store, el } = await freshStore();
  const a = track('a', { isPublic: true });
  const b = track('b', { isPublic: true });
  store.getState().play(a, [a, b]);
  el.dispatchEvent(new Event('ended')); // a termina → suena b
  el.dispatchEvent(new Event('ended')); // b termina → vuelve a sonar a
  await settle();
  assert.deepEqual(registerPlayCalls, ['a', 'b', 'a']);
});

test('sesión restaurada tras recargar, sin conteo previo: la canción pública cuenta una vez al reanudar', async () => {
  const t = track('r', { isPublic: true });
  const { store } = await freshStore({ session: { track: t, queue: [t], position: 42, duration: 200, counted: false } });
  assert.deepEqual(registerPlayCalls, [], 'restaurar no reproduce ni cuenta');
  store.getState().toggle(); // reanuda
  store.getState().toggle(); // pausa
  store.getState().toggle(); // reanuda de nuevo
  await settle();
  assert.deepEqual(registerPlayCalls, ['r'], 'una sola vez');
});

test('sesión restaurada que YA se había contado: reanudar no vuelve a contar', async () => {
  const t = track('r', { isPublic: true });
  const { store } = await freshStore({ session: { track: t, queue: [t], position: 42, duration: 200, counted: true } });
  store.getState().toggle();
  await settle();
  assert.deepEqual(registerPlayCalls, []);
});

test('la sesión guardada recuerda que la canción ya se contó (para no repetirlo al recargar)', async () => {
  const { store } = await freshStore();
  const t = track('s', { isPublic: true });
  store.getState().play(t);
  await settle();
  store.getState().seek(10); // guarda la sesión
  store.getState().toggle();
  const saved = JSON.parse(memory.get('melodya.player.session') ?? '{}');
  assert.equal(saved.track?.id, 's');
  assert.equal(saved.counted, true);
});

// ───────── el autor no cuenta las reproducciones de su propia canción ─────────

test('PÚBLICA propia (own: true) sin contador explícito: no se envía ninguna solicitud', async () => {
  const { store } = await freshStore();
  store.getState().play(track('mine', { isPublic: true, own: true }));
  await settle();
  assert.deepEqual(registerPlayCalls, []);
});

test('PÚBLICA propia con onPlayed explícito (feed, perfil, radio, detalle): el gancho NO se invoca', async () => {
  const { store } = await freshStore();
  let called = 0;
  store.getState().play(track('mine', { isPublic: true, own: true, onPlayed: () => { called += 1; } }));
  await settle();
  assert.equal(called, 0);
  assert.deepEqual(registerPlayCalls, []);
});

test('own: false o ausente sigue contando (la ajena y la de visibilidad pública sin dato de autor)', async () => {
  const { store } = await freshStore();
  store.getState().play(track('x', { isPublic: true, own: false }));
  store.getState().play(track('y', { isPublic: true }));
  await settle();
  assert.deepEqual(registerPlayCalls, ['x', 'y']);
});

test('cola mezclada: la propia no cuenta y las ajenas sí, al avanzar y al terminar', async () => {
  const { store, el } = await freshStore();
  const mine = track('mine', { isPublic: true, own: true });
  const other = track('other', { isPublic: true, own: false });
  store.getState().play(mine, [mine, other]);
  el.dispatchEvent(new Event('ended')); // → other
  el.dispatchEvent(new Event('ended')); // → mine (no cuenta)
  store.getState().next();              // → other (cuenta de nuevo)
  await settle();
  assert.deepEqual(registerPlayCalls, ['other', 'other']);
});

test('sesión restaurada de una canción propia: reanudar no cuenta', async () => {
  const t = track('mine', { isPublic: true, own: true });
  const { store } = await freshStore({ session: { track: t, queue: [t], position: 30, duration: 200, counted: false } });
  store.getState().toggle();
  await settle();
  assert.deepEqual(registerPlayCalls, []);
});

test('propia y privada, propia y sin visibilidad: nunca cuentan', async () => {
  const { store } = await freshStore();
  store.getState().play(track('p1', { isPublic: false, own: true }));
  store.getState().play(track('p2', { own: true }));
  await settle();
  assert.deepEqual(registerPlayCalls, []);
});

test('pausar/reanudar y volver a escuchar una canción propia tampoco cuenta (sin errores)', async () => {
  const { store } = await freshStore();
  const t = track('mine', { isPublic: true, own: true });
  store.getState().play(t);
  store.getState().play(t);
  store.getState().toggle();
  store.getState().toggle();
  await settle();
  assert.deepEqual(registerPlayCalls, []);
});

/* ── Canciones propias en la Papelera: se escuchan, pero nunca se registra la reproducción ── */
test('PAPELERA: la pista del detalle (isPublic false, own, trashed) suena y no pide POST /songs/:id/play', async () => {
  const { store, el } = await freshStore();
  store.getState().play(track('t', { isPublic: false, own: true, trashed: true }));
  await settle();
  assert.equal(el.paused, false, 'el audio arrancó');
  assert.deepEqual(registerPlayCalls, []);
});

test('PAPELERA: aunque llegue como pública y con un onPlayed viejo (cola o sesión restaurada), no se cuenta ni se reintenta', async () => {
  const { store, el } = await freshStore();
  let called = 0;
  store.getState().play(track('t1', { isPublic: true, trashed: true }));
  store.getState().play(track('t2', { isPublic: true, trashed: true, onPlayed: () => { called += 1; } }));
  await settle();
  assert.equal(el.paused, false);
  assert.equal(called, 0);
  assert.deepEqual(registerPlayCalls, []);
});

test('un onPlayed que falla (p. ej. el backend rechaza el conteo) no corta el audio ni se reintenta', async () => {
  const { store, el } = await freshStore();
  let calls = 0;
  store.getState().play(track('x', { isPublic: true, onPlayed: () => { calls += 1; throw new Error('404'); } }));
  await settle();
  assert.equal(calls, 1, 'un solo intento');
  assert.equal(el.paused, false, 'el audio sigue sonando');
  store.getState().toggle();
  store.getState().toggle();
  await settle();
  assert.equal(calls, 1, 'pausar/reanudar no reintenta');
});

/* ── Canción propia enviada a la Papelera mientras ya estaba en la cola / sesión ── */
test('setTrackTrashed: la pista en la cola pasa a no pública + trashed; al reproducirla no cuenta y usa descarga autenticada', async () => {
  const { store } = await freshStore();
  const a = track('a', { isPublic: true, own: true });
  const b = track('b', { isPublic: true, own: true });
  store.getState().play(a, [a, b]);
  await settle();
  registerPlayCalls.length = 0;

  store.getState().setTrackTrashed('b', true);
  const queued = store.getState().queue.find((t) => t.id === 'b');
  assert.equal(queued.trashed, true);
  assert.equal(queued.isPublic, false, 'ya no se pide como pública (sin sesión el backend la rechazaría)');
  assert.equal(store.getState().queue.find((t) => t.id === 'a').isPublic, true, 'las demás pistas no cambian');
  assert.equal(store.getState().track.trashed, undefined, 'la pista en curso (otra canción) tampoco');

  store.getState().play(queued, store.getState().queue);
  await settle();
  assert.deepEqual(registerPlayCalls, [], 'nada que contar');
});

test('setTrackTrashed sobre la pista en curso y los recientes; restaurar solo quita la marca; id ajeno no hace nada', async () => {
  const { store } = await freshStore();
  const a = track('a', { isPublic: true, own: true });
  store.getState().play(a, [a]);
  await settle();
  const before = store.getState().track;

  store.getState().setTrackTrashed('zzz', true);
  assert.equal(store.getState().track, before, 'id que no está en el reproductor: sin cambios');

  store.getState().setTrackTrashed('a', true);
  assert.equal(store.getState().track.trashed, true);
  assert.equal(store.getState().track.isPublic, false);
  assert.ok(JSON.parse(memory.get('melodya.player.session')).track.trashed, 'queda en la sesión persistida');

  store.getState().setTrackTrashed('a', false);
  assert.equal('trashed' in store.getState().track, false);
  assert.equal(store.getState().track.audioUrl, a.audioUrl);
});
