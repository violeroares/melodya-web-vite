// Cliente HTTP REAL (src/lib/api/client.ts) con `axios.post` sustituido por una promesa controlable (sin red): un refresh que vuela mientras se
// cierra la sesión o entra otra cuenta NO puede persistir sus tokens, y los refreshs concurrentes siguen siendo UNA sola solicitud.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.VITE_API_BASE_URL = 'http://127.0.0.1:9/api'; // jamás se contacta: axios.post está sustituido

const mem = new Map();
const localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
globalThis.localStorage = localStorage;
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };

const { clientRefresh, bindAuthCallbacks, resetRefreshBlock, ApiError } = await import('../src/lib/api/client.ts');
const { classifyError, isTransient, resetRateLimitGate } = await import('../src/lib/api/resilience.ts');
const KEY = 'melodya.session';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));
const refreshOk = (accessToken, refreshToken) => ({ data: { data: { accessToken, refreshToken } } });
const writeStored = (accessToken, refreshToken) => mem.set(KEY, JSON.stringify({ accessToken, refreshToken, accessExpiresAt: Date.now() + 900_000, expiresAt: Date.now() + 30 * 86400000 }));
const stored = () => JSON.parse(mem.get(KEY) ?? 'null');

const realPost = axios.post;
let posts;
let nextResponse;
let refreshed;
let currentRefreshToken;

test.beforeEach(() => {
  mem.clear();
  resetRateLimitGate();
  resetRefreshBlock();
  posts = [];
  refreshed = [];
  currentRefreshToken = 'r1';
  writeStored('a1', 'r1');
  axios.post = (url, body) => {
    posts.push({ url, body });
    return nextResponse.promise;
  };
  bindAuthCallbacks({
    getAccessToken: () => 'a1',
    getRefreshToken: () => currentRefreshToken,
    onRefreshed: (s) => { refreshed.push(s); },
    onUnauthorized: () => {},
  });
});
test.afterEach(() => { axios.post = realPost; });

test('control: sin cambios de sesión, el refresh persiste los tokens y avisa al store', async () => {
  nextResponse = deferred();
  const p = clientRefresh();
  await tick();
  nextResponse.resolve(refreshOk('a2', 'r2'));
  assert.equal(await p, 'a2');
  assert.equal(stored().refreshToken, 'r2', 'el token rotado quedó guardado');
  assert.equal(refreshed.length, 1);
});

test('logout MIENTRAS el refresh vuela: la respuesta tardía se DESCARTA (nada se guarda) y falla como error transitorio', async () => {
  nextResponse = deferred();
  const p = clientRefresh();
  await tick();
  assert.equal(posts.length, 1, 'el refresh salió con el token vigente');

  // Se cierra la sesión: el store ya no expone refresh token y el storage queda vacío.
  currentRefreshToken = null;
  mem.delete(KEY);
  nextResponse.resolve(refreshOk('a-tardio', 'r-tardio'));

  const err = await p.then(() => null, (e) => e);
  assert.ok(err instanceof ApiError, 'rechaza con ApiError');
  assert.equal(err.code, 'SESSION_CHANGED');
  assert.equal(err.status, 0);
  assert.equal(mem.has(KEY), false, 'NO resucita la sesión cerrada: storage sigue vacío');
  assert.equal(refreshed.length, 0, 'el store no recibe el token de la sesión cerrada');
  assert.ok(isTransient(classifyError(err)), 'es transitorio: no cuenta como rechazo definitivo (no cierra una sesión nueva)');
});

test('cambio de cuenta MIENTRAS el refresh vuela: se adopta la sesión vigente, los tokens de la cuenta anterior no se guardan', async () => {
  nextResponse = deferred();
  const p = clientRefresh();
  await tick();

  // Entró la cuenta B (otro refresh token y su sesión en storage).
  currentRefreshToken = 'rB';
  writeStored('aB', 'rB');
  nextResponse.resolve(refreshOk('a-de-A', 'r-de-A'));

  assert.equal(await p, 'aB', 'se usa el access token de la sesión vigente');
  assert.equal(stored().refreshToken, 'rB', 'storage conserva la sesión de B');
  assert.equal(stored().accessToken, 'aB');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].refreshToken, 'rB', 'el store sincroniza con la sesión de B, no con la de A');
});

test('otra pestaña rotó el token mientras tanto: se adopta su sesión y no se pisa con la respuesta propia', async () => {
  nextResponse = deferred();
  const p = clientRefresh();
  await tick();
  currentRefreshToken = 'r1-rotado-por-otra-pestana';
  writeStored('a-otra-pestana', 'r1-rotado-por-otra-pestana');
  nextResponse.resolve(refreshOk('a-propio', 'r-propio'));
  assert.equal(await p, 'a-otra-pestana');
  assert.equal(stored().refreshToken, 'r1-rotado-por-otra-pestana');
});

test('prevención de duplicados: varios refreshs simultáneos comparten UNA sola solicitud', async () => {
  nextResponse = deferred();
  const all = Promise.all([clientRefresh(), clientRefresh(), clientRefresh(), clientRefresh(), clientRefresh()]);
  await tick();
  nextResponse.resolve(refreshOk('a2', 'r2'));
  const tokens = await all;
  assert.equal(posts.length, 1, 'un único POST /auth/refresh');
  assert.deepEqual(new Set(tokens), new Set(['a2']));
});

test('un refresh fallido por 429 conserva el bloqueo y no dispara un segundo POST (protección de Vite intacta)', async () => {
  nextResponse = deferred();
  const p1 = clientRefresh();
  await tick();
  nextResponse.reject(Object.assign(new Error('429'), { isAxiosError: true, response: { status: 429, headers: { 'retry-after': '30' }, data: {} } }));
  await p1.then(() => null, () => null);
  assert.equal(posts.length, 1);
  nextResponse = deferred();
  const err = await clientRefresh().then(() => null, (e) => e);
  assert.equal(posts.length, 1, 'durante el bloqueo NO se envía otro refresh');
  assert.equal(err?.status, 429);
});
