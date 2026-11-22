// src/stores/auth.ts REAL (dobles de API/cliente/router/reset): sincronización de la sesión ENTRE PESTAÑAS vía el evento `storage`.
//  • Otra pestaña cierra sesión ⇒ ésta invalida la suya: época (respuestas tardías descartadas), temporizadores, caché de queries / reproductor /
//    imágenes (resetUserSessionState) — sin escribir en storage ni pedir otro logout al servidor.
//  • Otra pestaña renueva los tokens de LA MISMA sesión ⇒ no es un logout: se adopta el token y se reagenda.
//  • Otra pestaña entra con OTRA cuenta ⇒ nada de la anterior sobrevive y no se mezclan respuestas.
//  • Sin ciclos de eventos, sin logouts ni refreshs duplicados; la bandera de cierre no deja restaurar credenciales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./_helpers/auth-store-loader.mjs', import.meta.url);

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
const clearTimers = () => { for (const t of [...live.keys()]) globalThis.clearTimeout(t); live.clear(); };

const memory = new Map();
const listeners = {};
let writes = 0; // escrituras de ESTA pestaña en storage (un ciclo de eventos empezaría con una escritura)
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { writes += 1; memory.set(k, String(v)); },
  removeItem: (k) => { if (memory.has(k)) writes += 1; memory.delete(k); },
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

const jwt = (sub, ttlSec = 900, now = Date.now()) => {
  const iat = Math.floor(now / 1000);
  return `h.${Buffer.from(JSON.stringify({ sub, iat, exp: iat + ttlSec, r: Math.random() })).toString('base64url')}.s`;
};
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ME = (id) => ({ id, name: id });
const stored = () => JSON.parse(memory.get(KEY) ?? 'null');

/** Lo que deja OTRA pestaña en storage (login / renovación). */
function otherTabWrites(sub, refreshToken, ttlSec = 900) {
  const accessToken = jwt(sub, ttlSec);
  const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).exp * 1000;
  memory.set(KEY, JSON.stringify({ accessToken, refreshToken, accessExpiresAt: exp, expiresAt: Date.now() + 30 * 86400000 }));
  listeners.storage({ key: KEY, newValue: memory.get(KEY) });
  return accessToken;
}
/** Otra pestaña cerró sesión / limpió el storage. */
function otherTabLogsOut() {
  memory.delete(KEY);
  listeners.storage({ key: KEY, newValue: null });
}

/** Esta pestaña, ya autenticada como `sub` (bootstrap real con tokens en storage). */
async function bootAs(sub, refreshToken = 'rt-1') {
  const accessToken = jwt(sub);
  const exp = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).exp * 1000;
  memory.set(KEY, JSON.stringify({ accessToken, refreshToken, accessExpiresAt: exp, expiresAt: Date.now() + 30 * 86400000 }));
  shared.meImpl = async () => ME(sub);
  await useAuthStore.getState().bootstrap();
  assert.equal(useAuthStore.getState().user?.id, sub);
  return accessToken;
}

const resetDoubles = () => Object.assign(shared, { calls: [], navigations: [], resets: 0, refreshCalls: 0, meImpl: null, refreshImpl: null, loginImpl: null, logoutImpl: null, logoutCalls: 0 });
test.beforeEach(async () => {
  resetDoubles();
  await useAuthStore.getState().logout();
  clearTimers();
  memory.clear();
  resetRateLimitGate();
  resetDoubles();
  writes = 0;
  useAuthStore.setState({ user: null, accessToken: null, status: 'idle', bootstrapPromise: null, sessionRecovering: false });
});

/* ───────────────────── Logout en otra pestaña ───────────────────── */

test('otra pestaña cierra sesión: ésta invalida la suya (usuario, token, timers) y limpia todo el estado de usuario, SIN tocar storage ni el servidor', async () => {
  await bootAs('A');
  assert.equal(longTimers().length, 1, 'refresh proactivo agendado');
  writes = 0;
  shared.resets = 0;

  otherTabLogsOut();
  await tick();

  const s = useAuthStore.getState();
  assert.equal(s.user, null);
  assert.equal(s.accessToken, null);
  assert.equal(s.status, 'guest');
  assert.equal(s.sessionRecovering, false);
  assert.equal(longTimers().length, 0, 'sin temporizadores de refresh ni de recuperación');
  assert.equal(shared.resets, 1, 'resetUserSessionState: queries, reproductor, borradores e imágenes autenticadas');
  assert.equal(shared.logoutCalls, 0, 'NO se pide otro logout al servidor');
  assert.equal(writes, 0, 'esta pestaña no escribe en storage (no hay ciclo de eventos)');
});

test('el reseteo que dispara el logout remoto incluye la caché de imágenes autenticadas (session-reset.ts REAL)', () => {
  const src = readFileSync(new URL('../src/lib/session-reset.ts', import.meta.url), 'utf8');
  assert.match(src, /clearAuthImageCache\(\)/);
  assert.match(src, /queryClient\.clear\(\)/);
  assert.match(src, /hardReset\(\)/);
});

test('un evento repetido o posterior no vuelve a resetear ni a pedir nada (idempotente)', async () => {
  await bootAs('A');
  shared.resets = 0;
  otherTabLogsOut();
  otherTabLogsOut();
  listeners.storage({ key: KEY, newValue: null });
  await tick();
  assert.equal(shared.resets, 1, 'un solo reseteo');
  assert.equal(shared.logoutCalls, 0);
});

test('localStorage.clear() en otra pestaña (key === null) también cierra la sesión local', async () => {
  await bootAs('A');
  memory.clear();
  listeners.storage({ key: null, newValue: null });
  await tick();
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(useAuthStore.getState().status, 'guest');
});

test('eventos de OTRAS claves no afectan a la sesión', async () => {
  await bootAs('A');
  listeners.storage({ key: 'melodya.volume', newValue: '0.5' });
  assert.equal(useAuthStore.getState().user?.id, 'A');
  assert.equal(shared.resets, 0);
});

test('logout remoto mientras ESTA pestaña se recupera de un error temporal: abandona la recuperación', async () => {
  const token = jwt('A');
  memory.set(KEY, JSON.stringify({ accessToken: token, refreshToken: 'rt-1', accessExpiresAt: Date.now() + 900_000, expiresAt: Date.now() + 30 * 86400000 }));
  shared.meImpl = async () => { throw Object.assign(new Error('503'), { status: 503, code: 'X' }); };
  await useAuthStore.getState().bootstrap();
  assert.equal(useAuthStore.getState().sessionRecovering, true);
  const staleRetry = [...live.values()][0].fn;

  otherTabLogsOut();
  assert.equal(useAuthStore.getState().sessionRecovering, false);
  assert.equal(longTimers().length, 0);

  let meCalls = 0;
  shared.meImpl = async () => { meCalls += 1; return ME('A'); };
  staleRetry();
  await tick();
  assert.equal(meCalls, 0, 'el reintento viejo no se ejecuta');
});

/* ───────────── Respuestas tardías tras el logout remoto ───────────── */

test('refresh pendiente + logout remoto: el token tardío no restaura la sesión', async () => {
  await bootAs('A');
  // Refresh proactivo en vuelo (el token está por vencer).
  const exp = Date.now() + 5_000;
  memory.set(KEY, JSON.stringify({ accessToken: jwt('A', 5), refreshToken: 'rt-1', accessExpiresAt: exp, expiresAt: Date.now() + 30 * 86400000 }));
  const late = deferred();
  shared.refreshImpl = () => late.promise;
  const pending = useAuthStore.getState().refreshSession();
  await tick();
  assert.equal(shared.refreshCalls, 1);

  otherTabLogsOut();
  late.resolve(jwt('A'));
  await pending;
  await tick();
  assert.equal(useAuthStore.getState().accessToken, null, 'no se adopta el token de la sesión cerrada');
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(memory.has(KEY), false);
  assert.equal(longTimers().length, 0);
});

test('loadMe pendiente + logout remoto: el perfil tardío no resucita al usuario', async () => {
  await bootAs('A');
  const late = deferred();
  shared.meImpl = () => late.promise;
  const pending = useAuthStore.getState().loadMe();
  await tick();
  otherTabLogsOut();
  late.resolve(ME('A'));
  assert.equal(await pending, 'unauthorized');
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(useAuthStore.getState().status, 'guest');
});

test('hydrate (bootstrap) pendiente + logout remoto: no se restaura nada al llegar la respuesta', async () => {
  const token = jwt('A');
  memory.set(KEY, JSON.stringify({ accessToken: token, refreshToken: 'rt-1', accessExpiresAt: Date.now() + 900_000, expiresAt: Date.now() + 30 * 86400000 }));
  const late = deferred();
  shared.meImpl = () => late.promise;
  const booting = useAuthStore.getState().bootstrap();
  await tick();
  assert.equal(useAuthStore.getState().status, 'loading');

  otherTabLogsOut();
  late.resolve(ME('A'));
  await booting;
  await tick();
  const s = useAuthStore.getState();
  assert.equal(s.user, null, 'el perfil tardío NO se aplica');
  assert.equal(s.status, 'guest');
  assert.equal(longTimers().length, 0, 'tampoco se agenda un refresh');
});

/* ───────────── Renovación de la MISMA sesión (no es un logout) ───────────── */

test('otra pestaña renovó los tokens de la misma cuenta: se adopta el token, NO se cierra nada ni se pide otro refresh', async () => {
  await bootAs('A');
  shared.resets = 0;
  const renewed = otherTabWrites('A', 'rt-2');
  await tick();
  const s = useAuthStore.getState();
  assert.equal(s.user?.id, 'A', 'sigue autenticada');
  assert.equal(s.accessToken, renewed);
  assert.equal(shared.resets, 0, 'no se reseteó el estado de usuario');
  assert.equal(shared.refreshCalls, 0, 'ningún refresh innecesario');
  assert.equal(shared.logoutCalls, 0);
  assert.equal(longTimers().length, 1, 'un único timer, reagendado con el nuevo exp');
});

test('varias renovaciones seguidas desde otra pestaña no apilan timers ni solicitudes', async () => {
  await bootAs('A');
  for (let i = 0; i < 4; i++) otherTabWrites('A', `rt-${i + 2}`);
  assert.equal(longTimers().length, 1);
  assert.equal(shared.refreshCalls, 0);
  assert.equal(shared.resets, 0);
});

/* ───────────── Otra pestaña entra con OTRA cuenta ───────────── */

test('otra pestaña inicia sesión con otra cuenta: se limpia lo de la anterior y se hidrata la nueva, sin mezclar datos', async () => {
  await bootAs('A');
  shared.resets = 0;
  shared.meImpl = async () => ME('B');
  const tokenB = otherTabWrites('B', 'rt-B');

  // Inmediatamente: nada de A, y la UI está en «recuperando» (carga), no como invitado ni con datos de A.
  let s = useAuthStore.getState();
  assert.equal(s.user, null);
  assert.equal(s.sessionRecovering, true);

  await tick(); await tick(); await tick();
  s = useAuthStore.getState();
  assert.equal(shared.resets, 1, 'caché de queries, reproductor e imágenes de A limpiados');
  assert.equal(s.user?.id, 'B');
  assert.equal(s.status, 'authenticated');
  assert.equal(s.sessionRecovering, false);
  assert.equal(s.accessToken, tokenB);
  assert.equal(stored().refreshToken, 'rt-B', 'storage conserva la sesión de B');
  assert.equal(shared.logoutCalls, 0);
});

test('cambio de cuenta con un loadMe de A en vuelo: la respuesta tardía de A no pisa a B', async () => {
  await bootAs('A');
  const lateA = deferred();
  shared.meImpl = () => lateA.promise;
  const pendingA = useAuthStore.getState().loadMe();
  await tick();

  shared.meImpl = async () => ME('B');
  otherTabWrites('B', 'rt-B');
  await tick(); await tick(); await tick();
  assert.equal(useAuthStore.getState().user?.id, 'B');

  lateA.resolve(ME('A'));
  assert.equal(await pendingA, 'unauthorized');
  assert.equal(useAuthStore.getState().user?.id, 'B', 'sigue siendo B');
});

test('cambio de cuenta con un refresh de A en vuelo: su token tardío no pisa la sesión de B', async () => {
  await bootAs('A');
  memory.set(KEY, JSON.stringify({ accessToken: jwt('A', 5), refreshToken: 'rt-1', accessExpiresAt: Date.now() + 5_000, expiresAt: Date.now() + 30 * 86400000 }));
  const lateA = deferred();
  shared.refreshImpl = () => lateA.promise;
  const pendingA = useAuthStore.getState().refreshSession();
  await tick();

  shared.meImpl = async () => ME('B');
  const tokenB = otherTabWrites('B', 'rt-B');
  await tick(); await tick(); await tick();

  lateA.resolve(jwt('A'));
  await pendingA;
  assert.equal(useAuthStore.getState().accessToken, tokenB, 'el access token vigente es el de B');
  assert.equal(useAuthStore.getState().user?.id, 'B');
});

test('otra pestaña entra con otra cuenta y luego cierra sesión antes de que termine la hidratación: no queda nada', async () => {
  await bootAs('A');
  const lateB = deferred();
  shared.meImpl = () => lateB.promise;
  otherTabWrites('B', 'rt-B');
  await tick(); await tick();
  otherTabLogsOut();
  lateB.resolve(ME('B'));
  await tick(); await tick();
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(useAuthStore.getState().sessionRecovering, false);
  assert.equal(longTimers().length, 0);
});

test('una pestaña INVITADA ignora el login de otra (no hidrata ni solicita nada)', async () => {
  useAuthStore.setState({ user: null, accessToken: null, status: 'guest' });
  let meCalls = 0;
  shared.meImpl = async () => { meCalls += 1; return ME('B'); };
  otherTabWrites('B', 'rt-B');
  await tick();
  assert.equal(meCalls, 0);
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(shared.resets, 0);
});

/* ───────────── La bandera de cierre y los cierres concurrentes ───────────── */

test('mientras ESTA pestaña cierra sesión, el eco del evento storage no dispara un segundo cierre', async () => {
  await bootAs('A');
  shared.resets = 0;
  const slow = deferred();
  shared.logoutImpl = () => slow.promise;
  const closing = useAuthStore.getState().logout();
  await tick();
  otherTabLogsOut(); // otra pestaña (o el propio flujo) borra el storage mientras el servidor responde
  assert.equal(shared.resets, 0, 'sin reseteos duplicados mientras el logout está en curso');
  slow.resolve({ ok: true });
  await closing;
  assert.equal(shared.resets, 1, 'exactamente un reseteo');
  assert.equal(shared.logoutCalls, 1, 'una sola solicitud de logout');
});

test('la bandera de cierre es de ESTE logout: un refresh que termina durante el logout no restaura credenciales', async () => {
  await bootAs('A');
  assert.equal(shared.bound.getRefreshToken(), 'rt-1');
  const slow = deferred();
  shared.logoutImpl = () => slow.promise;
  const closing = useAuthStore.getState().logout();
  await tick();
  assert.equal(shared.bound.getRefreshToken(), null, 'durante el cierre el cliente no ve refresh token');
  slow.resolve({ ok: true });
  await closing;
  assert.equal(shared.bound.getRefreshToken(), null, 'tras el cierre tampoco (no hay sesión)');
  assert.equal(memory.has(KEY), false);
});

test('la bandera no queda pegada: tras un logout interrumpido por un login nuevo, el refresh token de la sesión nueva es visible', async () => {
  await bootAs('A');
  const slow = deferred();
  shared.logoutImpl = () => slow.promise;
  const closing = useAuthStore.getState().logout();
  await tick();
  assert.equal(shared.bound.getRefreshToken(), null);

  // Se inicia una sesión nueva en esta pestaña antes de que el servidor responda al logout.
  shared.loginImpl = async () => ({ accessToken: jwt('B'), refreshToken: 'rt-B' });
  shared.meImpl = async () => ME('B');
  await useAuthStore.getState().login('b@x.com', 'pw');
  assert.equal(shared.bound.getRefreshToken(), 'rt-B', 'la época nueva desactiva la bandera sin limpiezas manuales');

  slow.resolve({ ok: true });
  await closing;
  assert.equal(useAuthStore.getState().user?.id, 'B', 'el logout tardío NO pisa a la sesión nueva');
  assert.equal(stored().refreshToken, 'rt-B', 'ni borra sus tokens');
});

test('otra pestaña entra con OTRA cuenta mientras esta cierra sesión: el logout no borra los tokens de la cuenta nueva', async () => {
  await bootAs('A');
  const slow = deferred();
  shared.logoutImpl = () => slow.promise;
  const closing = useAuthStore.getState().logout();
  await tick();
  otherTabWrites('B', 'rt-B'); // ignorado por el evento (este logout está en curso), pero el storage ya es de B
  slow.resolve({ ok: true });
  await closing;
  assert.equal(stored()?.refreshToken, 'rt-B', 'la sesión de B en storage se conserva');
  assert.equal(useAuthStore.getState().user, null, 'esta pestaña sí queda cerrada');
  assert.equal(useAuthStore.getState().status, 'guest');
});

test('otra pestaña rotó los tokens de la MISMA cuenta durante el logout: el logout sí borra el storage (no queda una sesión viva)', async () => {
  await bootAs('A');
  const slow = deferred();
  shared.logoutImpl = () => slow.promise;
  const closing = useAuthStore.getState().logout();
  await tick();
  otherTabWrites('A', 'rt-rotado');
  slow.resolve({ ok: true });
  await closing;
  assert.equal(memory.has(KEY), false);
  assert.equal(useAuthStore.getState().user, null);
});
