// Cliente HTTP REAL (src/lib/api/client.ts) contra un servidor LOCAL mínimo que devuelve 429 por ruta: la pausa se registra en el alcance de
// la ruta que falló (api / refresh) y NO en las demás; login, asistente y administración no activan ninguna pausa; Retry-After sale de la
// cabecera o, sin ella, de retryAfterSec del cuerpo; un 503 conserva su Retry-After. Sin tráfico hacia api-dev ni producción.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const state = { counts: {}, mode: {}, refreshOk: true };
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  state.counts[path] = (state.counts[path] ?? 0) + 1;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', ...headers });
    res.end(JSON.stringify(body));
  };
  req.resume();
  req.on('end', () => {
    const m = state.mode[path];
    if (m === '429-header') return send(429, { error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes' } }, { 'retry-after': '7' });
    if (m === '429-body') return send(429, { error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes', retryAfterSec: 11 } });
    if (m === '429-none') return send(429, { error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes' } });
    if (m === '429-both') return send(429, { error: { code: 'RATE_LIMITED', message: 'x', retryAfterSec: 99 } }, { 'retry-after': '3' });
    if (m === '503') return send(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Mantenimiento' } }, { 'retry-after': '20' });
    if (path === '/api/auth/refresh') return send(200, { data: { accessToken: 'a.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url') + '.s', refreshToken: 'rt-nuevo' } });
    return send(200, { data: { ok: true } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${server.address().port}/api`;

const mem = new Map();
const localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
globalThis.localStorage = localStorage;
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };

const { client, getData, bindAuthCallbacks, resetRefreshBlock, performRefresh } = await import('../src/lib/api/client.ts');
const { noteRateLimit, rateLimitRemainingMs, resetRateLimitGate } = await import('../src/lib/api/resilience.ts');

let session;
bindAuthCallbacks({
  getAccessToken: () => session.accessToken,
  getRefreshToken: () => session.refreshToken,
  onRefreshed: (s) => { session = { accessToken: s.accessToken, refreshToken: s.refreshToken }; },
  onUnauthorized: () => {},
});
const remaining = () => Object.fromEntries(['api', 'refresh', 'files', 'auth', 'assistant', 'admin'].map((s) => [s, rateLimitRemainingMs(s)]));
const paused = (scope) => rateLimitRemainingMs(scope) > 0;
const failure = async (path) => getData(path).then(() => null, (e) => e);

test.beforeEach(() => {
  state.counts = {};
  state.mode = {};
  mem.clear();
  session = { accessToken: 'tok', refreshToken: 'rt-1' };
  resetRateLimitGate();
  resetRefreshBlock();
});
test.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

test('429 de una consulta de la API: pausa SOLO el alcance «api» (Retry-After de la cabecera)', async () => {
  state.mode['/api/songs'] = '429-header';
  const e = await failure('/songs');
  assert.equal(e.status, 429);
  assert.equal(e.retryAfterMs, 7000);
  assert.ok(paused('api') && rateLimitRemainingMs('api') <= 7000);
  assert.equal(rateLimitRemainingMs('refresh'), 0, 'no bloquea el refresh');
  assert.equal(rateLimitRemainingMs('files'), 0, 'no bloquea imágenes ni audio');
});

test('sin cabecera legible, el 429 usa retryAfterSec del cuerpo; con ambas gana la cabecera; sin ninguna, pausa por defecto de 30 s', async () => {
  state.mode['/api/songs'] = '429-body';
  const body = await failure('/songs');
  assert.equal(body.retryAfterMs, 11_000);
  assert.ok(rateLimitRemainingMs('api') > 10_000 && rateLimitRemainingMs('api') <= 11_000);
  resetRateLimitGate();
  state.mode['/api/songs'] = '429-both';
  assert.equal((await failure('/songs')).retryAfterMs, 3000, 'la cabecera prevalece sobre el cuerpo');
  resetRateLimitGate();
  state.mode['/api/songs'] = '429-none';
  const none = await failure('/songs');
  assert.equal(none.retryAfterMs, undefined);
  assert.ok(rateLimitRemainingMs('api') > 29_000, 'pausa por defecto');
});

test('el mensaje y el código del 429 no cambian (compatibilidad con la interfaz)', async () => {
  state.mode['/api/songs'] = '429-header';
  const e = await failure('/songs');
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.message, 'Demasiadas solicitudes');
});

test('un 429 de login / registro / recuperación NO activa ninguna pausa global', async () => {
  for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password']) {
    state.mode[path] = '429-header';
    const e = await client.post(path.replace('/api', ''), {}).then(() => null, (err) => err);
    assert.equal(e.status, 429, path);
    assert.deepEqual(remaining(), { api: 0, refresh: 0, files: 0, auth: 0, assistant: 0, admin: 0 }, `${path}: nada queda en pausa`);
  }
});

test('un 429 del asistente o de administración NO activa ninguna pausa global', async () => {
  for (const path of ['/api/assistant/lyrics', '/api/admin/users']) {
    state.mode[path] = '429-header';
    const e = await failure(path.replace('/api', ''));
    assert.equal(e.status, 429, path);
    assert.equal(paused('api') || paused('refresh') || paused('files'), false, `${path} no pausa nada`);
  }
});

test('logout y cambio de contraseña pasan por el limitador GENERAL: su 429 sí pausa la API (no el refresh)', async () => {
  for (const path of ['/api/auth/logout', '/api/auth/change-password']) {
    resetRateLimitGate();
    state.mode[path] = '429-header';
    const e = await client.post(path.replace('/api', ''), {}).then(() => null, (err) => err);
    assert.equal(e.status, 429);
    assert.ok(paused('api'), path);
    assert.equal(paused('refresh'), false, path);
  }
});

test('503 con Retry-After: se conserva en el error y NO registra pausa (no es un 429)', async () => {
  state.mode['/api/songs'] = '503';
  const e = await failure('/songs');
  assert.equal(e.status, 503);
  assert.equal(e.retryAfterMs, 20_000, 'se mantiene el Retry-After del 503');
  assert.equal(paused('api') || paused('refresh') || paused('files'), false);
});

test('429 del REFRESH: pausa SOLO «refresh»; el siguiente intento falla sin solicitud y la API sigue libre', async () => {
  state.mode['/api/auth/refresh'] = '429-header';
  const e = await performRefresh().then(() => null, (err) => err);
  assert.equal(e.status, 429);
  assert.equal(e.retryAfterMs, 7000);
  assert.equal(state.counts['/api/auth/refresh'], 1, 'una sola solicitud, sin reintento ciego');
  assert.ok(paused('refresh'));
  assert.equal(paused('api'), false, 'un 429 del refresh no bloquea las consultas');
  assert.equal(paused('files'), false);
  const again = await performRefresh().then(() => null, (err) => err);
  assert.equal(again.status, 429);
  assert.equal(state.counts['/api/auth/refresh'], 1, 'mientras dura la pausa no se le pega de nuevo al backend');
  assert.equal(await getData('/songs').then((d) => d.ok), true, 'la API general sigue funcionando');
});

test('refreshBlockedUntil sigue siendo el piso local del refresh y resetRefreshBlock lo limpia', async () => {
  state.mode['/api/auth/refresh'] = '429-none';
  await performRefresh().then(() => null, (e) => e);
  resetRateLimitGate(); // la pausa del alcance se borra pero el bloqueo local del refresh permanece
  const blocked = await performRefresh().then(() => null, (e) => e);
  assert.equal(blocked.status, 429);
  assert.equal(state.counts['/api/auth/refresh'], 1, 'el bloqueo local evitó la segunda solicitud');
  resetRefreshBlock();
  state.mode['/api/auth/refresh'] = undefined;
  assert.equal(typeof (await performRefresh()), 'string', 'tras limpiar el bloqueo el refresh vuelve a salir');
});

test('un 429 de la API general o de los archivos NO impide renovar la sesión', async () => {
  for (const scope of ['api', 'files']) {
    state.counts = {};
    resetRateLimitGate();
    noteRateLimit(120_000, scope);
    const token = await performRefresh();
    assert.equal(typeof token, 'string', `pausa de ${scope}`);
    assert.equal(state.counts['/api/auth/refresh'], 1);
  }
});
