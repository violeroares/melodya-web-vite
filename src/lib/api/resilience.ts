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

/* ── Compuerta global de rate limit ─────────────────────── */

const DEFAULT_RATE_LIMIT_PAUSE_MS = 30_000;
let blockedUntil = 0;

/** Registra un 429. El trabajo en SEGUNDO PLANO (polling, refresh proactivo, reintentos) espera hasta que pase. */
export function noteRateLimit(retryAfterMs?: number, now: number = Date.now()): void {
  const pause = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_PAUSE_MS;
  blockedUntil = Math.max(blockedUntil, now + Math.min(pause, MAX_RETRY_AFTER_MS));
}

/** ms que faltan para que termine el bloqueo (0 = libre). */
export function rateLimitRemainingMs(now: number = Date.now()): number {
  return Math.max(0, blockedUntil - now);
}

/** Solo pruebas. */
export function resetRateLimitGate(): void {
  blockedUntil = 0;
}

/* ── Backoff ────────────────────────────────────────────── */

/** base·2^(fallos-1) con tope y jitter (0..jitterRatio). `failures` = fallos CONSECUTIVOS (≥1). */
export function backoffMs(baseMs: number, failures: number, maxMs: number, jitterRatio = 0.2, rand: () => number = Math.random): number {
  const n = Math.max(1, failures);
  const raw = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return Math.round(raw * (1 + jitterRatio * rand()));
}

/** Espera tras un error de polling: backoff, nunca menos que Retry-After ni que la compuerta global. */
export function pollErrorDelayMs(baseMs: number, failures: number, err: unknown, maxMs = 5 * 60_000, rand: () => number = Math.random): number {
  const retryAfter = err && typeof err === 'object' && typeof (err as ErrorLike).retryAfterMs === 'number' ? ((err as ErrorLike).retryAfterMs as number) : 0;
  return Math.max(backoffMs(baseMs, failures, maxMs, 0.2, rand), retryAfter, rateLimitRemainingMs());
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
