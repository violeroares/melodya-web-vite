// Imágenes autenticadas (src/lib/auth-image.ts REAL, con dobles de sesión y de cliente HTTP): una descarga iniciada ANTES del logout / cambio de
// cuenta y que termina DESPUÉS no puede volver a introducir contenido de la sesión anterior en la caché.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_helpers/auth-image-loader.mjs', import.meta.url);

const memory = new Map();
globalThis.window = { location: { origin: 'http://localhost:3000' } };
globalThis.sessionStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, String(v)), removeItem: (k) => void memory.delete(k) };

const { authState } = await import('./_helpers/stubs/auth.mjs');
const { authImageObjectUrl, clearAuthImageCache } = await import('../src/lib/auth-image.ts');
const { resetRateLimitGate } = await import('../src/lib/api/resilience.ts');

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
let created;
let fetches;
/** respuestas pendientes de fetch, resolubles a mano. */
let gates;
let seq = 0;

const deferred = () => { let resolve; const promise = new Promise((a) => { resolve = a; }); return { promise, resolve }; };
const IMG = (n) => `http://localhost:4000/api/files/${n}/stream`;
const png = () => new Response(new Blob(['png-bytes'], { type: 'image/png' }), { status: 200 });

test.beforeEach(() => {
  memory.clear();
  created = [];
  fetches = [];
  gates = [];
  authState.accessToken = 'tok-A';
  resetRateLimitGate();
  clearAuthImageCache();
  globalThis.fetch = (url, init = {}) => {
    const gate = deferred();
    gates.push(gate);
    fetches.push({ url: String(url), auth: init.headers?.Authorization });
    return gate.promise;
  };
  URL.createObjectURL = () => { const u = `blob:test/${++seq}`; created.push(u); return u; };
  URL.revokeObjectURL = () => {};
});
test.afterEach(() => { globalThis.fetch = realFetch; URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });

test('descarga que termina DESPUÉS del logout: no crea el object URL ni lo guarda en la caché', async () => {
  const pending = authImageObjectUrl(IMG('privada-de-A'));
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].auth, 'Bearer tok-A');

  clearAuthImageCache(); // logout / cambio de cuenta con la descarga todavía en vuelo
  gates[0].resolve(png()); // llega tarde
  assert.equal(await pending, null, 'el resultado de la sesión anterior se descarta');
  assert.equal(created.length, 0, 'ni siquiera se materializó el blob');

  // La caché quedó limpia: pedir la misma URL con la sesión nueva vuelve a descargar (no sirve contenido anterior).
  authState.accessToken = 'tok-B';
  const second = authImageObjectUrl(IMG('privada-de-A'));
  assert.equal(fetches.length, 2, 'nueva descarga con la sesión vigente');
  assert.equal(fetches[1].auth, 'Bearer tok-B');
  gates[1].resolve(png());
  const url = await second;
  assert.match(url, /^blob:/);
  assert.equal(created.length, 1, 'solo existe el blob de la sesión nueva');
});

test('la invalidación aplica también a descargas cuya respuesta ya llegó pero siguen leyendo el cuerpo', async () => {
  const pending = authImageObjectUrl(IMG('x'));
  let finishBody;
  const slow = new Response(new ReadableStream({ start(c) { finishBody = () => { c.enqueue(new TextEncoder().encode('bytes')); c.close(); }; } }), { status: 200, headers: { 'content-type': 'image/png' } });
  gates[0].resolve(slow); // llegó la cabecera, el cuerpo todavía no
  await new Promise((r) => setImmediate(r));
  clearAuthImageCache();
  finishBody();
  assert.equal(await pending, null);
  assert.equal(created.length, 0);
});

test('una descarga NUEVA iniciada después del logout no se ve afectada por la invalidación de la anterior', async () => {
  const old = authImageObjectUrl(IMG('a'));
  clearAuthImageCache();
  authState.accessToken = 'tok-B';
  const fresh = authImageObjectUrl(IMG('b'));
  gates[0].resolve(png());
  gates[1].resolve(png());
  assert.equal(await old, null);
  assert.match(await fresh, /^blob:/);
  assert.equal(created.length, 1);
});

test('sin logout de por medio, la descarga se cachea normalmente (control)', async () => {
  const p = authImageObjectUrl(IMG('c'));
  gates[0].resolve(png());
  const url = await p;
  assert.match(url, /^blob:/);
  assert.equal(await authImageObjectUrl(IMG('c')), url, 'segunda vez: sale de la caché');
  assert.equal(fetches.length, 1);
});
