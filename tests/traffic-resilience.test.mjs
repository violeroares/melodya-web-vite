// Política de tráfico HTTP (lib/api/resilience.ts + lib/api/polling.ts): clasificación de errores, Retry-After, backoff, margen de refresh
// según la expiración REAL del token, reintentos de React Query y poller resiliente. Sin red. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessExpiryOf, backoffMs, classifyError, computeRefreshDelayMs, decodeJwtTimes, noteRateLimit, parseRetryAfter, pollErrorDelayMs, queryPollDelayMs,
  queryRetryDelayMs, rateLimitRemainingMs, refreshLeadMs, resetRateLimitGate, shouldRetryQuery,
} from '../src/lib/api/resilience.ts';
import { startPoller } from '../src/lib/api/polling.ts';

const err = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code: 'X', ...extra });
const jwt = (iat, exp) => `h.${Buffer.from(JSON.stringify({ iat, exp })).toString('base64url')}.s`;

test.beforeEach(() => resetRateLimitGate());

test('clasificación: 401 / 403 / 429 / red / servidor / resto de 4xx', () => {
  assert.equal(classifyError(err(401)), 'unauthorized');
  assert.equal(classifyError(err(403)), 'forbidden');
  assert.equal(classifyError(err(429)), 'rate-limited');
  assert.equal(classifyError(err(0, { code: 'NETWORK' })), 'network');
  assert.equal(classifyError(err(0, { code: 'TIMEOUT' })), 'network');
  assert.equal(classifyError(err(0, { code: 'API_NOT_CONFIGURED' })), 'client', 'sin backend configurado no es un corte de red');
  assert.equal(classifyError(err(502)), 'server');
  assert.equal(classifyError(err(404)), 'client');
  assert.equal(classifyError({ code: 'ERR_NETWORK' }), 'network', 'AxiosError sin respuesta');
  assert.equal(classifyError({ response: { status: 429 } }), 'rate-limited', 'AxiosError con respuesta');
  assert.equal(classifyError(null), 'unknown');
});

test('Retry-After: segundos, fecha HTTP, inválido y tope', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(' 2.5 '), 2500);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 10_000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:29:00 GMT')), 0, 'fecha pasada → 0');
  assert.equal(parseRetryAfter('basura'), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter('999999'), 15 * 60_000, 'nunca más que la ventana del backend (15 min)');
});

test('compuerta global de 429', () => {
  assert.equal(rateLimitRemainingMs(), 0);
  noteRateLimit(4000, 1_000);
  assert.equal(rateLimitRemainingMs(2_000), 3000);
  noteRateLimit(1000, 1_000); // un 429 más corto no acorta el bloqueo vigente
  assert.equal(rateLimitRemainingMs(2_000), 3000);
  assert.equal(rateLimitRemainingMs(10_000), 0);
  noteRateLimit(undefined, 0);
  assert.equal(rateLimitRemainingMs(0), 30_000, 'sin Retry-After se pausa 30 s por defecto');
});

test('backoff: exponencial, con tope y jitter acotado', () => {
  const r0 = () => 0;
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffMs(1000, n, 8000, 0.2, r0)), [1000, 2000, 4000, 8000, 8000]);
  assert.equal(backoffMs(1000, 1, 8000, 0.2, () => 1), 1200);
  // El error de polling nunca espera menos que Retry-After ni que la compuerta.
  assert.ok(pollErrorDelayMs(1000, 1, err(429, { retryAfterMs: 20_000 }), 60_000, r0) >= 20_000);
  noteRateLimit(45_000);
  assert.ok(pollErrorDelayMs(1000, 1, err(500), 60_000, r0) >= 44_000);
});

test('refresh proactivo: se agenda con la expiración REAL del token (no con un TTL fijo)', () => {
  const now = 1_000_000_000_000;
  const r0 = () => 0;
  // TTL por defecto del backend (900 s): margen 2 min → ≈ 13 min.
  assert.equal(computeRefreshDelayMs({ now, exp: now + 900_000, iat: now, rand: r0 }), 780_000);
  // TTL configurado a 60 s: margen del 20 % (12 s) → 48 s, NO 13 min ni un bucle apretado.
  assert.equal(computeRefreshDelayMs({ now, exp: now + 60_000, iat: now, rand: r0 }), 48_000);
  // TTL de 1 h: el margen se topa en 2 min.
  assert.equal(computeRefreshDelayMs({ now, exp: now + 3_600_000, iat: now, rand: r0 }), 3_480_000);
  // Token ya vencido o por vencer: mínimo de 5 s (nunca 0).
  assert.equal(computeRefreshDelayMs({ now, exp: now - 10_000, iat: now - 900_000, rand: r0 }), 5000);
  // Jitter ≤ 10 s para que varias pestañas no coincidan.
  const j = computeRefreshDelayMs({ now, exp: now + 900_000, iat: now, rand: () => 0.999 });
  assert.ok(j > 780_000 && j <= 790_000);
  // El jitter nunca supera la mitad del margen: con un TTL de 20 s (margen 5 s) la renovación llega antes de que el token venza.
  const shortTtl = computeRefreshDelayMs({ now, exp: now + 20_000, iat: now, rand: () => 0.999 });
  assert.ok(shortTtl <= 20_000 - 5_000 + 2_500, `TTL 20 s: renueva antes del vencimiento (${shortTtl} ms)`);
  assert.equal(refreshLeadMs(900_000), 120_000);
  assert.equal(refreshLeadMs(10_000), 5000);
});

test('el bug original (exp − 13 min con TTL de 15 min = 2 min) ya no ocurre', () => {
  const now = 1_000_000_000_000;
  const ms = computeRefreshDelayMs({ now, exp: now + 900_000, iat: now, rand: () => 0 });
  assert.ok(ms >= 10 * 60_000, `un token de 15 min se renueva a los ~13 min, no a los 2 (ms=${ms})`);
});

test('JWT: exp/iat reales; sin exp se usa el TTL de respaldo; basura no rompe', () => {
  const t = decodeJwtTimes(jwt(1000, 1900));
  assert.deepEqual(t, { exp: 1_900_000, iat: 1_000_000 });
  assert.equal(accessExpiryOf(jwt(1000, 1900), 5), 1_900_000);
  assert.equal(accessExpiryOf('no-es-jwt', 5), 5 + 15 * 60_000);
  assert.deepEqual(decodeJwtTimes('a.%%%.c'), {});
  assert.deepEqual(decodeJwtTimes(null), {});
});

test('React Query: 429/403/404/401 sin reintento; red y 5xx acotados; con la compuerta activa nunca', () => {
  for (const s of [401, 403, 404, 422, 429]) assert.equal(shouldRetryQuery(0, err(s)), false, `HTTP ${s}`);
  assert.equal(shouldRetryQuery(0, err(0, { code: 'NETWORK' })), true);
  assert.equal(shouldRetryQuery(1, err(0, { code: 'NETWORK' })), true);
  assert.equal(shouldRetryQuery(2, err(0, { code: 'NETWORK' })), false, 'máx. 2 reintentos');
  assert.equal(shouldRetryQuery(0, err(503)), true);
  assert.equal(shouldRetryQuery(2, err(503)), false);
  assert.equal(shouldRetryQuery(0, err(500)), true);
  assert.equal(shouldRetryQuery(1, err(500)), false, 'un 500 se reintenta una sola vez');
  noteRateLimit(5000);
  assert.equal(shouldRetryQuery(0, err(503)), false, 'con un 429 vigente no se reintenta nada');
  resetRateLimitGate();
  assert.ok(queryRetryDelayMs(1) >= 1000 && queryRetryDelayMs(1) <= 1200);
  assert.ok(queryRetryDelayMs(3) >= 4000);
  assert.ok(queryRetryDelayMs(1, err(503, { retryAfterMs: 9000 })) >= 9000);
});

test('refetchInterval dinámico: periodo normal, backoff con error, respeta Retry-After', () => {
  const ok = { state: { status: 'success', errorUpdateCount: 0 } };
  assert.equal(queryPollDelayMs(ok, 30_000), 30_000);
  const e1 = { state: { status: 'error', errorUpdateCount: 1, error: err(500) } };
  const e3 = { state: { status: 'error', errorUpdateCount: 3, error: err(500) } };
  assert.ok(queryPollDelayMs(e1, 30_000) >= 30_000);
  assert.ok(queryPollDelayMs(e3, 30_000) >= 120_000, 'crece con los fallos consecutivos');
  assert.ok(queryPollDelayMs({ state: { status: 'error', errorUpdateCount: 1, error: err(429, { retryAfterMs: 200_000 }) } }, 30_000) >= 200_000);
  assert.equal(queryPollDelayMs({ state: { status: 'error', errorUpdateCount: 1, error: err(403) } }, 30_000), 5 * 60_000, 'permanente: casi no insistir');
});

/* ── Poller con reloj y visibilidad simulados ───────────── */

function fakeEnv() {
  const timers = [];
  const listeners = new Set();
  const env = {
    hidden: false,
    timers,
    isHidden: () => env.hidden,
    onVisible: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    setTimer: (cb, ms) => { const h = { cb, ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    rand: () => 0,
    show: () => { env.hidden = false; for (const l of [...listeners]) l(); },
    /** Dispara el temporizador pendiente (si lo hay) y deja correr las promesas. */
    fire: async () => { const h = timers.shift(); h?.cb(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); return h?.ms; },
    pending: () => timers.map((t) => t.ms),
  };
  return env;
}
const flush = () => new Promise((r) => setImmediate(r));

test('poller: éxito → siguiente ciclo tras la espera base, sin solaparse', async () => {
  const env = fakeEnv();
  let calls = 0;
  const p = startPoller({ baseMs: 2500, env, run: async () => { calls++; } });
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(env.pending(), [2500]);
  await env.fire();
  assert.equal(calls, 2);
  p.stop();
  assert.deepEqual(env.pending(), [], 'stop limpia el temporizador');
});

test('poller: 429 NO detiene el seguimiento; espera ≥ Retry-After y se recupera solo', async () => {
  const env = fakeEnv();
  let mode = 'limited';
  let recovered = 0;
  const p = startPoller({
    baseMs: 2500, env, onRecovered: () => recovered++,
    run: async () => { if (mode === 'limited') throw err(429, { retryAfterMs: 30_000 }); },
  });
  await flush();
  assert.equal(p.failures, 1);
  assert.ok(env.pending()[0] >= 30_000, `espera ≥ Retry-After (${env.pending()[0]})`);
  for (let i = 0; i < 4; i++) await env.fire(); // varios 429 seguidos: nunca se rinde
  assert.ok(p.failures >= 4);
  assert.equal(env.pending().length, 1, 'sigue agendado');
  mode = 'ok';
  await env.fire();
  assert.equal(p.failures, 0);
  assert.equal(recovered, 1);
  assert.deepEqual(env.pending(), [2500], 'vuelve al ritmo normal');
  p.stop();
});

test('poller: red / 5xx → backoff creciente con tope, sin detenerse nunca', async () => {
  const env = fakeEnv();
  const p = startPoller({ baseMs: 1000, maxBackoffMs: 8000, env, run: async () => { throw err(503); } });
  await flush();
  const delays = [env.pending()[0]];
  for (let i = 0; i < 6; i++) delays.push(await env.fire().then(() => env.pending()[0]));
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 8000]);
  assert.equal(env.pending().length, 1);
  p.stop();
});

test('poller: error PERMANENTE (404/403) detiene el ciclo; estado terminal también', async () => {
  const env = fakeEnv();
  startPoller({ baseMs: 1000, env, run: async () => { throw err(404); } });
  await flush();
  assert.deepEqual(env.pending(), [], '404: no se insiste');
  const env2 = fakeEnv();
  let n = 0;
  startPoller({ baseMs: 1000, env: env2, run: async () => (++n >= 2 ? 'stop' : undefined) });
  await flush();
  await env2.fire();
  assert.deepEqual(env2.pending(), [], 'terminal: se detiene');
  assert.equal(n, 2);
});

test('poller: pestaña oculta pausa TODO (sin temporizador); al volver consulta de inmediato', async () => {
  const env = fakeEnv();
  env.hidden = true;
  let calls = 0;
  startPoller({ baseMs: 1000, env, run: async () => { calls++; } });
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(env.pending(), []);
  env.show();
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(env.pending(), [1000]);
});

test('poller: con la compuerta de 429 activa no consulta hasta que termine el bloqueo', async () => {
  const env = fakeEnv();
  noteRateLimit(20_000);
  let calls = 0;
  const p = startPoller({ baseMs: 1000, env, run: async () => { calls++; } });
  await flush();
  assert.equal(calls, 0, 'no se envía nada durante el bloqueo');
  assert.ok(env.pending()[0] >= 19_000);
  resetRateLimitGate();
  await env.fire();
  assert.equal(calls, 1);
  p.stop();
});

test('poller: poke no se solapa con un ciclo en curso', async () => {
  const env = fakeEnv();
  let inFlight = 0, max = 0, release;
  const gate = new Promise((r) => (release = r));
  const p = startPoller({ baseMs: 1000, env, run: async () => { inFlight++; max = Math.max(max, inFlight); await gate; inFlight--; } });
  await flush();
  p.poke(); p.poke();
  await flush();
  assert.equal(max, 1);
  release();
  p.stop();
});
