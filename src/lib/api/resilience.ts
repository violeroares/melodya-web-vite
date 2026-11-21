/**
 * MELODYA WEB (Vite) — Resiliencia ante errores HTTP: clasificación, 429/Retry-After, backoff y temporización del refresh.
 *
 * Módulo PURO (sin axios ni React): lo usan el cliente HTTP, el store de auth, React Query y los pollers, y se prueba
 * directamente con node:test.
 *
 * Política (ver también docs/TRAFFIC.md):
 *   401  definitivo → la sesión terminó (solo si el REFRESH lo confirma).
 *   403  permisos / cuenta no activa → no se reintenta; en refresh es definitivo.
 *   429  límite del backend → NUNCA cierra la sesión; se respeta Retry-After y se pausa el trabajo en segundo plano.
 *   red / timeout / 5xx → transitorios: reintento acotado con backoff exponencial + jitter.
 *   resto de 4xx → error de la petición, no se reintenta.
 */

export type ErrorKind = 'unauthorized' | 'forbidden' | 'rate-limited' | 'network' | 'server' | 'client' | 'unknown';

interface ErrorLike {
  status?: unknown;
  code?: unknown;
  retryAfterMs?: unknown;
  response?: { status?: unknown; headers?: unknown };
}

/** Estado HTTP de un ApiError o de un AxiosError (0 = sin respuesta). */
export function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as ErrorLike;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.response?.status === 'number') return e.response.status;
  return undefined;
}

export function classifyStatus(status: number | undefined, code?: unknown): ErrorKind {
  if (status === undefined) return 'unknown';
  if (status === 0) return code === 'API_NOT_CONFIGURED' ? 'client' : 'network';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status === 408) return 'network';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

export function classifyError(err: unknown): ErrorKind {
  const code = err && typeof err === 'object' ? (err as ErrorLike).code : undefined;
  // Un AxiosError sin respuesta trae code 'ERR_NETWORK' / 'ECONNABORTED' y ninguna respuesta.
  if (err && typeof err === 'object' && statusOf(err) === undefined && typeof code === 'string' && /^(ERR_NETWORK|ECONNABORTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED|NETWORK|TIMEOUT)$/.test(code)) return 'network';
  return classifyStatus(statusOf(err), code);
}

/** ¿Vale la pena reintentar más tarde (sin que el usuario haga nada)? */
export const isTransient = (kind: ErrorKind): boolean => kind === 'rate-limited' || kind === 'network' || kind === 'server';

/** Fallos que NO se arreglan reintentando (permisos, recurso inexistente, petición inválida). */
export const isPermanent = (kind: ErrorKind): boolean => kind === 'forbidden' || kind === 'client' || kind === 'unauthorized';

/* ── Retry-After ─────────────────────────────────────────── */

export const MAX_RETRY_AFTER_MS = 15 * 60_000; // la ventana del backend es de 15 min: nunca esperamos más que eso

/** `Retry-After` en segundos o fecha HTTP → ms (acotado). `undefined` si no hay valor válido. */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(raw)) ms = Number(raw) * 1000;
  else {
    if (!/[a-z]/i.test(raw)) return undefined; // una fecha HTTP lleva letras (día/mes/GMT): «-5» o «12:30» no son un Retry-After válido
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return undefined;
    ms = t - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Lee `retry-after` de las cabeceras de un AxiosError (objeto plano o AxiosHeaders). */
export function retryAfterFromHeaders(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as { get?: (k: string) => unknown } & Record<string, unknown>;
  const v = typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] ?? h['Retry-After']);
  return parseRetryAfter(v);
}

/**
 * `error.retryAfterSec` del cuerpo de un 429 del backend (aditivo, ver melodya.backend rateLimit.js). Es el respaldo cuando el navegador
 * no puede leer la cabecera (CORS solo la expone en backends nuevos). Solo se acepta un número de segundos.
 */
export function retryAfterFromBody(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const sec = (payload as { retryAfterSec?: unknown }).retryAfterSec;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return undefined;
  return parseRetryAfter(String(sec));
}

/* ── Compuerta de rate limit POR ALCANCE ─────────────────── */

/**
 * El backend tiene limitadores INDEPENDIENTES (general, refresh, auth, asistente, admin, archivos, webhooks): un 429 de uno no dice nada de
 * los demás. La compuerta local sigue esa separación para no bloquear de más:
 *   'refresh'  POST /auth/refresh
 *   'api'      el resto de la API general (consultas, perfil, biblioteca…)
 *   'files'    GET /files/:id/stream (portadas, avatares, audio): limitador propio del backend
 *   'auth'     login / registro / recuperación de contraseña   ┐
 *   'assistant' /assistant/*                                    ├ NO activan compuerta: son errores de ESA operación
 *   'admin'    /admin/*                                         ┘
 * Los archivos no pasan por el cliente Axios (<img>, <audio> y fetch): quien los pide (auth-image, reproductor) registra y consulta el alcance
 * 'files'. Un 429 de archivos NO frena la API general ni el refresh, y viceversa.
 */
export type RateScope = 'refresh' | 'api' | 'files' | 'auth' | 'assistant' | 'admin';

const GATED_SCOPES = ['refresh', 'api', 'files'] as const;
type GatedScope = (typeof GATED_SCOPES)[number];

const isGated = (scope: RateScope): scope is GatedScope => scope === 'refresh' || scope === 'api' || scope === 'files';

/**
 * Alcance de una solicitud del cliente Axios a partir de su URL (relativa al baseURL, p. ej. «/auth/login», o absoluta). Coincide con los
 * prefijos reales del backend (routes/index.js) y con los limitadores de auth.routes.js: SOLO register, login, forgot-password y
 * reset-password llevan el limitador estricto; logout, logout-all y change-password solo pasan por el general.
 * El enrutado del backend ignora mayúsculas y la barra final: acá también.
 */
export function rateLimitScopeOf(url: string | null | undefined, basePath = ''): RateScope {
  let p = String(url ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ''); // sin origen
  p = (p.split('?')[0] ?? '').split('#')[0] ?? '';
  const base = basePath.replace(/\/+$/, '').toLowerCase();
  p = p.toLowerCase();
  if (base && (p === base || p.startsWith(`${base}/`))) p = p.slice(base.length);
  p = `/${p.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  if (p === '/auth/refresh') return 'refresh';
  if (/^\/auth\/(login|register|forgot-password|reset-password)$/.test(p)) return 'auth';
  if (p === '/assistant' || p.startsWith('/assistant/')) return 'assistant';
  if (p === '/admin' || p.startsWith('/admin/')) return 'admin';
  if (/^\/files\/[^/]+\/stream$/.test(p)) return 'files';
  return 'api';
}

const DEFAULT_RATE_LIMIT_PAUSE_MS = 30_000;
const blockedUntil: Record<GatedScope, number> = { refresh: 0, api: 0, files: 0 };

/**
 * Registra un 429 del alcance indicado (por defecto la API general). Un alcance sin compuerta (auth, assistant, admin) no hace nada.
 * El trabajo en SEGUNDO PLANO de ESE alcance (refresh proactivo, hidratación del perfil, reintentos de consultas) espera hasta que pase.
 */
export function noteRateLimit(retryAfterMs?: number, scope: RateScope = 'api', now: number = Date.now()): void {
  if (!isGated(scope)) return;
  const pause = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_PAUSE_MS;
  blockedUntil[scope] = Math.max(blockedUntil[scope], now + Math.min(pause, MAX_RETRY_AFTER_MS));
}

/** ms que faltan para que termine el bloqueo del alcance (0 = libre; los alcances sin compuerta siempre 0). */
export function rateLimitRemainingMs(scope: RateScope = 'api', now: number = Date.now()): number {
  return isGated(scope) ? Math.max(0, blockedUntil[scope] - now) : 0;
}

/** Solo pruebas. */
export function resetRateLimitGate(): void {
  blockedUntil.refresh = 0;
  blockedUntil.api = 0;
  blockedUntil.files = 0;
}

/* ── Backoff ────────────────────────────────────────────── */

/** base·2^(fallos-1) con tope y jitter (0..jitterRatio). `failures` = fallos CONSECUTIVOS (≥1). */
export function backoffMs(baseMs: number, failures: number, maxMs: number, jitterRatio = 0.2, rand: () => number = Math.random): number {
  const n = Math.max(1, failures);
  const raw = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return Math.round(raw * (1 + jitterRatio * rand()));
}

/** Espera tras un error de polling: backoff, nunca menos que Retry-After ni que la pausa vigente del alcance consultado. */
export function pollErrorDelayMs(baseMs: number, failures: number, err: unknown, maxMs = 5 * 60_000, rand: () => number = Math.random, scope: RateScope = 'api'): number {
  const retryAfter = err && typeof err === 'object' && typeof (err as ErrorLike).retryAfterMs === 'number' ? ((err as ErrorLike).retryAfterMs as number) : 0;
  return Math.max(backoffMs(baseMs, failures, maxMs, 0.2, rand), retryAfter, rateLimitRemainingMs(scope));
}

/* ── React Query ────────────────────────────────────────── */

/** `retry` de React Query: solo errores transitorios (red / 5xx), máx. 2, y NUNCA con 429 ni con la compuerta activa. */
export function shouldRetryQuery(failureCount: number, err: unknown): boolean {
  if (rateLimitRemainingMs() > 0) return false;
  const kind = classifyError(err);
  if (kind === 'network') return failureCount < 2;
  if (kind === 'server') return failureCount < (statusOf(err) === 500 ? 1 : 2);
  return false; // 401 (lo gestiona el interceptor), 403, 404/422…, 429 y desconocidos: sin reintento inmediato
}

/** `retryDelay` de React Query v5: recibe el nº de fallos acumulados (1 en el primer reintento) → 1 s, 2 s… con jitter. */
export function queryRetryDelayMs(failureCount: number, err?: unknown): number {
  const retryAfter = err && typeof err === 'object' && typeof (err as ErrorLike).retryAfterMs === 'number' ? ((err as ErrorLike).retryAfterMs as number) : 0;
  return Math.max(backoffMs(1000, failureCount, 15_000), rateLimitRemainingMs(), retryAfter);
}

interface QueryLike {
  state: { status: string; errorUpdateCount: number; error?: unknown };
}

/** `refetchInterval` dinámico: periodo normal; con error, backoff; con 429, al menos hasta Retry-After. */
export function queryPollDelayMs(query: QueryLike, baseMs: number, maxMs = 5 * 60_000): number {
  if (query.state.status !== 'error') return Math.max(baseMs, rateLimitRemainingMs());
  const kind = classifyError(query.state.error);
  if (kind === 'forbidden' || kind === 'client' || kind === 'unauthorized') return maxMs; // permanente: casi no insistir
  return pollErrorDelayMs(baseMs, Math.max(1, query.state.errorUpdateCount), query.state.error, maxMs);
}

/* ── Refresh proactivo de sesión ────────────────────────── */

export interface JwtTimes {
  /** epoch ms de expiración (claim `exp`). */
  exp?: number;
  /** epoch ms de emisión (claim `iat`). */
  iat?: number;
}

/** Decodifica `exp`/`iat` de un JWT SIN verificar la firma (solo para agendar renovaciones). */
export function decodeJwtTimes(token: string | null | undefined): JwtTimes {
  if (!token) return {};
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    // atob existe en navegadores y en Node ≥ 16 (pruebas).
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const p = JSON.parse(json) as { exp?: unknown; iat?: unknown };
    return {
      exp: typeof p.exp === 'number' ? p.exp * 1000 : undefined,
      iat: typeof p.iat === 'number' ? p.iat * 1000 : undefined,
    };
  } catch {
    return {};
  }
}

/** TTL supuesto SOLO si el token no trae `exp` (el backend lo configura con ACCESS_TOKEN_TTL; por defecto 900 s). */
export const FALLBACK_ACCESS_TTL_MS = 15 * 60_000;

export const MIN_REFRESH_DELAY_MS = 5_000;
export const MAX_REFRESH_LEAD_MS = 2 * 60_000;
const MIN_REFRESH_LEAD_MS = 5_000;

/** Margen de seguridad: 20 % de la vida del token, entre 5 s y 2 min (así un TTL corto nunca produce un bucle apretado). */
export function refreshLeadMs(lifetimeMs: number): number {
  return Math.min(MAX_REFRESH_LEAD_MS, Math.max(MIN_REFRESH_LEAD_MS, Math.round(lifetimeMs * 0.2)));
}

/** Expiración real del access token: claim `exp`, o ahora + TTL de respaldo si el token no la trae. */
export function accessExpiryOf(token: string | null | undefined, now: number = Date.now()): number {
  return decodeJwtTimes(token).exp ?? now + FALLBACK_ACCESS_TTL_MS;
}

/**
 * Cuándo renovar: `exp − margen`, con un piso de 5 s y un jitter (para que varias pestañas no coincidan) de hasta 10 s pero NUNCA más de la
 * mitad del margen: así el jitter jamás empuja la renovación más allá del vencimiento (TTL corto).
 * Con el TTL por defecto (15 min) da ≈ 13 min; con un TTL de 60 s, ≈ 48 s.
 */
export function computeRefreshDelayMs(opts: { now: number; exp: number; iat?: number; rand?: () => number }): number {
  const { now, exp, iat, rand = Math.random } = opts;
  const lifetime = iat !== undefined && exp > iat ? exp - iat : Math.max(exp - now, FALLBACK_ACCESS_TTL_MS);
  const lead = refreshLeadMs(lifetime);
  const base = Math.max(MIN_REFRESH_DELAY_MS, exp - now - lead);
  return Math.round(base + rand() * Math.min(10_000, lead / 2));
}
