// MediaSession (pantalla de bloqueo / notificación): el `type` del artwork es el MIME REAL del blob autenticado cuando se conoce;
// si no se conoce (URL directa, sin Content-Type de imagen) la propiedad se OMITE — nunca se inventa 'image/png'.
// Título, artista, álbum y URL no cambian. Ejecutar: node --test "tests/*.test.mjs"
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
const session = { metadata: null, playbackState: 'none', setPositionState() {} };
Object.defineProperty(globalThis.navigator, 'mediaSession', { value: session, configurable: true });
globalThis.MediaMetadata = class { constructor(init) { Object.assign(this, init); } };

const { authState } = await import('./_helpers/stubs/auth.mjs');
const { authImageState } = await import('./_helpers/stubs/auth-image.mjs');

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = NaN; this.volume = 1; this.muted = false; this.playbackRate = 1; this.defaultPlaybackRate = 1; this._src = ''; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  removeAttribute() { this._src = ''; }
  getAttribute(name) { return name === 'src' && this._src ? this._src : null; }
  load() {}
  async play() { this.paused = false; }
  pause() { this.paused = true; }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

let n = 0;
async function play(coverUrl) {
  memory.clear();
  session.metadata = null;
  n += 1;
  const { usePlayerStore } = await import(`../src/stores/player.ts?media=${n}`);
  usePlayerStore.getState().setAudio(new FakeAudio());
  usePlayerStore.getState().play({ id: `m${n}`, title: 'Tema', artist: 'Vos', coverUrl, isPublic: true, audioUrl: `http://localhost:4000/api/files/m${n}/stream` });
  await settle();
  return session.metadata;
}

test.beforeEach(() => { authState.accessToken = null; authImageState.objectUrl = null; authImageState.type = undefined; });

test('con sesión y blob de portada WebP: el artwork declara image/webp y conserva el resto de metadatos', async () => {
  authState.accessToken = 'tok';
  authImageState.objectUrl = 'blob:http://localhost:3000/cover-1';
  authImageState.type = 'image/webp';
  const md = await play('/api/files/c1/stream');
  assert.equal(md.title, 'Tema');
  assert.equal(md.artist, 'Vos');
  assert.equal(md.album, 'Melodya');
  assert.deepEqual(md.artwork, [{ src: 'blob:http://localhost:3000/cover-1', sizes: '512x512', type: 'image/webp' }]);
});

test('con sesión y blob JPEG: usa image/jpeg (no PNG fijo)', async () => {
  authState.accessToken = 'tok';
  authImageState.objectUrl = 'blob:http://localhost:3000/cover-2';
  authImageState.type = 'image/jpeg';
  const md = await play('/api/files/c2/stream');
  assert.equal(md.artwork[0].type, 'image/jpeg');
});

test('con sesión y blob sin MIME conocido: el artwork omite `type`', async () => {
  authState.accessToken = 'tok';
  authImageState.objectUrl = 'blob:http://localhost:3000/cover-3';
  authImageState.type = undefined;
  const md = await play('/api/files/c3/stream');
  assert.equal(md.artwork.length, 1);
  assert.equal(md.artwork[0].src, 'blob:http://localhost:3000/cover-3');
  assert.equal('type' in md.artwork[0], false);
});

test('invitado (URL directa, MIME desconocido): artwork con la URL absoluta y SIN `type`', async () => {
  const md = await play('/api/files/c4/stream');
  assert.deepEqual(md.artwork, [{ src: 'http://localhost:3000/api/files/c4/stream', sizes: '512x512' }]);
});

test('con sesión pero sin blob (descarga fallida): último recurso = URL directa sin `type`', async () => {
  authState.accessToken = 'tok';
  const md = await play('/api/files/c5/stream');
  assert.deepEqual(md.artwork, [{ src: 'http://localhost:3000/api/files/c5/stream', sizes: '512x512' }]);
});

test('sin portada: artwork vacío', async () => {
  const md = await play(null);
  assert.deepEqual(md.artwork, []);
});
