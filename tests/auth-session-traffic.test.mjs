// src/stores/auth.ts REAL (con dobles de API/cliente/router, ver tests/_helpers): política de sesión ante errores HTTP.
//  • 429 / red / 5xx → la sesión (tokens y usuario) se CONSERVA y se reintenta con backoff ≥ Retry-After.
//  • Solo un rechazo definitivo (401/403 del refresh, 403 de /users/me) o un refresh token vencido cierra la sesión.
//  • El refresh proactivo se agenda con el `exp` REAL del JWT; un único timer por pestaña; otra pestaña que renovó se adopta sin pedir más.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_helpers/auth-store-loader.mjs', import.meta.url);

// Timers instrumentados: se registran y des-referencian (el proceso de prueba debe poder terminar).
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
const { resetRateLimitGate, noteRateLimit } = await import('../src/lib/api/resilience.ts');
const KEY = 'melodya.session';

const jwt = (ttlSec, now = Date.now()) => {
  const iat = Math.floor(now / 1000);
  return `h.${Buffer.from(JSON.stringify({ iat, exp: iat + ttlSec, r: Math.random() })).toString('base64url')}.s`;
};
const apiErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code: 'X', ...extra });
const storedSession = () => JSON.parse(memory.get(KEY) ?? 'null');
function seed({ ttlSec = 900, issuedAgoSec = 0, refreshExpiresIn = 30 * 86400000 } = {}) {
  const now = Date.now();
  const accessToken = jwt(ttlSec, now - issuedAgoSec * 1000);
  const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).exp * 1000;
  memory.set(KEY, JSON.stringify({ accessToken, refreshToken: 'rt-1', accessExpiresAt: exp, expiresAt: now + refreshExpiresIn }));
  return accessToken;
}

test.beforeEach(() => {
  for (const t of [...live.keys()]) globalThis.clearTimeout(t);
  live.clear();
  memory.clear();
  resetRateLimitGate();
  Object.assign(shared, { calls: [], navigations: [], resets: 0, refreshCalls: 0, meImpl: null, refreshImpl: null });
  useAuthStore.setState({ user: null, accessToken: null, status: 'idle', bootstrapPromise: null });
});

test('bootstrap sano: agenda el refresh según el exp REAL (≈13 min con TTL de 15 min, no 2) y deja UN solo timer', async () => {
  seed({ ttlSec: 900 });
  await useAuthStore.getState().bootstrap();
  assert.equal(useAuthStore.getState().status, 'authenticated');
  assert.equal(shared.refreshCalls, 0, 'el token está vigente: no se pide refresh al arrancar');
  const timers = longTimers();
  assert.equal(timers.length, 1, 'un único timer de refresh');
  assert.ok(timers[0].ms >= 780_000 && timers[0].ms <= 791_000, `≈ exp − 2 min (${timers[0].ms} ms)`);
});

test('TTL corto configurado en el backend (60 s): el timer respeta ese TTL', async () => {
  seed({ ttlSec: 60 });
  await useAuthStore.getState().bootstrap();
  const [t] = longTimers();
  assert.ok(t.ms >= 47_000 && t.ms <= 59_000, `≈ 48 s + jitter (${t.ms})`);
});

test('refresh al arrancar → 429: la sesión SE CONSERVA (tokens intactos, sin reset) y se reintenta tras Retry-After', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890 }); // vence en 10 s → hay que renovar
  const before = memory.get(KEY);
  shared.refreshImpl = async () => { throw apiErr(429, { retryAfterMs: 90_000 }); };
  await useAuthStore.getState().bootstrap();
  const s = useAuthStore.getState();
  assert.equal(s.status, 'guest', 'la UI arranca como invitado mientras tanto');
  assert.equal(memory.get(KEY), before, 'los tokens siguen guardados');
  assert.equal(shared.resets, 0, 'NO se reseteó el estado de usuario');
  const timers = longTimers();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 91_400, `reintento ≥ Retry-After + margen (${timers[0].ms})`);

  // Pasado el bloqueo: el timer reintenta, la sesión se recupera sola.
  shared.refreshImpl = null;
  seed({ ttlSec: 900 });
  live.values().next().value.fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(useAuthStore.getState().status, 'authenticated');
  assert.equal(useAuthStore.getState().user?.id, 'u1');
});

test('refresh al arrancar → red / 5xx: igual, sesión conservada', async () => {
  for (const e of [apiErr(0, { code: 'NETWORK' }), apiErr(503)]) {
    memory.clear(); useAuthStore.setState({ user: null, status: 'idle', bootstrapPromise: null });
    seed({ ttlSec: 900, issuedAgoSec: 890 });
    shared.refreshImpl = async () => { throw e; };
    await useAuthStore.getState().bootstrap();
    assert.ok(memory.has(KEY), `HTTP ${e.status}: tokens conservados`);
    assert.equal(shared.resets, 0);
  }
});

test('refresh al arrancar → 401 (revocado) o 403 (cuenta no activa): sesión cerrada y estado reseteado', async () => {
  for (const status of [401, 403]) {
    memory.clear(); shared.resets = 0; useAuthStore.setState({ user: null, status: 'idle', bootstrapPromise: null });
    seed({ ttlSec: 900, issuedAgoSec: 890 });
    shared.refreshImpl = async () => { throw apiErr(status); };
    await useAuthStore.getState().bootstrap();
    await new Promise((r) => setImmediate(r));
    assert.equal(memory.has(KEY), false, `HTTP ${status}: tokens eliminados`);
    assert.equal(shared.resets, 1);
    assert.equal(useAuthStore.getState().status, 'guest');
  }
});

test('refresh token VENCIDO: aunque el error sea transitorio no se mantiene indefinidamente una sesión muerta', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890, refreshExpiresIn: -1000 });
  shared.refreshImpl = async () => { throw apiErr(429, { retryAfterMs: 5000 }); };
  await useAuthStore.getState().bootstrap();
  await new Promise((r) => setImmediate(r));
  assert.equal(memory.has(KEY), false);
  assert.equal(shared.resets, 1);
});

test('loadMe: 429/red/5xx con usuario ya cargado lo CONSERVA; sin usuario reintenta con backoff; 403 cierra', async () => {
  seed();
  useAuthStore.setState({ user: { id: 'u1', name: 'Ana' }, status: 'authenticated', accessToken: 'x' });
  shared.meImpl = async () => { throw apiErr(429, { retryAfterMs: 1000 }); };
  assert.equal(await useAuthStore.getState().loadMe(), 'transient');
  assert.equal(useAuthStore.getState().user?.id, 'u1', 'antes se perdía el usuario (y la UI mostraba «invitado»)');
  assert.equal(useAuthStore.getState().status, 'authenticated');
  assert.equal(longTimers().length, 0, 'con usuario cargado no hace falta recuperación');

  useAuthStore.setState({ user: null, status: 'loading' });
  assert.equal(await useAuthStore.getState().loadMe(), 'transient');
  assert.equal(useAuthStore.getState().status, 'guest');
  assert.ok(memory.has(KEY), 'tokens guardados');
  assert.equal(longTimers().length, 1, 'un timer de recuperación');
  assert.equal(shared.resets, 0);

  shared.meImpl = async () => { throw apiErr(403); };
  assert.equal(await useAuthStore.getState().loadMe(), 'unauthorized');
  await new Promise((r) => setImmediate(r));
  assert.equal(memory.has(KEY), false, '403 (cuenta no activa) es definitivo');
});

test('refresh proactivo (timer): 429 → sesión conservada y reintento ≥ Retry-After; 401 → cierra', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890 });
  useAuthStore.setState({ user: { id: 'u1' }, status: 'authenticated', accessToken: 'x' });
  shared.refreshImpl = async () => { throw apiErr(429, { retryAfterMs: 45_000 }); };
  await useAuthStore.getState().refreshSession();
  assert.ok(memory.has(KEY));
  assert.equal(shared.resets, 0);
  assert.equal(useAuthStore.getState().status, 'authenticated');
  assert.ok(longTimers().every((t) => t.ms >= 45_000) && longTimers().length === 1);

  shared.refreshImpl = async () => { throw apiErr(401); };
  await useAuthStore.getState().refreshSession();
  await new Promise((r) => setImmediate(r));
  assert.equal(memory.has(KEY), false);
  assert.equal(shared.resets, 1);
});

test('refresh proactivo: si OTRA pestaña ya renovó, se adopta su token SIN pedir otro refresh', async () => {
  const fresh = seed({ ttlSec: 900 }); // lo que dejó la otra pestaña en storage
  useAuthStore.setState({ user: { id: 'u1' }, status: 'authenticated', accessToken: 'token-viejo-en-memoria' });
  await useAuthStore.getState().refreshSession();
  assert.equal(shared.refreshCalls, 0, 'cero solicitudes');
  assert.equal(useAuthStore.getState().accessToken, fresh);
  assert.equal(longTimers().length, 1, 'y reagenda su timer con el nuevo exp');
});

test('refresh proactivo: con la pausa del REFRESH activa no se pide nada (espera el bloqueo)', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890 });
  useAuthStore.setState({ user: { id: 'u1' }, status: 'authenticated', accessToken: 'x' });
  noteRateLimit(60_000, 'refresh');
  await useAuthStore.getState().refreshSession();
  assert.equal(shared.refreshCalls, 0);
  assert.ok(longTimers()[0].ms >= 59_000);
});

test('un 429 de la API general o de los archivos NO impide renovar la sesión (alcances independientes)', async () => {
  for (const scope of ['api', 'files']) {
    shared.refreshCalls = 0;
    seed({ ttlSec: 900, issuedAgoSec: 890 });
    useAuthStore.setState({ user: { id: 'u1' }, status: 'authenticated', accessToken: 'x' });
    resetRateLimitGate();
    noteRateLimit(120_000, scope);
    await useAuthStore.getState().refreshSession();
    assert.equal(shared.refreshCalls, 1, `pausa de ${scope}: el refresh sale igual`);
  }
});

test('reintento tras un 429 del refresh: espera la pausa del REFRESH, no la de la API general', async () => {
  seed({ ttlSec: 900, issuedAgoSec: 890 });
  useAuthStore.setState({ user: { id: 'u1' }, status: 'authenticated', accessToken: 'x' });
  shared.refreshImpl = async () => { throw apiErr(429, { retryAfterMs: 2_000 }); };
  noteRateLimit(300_000, 'api'); // la API general está en pausa: no debe alargar el reintento del refresh
  await useAuthStore.getState().refreshSession();
  assert.equal(longTimers().length, 1);
  assert.ok(longTimers()[0].ms < 120_000, `el reintento no hereda la pausa de la API (${longTimers()[0].ms} ms)`);

  for (const t of [...live.keys()]) globalThis.clearTimeout(t);
  live.clear();
  resetRateLimitGate();
  noteRateLimit(300_000, 'refresh');
  await useAuthStore.getState().refreshSession(); // con la pausa del refresh vigente no sale y espera su fin
  assert.ok(longTimers()[0].ms >= 299_000, 'sí respeta la pausa del refresh');
});

test('recuperación al cargar el perfil (GET /users/me, API general): espera la pausa de la API, no la del refresh', async () => {
  seed();
  useAuthStore.setState({ user: null, status: 'loading' });
  shared.meImpl = async () => { throw apiErr(429, { retryAfterMs: 1_000 }); };
  noteRateLimit(200_000, 'refresh'); // el refresh en pausa no debe alargar la recuperación del perfil
  assert.equal(await useAuthStore.getState().loadMe(), 'transient');
  assert.ok(longTimers()[0].ms < 100_000, `no hereda la pausa del refresh (${longTimers()[0].ms} ms)`);
});

test('evento storage de otra pestaña: se adopta el token nuevo y se reagenda (sin refresh propio)', async () => {
  seed({ ttlSec: 900 });
  await useAuthStore.getState().bootstrap();
  assert.equal(typeof listeners.storage, 'function', 'la pestaña escucha `storage`');
  const newer = seed({ ttlSec: 900 }); // otra pestaña escribió un token nuevo
  listeners.storage({ key: KEY, newValue: memory.get(KEY) });
  assert.equal(useAuthStore.getState().accessToken, newer);
  assert.equal(shared.refreshCalls, 0);
  assert.equal(longTimers().length, 1, 'sigue habiendo UN solo timer');
});

test('ciclos repetidos no acumulan timers', async () => {
  seed({ ttlSec: 900 });
  await useAuthStore.getState().bootstrap();
  for (let i = 0; i < 5; i++) {
    seed({ ttlSec: 900 });
    await useAuthStore.getState().refreshSession();
  }
  assert.equal(longTimers().length, 1);
});
