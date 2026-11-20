// Guardas estáticas anti-regresión de la política de tráfico: nadie puede reintroducir intervalos HTTP sin backoff, un segundo socket
// ni la limpieza faltante del intervalo de Socket.IO. Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(root);
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const read = (r) => fs.readFileSync(path.join(root, r), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('Socket.IO: una sola conexión (useRealtime se invoca desde un único lugar: el shell persistente)', () => {
  const callers = files.filter((f) => /useRealtime\(/.test(strip(fs.readFileSync(f, 'utf8'))) && !/export function useRealtime/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(callers.map(rel), ['components/layout/AppShell.tsx']);
  const ios = files.filter((f) => /\bio\(/.test(strip(fs.readFileSync(f, 'utf8'))) && /socket\.io-client/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(ios.map(rel), ['hooks/index.ts'], 'solo un módulo abre sockets');
});

test('Socket.IO: el intervalo de estado y los temporizadores se limpian en el cleanup', () => {
  const src = strip(read('hooks/index.ts'));
  assert.ok(!/__poll/.test(src), 'el handle ya no se pierde en una propiedad del socket');
  assert.match(src, /connectedPoll = setInterval\(/);
  assert.match(src, /clearInterval\(connectedPoll\)/);
  assert.match(src, /clearTimeout\(serverDisconnectTimer\)/);
  assert.match(src, /removeAllListeners/);
});

test('ningún setInterval consulta al backend: solo temporizadores de UI/estado local (lista cerrada)', () => {
  const allowed = new Map([
    ['components/banners/index.tsx', 1], // carrusel de banners (UI)
    ['components/player/PlayerBar.tsx', 1], // cuenta regresiva del timer de sueño (UI)
    ['hooks/index.ts', 1], // estado «conectado» del socket (local)
    ['hooks/use-voice-recorder.ts', 1], // cronómetro de grabación (local)
    ['lib/api/client.ts', 1], // espera del lock de refresh entre pestañas (localStorage)
  ]);
  const found = new Map();
  for (const f of files) {
    const n = (strip(fs.readFileSync(f, 'utf8')).match(/\bsetInterval\(/g) ?? []).length;
    if (n) found.set(rel(f), n);
  }
  assert.deepEqual([...found.entries()].sort(), [...allowed.entries()].sort());
});

test('todo refetchInterval pasa por queryPollDelayMs (backoff + Retry-After), nunca un número fijo', () => {
  for (const f of files) {
    const src = strip(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/refetchInterval:\s*([^\n]+)/g)) {
      assert.match(m[1], /queryPollDelayMs\(/, `${rel(f)}: refetchInterval sin backoff → ${m[1].trim()}`);
    }
  }
});

test('el seguimiento de generaciones usa el poller resiliente y no un setInterval', () => {
  const gen = strip(read('features/creator/GenerationStatus.tsx'));
  assert.match(gen, /startPoller\(/);
  assert.ok(!/setInterval\(/.test(gen));
  const rec = strip(read('hooks/index.ts'));
  assert.match(rec, /useGenerationReconciliation[\s\S]*startPoller\(/);
});

test('React Query: política central (sin reintento inmediato de 429) y un único QueryClient', () => {
  const qc = strip(read('lib/query-client.ts'));
  assert.match(qc, /retry:\s*shouldRetryQuery/);
  assert.match(qc, /retryDelay:\s*queryRetryDelayMs/);
  const created = files.filter((f) => /new QueryClient\(/.test(strip(fs.readFileSync(f, 'utf8')))).map(rel);
  assert.deepEqual(created, ['lib/query-client.ts']);
  // Ninguna consulta pide reintentos propios agresivos.
  for (const f of files) {
    const src = strip(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\bretry:\s*(\d+)/g)) assert.ok(Number(m[1]) <= 2, `${rel(f)}: retry ${m[1]}`);
  }
});

test('el cliente no cierra la sesión por un 429 (solo rechazo definitivo del refresh)', () => {
  const client = strip(read('lib/api/client.ts'));
  assert.match(client, /isDefinitiveRefreshFailure\(refreshErr\)/);
  assert.ok(!/catch\s*\{\s*onUnauthorized\(\)/.test(client), 'el catch genérico que cerraba la sesión ya no existe');
  const auth = strip(read('stores/auth.ts'));
  assert.ok(!/catch\s*\{\s*forceGuest\(\)/.test(auth), 'ningún catch genérico llama a forceGuest');
  assert.ok(!/13 \* 60 \* 1000/.test(auth), 'el cálculo con 13 min fijos (que daba 2 min) ya no existe');
});

test('imágenes: el intento directo condenado a 401/403 se omite y las descargas autenticadas se comparten', () => {
  const img = strip(read('lib/auth-image.ts'));
  assert.match(img, /shouldSkipDirectLoad\(/);
  assert.match(img, /inflight\.get\(key\)/);
  assert.match(img, /markPrivate\(key\)/);
  assert.match(img, /clearAuthImageCache[\s\S]*PRIVATE_KEYS_STORAGE/, 'el aprendizaje de privacidad se borra al cambiar de usuario');
  const songs = strip(read('features/library/SongsTab.tsx'));
  assert.match(songs, /requireAuth=\{song\.visibility === 'PRIVATE'\}/);
});

test('el .env del usuario no se usa en las pruebas: los tests solo hablan con el mock local', () => {
  for (const f of ['traffic-client-mock.test.mjs']) {
    const src = fs.readFileSync(path.join(root, '..', 'tests', f), 'utf8');
    assert.match(src, /startMockApi\(\)/);
    assert.ok(!/api-dev\.melodya|melodya\.com\.ar/.test(src));
  }
});
