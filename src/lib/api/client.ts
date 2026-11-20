/**
 * MELODYA WEB — Cliente HTTP central (Axios).
 *  • Base URL EXPLÍCITA (VITE_API_BASE_URL, obligatoria; ver resolveApiBase): sin ella el cliente no envía nada.
 *  • Inyecta Bearer; 401 → refresh ÚNICO en vuelo → reintento.
 *  • Errores → ApiError con mensaje humano (lib/errors).
 *  • apiFileUrl() resuelve las URLs relativas de archivos contra el origin del API.
 */
import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import {
  accessExpiryOf,
  classifyError,
  noteRateLimit,
  rateLimitRemainingMs,
  retryAfterFromHeaders,
} from './resilience.ts';

/*
 * Configuración EXPLÍCITA del backend oficial. La web es solo el frontend: no trae ningún servidor de negocio propio y NO hay
 * valor por defecto ni rutas del mismo origen. Si VITE_API_BASE_URL falta o no es una URL http(s) válida, el cliente
 * queda desactivado (toda solicitud se rechaza con API_NOT_CONFIGURED) y la pantalla de arranque muestra el mensaje.
 */
export type ApiConfig = { base: string; error: null } | { base: ''; error: string };

const VARIABLE = 'VITE_API_BASE_URL';
const EXAMPLE = 'http://localhost:4000/api';

export function resolveApiBase(raw: string | undefined | null): ApiConfig {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return {
      base: '',
      error: `Falta ${VARIABLE}. Definila en .env (por ejemplo ${VARIABLE}=${EXAMPLE}) y reiniciá la web: Vite la incorpora al compilar.`,
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { base: '', error: `${VARIABLE} no es una URL válida ("${value}"). Debe ser absoluta, por ejemplo ${EXAMPLE}.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { base: '', error: `${VARIABLE} debe usar http o https ("${value}"). Ejemplo: ${EXAMPLE}.` };
  }
  return { base: value.replace(/\/+$/, ''), error: null };
}

/* Vite expone VITE_* en import.meta.env; bajo node (pruebas) se lee de process.env. */
const rawEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
  ?? (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_API_BASE_URL;
const apiConfig = resolveApiBase(rawEnv);
export const API_BASE = apiConfig.base;
/** Mensaje de configuración si la URL del backend falta o es inválida (null = configuración correcta). */
export const API_CONFIG_ERROR = apiConfig.error;

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  /** 429/503: cuánto pide esperar el backend (cabecera Retry-After), en ms. */
  retryAfterMs?: number;

  constructor(status: number, code: string, message: string, details?: unknown, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

export const client: AxiosInstance = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

/** Tokens (gestionados por authStore; referencias circulares evitadas). */
let getAccessToken: () => string | null = () => null;
let getRefreshToken: () => string | null = () => null;
let onRefreshed: (session: { accessToken: string; refreshToken: string }) => void = () => {};
let onUnauthorized: () => void = () => {};

export function bindAuthCallbacks(fns: {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  onRefreshed: (session: { accessToken: string; refreshToken: string }) => void;
  onUnauthorized: () => void;
}) {
  getAccessToken = fns.getAccessToken;
  getRefreshToken = fns.getRefreshToken;
  onRefreshed = fns.onRefreshed;
  onUnauthorized = fns.onUnauthorized;
}

client.interceptors.request.use((config) => {
  // Sin backend configurado no se envía NADA (ni a rutas del mismo origen): el error es explícito y diagnosticable.
  if (API_CONFIG_ERROR) return Promise.reject(new ApiError(0, 'API_NOT_CONFIGURED', API_CONFIG_ERROR));
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Refresh único en vuelo (mutex intra-tab: respeta la ventana de gracia del backend)
let refreshPromise: Promise<string> | null = null;

/* Lock cross-tab via localStorage: evita que múltiples pestañas/refs de
 * página disparen refreshs concurrentes (ej: Ctrl+F5 rápido) leyendo el mismo
 * refreshToken viejo. El primer proceso que adquiere el lock hace el refresh;
 * los demás esperan a que se libere.
 *
 * Cada owner es un string "timestamp:random". La adquisición verifica que el
 * lock existente haya expirado (timestamp + TTL < now); si expiró, escribe su
 * propio owner y verifica (re-read) que su escritura tomó efecto. */
const REFRESH_LOCK_KEY = 'melodya.refresh.lock';
const REFRESH_LOCK_TTL_MS = 20_000; // > axios timeout (15s): el lock persiste hasta que el owner termine

function acquireRefreshLock(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const now = Date.now();
  const owner = `${now}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const existing = window.localStorage.getItem(REFRESH_LOCK_KEY);
    if (existing) {
      const existingTs = Number(existing.split(':')[0]);
      if (now - existingTs < REFRESH_LOCK_TTL_MS) return null; // lock activo
    }
    window.localStorage.setItem(REFRESH_LOCK_KEY, owner);
    const after = window.localStorage.getItem(REFRESH_LOCK_KEY);
    if (after !== owner) return null; // perdimos la carrera
    return owner;
  } catch {
    /* localStorage bloqueado (privado/itinerante en dev): no podemos coordinar
     * cross-tab, pero el mutex intra-tab (refreshPromise) sigue funcionando. */
    return null;
  }
}

function releaseRefreshLock(owner: string | null) {
  if (!owner || typeof window === 'undefined' || !window.localStorage) return;
  try {
    const current = window.localStorage.getItem(REFRESH_LOCK_KEY);
    if (current === owner) window.localStorage.removeItem(REFRESH_LOCK_KEY);
  } catch {
    /* noop */
  }
}

/* Evento cross-tab: el dueño del lock avisa cuando termina (éxito o fracaso)
 * para que los waiters dejen de polling.
 * Se usan DOS canales:
 *  • window.dispatchEvent: intra-tab (misma pestaña, ej: HMR/recarga de módulo).
 *  • localStorage 'storage' event: cross-tab (pestañas/ventanas distintas). */
const REFRESH_DONE_KEY = 'melodya.refresh.done';
function notifyRefreshDone() {
  if (typeof window === 'undefined') return;
  if (window.dispatchEvent) {
    window.dispatchEvent(new Event('melodya:refresh-done'));
  }
  try {
    /* 'storage' event se dispara en otras pestañas (NO en la actual).
     * Escribir+leer inmediatamente también notifica intra-tab si el dispatcher
     * no está disponible. */
    window.localStorage.setItem(REFRESH_DONE_KEY, String(Date.now()));
  } catch {
    /* noop */
  }
}

/** Lee el accessToken persistido en storage (melodya.session). El cliente no
 *  importa de authStore para evitar dependencia circular; usa la clave conocida. */
const STORAGE_KEY = 'melodya.session';
function readStoredAccessToken(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accessToken?: string };
    return parsed.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Espera cross-tab al dueño del lock refrescando con polling ligero. */
function waitForRefreshLockRelease(): Promise<void> {
  return new Promise((resolve) => {
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onStorageDone = (e: StorageEvent) => {
      if (e.key === REFRESH_DONE_KEY) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearInterval(iv);
      window.removeEventListener('melodya:refresh-done', onDone);
      window.removeEventListener('storage', onStorageDone);
    };
    const iv = setInterval(() => {
      const existing = window.localStorage.getItem(REFRESH_LOCK_KEY);
      if (!existing || Date.now() - Number(existing.split(':')[0]) >= REFRESH_LOCK_TTL_MS) {
        cleanup();
        resolve();
      }
    }, 200);
    window.addEventListener('melodya:refresh-done', onDone);
    /* 'storage' event: cross-tab (otras pestañas). El owner escribe
     * REFRESH_DONE_KEY al terminar; el evento se dispara en esta pestaña
     * cuando la otra pestaña escribe a localStorage. */
    window.addEventListener('storage', onStorageDone);
    /* Seguridad: máximo 15s de espera */
    setTimeout(cleanup, REFRESH_LOCK_TTL_MS + 1000);
  });
}

/** Bloqueo del refresh tras un 429 (hasta Retry-After): mientras dure, NO se envía ningún /auth/refresh (cada intento cuenta contra el límite). */
let refreshBlockedUntil = 0;

/** Un fallo de refresh es DEFINITIVO (la sesión terminó) solo si el backend rechazó el refresh token: 401 (inválido, expirado, revocado)
 *  o 403 (cuenta no activa). 429, red y 5xx son transitorios: la sesión se conserva y se reintenta más tarde. */
export function isDefinitiveRefreshFailure(err: unknown): boolean {
  const kind = classifyError(err);
  return kind === 'unauthorized' || kind === 'forbidden';
}

/** Convierte cualquier error de Axios en ApiError (mensaje humano, estado, código y Retry-After). */
export function normalizeAxiosError(error: AxiosError<{ error?: { code?: string; message?: string; details?: unknown } }>): ApiError {
  const status = error.response?.status ?? 0;
  const payload = error.response?.data?.error;
  const retryAfterMs = status === 429 || status === 503 ? retryAfterFromHeaders(error.response?.headers) : undefined;
  if (status === 429) noteRateLimit(retryAfterMs);
  if (payload?.message) return new ApiError(status, payload.code ?? 'ERROR', payload.message, payload.details, retryAfterMs);
  if (error.code === 'ECONNABORTED') return new ApiError(0, 'TIMEOUT', 'La conexión tardó demasiado. Intentá de nuevo.');
  if (!error.response) return new ApiError(0, 'NETWORK', 'No pudimos conectar con Melodya. Revisá tu conexión.');
  if (status === 429) return new ApiError(429, 'RATE_LIMITED', 'Demasiadas solicitudes, probá más tarde', undefined, retryAfterMs);
  return new ApiError(status, payload?.code ?? 'ERROR', payload?.message ?? 'Algo salió mal. Intentá de nuevo.', undefined, retryAfterMs);
}

/**
 * Un solo POST /auth/refresh (axios «crudo»: sin interceptores, así un 401/429 del refresh no dispara otro refresh).
 *  • 429: se registra el bloqueo (Retry-After) y se lanza ApiError(429) SIN reintentar: el backend limita ANTES de rotar el token,
 *    así que el refresh token sigue vigente y se reintenta cuando pase la espera.
 *  • 401: otro proceso (pestaña) pudo haber rotado el token → si cambió en storage, se reintenta UNA vez con el nuevo.
 *  • Red / 5xx: se lanza el error tal cual y NO se reintenta a ciegas (si el servidor llegó a rotar, reenviar el token viejo fuera de la
 *    ventana de gracia revocaría toda la familia). El llamador reprograma con backoff.
 */
export async function performRefresh(): Promise<string> {
  let refreshToken = getRefreshToken();
  if (!refreshToken) throw new ApiError(401, 'UNAUTHORIZED', 'Tu sesión expiró');
  const blocked = Math.max(refreshBlockedUntil - Date.now(), rateLimitRemainingMs());
  if (blocked > 0) throw new ApiError(429, 'RATE_LIMITED', 'Demasiadas solicitudes, probá más tarde', undefined, blocked);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken }, { timeout: 15000 });
      const data = res.data.data as { accessToken: string; refreshToken: string; refreshTokenExpiresAt?: string };
      /* Persistir el nuevo token en storage INMEDIATAMENTE (no depender de onRefreshed, que puede perderse en HMR si el módulo se recarga
       * entre la respuesta HTTP y el callback). */
      persistTokensToStorage(data);
      onRefreshed(data);
      return data.accessToken;
    } catch (e: unknown) {
      const apiErr = e instanceof AxiosError ? normalizeAxiosError(e) : e;
      lastError = apiErr;
      const kind = classifyError(apiErr);
      if (kind === 'rate-limited') {
        refreshBlockedUntil = Date.now() + Math.max(rateLimitRemainingMs(), 1000);
        break;
      }
      if (kind !== 'unauthorized') break; // 403, red, 5xx…: sin reintento inmediato
      /* 401 (token rotado/revocado): si otro proceso lo renovó, leer el actualizado y reintentar UNA vez. */
      const newRefreshToken = getRefreshToken();
      if (!newRefreshToken || newRefreshToken === refreshToken) break;
      refreshToken = newRefreshToken;
    }
  }
  throw lastError ?? new ApiError(401, 'UNAUTHORIZED', 'No se pudo refrescar la sesión');
}

/** Solo pruebas: borra el bloqueo del refresh. */
export function resetRefreshBlock(): void {
  refreshBlockedUntil = 0;
}

/** Persiste tokens en localStorage usando la misma estructura que authStore.
 *  Se duplica la lógica de persistSession/onRefreshed para ser tolerante
 *  al HMR: performRefresh no puede depender del store (que puede recargarse).
 *  La expiración sale del claim `exp` del propio token (el TTL lo configura el backend), no de un valor fijo. */
function persistTokensToStorage(session: { accessToken: string; refreshToken: string; refreshTokenExpiresAt?: string }) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    let expiresAt = Date.now() + 30 * 86400000;
    if (raw) {
      try { expiresAt = (JSON.parse(raw) as { expiresAt?: number }).expiresAt ?? expiresAt; } catch {}
    }
    const refreshExp = session.refreshTokenExpiresAt ? Date.parse(session.refreshTokenExpiresAt) : NaN;
    if (!Number.isNaN(refreshExp)) expiresAt = refreshExp;
    const stored: {
      accessToken: string;
      refreshToken: string;
      accessExpiresAt: number;
      expiresAt: number;
    } = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: accessExpiryOf(session.accessToken),
      expiresAt,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* storage lleno/bloqueado: el onRefreshed del store hará lo suyo */
  }
}

/** Refresh con mutex intra-tab + cross-tab.
 *  • Intra-tab: refreshPromise (Promise en vuelo) evita refreshs duplicados
 *    dentro de la misma pestaña (interceptor 401 + timer + bootstrap).
 *  • Cross-tab: lock de localStorage evita que múltiples pestañas (ej: Ctrl+F5
 *    rápido) lean el mismo refreshToken viejo y disparen refreshs concurrentes
 *    → 429 Too Many Requests.
 *
 * El lock se adquiere ANTES de leer el refreshToken: así, aunque el refreshToken
 * ya haya sido rotado por el owner, este proceso vuelve a leer el nuevo token
 * desde storage (persistido por onRefreshed) en lugar de usar un token viejo. */
export async function clientRefresh(): Promise<string> {
  /* 1) Mutex intra-tab: si ya hay un refresh en vuelo en ESTA pestaña, esperar. */
  if (refreshPromise) return refreshPromise;

  /* Guardamos el refreshToken al que estábamos apuntando: si otro proceso
   *  cross-tab lo renovó mientras esperábamos el lock, el refreshToken en
   *  storage cambió y NO necesitamos refrescar de nuevo. */
  const myTokenAtStart = getRefreshToken();

  /* 2) Mutex cross-tab: intentar adquirir lock. Reintentar hasta N veces si
   *    otro proceso lo tiene (esperando a que libere). */
  let lockOwner: string | null = null;
  let retries = 0;
  const MAX_RETRIES = 5;
  while (!(lockOwner = acquireRefreshLock())) {
    if (retries++ >= MAX_RETRIES) break;
    await waitForRefreshLockRelease();
  }

  /* 3) Si no pudimos adquirir el lock tras varios intentos, el owner probablemente
   *    falló o se cuelga. Último recurso: refrescar de por medio (sin lock). */
  if (!lockOwner) {
    /* Pero antes: si el refreshToken cambió (otro proceso lo renovó), usar
     *  el accessToken del storage en lugar de refrescar de nuevo. */
    const currentToken = getRefreshToken();
    if (currentToken && currentToken !== myTokenAtStart) {
      const accessToken = readStoredAccessToken();
      if (accessToken) return accessToken;
    }
    return performRefresh();
  }

  /* 4) CRUCIAL: si el refreshToken cambió mientras esperábamos el lock, otro
   *    proceso ya renovó la sesión. Devolver el accessToken actualizado SIN
   *    refrescar de nuevo (evita 429 por refreshs redundantes). */
  const currentToken = getRefreshToken();
  if (currentToken && currentToken !== myTokenAtStart) {
    releaseRefreshLock(lockOwner);
    notifyRefreshDone();
    const accessToken = readStoredAccessToken();
    if (accessToken) return accessToken;
    /* Fallback: refrescar de por medio (caso raro: storage no actualizado). */
    return performRefresh();
  }

  /* 5) Somos el owner: hacer el refresh. performRefresh lee el refreshToken
   *    ACTUAL de loadStored(), persiste el nuevo token vía onRefreshed, y
   *    libera el lock. */
  refreshPromise = performRefresh()
    .finally(() => {
      refreshPromise = null;
      releaseRefreshLock(lockOwner);
      notifyRefreshDone();
    });
  return refreshPromise;
}

client.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<{ error?: { code?: string; message?: string; details?: unknown } }>) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean; replayOnlyOnAuth401?: boolean }) | undefined;

    /* Opt-in por request (p. ej. POST /assistant/lyrics): el backend puede REENVIAR el estado HTTP de un proveedor
     * (incluso un 401) en el cuerpo de un error propio (code distinto de UNAUTHORIZED). Eso no es una sesión vencida:
     * no se refresca ni se repite el POST. Un 401 de autenticación real (code UNAUTHORIZED) sigue su camino de siempre. */
    const authCode = error.response?.data?.error?.code;
    const forwardedByProvider = original?.replayOnlyOnAuth401 === true && typeof authCode === 'string' && authCode !== 'UNAUTHORIZED';

    if (error.response?.status === 401 && original && !original._retried && !original.url?.includes('/auth/') && !forwardedByProvider) {
      original._retried = true;
      try {
        /* Mutex global compartido (clientRefresh): el refresh proactivo del store y los reactivos de varios 401 concurrentes
         * comparten un único POST /auth/refresh. */
        const accessToken = await clientRefresh();
        original.headers.Authorization = `Bearer ${accessToken}`;
        return client.request(original);
      } catch (refreshErr) {
        /* SOLO un rechazo definitivo del refresh (401/403) termina la sesión. Un 429, un corte de red o un 5xx son transitorios:
         * la sesión se conserva y la petición falla con el error real (el llamador / React Query decide cuándo reintentar). */
        if (isDefinitiveRefreshFailure(refreshErr)) {
          onUnauthorized();
          return Promise.reject(new ApiError(401, 'UNAUTHORIZED', 'Tu sesión expiró. Iniciá sesión de nuevo.'));
        }
        return Promise.reject(refreshErr instanceof ApiError ? refreshErr : error instanceof AxiosError ? normalizeAxiosError(error) : refreshErr);
      }
    }

    return Promise.reject(normalizeAxiosError(error));
  }
);

/** GET/POST/etc con unwrapping de { data } — helpers tipados. */
export async function getData<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await client.get(url, { params });
  return res.data.data as T;
}

export async function postData<T>(url: string, body?: unknown): Promise<T> {
  const res = await client.post(url, body);
  return res.data.data as T;
}

/** POST que además devuelve el estado HTTP (200 vs 202): lo necesita el asistente de letras. */
export async function postDataWithStatus<T>(
  url: string,
  body?: unknown,
  config?: { headers?: Record<string, string>; replayOnlyOnAuth401?: boolean },
): Promise<{ status: number; data: T }> {
  const res = await client.post(url, body, config as never);
  return { status: res.status, data: res.data?.data as T };
}

export async function patchData<T>(url: string, body?: unknown): Promise<T> {
  const res = await client.patch(url, body);
  return res.data.data as T;
}

export async function deleteData<T>(url: string): Promise<T> {
  const res = await client.delete(url);
  return res.data.data as T;
}

/** Las URLs de archivos del backend vienen como /api/files/{id}/stream —
 *  si el API está en otro origin, hay que prefijarlo. */
export function apiFileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!API_BASE) return url;
  try {
    const origin = new URL(API_BASE).origin;
    return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
  } catch {
    return url;
  }
}
