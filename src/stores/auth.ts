/**
 * MELODYA WEB — authStore (zustand + persistencia):
 * tokens en storage, refresh proactivo, hidratación de sesión (GET /users/me).
 *
 * POLÍTICA DE ERRORES (ver lib/api/resilience.ts y docs/TRAFFIC.md)
 *  • Solo un rechazo DEFINITIVO del refresh (401 / 403 de POST /auth/refresh) o un refresh token vencido cierra la sesión (forceGuest).
 *  • 429, corte de red y 5xx son TRANSITORIOS: la sesión (tokens y usuario cargado) se conserva y se reintenta con backoff,
 *    respetando Retry-After.
 *  • El refresh proactivo se agenda con la expiración REAL del access token (claim `exp`), no con un TTL supuesto.
 */
import { create } from 'zustand';
import { authApi, profileApi } from '@/lib/api';
import { bindAuthCallbacks, clientRefresh } from '@/lib/api/client';
import { navigate } from '@/lib/router';
import {
  accessExpiryOf,
  backoffMs,
  classifyError,
  computeRefreshDelayMs,
  decodeJwtTimes,
  FALLBACK_ACCESS_TTL_MS,
  isTransient,
  rateLimitRemainingMs,
  refreshLeadMs,
  type RateScope,
} from '../lib/api/resilience.ts';
import type { MeProfile } from '@/types';

const STORAGE_KEY = 'melodya.session';

/** Evento de ventana: la sesión de este dispositivo se renovó (p. ej. al cambiar la contraseña) → reconectar Socket.IO. */
export const SESSION_RENEWED_EVENT = 'melodya:session-renewed';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms de expiración REAL del access token (claim `exp`) — para el refresh proactivo
  expiresAt: number; // epoch ms del refresh token
}

function loadStored(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Token de acceso sincrónico (store o storage persistido). Lo usan cargas
 *  tempranas (p. ej. el artwork del MediaSession cuando se restaura la sesión
 *  del player) que pueden correr antes de que termine el bootstrap async. */
export function getAccessTokenSync(): string | null {
  return useAuthStore.getState().accessToken ?? loadStored()?.accessToken ?? null;
}

/** Resultado de intentar cargar el perfil: 'transient' = no se pudo ahora (429/red/5xx) pero la sesión sigue vigente. */
export type LoadMeOutcome = 'ok' | 'unauthorized' | 'transient';

interface AuthState {
  user: MeProfile | null;
  accessToken: string | null;
  status: 'idle' | 'loading' | 'authenticated' | 'guest';
  bootstrapPromise: Promise<void> | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: (all?: boolean) => Promise<void>;
  refreshSession: () => Promise<void>;
  /** Cambia la contraseña y renueva la sesión de ESTE dispositivo (las demás quedan cerradas). */
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ sessionRenewed: boolean }>;
  loadMe: () => Promise<LoadMeOutcome>;
  setUser: (user: MeProfile | null) => void;
  bootstrap: () => Promise<void>;
}

/* ── Timers (uno solo de cada tipo por pestaña) ───────────── */

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let refreshFailures = 0;
let recoveryFailures = 0;
let storageSyncBound = false;

const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Margen sobre Retry-After / la compuerta de 429: si el reintento cae unos ms ANTES de que termine el bloqueo, se rechaza sin
 *  HTTP y cuenta como un fallo más (saltaría al siguiente escalón de backoff). */
const RETRY_AFTER_MARGIN_MS = 1500;

/** Espera hasta el próximo reintento: backoff, nunca antes de Retry-After ni de que termine la pausa del alcance que falló (con margen):
 *  'refresh' para la renovación de la sesión, 'api' para cargar el perfil (GET /users/me). */
function retryDelayMs(failures: number, err: unknown, scope: RateScope = 'api'): number {
  const retryAfter = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0;
  const gate = rateLimitRemainingMs(scope);
  const floor = Math.max(retryAfter, gate);
  return Math.max(backoffMs(RETRY_BASE_MS, failures, RETRY_MAX_MS), floor > 0 ? floor + RETRY_AFTER_MARGIN_MS : 0);
}

function armRefreshTimer(ms: number) {
  if (typeof window === 'undefined') return;
  if (refreshTimer) clearTimeout(refreshTimer); // nunca dos timers de refresh a la vez
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void useAuthStore.getState().refreshSession();
  }, ms);
}

/** Agenda la renovación según la expiración REAL del access token: `exp` del JWT (o `fallbackExp` si el token no es un JWT), con margen
 *  de seguridad del 20 % de su vida (entre 5 s y 2 min) y jitter para que varias pestañas no coincidan. */
function scheduleProactiveRefresh(accessToken: string | null | undefined, fallbackExp?: number) {
  const times = decodeJwtTimes(accessToken);
  const exp = times.exp ?? fallbackExp ?? Date.now() + FALLBACK_ACCESS_TTL_MS;
  armRefreshTimer(computeRefreshDelayMs({ now: Date.now(), exp, iat: times.iat }));
}

function armFromStored() {
  const s = loadStored();
  if (s) scheduleProactiveRefresh(s.accessToken, s.accessExpiresAt);
}

/** ¿El access token guardado está dentro del margen de renovación (o vencido)? */
function needsRefresh(s: StoredSession): boolean {
  const times = decodeJwtTimes(s.accessToken);
  const exp = times.exp ?? s.accessExpiresAt;
  const lifetime = times.iat && exp > times.iat ? exp - times.iat : Math.max(exp - Date.now(), FALLBACK_ACCESS_TTL_MS);
  return exp - Date.now() <= refreshLeadMs(lifetime) + 15_000;
}

/** Estado de sesión guardado en storage. */
function persistSession(session: StoredSession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

/** 401/403 definitivo del refresh (o refresh token vencido): sesión abajo + reset de todo el
 *  estado de usuario (caché de queries, player, borradores, object URLs). */
function forceGuest() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (recoveryTimer) clearTimeout(recoveryTimer);
  refreshTimer = null;
  recoveryTimer = null;
  refreshFailures = 0;
  recoveryFailures = 0;
  localStorage.removeItem(STORAGE_KEY);
  useAuthStore.setState({ user: null, accessToken: null, status: 'guest' });
  void import('@/lib/session-reset').then((m) => m.resetUserSessionState());
}

/** Falló un refresh. Definitivo → cierra la sesión. Transitorio → la conserva y reintenta con backoff (≥ Retry-After). */
function handleRefreshFailure(err: unknown) {
  const kind = classifyError(err);
  const stored = loadStored();
  if (!isTransient(kind) || !stored || stored.expiresAt <= Date.now()) {
    forceGuest();
    return;
  }
  refreshFailures += 1;
  armRefreshTimer(retryDelayMs(refreshFailures, err, 'refresh'));
}

/** Sin usuario cargado y con un fallo transitorio: reintenta hidratar la sesión con backoff (un solo timer, sin ráfagas). */
function scheduleSessionRecovery(err: unknown, scope: RateScope = 'api') {
  if (recoveryTimer || typeof window === 'undefined') return;
  recoveryFailures += 1;
  const delay = retryDelayMs(recoveryFailures, err, scope);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (!loadStored() || useAuthStore.getState().user) return;
    void hydrate();
  }, delay);
}

/** Hidrata la sesión guardada: renueva el token si está por vencer y carga GET /users/me. Nunca cierra la sesión por errores transitorios. */
async function hydrate(): Promise<LoadMeOutcome> {
  const stored = loadStored();
  if (!stored) return 'unauthorized';
  useAuthStore.setState({ accessToken: stored.accessToken });
  if (needsRefresh(stored)) {
    try {
      await clientRefresh();
    } catch (err) {
      if (!isTransient(classifyError(err)) || stored.expiresAt <= Date.now()) {
        forceGuest();
        return 'unauthorized';
      }
      // 429 / red / 5xx: la sesión sigue guardada; la UI arranca como invitado y se reintenta con backoff.
      if (!useAuthStore.getState().user) useAuthStore.setState({ status: 'guest' });
      scheduleSessionRecovery(err, 'refresh');
      return 'transient';
    }
  }
  const outcome = await useAuthStore.getState().loadMe();
  if (outcome === 'ok') {
    recoveryFailures = 0;
    armFromStored();
  }
  return outcome;
}

/** Configura el cliente HTTP con este store (una sola definición, compartida
 *  por login/register/bootstrap — antes estaba triplicada). */
function bindStoreToClient() {
  bindAuthCallbacks({
    getAccessToken: () => useAuthStore.getState().accessToken ?? loadStored()?.accessToken ?? null,
    getRefreshToken: () => loadStored()?.refreshToken ?? null,
    onRefreshed: (s) => {
      refreshFailures = 0;
      persistSession({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        accessExpiresAt: accessExpiryOf(s.accessToken),
        expiresAt: loadStored()?.expiresAt ?? Date.now() + 30 * 86400000,
      });
      useAuthStore.setState({ accessToken: s.accessToken });
      /* El refresh reactivo (401) también reagenda el proactivo con la nueva expiración real. */
      scheduleProactiveRefresh(s.accessToken);
    },
    onUnauthorized: forceGuest,
  });
}

/** Varias pestañas: cuando otra renueva los tokens, esta adopta el token nuevo y reagenda SU timer (no pide otro refresh). */
function bindStorageSync() {
  if (storageSyncBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  storageSyncBound = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    const s = loadStored();
    const state = useAuthStore.getState();
    if (!s || state.status !== 'authenticated' || s.accessToken === state.accessToken) return;
    useAuthStore.setState({ accessToken: s.accessToken });
    refreshFailures = 0;
    scheduleProactiveRefresh(s.accessToken, s.accessExpiresAt);
  });
}

/** Login/registro comparten el posproceso: reset del estado del usuario
 *  anterior (caché, player, borradores), guardado de tokens e hidratación. */
async function startSession(session: { accessToken: string; refreshToken: string }) {
  /* Si había una sesión de OTRA cuenta (o datos de invitado) en caché, fuera:
   * el usuario que entra arranca desde cero, sin ver nada del anterior. */
  const { resetUserSessionState } = await import('@/lib/session-reset');
  await resetUserSessionState();

  persistSession({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: accessExpiryOf(session.accessToken),
    expiresAt: Date.now() + 30 * 86400000,
  });
  useAuthStore.setState({ accessToken: session.accessToken, status: 'authenticated' });
  bindStoreToClient();
  bindStorageSync();
  const outcome = await useAuthStore.getState().loadMe();
  if (outcome === 'ok') armFromStored();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  status: 'idle',
  bootstrapPromise: null,

  login: async (email, password) => {
    const session = await authApi.login({ email, password });
    await startSession(session);
  },

  register: async (email, password, name) => {
    const session = await authApi.register({ email, password, name });
    await startSession(session);
  },

  logout: async (all = false) => {
    const stored = loadStored();
    try {
      if (all) await authApi.logoutAll();
      else await authApi.logout(stored?.refreshToken);
    } catch {
      /* logout best-effort */
    }
    localStorage.removeItem(STORAGE_KEY);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    refreshTimer = null;
    recoveryTimer = null;
    set({ user: null, accessToken: null, status: 'guest' });

    /* Todo el estado del usuario (caché de queries, reproductor, historial,
     * borrador del asistente, object URLs) se limpia: el siguiente usuario del
     * mismo navegador no debe ver nada del anterior sin un Ctrl+F5. */
    const { resetUserSessionState } = await import('@/lib/session-reset');
    await resetUserSessionState();

    /* Volver al inicio (landing pública): sin vistas privadas abiertas. */
    if (typeof window !== 'undefined') navigate('/');
  },

  /** Renovación proactiva (la dispara el timer). */
  refreshSession: async () => {
    const stored = loadStored();
    if (!stored) return;
    /* Otra pestaña ya renovó mientras tanto: se adopta su token SIN pedir otro refresh (evita renovaciones duplicadas). */
    if (!needsRefresh(stored)) {
      if (stored.accessToken !== get().accessToken) set({ accessToken: stored.accessToken });
      scheduleProactiveRefresh(stored.accessToken, stored.accessExpiresAt);
      return;
    }
    /* Trabajo en segundo plano: si el limitador del REFRESH está pidiendo esperar (429), se espera a que termine. Un 429 de la API general
     * o de los archivos no impide renovar el access token. */
    const wait = rateLimitRemainingMs('refresh');
    if (wait > 0) {
      armRefreshTimer(wait + RETRY_AFTER_MARGIN_MS);
      return;
    }
    try {
      const newAccessToken = await clientRefresh();
      set({ accessToken: newAccessToken });
    } catch (err) {
      handleRefreshFailure(err);
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    const stored = loadStored();
    const res = await authApi.changePassword({ currentPassword, newPassword, refreshToken: stored?.refreshToken });
    if (res.sessionRenewed && res.accessToken && res.refreshToken) {
      /* Sesión nueva de ESTE dispositivo: los tokens anteriores ya no valen (el backend sube la versión de sesión). */
      persistSession({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        accessExpiresAt: accessExpiryOf(res.accessToken),
        expiresAt: Date.now() + 30 * 86400000,
      });
      set({ accessToken: res.accessToken });
      scheduleProactiveRefresh(res.accessToken);
      /* El backend cerró los sockets de la cuenta: useRealtime reconecta con el access token nuevo. */
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_RENEWED_EVENT));
      return { sessionRenewed: true };
    }
    /* Sin sesión nueva (cliente sin refresh vigente): el backend cerró TODAS las sesiones, también esta. */
    forceGuest();
    if (typeof window !== 'undefined') navigate('/login');
    return { sessionRenewed: false };
  },

  loadMe: async () => {
    try {
      const me = await profileApi.me();
      set({ user: me, status: 'authenticated' });
      return 'ok';
    } catch (err) {
      const kind = classifyError(err);
      if (isTransient(kind)) {
        /* 429 / red / 5xx: NO es una sesión inválida. Si ya había un usuario cargado se conserva tal cual; si no, la UI sigue como
         * invitado mientras se reintenta con backoff (los tokens quedan guardados). */
        if (!get().user) {
          set({ status: 'guest' });
          scheduleSessionRecovery(err);
        }
        return 'transient';
      }
      if (kind === 'forbidden') {
        forceGuest(); // cuenta no activa: reintentar no ayuda
        return 'unauthorized';
      }
      set({ user: null, status: 'guest' });
      return 'unauthorized';
    }
  },

  setUser: (user) => set({ user }),

  bootstrap: () => {
    const state = get();
    if (state.bootstrapPromise) return state.bootstrapPromise;
    const p = (async () => {
      bindStoreToClient();
      bindStorageSync();
      const stored = loadStored();
      if (!stored) {
        set({ status: 'guest' });
        return;
      }
      set({ accessToken: stored.accessToken, status: 'loading' });
      /* Si el token YA venció (o está dentro del margen) se renueva ANTES de pedir el perfil: así varias recargas seguidas no disparan
       * refreshs concurrentes. Un 429/red/5xx NO cierra la sesión: arranca como invitado y se reintenta con backoff. */
      await hydrate();
    })();
    set({ bootstrapPromise: p });
    return p;
  },
}));
