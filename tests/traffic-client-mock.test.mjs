// Cliente HTTP REAL (src/lib/api/client.ts) contra el backend simulado LOCAL (scripts/mock-api.mjs, puerto libre en 127.0.0.1).
// NO hay tráfico hacia api-dev ni producción. Verifica: 401 → refresh único → replay, sin bucles, 429 + Retry-After sin cerrar la sesión,
// recuperación tras el bloqueo, 5xx/red como transitorios, refresh concurrente único y reintentos de React Query.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { startMockApi } from '../scripts/mock-api.mjs';

const mock = await startMockApi();
process.env.VITE_API_BASE_URL = mock.apiBase;

// Mínimo de navegador que usa el cliente para el lock de refresh entre pestañas.
const mem = new Map();
const localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
globalThis.localStorage = localStorage;
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };

const { client, getData, ApiError, bindAuthCallbacks, resetRefreshBlock, API_BASE } = await import('../src/lib/api/client.ts');
const { resetRateLimitGate, rateLimitRemainingMs, shouldRetryQuery, queryRetryDelayMs } = await import('../src/lib/api/resilience.ts');

assert.equal(API_BASE, mock.apiBase, 'el cliente apunta al mock local, no al backend compartido');
assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/api$/.test(API_BASE));

let session;
let unauthorized;
const count = async (key) => (await mock.stats()).counts[key] ?? 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sesión con access token VENCIDO (para forzar el camino 401 → refresh) y un refresh token vigente. */
async function expiredSession() {
  await mock.ctl({ accessTtlSec: -30 });
  const t = mock.issueTokens();
  await mock.ctl({ accessTtlSec: 900 });
  return { accessToken: t.accessToken, refreshToken: t.refreshToken };
}

test.beforeEach(async () => {
  await mock.ctl({ reset: true });
  resetRateLimitGate();
  resetRefreshBlock();
  mem.clear();
  unauthorized = 0;
  session = await expiredSession();
  bindAuthCallbacks({
    getAccessToken: () => session.accessToken,
    getRefreshToken: () => session.refreshToken,
    onRefreshed: (s) => { session = { accessToken: s.accessToken, refreshToken: s.refreshToken }; },
    onUnauthorized: () => { unauthorized += 1; },
  });
});

test.after(async () => { await mock.close(); });

test('401 con token vencido → UN refresh → replay exitoso (sesión persistida)', async () => {
  const before = session.accessToken;
  const me = await getData('/users/me');
  assert.equal(me.id, 'me1');
  assert.notEqual(session.accessToken, before, 'el token se renovó');
  assert.equal(await count('POST /api/auth/refresh'), 1);
  assert.equal(await count('GET /api/users/me'), 2, 'una vez rechazada (401) y una vez repetida');
  assert.equal(unauthorized, 0);
  const stored = JSON.parse(mem.get('melodya.session'));
  assert.ok(stored.accessExpiresAt > Date.now() + 800_000, 'accessExpiresAt sale del `exp` real del token (≈15 min), no de un valor supuesto');
});

test('varias peticiones concurrentes con token vencido comparten UN solo refresh', async () => {
  await Promise.all(Array.from({ length: 6 }, () => getData('/users/me')));
  assert.equal(await count('POST /api/auth/refresh'), 1);
  assert.equal(unauthorized, 0);
});

test('sin bucle 401 → refresh → 401: si el replay también devuelve 401 se rinde, con UN refresh', async () => {
  await mock.ctl({ accessTtlSec: -30 }); // los tokens que emite el refresh ya nacen vencidos
  await assert.rejects(() => getData('/users/me'), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(await count('POST /api/auth/refresh'), 1, 'exactamente un refresh');
  assert.equal(await count('GET /api/users/me'), 2, 'la petición original y su único replay');
  assert.equal(unauthorized, 0, 'un 401 del replay no es un rechazo del refresh');
});

test('refresh → 429: la sesión se CONSERVA, el error lleva Retry-After y no hay más refresh durante el bloqueo', async () => {
  await mock.ctl({ refreshMode: '429', retryAfterSec: 2 });
  const tokensBefore = { ...session };
  await assert.rejects(() => getData('/users/me'), (e) => e instanceof ApiError && e.status === 429 && e.retryAfterMs >= 1000 && e.retryAfterMs <= 2100);
  assert.equal(unauthorized, 0, 'un 429 NO cierra la sesión');
  assert.deepEqual(session, tokensBefore, 'los tokens siguen intactos');
  assert.equal(await count('POST /api/auth/refresh'), 1);
  assert.ok(rateLimitRemainingMs() > 0, 'la compuerta global queda activa');

  // Durante el bloqueo: ni un solo POST /auth/refresh más (cada intento contaría contra el límite).
  await assert.rejects(() => getData('/users/me'), (e) => e.status === 429);
  await assert.rejects(() => getData('/users/me'), (e) => e.status === 429);
  assert.equal(await count('POST /api/auth/refresh'), 1, 'sin ráfagas de refresh mientras dura el bloqueo');

  // Recuperación: pasado el Retry-After y con el backend sano, la misma sesión se renueva sola.
  await mock.ctl({ refreshMode: 'ok' });
  await sleep(2200);
  const me = await getData('/users/me');
  assert.equal(me.id, 'me1');
  assert.equal(await count('POST /api/auth/refresh'), 2);
  assert.equal(unauthorized, 0);
});

test('refresh → 401 (token revocado) SÍ es definitivo: cierra la sesión una vez', async () => {
  await mock.ctl({ refreshMode: '401' });
  await assert.rejects(() => getData('/users/me'), (e) => e instanceof ApiError && e.status === 401);
  assert.equal(unauthorized, 1);
  assert.equal(await count('POST /api/auth/refresh'), 1);
});

test('refresh → 500 o corte de red: transitorio, NO cierra la sesión y conserva el error real', async () => {
  await mock.ctl({ refreshMode: '500' });
  await assert.rejects(() => getData('/users/me'), (e) => e instanceof ApiError && e.status === 500);
  await mock.ctl({ refreshMode: 'drop' });
  await assert.rejects(() => getData('/users/me'), (e) => e instanceof ApiError && e.status === 0);
  assert.equal(unauthorized, 0);
  assert.equal(await count('POST /api/auth/refresh'), 2, 'un intento por petición, sin reintentos a ciegas');
});

test('límite del backend (contador): 429 con Retry-After y recuperación al terminar la ventana', async () => {
  const tokens = mock.issueTokens();
  session = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  await mock.ctl({ limit: { max: 3, windowSec: 2 } });
  for (let i = 0; i < 3; i++) assert.equal((await getData('/community/songs')).items.length, 3);
  const e = await getData('/community/songs').catch((x) => x);
  assert.ok(e instanceof ApiError && e.status === 429 && e.code === 'RATE_LIMITED');
  assert.ok(e.retryAfterMs >= 1000 && e.retryAfterMs <= 2000, `Retry-After leído de la cabecera (${e.retryAfterMs})`);
  assert.equal(unauthorized, 0);
  await sleep(2200); // la ventana fija termina: vuelve a funcionar sin reiniciar nada
  assert.equal((await getData('/community/songs')).items.length, 3);
});

test('React Query con el cliente real: un 429 NO se reintenta; un 500 se reintenta UNA vez; red acotada', async () => {
  const tokens = mock.issueTokens();
  session = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: () => 5 } } });

  // 429
  await mock.ctl({ meMode: '429', retryAfterSec: 1 });
  await assert.rejects(() => qc.fetchQuery({ queryKey: ['me-429'], queryFn: () => getData('/users/me') }));
  assert.equal(await count('GET /api/users/me'), 1, '429: exactamente 1 solicitud (sin reintento inmediato)');

  // 500
  resetRateLimitGate();
  await mock.ctl({ reset: true, meMode: '500' });
  await assert.rejects(() => qc.fetchQuery({ queryKey: ['me-500'], queryFn: () => getData('/users/me') }));
  assert.equal(await count('GET /api/users/me'), 2, '500: la original + 1 reintento');

  // 404
  await mock.ctl({ reset: true });
  await assert.rejects(() => qc.fetchQuery({ queryKey: ['gone'], queryFn: () => getData('/community/songs/nope') }));
  assert.equal(await count('GET /api/community/songs/nope'), 1, '404: una sola solicitud (no se reintenta)');
  assert.ok(queryRetryDelayMs(1) >= 1000);
});

test('polling REST de una generación: progreso → completada; 429 pausa y retoma; 404 se detiene', async () => {
  const tokens = mock.issueTokens();
  session = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  const { startPoller } = await import('../src/lib/api/polling.ts');
  const env = { isHidden: () => false, onVisible: () => () => {}, setTimer: (cb, ms) => setTimeout(cb, Math.min(ms, 30)), clearTimer: (h) => clearTimeout(h), rand: () => 0 };

  // Progreso normal: 3 consultas y termina (estado terminal → el poller se detiene solo).
  await mock.ctl({ completeAfter: 3 });
  const seen = [];
  await new Promise((resolve) => {
    startPoller({ baseMs: 10, env, run: async () => { const g = await getData('/generations/gen-A'); seen.push(g.status); if (g.status === 'COMPLETED') return 'stop'; } });
    const t = setInterval(() => { if (seen.includes('COMPLETED')) { clearInterval(t); resolve(); } }, 5);
  });
  assert.deepEqual(seen, ['PROCESSING', 'PROCESSING', 'COMPLETED']);
  await sleep(80);
  assert.equal(await count('GET /api/generations/:gen'), 3, 'tras el estado terminal no hay más solicitudes');

  // 429 durante el seguimiento: no se rinde; reanuda cuando termina el bloqueo.
  await mock.ctl({ reset: true, completeAfter: 2, genMode: '429', retryAfterSec: 1 });
  resetRateLimitGate();
  let done = false;
  const failures = [];
  const poller = startPoller({
    baseMs: 10, env: { ...env, setTimer: (cb, ms) => setTimeout(cb, Math.min(ms, 400)) },
    onError: (e) => failures.push(e.status),
    run: async () => { const g = await getData('/generations/gen-B'); if (g.status === 'COMPLETED') { done = true; return 'stop'; } },
  });
  await sleep(150);
  assert.ok(failures.length >= 1 && failures.every((s) => s === 429), 'recibió 429');
  const requestsDuringBlock = await count('GET /api/generations/:gen');
  await sleep(300);
  assert.ok((await count('GET /api/generations/:gen')) - requestsDuringBlock <= 1, 'durante el bloqueo no se insiste');
  await mock.ctl({ genMode: 'ok' });
  for (let i = 0; i < 60 && !done; i++) await sleep(100);
  assert.ok(done, 'el seguimiento SE REANUDA y termina tras el bloqueo temporal');
  poller.stop();

  // 404 permanente: se detiene.
  await mock.ctl({ reset: true, genMode: '404' });
  resetRateLimitGate();
  let stoppedErr;
  const p404 = startPoller({ baseMs: 10, env, onError: (e) => { stoppedErr = e.status; }, run: async () => { await getData('/generations/gen-C'); } });
  await sleep(150);
  assert.equal(stoppedErr, 404);
  assert.equal(await count('GET /api/generations/:gen'), 1, '404: una sola consulta, no se insiste');
  p404.stop();
});
