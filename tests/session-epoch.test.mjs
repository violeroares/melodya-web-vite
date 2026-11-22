// src/stores/auth.ts REAL (con dobles de API/cliente/router, ver tests/_helpers): ÉPOCA DE SESIÓN y ESTADO DE RECUPERACIÓN.
//  • Una respuesta tardía (perfil, refresh) NO puede restaurar el usuario ni los tokens de una sesión cerrada o de otra cuenta.
//  • Cerrar sesión invalida lo pendiente y detiene los temporizadores SIN esperar al servidor.
//  • Con credenciales guardadas y un error temporal (429 / red / 5xx) la sesión se recupera sola y NO se presenta como «invitado»
//    (`sessionRecovering`); una sesión realmente inválida (401/403) se cierra y limpia ese estado.
//  • Coordinación entre pestañas y ausencia de reintentos duplicados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_helpers/auth-store-loader.mjs', import.meta.url);

// Timers instrumentados (se des-referencian: el proceso de prueba debe poder terminar).
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const live = new Map();
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(() => { live.delete(t); fn(...args); }, ms);
  t?.unref?.();
  live.set(t, { ms, fn: () => fn(...args) });
  return t;
};
globalThis.clearTimeout = (t) => { live.delete(t); realClearTimeout(t); };
const longTimers = () => [...live.values()].filter((t) => t.ms >= 1000);

const memory = new Map();
const listeners = {};
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)); },
  removeItem: (k) => { memory.delete(k); },
};
globalThis.window = {
  location: { origin: 'http://localhost:3000' },
  dispatchEvent: () => true,
  addEventListener: (type, fn) => { listeners[type] = fn; },
  removeEventListener: () => {},
};

const { shared } = await import('./_helpers/stubs/auth-store-doubles.mjs');
const { useAuthStore } = await import('../src/stores/auth.ts');
const { resetRateLimitGate } = await import('../src/lib/api/resilience.ts');
const KEY = 'melodya.session';

const jwt = (ttlSec, now = Date.now()) => {
  const iat = Math.floor(now / 1000);
  return `h.${Buffer.from(JSON.stringify({ iat, exp: iat + ttlSec, r: Math.random() })).toString('base64url')}.s`;
};
const apiErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code: 'X', ...extra });
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const stored = () => JSON.parse(memory.get(KEY) ?? 'null');
const ME = (id) => ({ id, name: id });

function seed({ ttlSec = 900, issuedAgoSec = 0, refreshToken = 'rt-1', refreshExpiresIn = 30 * 86400000 } = {}) {
  const now = Date.now();
  const accessToken = jwt(ttlSec, now - issuedAgoSec * 1000);
  const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).exp * 1000;
  memory.set(KEY, JSON.stringify({ accessToken, refreshToken, accessExpiresAt: exp, expiresAt: now + refreshExpiresIn }));
  return accessToken;
}
const authenticatedAs = (id, accessToken = 'x') => useAuthStore.setState({ user: ME(id), status: 'authenticated', accessToken, sessionRecovering: false });
const clearTimers = () => { for (const t of [...live.keys()]) globalThis.clearTimeout(t); live.clear(); };

const resetDoubles = () => Object.assign(shared, { calls: [], navigations: [], resets: 0, refreshCalls: 0, meImpl: null, refreshImpl: null, loginImpl: null, logoutImpl: null, logoutCalls: 0 });
/** Deja el store y el estado interno del módulo (temporizadores, época) como al arrancar: un logout real los reinicia. */
async function resetStore() {
  resetDoubles();
  await useAuthStore.getState().logout();
  clearTimers();
  memory.clear();
  resetRateLimitGate();
  resetDoubles();
  useAuthStore.setState({ user: null, accessToken: null, status: 'idle', bootstrapPromise: null, sessionRecovering: false });
}

test.beforeEach(async () => {
  await resetStore();
});

/* ───────────────────────── Época de sesión ───────────────────────── */

test('logout MIENTRAS hay un refresh pendiente: la respuesta tardía no restaura el token ni agenda nada', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890 }); // por vencer: refreshSession sí renueva
  authenticatedAs('u1');
  const late = deferred();
  shared.refreshImpl = () => late.promise;
  const pending = useAuthStore.getState().refreshSession();
  await tick();
  assert.equal(shared.refreshCalls, 1, 'hay un refresh en vuelo');

  await useAuthStore.getState().logout();
  late.resolve('token-de-la-sesion-cerrada');
  await pending;
  await tick();

  const s = useAuthStore.getState();
  assert.equal(s.accessToken, null, 'el token tardío NO se adopta');
  assert.equal(s.user, null);
  assert.equal(s.status, 'guest');
  assert.equal(memory.has(KEY), false, 'no queda nada en storage');
  assert.equal(longTimers().length, 0, 'no se reagenda ningún refresh');
});

test('logout MIENTRAS loadMe está pendiente: el perfil tardío no resucita al usuario', async () => {
  seed();
  authenticatedAs('u1');
  const late = deferred();
  shared.meImpl = () => late.promise;
  const pending = useAuthStore.getState().loadMe();
  await tick();

  await useAuthStore.getState().logout();
  late.resolve(ME('u1'));
  assert.equal(await pending, 'unauthorized', 'el resultado de una sesión cerrada se descarta');

  const s = useAuthStore.getState();
  assert.equal(s.user, null, 'el usuario anterior NO vuelve');
  assert.equal(s.status, 'guest');
  assert.equal(s.sessionRecovering, false);
});

test('logout MIENTRAS loadMe falla (429): no se agenda una recuperación de una sesión cerrada', async () => {
  seed();
  useAuthStore.setState({ user: null, status: 'loading' });
  const late = deferred();
  shared.meImpl = () => late.promise;
  const pending = useAuthStore.getState().loadMe();
  await tick();
  await useAuthStore.getState().logout();
  late.reject(apiErr(429, { retryAfterMs: 5000 }));
  assert.equal(await pending, 'unauthorized');
  assert.equal(longTimers().length, 0, 'ninguna recuperación pendiente');
  assert.equal(useAuthStore.getState().sessionRecovering, false);
});

test('cambio de cuenta con un loadMe anterior en curso: el perfil tardío de la cuenta A no pisa a la B', async () => {
  seed();
  authenticatedAs('A');
  const lateA = deferred();
  shared.meImpl = () => lateA.promise; // la solicitud de A queda colgada
  const pendingA = useAuthStore.getState().loadMe();
  await tick();

  const tokenB = jwt(900);
  shared.loginImpl = async () => ({ accessToken: tokenB, refreshToken: 'rt-B' });
  shared.meImpl = async () => ME('B'); // lo que responde ahora el backend
  await useAuthStore.getState().login('b@x.com', 'pw');
  assert.equal(useAuthStore.getState().user?.id, 'B');

  lateA.resolve(ME('A')); // llega tarde
  assert.equal(await pendingA, 'unauthorized');
  assert.equal(useAuthStore.getState().user?.id, 'B', 'sigue siendo la cuenta B');
  assert.equal(stored().refreshToken, 'rt-B');
});

test('cambio de cuenta con un refresh anterior en curso: el token tardío de A no pisa la sesión de B ni sus timers', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890, refreshToken: 'rt-A' });
  authenticatedAs('A');
  const lateA = deferred();
  shared.refreshImpl = () => lateA.promise;
  const pendingA = useAuthStore.getState().refreshSession();
  await tick();

  const tokenB = jwt(900);
  shared.loginImpl = async () => ({ accessToken: tokenB, refreshToken: 'rt-B' });
  shared.meImpl = async () => ME('B');
  await useAuthStore.getState().login('b@x.com', 'pw');

  lateA.resolve('token-de-A');
  await pendingA;
  assert.equal(useAuthStore.getState().accessToken, tokenB, 'el access token vigente es el de B');
  assert.equal(longTimers().length, 1, 'un único timer: el de la sesión de B');
});

test('un reintento de recuperación agendado antes del logout NO se ejecuta aunque su timer dispare', async () => {
  seed();
  useAuthStore.setState({ user: null, status: 'loading' });
  shared.meImpl = async () => { throw apiErr(429, { retryAfterMs: 1000 }); };
  await useAuthStore.getState().loadMe();
  assert.equal(longTimers().length, 1);
  const staleFire = [...live.values()][0].fn; // el callback del timer viejo (como si ya hubiera vencido)

  await useAuthStore.getState().logout();
  assert.equal(longTimers().length, 0, 'el logout detuvo el temporizador');
  let meCalls = 0;
  shared.meImpl = async () => { meCalls += 1; return ME('u1'); };
  seed(); // otra cuenta dejó tokens en storage
  staleFire();
  await tick();
  assert.equal(meCalls, 0, 'la época cambió: el reintento viejo no hidrata nada');
  assert.equal(useAuthStore.getState().user, null);
});

test('logout invalida YA, sin esperar al servidor: timers detenidos y el cliente HTTP no ve refresh token mientras tanto', async () => {
  seed({ ttlSec: 900 });
  await useAuthStore.getState().bootstrap();
  assert.equal(useAuthStore.getState().status, 'authenticated');
  assert.equal(longTimers().length, 1, 'refresh proactivo agendado');
  assert.equal(shared.bound.getRefreshToken(), 'rt-1', 'con sesión, el cliente ve su refresh token');

  const slowServer = deferred();
  shared.logoutImpl = () => slowServer.promise;
  const closing = useAuthStore.getState().logout();
  await tick();

  assert.equal(shared.logoutCalls, 1, 'se pidió el logout al servidor');
  assert.equal(longTimers().length, 0, 'sin esperar la respuesta: el timer de refresh ya no existe');
  assert.equal(shared.bound.getRefreshToken(), null, 'un refresh en vuelo no puede persistir nada mientras se cierra');
  assert.ok(shared.bound.getAccessToken(), 'pero el access token sigue disponible para autenticar el propio logout');

  slowServer.resolve({ ok: true });
  await closing;
  assert.equal(memory.has(KEY), false);
  assert.equal(useAuthStore.getState().status, 'guest');
  assert.deepEqual(shared.navigations.at(-1), '/');
});

test('un login posterior al logout vuelve a exponer el refresh token (la bandera de cierre no queda pegada)', async () => {
  seed();
  await useAuthStore.getState().bootstrap();
  await useAuthStore.getState().logout();
  assert.equal(shared.bound.getRefreshToken(), null, 'sin sesión no hay refresh token');
  shared.loginImpl = async () => ({ accessToken: jwt(900), refreshToken: 'rt-nuevo' });
  shared.meImpl = async () => ME('u2');
  await useAuthStore.getState().login('a@x.com', 'pw');
  assert.equal(shared.bound.getRefreshToken(), 'rt-nuevo');
});

/* ───────────────────────── Recuperación de sesión ───────────────────────── */

test('arranque con 429 del refresh: sessionRecovering (no «invitado»), tokens intactos y se recupera sola', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890 });
  const before = memory.get(KEY);
  shared.refreshImpl = async () => { throw apiErr(429, { retryAfterMs: 90_000 }); };
  await useAuthStore.getState().bootstrap();

  let s = useAuthStore.getState();
  assert.equal(s.sessionRecovering, true, 'la UI sabe que NO es un invitado');
  assert.equal(s.user, null);
  assert.equal(memory.get(KEY), before, 'los tokens siguen guardados');
  assert.equal(shared.resets, 0);
  assert.ok(longTimers()[0].ms >= 91_400, 'reintento ≥ Retry-After + margen (backoff de Vite intacto)');

  shared.refreshImpl = null;
  shared.meImpl = async () => ME('u1');
  seed({ ttlSec: 900 });
  [...live.values()][0].fn();
  await tick();
  await tick();
  s = useAuthStore.getState();
  assert.equal(s.status, 'authenticated');
  assert.equal(s.user?.id, 'u1');
  assert.equal(s.sessionRecovering, false, 'al recuperarse se limpia');
});

test('arranque con 5xx / red al cargar el perfil: sessionRecovering y UN solo temporizador, aunque falle varias veces', async () => {
  for (const e of [apiErr(503), apiErr(0, { code: 'NETWORK' })]) {
    await resetStore();
    seed({ ttlSec: 900 });
    shared.meImpl = async () => { throw e; };
    await useAuthStore.getState().bootstrap();
    assert.equal(useAuthStore.getState().sessionRecovering, true, `HTTP ${e.status}`);
    assert.equal(useAuthStore.getState().status, 'guest');
    assert.ok(memory.has(KEY), 'tokens conservados');
    // Más fallos mientras se recupera: no se apilan temporizadores (prevención de reintentos duplicados).
    await useAuthStore.getState().loadMe();
    await useAuthStore.getState().loadMe();
    assert.equal(longTimers().length, 1, 'un único timer de recuperación');
  }
});

test('loadMe con usuario ya cargado y error temporal: lo conserva y NO marca recuperación', async () => {
  seed();
  authenticatedAs('u1');
  shared.meImpl = async () => { throw apiErr(429, { retryAfterMs: 1000 }); };
  assert.equal(await useAuthStore.getState().loadMe(), 'transient');
  assert.equal(useAuthStore.getState().user?.id, 'u1');
  assert.equal(useAuthStore.getState().sessionRecovering, false);
});

test('sesión realmente inválida (401/403 del refresh): se cierra, se resetea y sessionRecovering queda en false', async () => {
  for (const status of [401, 403]) {
    await resetStore();
    useAuthStore.setState({ sessionRecovering: true });
    seed({ ttlSec: 900, issuedAgoSec: 890 });
    shared.refreshImpl = async () => { throw apiErr(status); };
    await useAuthStore.getState().bootstrap();
    await tick();
    const s = useAuthStore.getState();
    assert.equal(s.sessionRecovering, false, `HTTP ${status}: NO es una recuperación temporal`);
    assert.equal(s.status, 'guest');
    assert.equal(memory.has(KEY), false);
    assert.equal(shared.resets, 1);
    assert.equal(longTimers().length, 0);
  }
});

test('403 de /users/me (cuenta no activa): definitivo, no queda «recuperando»', async () => {
  seed();
  useAuthStore.setState({ user: null, status: 'loading', sessionRecovering: true });
  shared.meImpl = async () => { throw apiErr(403); };
  assert.equal(await useAuthStore.getState().loadMe(), 'unauthorized');
  await tick();
  assert.equal(useAuthStore.getState().sessionRecovering, false);
  assert.equal(memory.has(KEY), false);
});

test('refresh token VENCIDO con error temporal: no se mantiene una sesión muerta ni queda «recuperando»', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890, refreshExpiresIn: -1000 });
  shared.refreshImpl = async () => { throw apiErr(429, { retryAfterMs: 5000 }); };
  await useAuthStore.getState().bootstrap();
  await tick();
  assert.equal(useAuthStore.getState().sessionRecovering, false);
  assert.equal(memory.has(KEY), false);
});

test('iniciar sesión (login) limpia el estado de recuperación', async () => {
  useAuthStore.setState({ sessionRecovering: true });
  shared.loginImpl = async () => ({ accessToken: jwt(900), refreshToken: 'rt-n' });
  shared.meImpl = async () => ME('u1');
  await useAuthStore.getState().login('a@x.com', 'pw');
  assert.equal(useAuthStore.getState().sessionRecovering, false);
  assert.equal(useAuthStore.getState().user?.id, 'u1');
});

/* ───────────────────────── Coordinación entre pestañas ───────────────────────── */

test('otra pestaña cierra la sesión mientras ésta se recupera: se abandona la recuperación (sin timers ni «recuperando»)', async () => {
  seed({ ttlSec: 900 });
  shared.meImpl = async () => { throw apiErr(503); };
  await useAuthStore.getState().bootstrap();
  assert.equal(useAuthStore.getState().sessionRecovering, true);
  assert.equal(longTimers().length, 1);
  const staleFire = [...live.values()][0].fn;

  memory.delete(KEY); // la otra pestaña hizo logout
  listeners.storage({ key: KEY, newValue: null });
  assert.equal(useAuthStore.getState().sessionRecovering, false);
  assert.equal(longTimers().length, 0);

  let meCalls = 0;
  shared.meImpl = async () => { meCalls += 1; return ME('u1'); };
  staleFire();
  await tick();
  assert.equal(meCalls, 0, 'el reintento viejo ya no corre');
});

test('otra pestaña renovó los tokens: se adopta su token sin pedir refresh y sin timers duplicados', async () => {
  seed({ ttlSec: 900 });
  shared.meImpl = async () => ME('u1');
  await useAuthStore.getState().bootstrap();
  const newer = seed({ ttlSec: 900 });
  listeners.storage({ key: KEY, newValue: memory.get(KEY) });
  assert.equal(useAuthStore.getState().accessToken, newer);
  assert.equal(shared.refreshCalls, 0);
  assert.equal(longTimers().length, 1);
});
