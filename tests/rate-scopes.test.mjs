// Rate limit POR ALCANCE (lib/api/resilience.ts): un 429 solo frena lo de SU limitador. Sin red. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RETRY_AFTER_MS, noteRateLimit, parseRetryAfter, pollErrorDelayMs, queryPollDelayMs, rateLimitRemainingMs, rateLimitScopeOf, resetRateLimitGate,
  retryAfterFromBody, retryAfterFromHeaders, shouldRetryQuery,
} from '../src/lib/api/resilience.ts';

const err = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, code: 'X', ...extra });
test.beforeEach(() => resetRateLimitGate());

test('retryAfterFromBody: solo números de segundos válidos (respaldo cuando CORS no expone la cabecera)', () => {
  assert.equal(retryAfterFromBody({ retryAfterSec: 12 }), 12_000);
  assert.equal(retryAfterFromBody({ retryAfterSec: 0 }), 0);
  assert.equal(retryAfterFromBody({ retryAfterSec: 999_999 }), MAX_RETRY_AFTER_MS, 'acotado a la ventana del backend');
  for (const bad of [undefined, null, 'x', {}, { retryAfterSec: '12' }, { retryAfterSec: -1 }, { retryAfterSec: NaN }, { retryAfterSec: Infinity }]) {
    assert.equal(retryAfterFromBody(bad), undefined, JSON.stringify(bad));
  }
});

test('Retry-After por cabecera: plano y con get() (AxiosHeaders); valores inválidos se ignoran', () => {
  assert.equal(retryAfterFromHeaders({ 'retry-after': '7' }), 7000);
  assert.equal(retryAfterFromHeaders({ 'Retry-After': '3' }), 3000);
  assert.equal(retryAfterFromHeaders({ get: (k) => (k === 'retry-after' ? '9' : undefined) }), 9000);
  assert.equal(retryAfterFromHeaders({ 'retry-after': '-5' }), undefined);
  assert.equal(retryAfterFromHeaders(undefined), undefined);
});

test('la compuerta es POR ALCANCE: api, refresh y files no se bloquean entre sí', () => {
  noteRateLimit(10_000, 'api', 0);
  assert.equal(rateLimitRemainingMs('api', 0), 10_000);
  assert.equal(rateLimitRemainingMs('refresh', 0), 0, 'un 429 de la API no bloquea el refresh');
  assert.equal(rateLimitRemainingMs('files', 0), 0, 'ni los archivos');
  resetRateLimitGate();
  noteRateLimit(20_000, 'files', 0);
  assert.equal(rateLimitRemainingMs('files', 0), 20_000);
  assert.equal(rateLimitRemainingMs('api', 0), 0, 'un 429 de imágenes/audio NO frena las consultas normales');
  assert.equal(rateLimitRemainingMs('refresh', 0), 0, 'ni el refresh');
  resetRateLimitGate();
  noteRateLimit(5_000, 'refresh', 0);
  assert.equal(rateLimitRemainingMs('refresh', 0), 5_000);
  assert.equal(rateLimitRemainingMs('api', 0), 0);
  assert.equal(rateLimitRemainingMs('files', 0), 0);
});

test('el alcance por defecto es «api» y un 429 más corto no acorta la pausa de ese alcance', () => {
  noteRateLimit(8_000, undefined, 0);
  assert.equal(rateLimitRemainingMs(undefined, 0), 8_000);
  noteRateLimit(1_000, 'api', 0);
  assert.equal(rateLimitRemainingMs('api', 0), 8_000);
  noteRateLimit(undefined, 'files', 0);
  assert.equal(rateLimitRemainingMs('files', 0), 30_000, 'sin Retry-After: 30 s por defecto');
});

test('login/registro/recuperación, asistente y administración NO activan ninguna pausa global', () => {
  for (const scope of ['auth', 'assistant', 'admin']) {
    noteRateLimit(60_000, scope, 0);
    for (const s of ['api', 'refresh', 'files', 'auth', 'assistant', 'admin']) assert.equal(rateLimitRemainingMs(s, 0), 0, `${scope} → ${s}`);
  }
});

test('rateLimitScopeOf: prefijos reales del backend (relativas, absolutas, query, mayúsculas, barra final, baseURL)', () => {
  const base = '/api';
  const cases = [
    ['/auth/refresh', 'refresh'], ['/auth/refresh/', 'refresh'], ['/AUTH/Refresh', 'refresh'],
    ['/auth/login', 'auth'], ['/auth/register', 'auth'], ['/auth/forgot-password', 'auth'], ['/auth/reset-password', 'auth'],
    ['/auth/logout', 'api'], ['/auth/logout-all', 'api'], ['/auth/change-password', 'api'], ['/auth/refresh-token', 'api'],
    ['/assistant', 'assistant'], ['/assistant/lyrics', 'assistant'], ['/assistantx', 'api'],
    ['/admin/users', 'admin'], ['/admin', 'admin'], ['/administrator', 'api'],
    ['/files/abc/stream', 'files'], ['/files/abc/stream?st=1', 'files'], ['/files/abc/download', 'api'],
    ['/songs', 'api'], ['/users/me', 'api'], ['', 'api'], [null, 'api'], [undefined, 'api'],
    ['http://localhost:4000/api/auth/login', 'auth'], ['http://localhost:4000/api/auth/refresh', 'refresh'], ['https://x.test/api/files/1/stream', 'files'],
    ['/api/auth/login', 'auth'], ['/api/songs', 'api'],
  ];
  for (const [url, expected] of cases) assert.equal(rateLimitScopeOf(url, base), expected, String(url));
  assert.equal(rateLimitScopeOf('/auth/login'), 'auth', 'sin baseURL');
});

test('el poller y las consultas consultan SU alcance: una pausa de archivos no demora un error de API', () => {
  const r0 = () => 0;
  noteRateLimit(45_000, 'files'); // reloj real: pollErrorDelayMs / shouldRetryQuery / queryPollDelayMs consultan la hora actual
  assert.ok(pollErrorDelayMs(1000, 1, err(500), 60_000, r0, 'api') < 5_000, 'la API general no espera por archivos');
  assert.ok(pollErrorDelayMs(1000, 1, err(500), 60_000, r0, 'files') >= 44_000, 'el poller de archivos sí espera su pausa');
  assert.equal(shouldRetryQuery(0, err(500)), true, 'una consulta de API no queda frenada por una pausa de archivos');
  const q = { state: { status: 'success', errorUpdateCount: 0 } };
  assert.equal(queryPollDelayMs(q, 30_000), 30_000);
  resetRateLimitGate();
  noteRateLimit(120_000, 'api');
  assert.equal(shouldRetryQuery(0, err(500)), false, 'con la API en pausa no se reintenta');
  assert.ok(queryPollDelayMs(q, 30_000) >= 110_000, 'el sondeo de la API espera a su propia pausa');
});
