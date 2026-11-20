/**
 * BACKEND SIMULADO SOLO PARA PRUEBAS LOCALES (no forma parte de la app). Nunca habla con api-dev ni con producción.
 *
 *   node scripts/mock-api.mjs            → escucha en 127.0.0.1:4010
 *   import { startMockApi } from './mock-api.mjs'   → uso desde las pruebas (puerto 0 = libre)
 *
 * Simula lo necesario de los contratos de melodya.backend para probar la política de tráfico de la web:
 *  • JWT de acceso con `exp`/`iat` (TTL configurable), login, y POST /auth/refresh con ROTACIÓN (el refresh token viejo deja de servir).
 *  • Límite de solicitudes por contador (como express-rate-limit: ventana fija, 429 + Retry-After + RateLimit-*), o bloqueo manual.
 *  • Rutas privadas que exigen Bearer vigente (401 si no): /users/me, /generations/:id, /notifications/unread-count…
 *  • Progreso de una generación, comunidad pública, banners y archivos (WAV con Range, portadas SVG).
 *  • Contadores por ruta: GET /__stats. Control en caliente: POST /__ctl (JSON).
 *
 * /__ctl acepta (todo opcional):
 *   { accessTtlSec, refreshMode: 'ok'|'401'|'429'|'500'|'drop', block: {seconds}|null, limit: {max, windowSec}|null,
 *     retryAfterSec, completeAfter, genMode: 'ok'|'429'|'500'|'404', meMode: 'ok'|'429'|'500', reset: true }
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** WAV mono 8 kHz de `sec` segundos con un tono (para probar reproducción real, pausa y seek). */
function makeWav(sec, hz) {
  const rate = 8000;
  const n = rate * sec;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 3000), 44 + i * 2);
  return buf;
}

const cover = (hue) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="hsl(${hue},70%,45%)"/><text x="300" y="320" font-size="90" text-anchor="middle" fill="#fff" font-family="sans-serif">♪</text></svg>`;

const ME = {
  id: 'me1', email: 'prueba@melodya.test', name: 'Usuario de prueba', role: 'USER', status: 'ACTIVE', avatarFileId: null, avatarUrl: null, coverImageFileId: null,
  genres: [], creditsBalance: 100, voiceConsentAcceptedAt: null, voiceConsentVersion: null, lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  bio: null, subscription: null, effectivePlan: null, entitlements: {},
};
const page = (items) => ({ items, pagination: { total: items.length, page: 1, pageSize: 20, pages: 1 } });

export async function startMockApi({ port = 0, host = '127.0.0.1' } = {}) {
  const WAVS = { a1: makeWav(60, 440), a2: makeWav(60, 550), a3: makeWav(60, 660) };
  const author = { id: 'u1', name: 'Ana Compositora <test>', avatarUrl: '/api/files/av1/stream', followersCount: 12 };
  const mk = (id, title, audio, hue) => ({
    id, title, createdAt: '2026-11-01T12:00:00.000Z', author, coverUrl: `/api/files/c${hue}/stream`, audioUrl: `/api/files/${audio}/stream`,
    durationSec: 60, genre: 'Pop', tags: ['pop'], likesCount: 3, dislikesCount: 0, playsCount: 10, commentsCount: 0, allowRemix: false, viewerReaction: null,
  });
  const SONGS = [mk('s1', 'Canción Uno "demo"', 'a1', 20), mk('s2', 'Canción Dos', 'a2', 200), mk('s3', 'Canción Tres', 'a3', 300)];
  const detail = (s) => ({ ...s, allowComments: true, description: 'Una canción de prueba <b>sin HTML</b>', styleSummary: 'Pop alegre', lyrics: '[Verso]\nLa la la', comments: page([]) });

  const state = {
    accessTtlSec: 900,
    refreshMode: 'ok',
    meMode: 'ok',
    genMode: 'ok',
    completeAfter: 3,
    retryAfterSec: 5,
    blockUntil: 0,
    limit: null, // { max, windowSec }
    windowStart: 0,
    windowCount: 0,
    validRefresh: new Set(),
    seq: 0,
    genPolls: {},
    counts: {},
    log: [],
    privateFile401: 0,
    privateFileOk: 0,
  };

  const issue = () => {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'me1', iat: now, exp: now + state.accessTtlSec, n: ++state.seq })}.mock`;
    const refreshToken = `rt-${state.seq}-${Math.random().toString(36).slice(2, 10)}`;
    state.validRefresh.add(refreshToken);
    return { accessToken, refreshToken, refreshTokenExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), sessionId: 'mock-session' };
  };
  const bearerOk = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return false;
    try {
      const p = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
      return typeof p.exp === 'number' && p.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  };
  const send = (res, status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, {
      'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': '*', ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const limited = (res, retryAfterSec) =>
    send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes, probá más tarde' } }, 'application/json', { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) });

  const readBody = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    if (req.method === 'OPTIONS') return send(res, 204, '');

    // ── Control y estadísticas (no cuentan)
    if (p === '/__stats') return send(res, 200, { counts: state.counts, privateFile401: state.privateFile401, privateFileOk: state.privateFileOk, windowCount: state.windowCount, validRefresh: state.validRefresh.size, log: state.log.slice(-200) });
    if (p === '/__ctl' && req.method === 'POST') {
      const c = await readBody(req);
      if (c.reset) { state.counts = {}; state.log = []; state.windowCount = 0; state.windowStart = 0; state.genPolls = {}; state.blockUntil = 0; state.limit = null; state.validRefresh.clear(); state.privateFile401 = 0; state.privateFileOk = 0; state.refreshMode = 'ok'; state.meMode = 'ok'; state.genMode = 'ok'; state.accessTtlSec = 900; state.completeAfter = 3; state.retryAfterSec = 5; }
      for (const k of ['accessTtlSec', 'refreshMode', 'meMode', 'genMode', 'completeAfter', 'retryAfterSec']) if (c[k] !== undefined) state[k] = c[k];
      if ('block' in c) state.blockUntil = c.block ? Date.now() + c.block.seconds * 1000 : 0;
      if ('limit' in c) { state.limit = c.limit; state.windowStart = 0; state.windowCount = 0; }
      return send(res, 200, { ok: true });
    }

    const key = `${req.method} ${p.replace(/\/(s|u)\d+(?=\/|$)/, '/:id').replace(/\/generations\/gen[\w-]*/, '/generations/:gen')}`;
    state.counts[key] = (state.counts[key] ?? 0) + 1;
    state.log.push({ t: Date.now(), k: key });

    // ── Límite de solicitudes (todas las rutas /api, como el generalLimiter del backend)
    if (p.startsWith('/api')) {
      if (state.blockUntil > Date.now()) return limited(res, (state.blockUntil - Date.now()) / 1000);
      if (state.limit) {
        const now = Date.now();
        if (now - state.windowStart >= state.limit.windowSec * 1000) { state.windowStart = now; state.windowCount = 0; }
        state.windowCount += 1;
        if (state.windowCount > state.limit.max) return limited(res, (state.windowStart + state.limit.windowSec * 1000 - now) / 1000);
      }
    }

    let m;
    // ── Auth
    if (p === '/api/auth/login' && req.method === 'POST') return send(res, 200, { data: { ...issue(), user: ME } });
    if (p === '/api/auth/refresh' && req.method === 'POST') {
      const body = await readBody(req);
      if (state.refreshMode === '429') return limited(res, state.retryAfterSec);
      if (state.refreshMode === '500') return send(res, 500, { error: { code: 'INTERNAL', message: 'Error interno' } });
      if (state.refreshMode === 'drop') return req.socket.destroy();
      if (state.refreshMode === '401' || !state.validRefresh.has(body.refreshToken)) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Refresh token inválido' } });
      state.validRefresh.delete(body.refreshToken); // rotación: el token usado deja de servir
      return send(res, 200, { data: issue() });
    }
    if (p === '/api/auth/logout') return send(res, 200, { data: { ok: true } });

    // ── Rutas privadas
    const needsAuth = p === '/api/users/me' || p.startsWith('/api/generations') || p.startsWith('/api/notifications') || p === '/api/credits' || p.startsWith('/api/billing');
    if (needsAuth && !bearerOk(req)) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Token inválido o vencido' } });
    if (p === '/api/users/me') {
      if (state.meMode === '429') return limited(res, state.retryAfterSec);
      if (state.meMode === '500') return send(res, 500, { error: { code: 'INTERNAL', message: 'Error interno' } });
      return send(res, 200, { data: ME });
    }
    if (p === '/api/notifications/unread-count') return send(res, 200, { data: { count: 0 } });
    if (p === '/api/credits' || p.startsWith('/api/billing')) return send(res, 200, { data: { balance: 100 } });
    if (p === '/api/generations' && req.method === 'GET') return send(res, 200, { data: page([]) });
    if ((m = /^\/api\/generations\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      if (state.genMode === '429') return limited(res, state.retryAfterSec);
      if (state.genMode === '500') return send(res, 500, { error: { code: 'INTERNAL', message: 'Error interno' } });
      if (state.genMode === '404') return send(res, 404, { error: { code: 'NOT_FOUND', message: 'No encontrada' } });
      const n = (state.genPolls[m[1]] = (state.genPolls[m[1]] ?? 0) + 1);
      const done = n >= state.completeAfter;
      return send(res, 200, { data: { id: m[1], status: done ? 'COMPLETED' : 'PROCESSING', songId: done ? 's1' : null, jobs: [{ task: 'MUSIC', status: done ? 'COMPLETED' : 'PROCESSING', progress: Math.min(100, n * 30) }] } });
    }

    // ── Público
    if (p === '/api/songs' && req.method === 'GET') {
      if (!bearerOk(req)) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Token inválido o vencido' } });
      const v = { id: 'pv1-v1', songId: 'pv1', versionNumber: 1, generationId: null, title: null, lyricsText: null, lyricsSource: null, durationSec: 60, genre: 'Pop', tags: [], createdAt: '2026-11-01T12:00:00.000Z', audioUrl: '/api/files/a1/stream', coverUrl: '/api/files/pc1/stream' };
      return send(res, 200, { data: page([{ id: 'pv1', userId: 'me1', projectId: null, title: 'Mi canción privada', coverUrl: '/api/files/pc1/stream', visibility: 'PRIVATE', allowComments: true, currentVersionId: v.id, completedVersionCount: 1, likesCount: 0, dislikesCount: 0, playsCount: 0, commentsCount: 0, lastGenerationAt: null, createdAt: v.createdAt, updatedAt: v.createdAt, currentVersion: v, versions: [{ id: v.id, versionNumber: 1, createdAt: v.createdAt, title: null }] }]) });
    }
    if (p === '/api/files/pc1/stream') {
      if (!bearerOk(req)) { state.privateFile401 += 1; return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Archivo privado' } }); }
      state.privateFileOk += 1;
      return send(res, 200, cover(300), 'image/svg+xml');
    }
    if (p === '/api/community/songs') return send(res, 200, { data: page(SONGS) });
    if ((m = /^\/api\/community\/songs\/([^/]+)$/.exec(p))) {
      const s = SONGS.find((x) => x.id === m[1]);
      return s ? send(res, 200, { data: detail(s) }) : send(res, 404, { error: { code: 'NOT_FOUND', message: 'No encontrada' } });
    }
    if ((m = /^\/api\/community\/users\/([^/]+)$/.exec(p))) {
      return m[1] === 'u1'
        ? send(res, 200, { data: { ...author, bio: 'Hago música de prueba.', genres: ['Pop'], followersCount: 12, followingCount: 1, songsCount: 3, totalPlays: 30, totalLikes: 9 } })
        : send(res, 404, { error: { code: 'NOT_FOUND', message: 'No encontrado' } });
    }
    if (p === '/api/banners') return send(res, 200, { data: { items: [] } });
    if (p === '/api/announcements') return send(res, 200, { data: { items: [] } });
    if ((m = /^\/api\/songs\/([^/]+)(\/versions)?$/.exec(p)) && req.method === 'GET') {
      const s = SONGS.find((x) => x.id === m[1]);
      if (!s) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'No encontrada' } });
      const version = { id: `${s.id}-v1`, songId: s.id, versionNumber: 1, generationId: null, title: null, lyricsText: '[Verso]\nLa la la', lyricsSource: 'USER', durationSec: 60, genre: 'Pop', tags: ['pop'], createdAt: s.createdAt, audioUrl: s.audioUrl, coverUrl: s.coverUrl };
      if (m[2]) return send(res, 200, { data: { items: [version] } });
      return send(res, 200, { data: { id: s.id, userId: 'me1', projectId: null, title: s.title, coverUrl: s.coverUrl, visibility: 'PUBLIC', allowComments: true, allowRemix: false, remixCount: 0, origin: null, styleSummary: 'Pop alegre', description: null, currentVersionId: version.id, completedVersionCount: 1, likesCount: 3, dislikesCount: 0, playsCount: 10, commentsCount: 0, lastGenerationAt: null, createdAt: s.createdAt, updatedAt: s.createdAt, currentVersion: version, versions: [{ id: version.id, versionNumber: 1, createdAt: s.createdAt, title: null }] } });
    }
    if ((m = /^\/api\/files\/(a\d)\/stream$/.exec(p))) {
      const wav = WAVS[m[1]];
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : wav.length - 1;
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': end - start + 1 });
        return res.end(wav.subarray(start, end + 1));
      }
      res.writeHead(200, { ...headers, 'content-length': wav.length });
      return res.end(wav);
    }
    if ((m = /^\/api\/files\/c(\d+)\/stream$/.exec(p))) return send(res, 200, cover(m[1]), 'image/svg+xml');
    if (/^\/api\/files\/av1\/stream$/.test(p)) return send(res, 200, cover(120), 'image/svg+xml');
    return send(res, 200, { data: page([]) });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    apiBase: `${origin}/api`,
    state,
    ctl: (body) => fetch(`${origin}/__ctl`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }).then((r) => r.json()),
    stats: () => fetch(`${origin}/__stats`).then((r) => r.json()),
    issueTokens: issue,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

// Ejecución directa: node scripts/mock-api.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_PORT || 4010);
  const mock = await startMockApi({ port });
  console.log(`mock-api (SOLO PRUEBAS) en ${mock.apiBase}  ·  control: POST ${mock.origin}/__ctl  ·  stats: GET ${mock.origin}/__stats`);
}
