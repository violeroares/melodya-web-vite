// Cliente HTTP real (src/lib/api/client.ts) contra un servidor local: comportamiento del interceptor ante un 401
// en POST /assistant/lyrics. Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const requests = [];
let respond = () => ({ status: 200, body: { data: {} } });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    const { status, body } = respond(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.VITE_API_BASE_URL = `http://127.0.0.1:${server.address().port}/api`;

// El cliente coordina el refresh con localStorage/eventos de `window` (cross-tab). Node no los tiene: se simula
// un `window` mínimo en memoria (sin tocar código de producción) para que el flujo de refresh se ejecute de verdad.
const memory = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: (k) => { memory.delete(k); },
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
};

const { client, bindAuthCallbacks, postDataWithStatus, ApiError } = await import('../src/lib/api/client.ts');

let unauthorizedCalls = 0;
let refreshToken = 'rt-1';
let accessToken = 'at-1';
bindAuthCallbacks({
  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,
  onRefreshed: (tokens) => { accessToken = tokens.accessToken; },
  onUnauthorized: () => { unauthorizedCalls += 1; },
});

test.beforeEach(() => {
  requests.length = 0;
  unauthorizedCalls = 0;
  refreshToken = 'rt-1';
  accessToken = 'at-1';
});
test.after(() => server.close());

const lyricsPosts = () => requests.filter((r) => r.url.endsWith('/assistant/lyrics'));
const refreshes = () => requests.filter((r) => r.url.endsWith('/auth/refresh'));

test('postDataWithStatus devuelve el estado HTTP y data (200 vs 202) y envía Idempotency-Key', async () => {
  respond = () => ({ status: 202, body: { data: { operation: { id: 'op1', status: 'PROCESSING' } } } });
  const r = await postDataWithStatus('/assistant/lyrics', { idea: 'x' }, { headers: { 'Idempotency-Key': 'mly-clave-estable' }, replayOnlyOnAuth401: true });
  assert.equal(r.status, 202);
  assert.deepEqual(r.data, { operation: { id: 'op1', status: 'PROCESSING' } });
  assert.equal(lyricsPosts()[0].headers['idempotency-key'], 'mly-clave-estable');

  respond = () => ({ status: 200, body: { data: { lyrics: 'letra' } } });
  assert.equal((await postDataWithStatus('/assistant/lyrics', {}, { replayOnlyOnAuth401: true })).status, 200);
});

test('401 REENVIADO por el proveedor (code distinto de UNAUTHORIZED) en el asistente: UN solo POST, sin refresh ni repetición ni cierre de sesión', async () => {
  respond = () => ({ status: 401, body: { error: { code: 'INTERNAL', message: 'HTTP 401 de proveedor x' } } });
  await assert.rejects(
    postDataWithStatus('/assistant/lyrics', { idea: 'x' }, { headers: { 'Idempotency-Key': 'mly-clave-estable' }, replayOnlyOnAuth401: true }),
    (err) => err instanceof ApiError && err.status === 401 && err.code === 'INTERNAL',
  );
  assert.equal(lyricsPosts().length, 1, 'el POST no se repite');
  assert.equal(refreshes().length, 0, 'no se intenta refrescar la sesión');
  assert.equal(unauthorizedCalls, 0, 'no se cierra la sesión');
});

test('401 de AUTENTICACIÓN real + refresh EXITOSO: el POST se reenvía UNA vez con la MISMA Idempotency-Key y el token nuevo', async () => {
  let lyricsCalls = 0;
  respond = (req) => {
    if (req.url.endsWith('/auth/refresh')) return { status: 200, body: { data: { accessToken: 'at-2', refreshToken: 'rt-2' } } };
    lyricsCalls += 1;
    return lyricsCalls === 1
      ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expirado' } } }
      : { status: 200, body: { data: { title: 'T', lyrics: 'letra' } } };
  };
  const r = await postDataWithStatus('/assistant/lyrics', { idea: 'x' }, { headers: { 'Idempotency-Key': 'mly-clave-estable' }, replayOnlyOnAuth401: true });
  assert.equal(r.status, 200);
  assert.equal(refreshes().length, 1, 'un solo refresh');
  assert.equal(lyricsPosts().length, 2, 'el original (401, rechazado antes del servicio) y UN reenvío');
  assert.equal(lyricsPosts()[0].headers['idempotency-key'], 'mly-clave-estable');
  assert.equal(lyricsPosts()[1].headers['idempotency-key'], 'mly-clave-estable', 'misma clave en el reenvío');
  assert.equal(lyricsPosts()[1].headers.authorization, 'Bearer at-2', 'con el token renovado');
  assert.equal(lyricsPosts()[1].body, lyricsPosts()[0].body, 'mismo payload');
  assert.equal(unauthorizedCalls, 0);
});

test('401 de AUTENTICACIÓN real (code UNAUTHORIZED) en el asistente: se conserva el refresh de siempre', async () => {
  respond = (req) => (req.url.endsWith('/auth/refresh')
    ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'refresh inválido' } } }
    : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Token expirado' } } });
  await assert.rejects(postDataWithStatus('/assistant/lyrics', { idea: 'x' }, { replayOnlyOnAuth401: true }), (err) => err instanceof ApiError && err.status === 401);
  assert.ok(refreshes().length >= 1, 'sí intenta refrescar');
  assert.equal(lyricsPosts().length, 1, 'el refresh falló: no hay repetición');
  assert.equal(unauthorizedCalls, 1);
});

test('el resto de las requests NO cambia: un 401 con otro code sigue intentando el refresh (comportamiento global intacto)', async () => {
  respond = (req) => (req.url.endsWith('/auth/refresh')
    ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'refresh inválido' } } }
    : { status: 401, body: { error: { code: 'INTERNAL', message: 'x' } } });
  await assert.rejects(client.get('/songs'), (err) => err instanceof ApiError);
  assert.ok(refreshes().length >= 1, 'sin la opción, el interceptor refresca como antes');
});
