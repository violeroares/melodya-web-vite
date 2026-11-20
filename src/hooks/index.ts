
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { billingApi, generationApi } from '@/lib/api';
import { API_BASE } from '@/lib/api/client';
import { startPoller } from '@/lib/api/polling';
import { useAuthStore, getAccessTokenSync, SESSION_RENEWED_EVENT } from '@/stores/auth';
import { isCommercialStateCurrent, refreshCommercialState, type BillingStateEvent } from '@/lib/commercial-state';
import { usePlayerStore } from '@/stores/player';
import type { GenerationFailure } from '@/lib/generation-failure';
import {
  activeGenerationIds,
  activeGenerationSignature,
  applyGenerationCompleted,
  settledSince,
  type GenerationCompletedPayload,
} from '@/lib/generation-sync';
import type { Generation, NotificationType } from '@/types';

/** Saldo de fichas — siempre fresco (socket lo actualiza por cache). */
export function useCredits() {
  const status = useAuthStore((s) => s.status);
  return useQuery({
    queryKey: ['credits'],
    queryFn: () => billingApi.balance(),
    enabled: status === 'authenticated',
    staleTime: 30_000,
  });
}

/** Actualiza todos los saldos cacheados (evento socket credits:update). */
export function applyCreditsUpdate(qc: QueryClient, balance: number) {
  qc.setQueryData(['credits'], { balance });
  const me = qc.getQueryData<{ creditsBalance: number }>(['me']);
  if (me) qc.setQueryData(['me'], { ...me, creditsBalance: balance });
}

export function useDebounce<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Formato de duración mm:ss. */
export function formatDuration(seconds?: number | null): string {
  if (!seconds || !Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatPriceCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

export function formatRelative(date?: string | null): string {
  if (!date) return '';
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'recién';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatNumber(n?: number | null): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 < 100 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/* ── Socket.IO: eventos EXACTOS del backend ──
 *  generation:update { generationId, jobId, task, status, progress }
 *  generation:completed { generationId, songId, versionId, versionNumber? }
 *  generation:failed { generationId, error }
 *  credits:update { balance, reason? }
 *  billing:state-changed { reason, status, planCode, currentPeriodEnd }   (el backend cambió la suscripción: renovación, gracia, vencimiento, cambio programado…)
 *  notification:created { id, type, actor, song, createdAt }   (v0.18.0)
 */
interface SocketLike {
  connected: boolean;
  on(ev: string, cb: (payload: never) => void): void;
  off(ev: string, cb: (payload: never) => void): void;
  disconnect(): void;
  connect(): void;
}

type GenUpdate = { generationId: string; jobId: string; task: string; status: string; progress: number };
type GenCompleted = GenerationCompletedPayload;
type GenFailed = { generationId: string; error?: GenerationFailure };
type CreditsUpdate = { balance: number; reason?: string };

/** Payload del evento `notification:created` (backend v0.18.0): llega en vivo
 *  cuando alguien te sigue, comenta, responde o da me gusta. */
export interface NotificationCreatedPayload {
  id: string;
  type: NotificationType;
  actor: { id: string; name: string } | null;
  song: { id: string; title: string } | null;
  /** v0.24.0 — texto del aviso SYSTEM (toasts del panel / moderación). */
  message?: string | null;
  createdAt: string;
}

export { applyGenerationCompleted };

const RECONCILE_ACTIVE_MS = 5_000;
const RECONCILE_IDLE_MS = 60_000;

export type RealtimeEvent =
  | { type: 'generation:update'; payload: GenUpdate }
  | { type: 'generation:completed'; payload: GenCompleted }
  | { type: 'generation:failed'; payload: GenFailed }
  | { type: 'credits:update'; payload: CreditsUpdate }
  | { type: 'billing:state-changed'; payload: BillingStateEvent }
  | { type: 'notification:created'; payload: NotificationCreatedPayload };

export function useRealtime(onEvent?: (ev: RealtimeEvent) => void) {
  const qc = useQueryClient();
  const status = useAuthStore((s) => s.status);
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(onEvent);
  useEffect(() => {
    cbRef.current = onEvent;
  });

  useEffect(() => {
    if (status !== 'authenticated') return;
    let disposed = false;
    let socket: (SocketLike & { auth: unknown }) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let removeRenewed: (() => void) | null = null;
    let connectedPoll: ReturnType<typeof setInterval> | null = null;
    let serverDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (disposed) return;
      try {
        const { io } = await import('socket.io-client');
        const token = useAuthStore.getState().accessToken ?? getAccessTokenSync();
        if (!token || disposed) return;
        /* Realtime: socket.io del MISMO origen que el backend oficial (path /socket.io, como initIo del backend).
         * Sin VITE_API_BASE_URL válida no hay conexión (la web muestra el error de configuración). */
        if (!API_BASE) return;
        const realtimeUrl = new URL(API_BASE).origin;
        socket = io(realtimeUrl, {
          path: '/socket.io',
          /* Función: cada conexión y reconexión usa el access token VIGENTE (no el capturado al abrir). Sin esto, tras renovar o
           * refrescar la sesión el socket reconectaría con un token viejo e invalidado. */
          auth: (cb: (data: { token: string | null }) => void) => cb({ token: useAuthStore.getState().accessToken ?? getAccessTokenSync() }),
          transports: ['websocket', 'polling'],
          reconnectionDelay: 2000,
          reconnectionDelayMax: 10000,
        }) as unknown as SocketLike & { auth: unknown };

        /* Sin escritura en caché: el progreso en vivo lo pinta GenerationStatus (GET /generations/:id) y los listados se
         * refrescan con la reconciliación y al completarse. (Antes había un setQueryData sobre ['generations'], una clave
         * exacta que ninguna consulta usa y con forma de arreglo: nunca tuvo efecto.) */
        const onUpdate = (payload: GenUpdate) => {
          cbRef.current?.({ type: 'generation:update', payload });
        };
        const onCompleted = (payload: GenCompleted) => {
          applyGenerationCompleted(qc, payload);
          cbRef.current?.({ type: 'generation:completed', payload });
        };
        const onFailed = (payload: GenFailed) => {
          void qc.invalidateQueries({ queryKey: ['generations'] });
          void qc.invalidateQueries({ queryKey: ['credits'] });
          cbRef.current?.({ type: 'generation:failed', payload });
        };
        const onCredits = (payload: CreditsUpdate) => {
          applyCreditsUpdate(qc, payload.balance);
          void qc.invalidateQueries({ queryKey: ['me'] });
          cbRef.current?.({ type: 'credits:update', payload });
        };
        /* Notificación nueva (v0.18.0): repinta el centro de notificaciones y el
         * badge de la campanita; el toast lo decide el callback (AppShell) para
         * no molestar cuando el usuario ya está en /notifications. */
        const onNotification = (payload: NotificationCreatedPayload) => {
          /* ['notifications'] ya cubre ['notifications', 'unread-count'] (coincidencia por prefijo). */
          void qc.invalidateQueries({ queryKey: ['notifications'] });
          cbRef.current?.({ type: 'notification:created', payload });
        };

        socket.on('generation:update', onUpdate as never);
        socket.on('generation:completed', onCompleted as never);
        socket.on('generation:failed', onFailed as never);
        /* El backend cambió la suscripción (renovación, gracia, vencimiento, cambio programado…): se vuelve a hidratar el estado comercial con el MISMO
         * mecanismo que usan las acciones del usuario. Si el perfil ya coincide (la propia acción del usuario ya lo cargó) no se pide nada. */
        const refreshFromServer = () => void refreshCommercialState(qc, () => useAuthStore.getState().loadMe());
        const onBilling = (payload: BillingStateEvent) => {
          if (!isCommercialStateCurrent(useAuthStore.getState().user, payload)) refreshFromServer();
          cbRef.current?.({ type: 'billing:state-changed', payload });
        };
        socket.on('credits:update', onCredits as never);
        socket.on('billing:state-changed', onBilling as never);
        /* Recuperación tras una desconexión: los avisos emitidos mientras no había conexión no se reenvían, así que al RECONECTAR (no en la primera conexión ni en la
         * reconexión deliberada al renovar la sesión) se vuelve a hidratar el estado vigente. */
        let hadConnection = false;
        let deliberateReconnect = false;
        const onConnect = () => {
          if (hadConnection && !deliberateReconnect && !disposed) refreshFromServer();
          deliberateReconnect = false;
          hadConnection = true;
        };
        socket.on('connect', onConnect as never);
        socket.on('notification:created', onNotification as never);
        /* Si el backend cierra la conexión (cambio/recuperación de contraseña: io server disconnect) socket.io NO reconecta solo:
         * se reconecta con el access token vigente. Al renovar la sesión de este dispositivo se fuerza una reconexión inmediata. */
        const sock = socket;
        sock.on('disconnect', ((reason: string) => {
          if (reason === 'io server disconnect' && !disposed) {
            if (serverDisconnectTimer) clearTimeout(serverDisconnectTimer);
            serverDisconnectTimer = setTimeout(() => { if (!disposed) sock.connect(); }, 1500);
          }
        }) as never);
        const onRenewed = () => {
          if (disposed) return;
          deliberateReconnect = true; // el estado no cambió: no hace falta hidratar al volver
          sock.disconnect();
          sock.connect();
        };
        window.addEventListener(SESSION_RENEWED_EVENT, onRenewed);
        removeRenewed = () => window.removeEventListener(SESSION_RENEWED_EVENT, onRenewed);
        /* Solo estado local (sin HTTP). El handle se guarda y se limpia en el cleanup: antes se perdía y quedaba un intervalo vivo
         * por cada ciclo de sesión. */
        if (connectedPoll) clearInterval(connectedPoll);
        connectedPoll = setInterval(() => setConnected(Boolean(socket?.connected)), 1500);
      } catch {
        if (!disposed) reconnectTimer = setTimeout(connect, 5000);
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (connectedPoll) clearInterval(connectedPoll);
      if (serverDisconnectTimer) clearTimeout(serverDisconnectTimer);
      removeRenewed?.();
      (socket as unknown as { removeAllListeners?: () => void } | null)?.removeAllListeners?.();
      socket?.disconnect();
      setConnected(false);
    };
  }, [qc, status]);

  return connected;
}

/** Polling de reconciliación de generaciones activas (fuente de verdad REST).
 *  Con generaciones activas sondea cada 5s; sin actividad, un latido lento
 *  cada 60s (para descubrir generaciones iniciadas en otro dispositivo). */
export function useGenerationReconciliation() {
  const status = useAuthStore((s) => s.status);
  const qc = useQueryClient();
  useEffect(() => {
    if (status !== 'authenticated') return;
    let hasActive = false;
    let first = true;
    /* Huella e ids de las generaciones en curso del ciclo anterior: solo se invalida cuando cambia (ver generation-sync.ts). */
    let lastSignature = '';
    let lastActiveIds = new Set<string>();
    /* Poller resiliente (lib/api/polling.ts): un ciclo en vuelo, pausa con la pestaña oculta (al volver reconcilia de inmediato),
     * backoff con 429/red/5xx (respeta Retry-After) y SIN detenerse por errores transitorios: sigue descubriendo generaciones. */
    const poller = startPoller({
      immediate: false,
      baseMs: () => {
        if (first) {
          first = false;
          return RECONCILE_ACTIVE_MS;
        }
        // Rápido con trabajo en curso; latido lento en reposo (descubre generaciones iniciadas en otro dispositivo).
        return hasActive ? RECONCILE_ACTIVE_MS : RECONCILE_IDLE_MS;
      },
      run: async () => {
        const res = await generationApi.list({ pageSize: 10 });
        const signature = activeGenerationSignature(res.items);
        hasActive = signature !== '';
        /* Las que terminaron desde el ciclo anterior sin que llegara el evento por socket (conexión caída, pestaña dormida). */
        const settled = settledSince(lastActiveIds, res.items);
        lastActiveIds = activeGenerationIds(res.items);
        for (const done of settled.completed) applyGenerationCompleted(qc, done);
        if (settled.unsuccessful.length > 0) void qc.invalidateQueries({ queryKey: ['credits'] });
        if (signature !== lastSignature) {
          lastSignature = signature;
          await qc.invalidateQueries({ queryKey: ['generations'] });
        }
      },
    });
    return () => poller.stop();
  }, [status, qc]);
}

/** Autoplay helper del player global (registra plays de la comunidad). */
export function useRegisterCommunityPlay() {
  const play = usePlayerStore((s) => s.play);
  return (track: Parameters<typeof play>[0]) => play(track);
}
