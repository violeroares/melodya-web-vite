
/**
 * MELODYA WEB — playerStore: reproductor global persistente entre vistas.
 * Un único <audio> montado en el shell; la navegación no corta la música.
 *
 * • Audio privado: los <audio>/<img> no pueden enviar el header Authorization,
 *   así que si el stream directo falla (403 → MEDIA_ELEMENT_ERROR) se re-intenta
 *   descargando el archivo con fetch autenticado y usando un blob URL (compatible
 *   con el contrato real del backend, sin endpoints inventados).
 * • MediaSession API (CLIENT-ONLY): controles de pantalla de bloqueo / teclas
 *   multimedia del SO / auriculares Bluetooth sincronizados con el player.
 * • "Escuchadas recientemente": historial local (localStorage) de las últimas
 *   pistas reproducidas para ofrecer "Seguí escuchando" en el home.
 * • Sesión persistida: tras recargar, el reproductor vuelve con la última pista
 *   y cola (PAUSADA en la posición guardada) — "seguí donde la dejaste".
 * • Velocidad de reproducción (0.75×–1.5×) persistida entre sesiones.
 * • Timer de sueño (CLIENT-ONLY): pausa la música a los N minutos o al terminar
 *   el tema actual, con aviso previo en la UI.
 * • Radio de la comunidad (CLIENT-ONLY sobre paginación real del feed): cola
 *   infinita — cuando quedan ≤2 temas por delante se agrega la página siguiente
 *   (useRadioWatcher en PlayerBar). Al recargar, la radio no se restaura (la
 *   cola queda estática, pausada donde quedó).
 */
import { create } from 'zustand';
import { useAuthStore, getAccessTokenSync } from './auth';
import { ensureAudioRunning } from '@/lib/audio-viz';
import { apiFileUrl } from '@/lib/api/client';
import { songsApi } from '@/lib/api';
import { authImageMimeType, authImageObjectUrl } from '@/lib/auth-image';
import { noteRateLimit, rateLimitRemainingMs } from '@/lib/api/resilience';
import { usesAuthenticatedSource, createAuthSource, fetchAudioBlob, probeAudioAccess, audioErrorMessage, isTransientAudioError, AudioSourceError } from './player-source';

export interface PlayerTrack {
  id: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  audioUrl: string;
  durationSec?: number | null;
  lyrics?: string | null;
  isPublic?: boolean;
  /** Tipo de recurso. Ausente = canción. Un `sample` (muestra de voz/instrumental) no es una canción: no tiene letra ni ficha en /songs/:id. */
  kind?: 'song' | 'sample';
  /** La canción pertenece al usuario actual (solo esas se pueden referenciar
   *  en colecciones/letristas según el contrato real del backend). */
  own?: boolean;
  /** Canción propia en la Papelera: se puede escuchar y leer la letra, pero no se comparte ni se descarga. */
  trashed?: boolean;
  onPlayed?: () => void;
  /** Metadatos de comunidad (si la pista viene del feed público): permite
   *  reaccionar (me gusta) desde el reproductor sin re-fetch, y saltar al
   * perfil del creador en la comunidad (authorId, filtro real del feed). */
  community?: {
    likesCount: number;
    viewerReaction: 'LIKE' | 'DISLIKE' | null;
    authorId?: string | null;
  };
}

/** Modo radio activo (por ahora solo comunidad). null = reproducción normal. */
export type RadioMode = 'community-newest' | 'community-most_liked' | 'community-most_played';

interface PlayerState {
  track: PlayerTrack | null;
  queue: PlayerTrack[];
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  recent: PlayerTrack[];
  /* Reproducción en orden aleatorio persistida (CLIENT-ONLY): cuando está
     activa, "siguiente" elige una pista al azar del resto de la cola. */
  shuffle: boolean;
  /* Timer de sueño: epoch-ms en que hay que pausar (null = desactivado). */
  sleepAt: number | null;
  /* Pausar cuando termine el tema actual. */
  sleepEndOfTrack: boolean;
  /* Se restauró la sesión persistida en este arranque (para avisar una vez). */
  sessionRestored: boolean;
  /* Radio: modo activo (null = normal), última página de feed cargada y
     género del filtro activo (la radio por género usa el mismo contrato). */
  radioMode: RadioMode | null;
  radioPage: number;
  radioGenre: string | null;
  setAudio: (el: HTMLAudioElement | null) => void;
  play: (track: PlayerTrack, queue?: PlayerTrack[], opts?: { keepRadio?: boolean }) => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setSpeed: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  syncTime: (position: number, duration: number) => void;
  next: () => void;
  prev: () => void;
  stop: () => void;
  retryWithAuth: () => Promise<void>;
  /** Motivo (para el usuario) por el que no se pudo cargar el audio autenticado; null si no hubo error. */
  playbackError: string | null;
  clearRecent: () => void;
  setSleepTimer: (minutes: number | null) => void;
  setSleepEndOfTrack: (v: boolean) => void;
  clearSleep: () => void;
  acknowledgeRestore: () => void;
  /* Radio de la comunidad */
  startRadio: (mode: RadioMode, tracks: PlayerTrack[], opts?: { genre?: string | null }) => void;
  appendRadioPage: (tracks: PlayerTrack[]) => number;
  /* Cola manual: "reproducir a continuación" / "agregar a la cola" / quitar */
  playNext: (track: PlayerTrack) => boolean;
  addToQueue: (track: PlayerTrack) => boolean;
  removeFromQueue: (track: PlayerTrack) => boolean;
  /* Reordenar la cola (drag & drop / botones): mueve la pista de `from` a `to`. */
  moveInQueue: (from: number, to: number) => boolean;
  /* Vaciar la cola (conserva el tema en curso). Devuelve cuántas quitó;
   * se puede deshacer una vez con undoClearQueue(). */
  clearQueue: () => number;
  undoClearQueue: () => boolean;
  /* Reacción del tema en curso (me gusta): actualiza pista + cola + sesión. */
  setTrackReaction: (liked: boolean, count: number) => void;
  /* Renombraron una canción (PATCH /songs/:id): sincroniza el título en el
   * tema en curso, la cola y el historial de escuchadas, para que el player
   * no siga mostrando el nombre viejo hasta la próxima reproducción. */
  renameTrack: (id: string, title: string) => void;
  /* Enviaron una canción propia a la Papelera (o la restauraron): marca sus pistas ya cargadas (en curso, cola, recientes y sesión).
   * En la Papelera la pista deja de ser «pública» (el audio solo lo sirve el backend al dueño, con sesión → descarga autenticada) y
   * no cuenta reproducciones ni se comparte/descarga. Sin consultas: solo reutiliza el estado del reproductor. */
  setTrackTrashed: (id: string, trashed: boolean) => void;
  /* Bloqueo de usuario (v0.26): el bloqueo oculta TODO, incluida la música
   * del autor que ya estaba en la cola o sonando. Quita sus pistas de la
   * cola y del historial; si estaba sonando, salta a la siguiente pista
   * disponible (o corta si no queda nada). Devuelve cuántas quitó. */
  purgeAuthor: (authorId: string) => number;
  /* Reset completo de usuario (logout / cambio de cuenta): corta el audio,
   * vacía cola + historial + radio, borra la sesión persistida y los datos
   * del usuario en localStorage. No toca volumen/velocidad (prefs de dispositivo). */
  hardReset: () => void;
}

let audioEl: HTMLAudioElement | null = null;
let retriedTrack: string | null = null;
/* Última cola vaciada (para "Deshacer" una única vez). */
let lastClearedQueue: PlayerTrack[] | null = null;

/** El backend (y varias vistas) arman las URLs de audio/portada RELATIVAS
 *  (/api/files/{id}/stream). Con el API en otro origin (VITE_API_BASE_URL
 *  http://…:4000/api) esas rutas resolverían contra el origen de la WEB y
 *  producirían 404 en el <audio>, el MediaSession artwork y la cola. El store
 *  es el único embudo hacia el <audio>: normalizamos acá TODA pista que entra
 *  (play, cola, radio, sesión restaurada) para que audioUrl/coverUrl apunten
 *  siempre al backend, vengan de donde vengan. */
function normalizeTrack(t: PlayerTrack): PlayerTrack {
  const audioUrl = apiFileUrl(t.audioUrl) ?? t.audioUrl;
  const coverUrl = apiFileUrl(t.coverUrl);
  const resolved = audioUrl === t.audioUrl && coverUrl === t.coverUrl ? t : { ...t, audioUrl, coverUrl };
  return withPlayCounter(resolved);
}

/**
 * Toda canción PÚBLICA que entra al reproductor (play, cola, historial o sesión restaurada) cuenta su reproducción
 * (POST /songs/:id/play) aunque quien la armó no haya pasado un gancho propio. Las privadas no cuentan: el backend
 * responde 404 para ellas. Un `onPlayed` explícito (feed, detalle, radio…) tiene prioridad.
 */
function withPlayCounter(t: PlayerTrack): PlayerTrack {
  if (t.trashed || t.onPlayed || t.isPublic !== true) return t; // en la Papelera nunca se cuenta (el backend la trata como inexistente)
  return {
    ...t,
    onPlayed: () => {
      songsApi.registerPlay(t.id).catch(() => undefined);
    },
  };
}

/** Clave de la canción cuya reproducción ya se contó (una vez por canción cargada: pausar y reanudar no suma). */
let countedKey: string | null = null;
const trackKey = (t: PlayerTrack) => `${t.id}|${t.audioUrl}`;

function countPlayOnce(track: PlayerTrack) {
  const key = trackKey(track);
  if (countedKey === key) return;
  countedKey = key;
  // El autor escuchando su propia canción no suma (el backend lo ignora igual; así se evita la solicitud).
  if (track.own === true) return;
  // Canción en la Papelera: sin conteo aunque llegue un `onPlayed` viejo (cola o sesión restaurada). Un gancho que falle tampoco corta el audio.
  if (track.trashed === true) return;
  try {
    track.onPlayed?.();
  } catch {
    /* contar es secundario: nunca debe interrumpir la reproducción */
  }
}

/** Descarga autenticada del audio (pistas privadas): ciclo de vida del blob y protección contra respuestas viejas. */
const authSource = createAuthSource({
  fetchBlob: (url, signal) => fetchAudioBlob(url, getAccessTokenSync(), signal),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
});

/** Cancela la descarga pendiente y revoca el blob vigente (cambio de pista, stop, reset). */
function cleanupBlob() {
  authSource.reset();
}

const hasSession = (): boolean => Boolean(getAccessTokenSync());

/**
 * Deja el <audio> SIN fuente: pausa, quita el atributo `src` y llama a `load()`. Quitar `src` por sí solo NO reinicia el elemento (HTML): sigue
 * conectado al recurso anterior (`currentSrc`, `readyState` 4) y un `play()` posterior reproduce —o vuelve a pedir— el audio de la pista
 * ANTERIOR. `load()` lo vacía (networkState EMPTY, readyState 0) sin disparar `error`.
 */
function clearAudioSource(el: HTMLAudioElement) {
  el.pause();
  el.removeAttribute('src');
  el.load();
}

/** Posición diferida: se aplica cuando la metadata del audio está disponible. */
function seekWhenReady(el: HTMLAudioElement, target: number) {
  if (!(target > 0)) return;
  const onMeta = () => {
    el.removeEventListener('loadedmetadata', onMeta);
    if (!el.duration || Number.isFinite(el.duration)) {
      if (!el.duration || target < el.duration) {
        try {
          el.currentTime = target;
        } catch {
          /* noop */
        }
      }
    }
  };
  el.addEventListener('loadedmetadata', onMeta);
}

/**
 * ÚNICO camino de audio autenticado (play, restauración de sesión, remontaje y reintento): descarga el archivo con
 * Authorization y deja el blob en el <audio>. Una respuesta vieja (cambió la pista, stop, reset) se descarta sin crear
 * blob. Los errores de autenticación/permiso se informan en `playbackError` con su motivo.
 */
async function loadAuthenticated(track: PlayerTrack, opts: { autoplay: boolean; position?: number }): Promise<void> {
  /* El limitador de archivos pidió esperar (429 reciente): no se le pega con otra descarga completa; se informa el motivo real. */
  if (rateLimitRemainingMs('files') > 0) {
    usePlayerStore.setState({ isPlaying: false, playbackError: audioErrorMessage(new AudioSourceError(429, 'pausa vigente')) });
    return;
  }
  let result;
  try {
    result = await authSource.load(track.audioUrl);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    if (err instanceof AudioSourceError && err.status === 429) noteRateLimit(err.retryAfterMs, 'files'); // pausa del alcance de archivos (no frena API ni refresh)
    usePlayerStore.setState({ isPlaying: false, playbackError: audioErrorMessage(err) });
    return;
  }
  if (result.status === 'stale') return;
  const el = audioEl;
  if (!el) return; // sin <audio> montado: el blob queda vigente y el remontaje lo reutiliza
  el.src = result.url;
  seekWhenReady(el, opts.position ?? 0);
  if (!opts.autoplay) return;
  el.playbackRate = usePlayerStore.getState().speed; // load() resetea a defaultPlaybackRate; lo reforzamos
  void el.play().then(() => {
    usePlayerStore.setState({ isPlaying: true });
    updateMediaPlayback(true, 0, track.durationSec ?? 0);
  }).catch(() => usePlayerStore.setState({ isPlaying: false }));
}

/**
 * ¿La pista privada actual no tiene fuente válida en el <audio> (la descarga falló —p. ej. un 429— o el elemento se limpió) y tampoco hay una
 * descarga en curso? Entonces un `el.play()` no tiene qué reproducir: hay que volver a pasar por el flujo autenticado. Con una descarga EN CURSO
 * (p. ej. la restauración de la sesión) no se toca nada: el `el.play()` queda pendiente y arranca solo cuando llega el blob.
 */
function needsAuthenticatedReload(track: PlayerTrack, el: HTMLAudioElement): boolean {
  return usesAuthenticatedSource(track, hasSession()) && !el.getAttribute('src') && !authSource.isLoading(track.audioUrl);
}

/**
 * Reintenta la pista privada por el flujo existente (loadAuthenticated): respeta la pausa de archivos (durante un 429 no sale ninguna solicitud y
 * se muestra su mensaje) y, terminada la pausa, descarga y reproduce la pista CORRECTA. Lo usan el segundo clic sobre la misma pista (play) y
 * el botón de reproducir del reproductor, de las tarjetas y de MediaSession (toggle).
 */
function reloadAuthenticated(track: PlayerTrack) {
  retriedTrack = track.audioUrl; // si el blob falla al decodificar no se reintenta en bucle
  usePlayerStore.setState({ isPlaying: false, playbackError: null });
  void loadAuthenticated(track, { autoplay: true });
  countPlayOnce(track);
}

/* ── Historial local "escuchadas recientemente" (CLIENT-ONLY, sin backend) ── */
const RECENT_KEY = 'melodya.player.recent';
const RECENT_MAX = 12;

function loadRecent(): PlayerTrack[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is PlayerTrack => !!t && typeof t.id === 'string' && typeof t.audioUrl === 'string'
    );
  } catch {
    return [];
  }
}

function saveRecent(list: PlayerTrack[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* almacenamiento lleno o no disponible: no rompe nada */
  }
}

function pushRecent(list: PlayerTrack[], track: PlayerTrack): PlayerTrack[] {
  // Sin onPlayed (callback no serializable) y al frente, sin duplicar id+audio.
  const snapshot: PlayerTrack = { ...track, onPlayed: undefined };
  const rest = list.filter((t) => !(t.id === track.id && t.audioUrl === track.audioUrl));
  return [snapshot, ...rest].slice(0, RECENT_MAX);
}

/* ── Sesión del player persistida (CLIENT-ONLY): pista + cola + posición ──
   Tras una recarga se restaura PAUSADA donde quedó (nunca autoplay). */
const SESSION_KEY = 'melodya.player.session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // una semana

interface SavedSession {
  track: PlayerTrack;
  queue: PlayerTrack[];
  position: number;
  duration: number;
  savedAt: string;
  /** La reproducción de `track` ya se contó antes de guardar la sesión. */
  counted?: boolean;
}

function stripCallbacks(t: PlayerTrack): PlayerTrack {
  return { ...t, onPlayed: undefined };
}

function saveSession(s: { track: PlayerTrack | null; queue: PlayerTrack[]; position: number; duration: number }) {
  if (!s.track) return;
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        track: stripCallbacks(s.track),
        queue: s.queue.map(stripCallbacks),
        position: s.position,
        duration: s.duration,
        savedAt: new Date().toISOString(),
        counted: countedKey === trackKey(s.track),
      })
    );
  } catch {
    /* storage lleno o no disponible: no rompe nada */
  }
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession | null;
    if (!s?.track || typeof s.track.id !== 'string' || typeof s.track.audioUrl !== 'string') return null;
    if (s.savedAt && Date.now() - new Date(s.savedAt).getTime() > SESSION_MAX_AGE_MS) {
      clearSession();
      return null;
    }
    if (!Array.isArray(s.queue) || !s.queue.length) s.queue = [s.track];
    return s;
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* noop */
  }
}

/* ── Volumen y velocidad persistidos (CLIENT-ONLY) ── */
const VOLUME_KEY = 'melodya.player.volume';
const SPEED_KEY = 'melodya.player.speed';
const SHUFFLE_KEY = 'melodya.player.shuffle';

function loadShuffle(): boolean {
  try {
    return localStorage.getItem(SHUFFLE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveShuffle(v: boolean) {
  try {
    localStorage.setItem(SHUFFLE_KEY, v ? '1' : '0');
  } catch {
    /* noop */
  }
}

function loadVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.9;
  } catch {
    return 0.9;
  }
}

function saveVolume(v: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    /* noop */
  }
}

const SPEEDS = [0.75, 1, 1.25, 1.5];

function loadSpeed(): number {
  try {
    const v = parseFloat(localStorage.getItem(SPEED_KEY) ?? '');
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

function saveSpeed(v: number) {
  try {
    localStorage.setItem(SPEED_KEY, String(v));
  } catch {
    /* noop */
  }
}

/* Sesión pendiente de restaurar: se aplica cuando el <audio> se monta. */
let pendingSession: SavedSession | null = typeof window === 'undefined' ? null : loadSession();
let lastSessionSaveAt = 0;

interface RestoredSession {
  track: PlayerTrack;
  queue: PlayerTrack[];
  position: number;
  duration: number;
}

/** Carga la pista/cola guardadas en el <audio> (sin play). Devuelve el estado a aplicar. */
function restorePendingSession(el: HTMLAudioElement): RestoredSession | null {
  if (!pendingSession) return null;
  const s = pendingSession;
  pendingSession = null;
  // Sesiones guardadas por versiones previas pueden traer URLs relativas:
  // se normalizan al restaurar (audio + portadas de la cola).
  const restoredQueue = s.queue.map(normalizeTrack);
  const track = normalizeTrack(restoredQueue.find((t) => t.id === s.track.id && t.audioUrl === s.track.audioUrl) ?? s.track);
  // Si ya se contó antes de recargar, no se vuelve a contar al reanudar; si no, la primera reproducción sí cuenta.
  countedKey = s.counted ? trackKey(track) : null;
  el.preload = 'metadata';
  // Posición diferida: hasta que la metadata del audio esté disponible.
  const target = s.position > 1 ? s.position : 0;
  if (usesAuthenticatedSource(track, hasSession())) {
    // Pista privada con sesión: sin solicitud anónima; la descarga autenticada deja el audio listo (en pausa) en la posición guardada.
    void loadAuthenticated(track, { autoplay: false, position: target });
  } else {
    el.src = track.audioUrl;
    const onMeta = () => {
      el.removeEventListener('loadedmetadata', onMeta);
      if (target > 0 && (!el.duration || Number.isFinite(el.duration)) && (!el.duration || target < el.duration)) {
        try {
          el.currentTime = target;
        } catch {
          /* noop */
        }
      }
    };
    el.addEventListener('loadedmetadata', onMeta);
  }
  return { track, queue: restoredQueue, position: s.position, duration: s.duration || track.durationSec || 0 };
}

/* ── MediaSession API (CLIENT-ONLY): controles del SO / pantalla de bloqueo ── */

function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

function mediaSession(): MediaSession | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
  return navigator.mediaSession;
}

function updateMediaMetadata(track: PlayerTrack | null) {
  const ms = mediaSession();
  if (!ms) return;
  if (!track) {
    ms.metadata = null;
    return;
  }
  const apply = (artworkSrc: string | null, artworkType?: string) => {
    // La pista cambió mientras cargábamos la portada: no pisamos la metadata nueva.
    if (usePlayerStore.getState().track !== track) return;
    try {
      ms.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: 'Melodya',
        /* `type` solo si se conoce el MIME real (blob autenticado); con URL directa se omite en vez de inventarlo. */
        artwork: artworkSrc
          ? [{ src: artworkSrc, sizes: '512x512', ...(artworkType ? { type: artworkType } : {}) }]
          : [],
      });
    } catch {
      /* MediaMetadata no disponible: seguimos sin metadata */
    }
  };
  const direct = track.coverUrl ? absoluteUrl(track.coverUrl) : null;
  if (!direct) {
    apply(null);
    return;
  }
  if (getAccessTokenSync()) {
    /* Con sesión iniciada: el artwork del SO/lock-screen no puede mandar el
       header Authorization y las portadas PRIVATE fallan (403, y antes de
       normalizar la URL relativa daba 404 contra el origen de la web).
       Publicamos la metadata enseguida y la completamos con un blob
       autenticado (el mismo cache que las portadas de la UI) en cuanto
       llega; si el fetch falla, quedamos con la URL directa como último
       recurso. */
    apply(null);
    void authImageObjectUrl(direct).then((obj) => (obj ? apply(obj, authImageMimeType(obj)) : apply(direct)));
  } else {
    /* Invitado: solo suenan canciones públicas de la comunidad y su portada
       es anónima-accesible; el navegador la puede traer sin header. */
    apply(direct);
  }
}

function updateMediaPlayback(playing: boolean, position: number, duration: number) {
  const ms = mediaSession();
  if (!ms) return;
  ms.playbackState = playing ? 'playing' : 'paused';
  try {
    if (duration > 0 && Number.isFinite(duration)) {
      ms.setPositionState({
        playbackRate: 1,
        position: Math.min(Math.max(0, position), duration),
        duration,
      });
    }
  } catch {
    /* setPositionState opcional: algunos navegadores lo omiten */
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  track: null,
  queue: [],
  isPlaying: false,
  position: 0,
  duration: 0,
  volume: typeof window === 'undefined' ? 0.9 : loadVolume(),
  muted: false,
  speed: typeof window === 'undefined' ? 1 : loadSpeed(),
  playbackError: null,
  recent: typeof window === 'undefined' ? [] : loadRecent(),
  shuffle: typeof window === 'undefined' ? false : loadShuffle(),
  sleepAt: null,
  sleepEndOfTrack: false,
  sessionRestored: false,
  radioMode: null,
  radioPage: 0,
  radioGenre: null,

  setAudio: (el) => {
    audioEl = el;
    if (el) {
      /* CORS-limpio desde el primer src: sin esto, si el API vive en otro
         origen el elemento carga "tainted" y el visualizador (Web Audio)
         silencia la salida al conectarse. Debe setearse ANTES de asignar src. */
      el.crossOrigin = 'anonymous';
      el.volume = get().volume;
      // defaultPlaybackRate sobrevive a los cambios de src (load()).
      el.defaultPlaybackRate = get().speed;
      el.playbackRate = get().speed;
      el.addEventListener('ended', () => {
        countedKey = null; // terminó: escucharla de nuevo cuenta otra reproducción
        // Timer de sueño "al terminar el tema": frenamos acá, sin avanzar la cola.
        if (get().sleepEndOfTrack) {
          set({ isPlaying: false, sleepEndOfTrack: false });
          updateMediaPlayback(false, 0, get().duration);
          return;
        }
        get().next();
      });
      registerMediaSessionHandlers();
      // Sesión persistida: vuelve PAUSADA en la posición guardada (nunca autoplay).
      const restored = restorePendingSession(el);
      if (restored) {
        set({ ...restored, isPlaying: false, sessionRestored: true });
        // Metadata del MediaSession DESPUÉS del set(): el guard de identidad de
        // updateMediaMetadata compara contra la pista ya cargada en el store.
        updateMediaMetadata(restored.track);
      } else if (get().track) {
        /* Remontaje del PlayerBar con una pista ya en curso (raro en
           producción, frecuente en dev con Fast Refresh): re-enganchamos
           el src al elemento nuevo para no dejar el tema "colgado". */
        const current = get().track!;
        const target = get().position;
        if (authSource.blobUrl) {
          // Pista privada ya descargada: se reutiliza el blob vigente (sin ninguna solicitud).
          el.src = authSource.blobUrl;
          seekWhenReady(el, target);
        } else if (authSource.isLoading(current.audioUrl)) {
          // La descarga autenticada sigue en curso: no se duplica; al llegar se asigna al <audio> vigente (este).
        } else if (usesAuthenticatedSource(current, hasSession())) {
          // Pista privada sin blob todavía: descarga autenticada, nunca un intento anónimo.
          void loadAuthenticated(current, { autoplay: false, position: target });
        } else {
          el.src = current.audioUrl;
          if (target > 0) {
            const onMeta = () => {
              el.removeEventListener('loadedmetadata', onMeta);
              try {
                el.currentTime = target;
              } catch {
                /* noop */
              }
            };
            el.addEventListener('loadedmetadata', onMeta);
          }
        }
        set({ isPlaying: false });
      }
    }
  },

  play: (track, queue, opts) => {
    if (!audioEl) return;
    const el = audioEl;
    ensureAudioRunning();
    // Embudo único: la pista y la cola entran SIEMPRE con URLs resueltas
    // contra el origin del API (normalizeTrack arriba).
    track = normalizeTrack(track);
    if (queue) queue = queue.map(normalizeTrack);
    const state = get();
    const sameTrack = state.track?.id === track.id && state.track?.audioUrl === track.audioUrl;
    const newQueue = queue && queue.length ? queue : [track];
    // Una reproducción externa (nueva cola) apaga la radio; la propia radio
    // y los saltos next/prev la conservan con opts.keepRadio.
    const keepRadio = !!opts?.keepRadio;
    if (sameTrack) {
      // Mismo tema pero con cola nueva (p. ej. "Reproducir todo" cuando ya suena
      // la primera): adoptamos la cola nueva sin reiniciar el tema.
      const queueChanged = queue && queue.length > 1 && (queue.length !== state.queue.length || queue.some((t, i) => t.id !== state.queue[i]?.id || t.audioUrl !== state.queue[i]?.audioUrl));
      if (queueChanged) {
        set({ queue: newQueue, radioMode: keepRadio ? state.radioMode : null, radioGenre: keepRadio ? state.radioGenre : null });
        saveSession({ track: state.track!, queue: newQueue, position: state.position, duration: state.duration });
      }
      if (state.isPlaying) {
        el.pause();
        set({ isPlaying: false });
        updateMediaPlayback(false, el.currentTime, el.duration || track.durationSec || 0);
      } else if (needsAuthenticatedReload(state.track ?? track, el)) {
        /* Pista privada SIN fuente válida: no se llama a el.play() (no hay qué reproducir) sino al flujo autenticado, que respeta la pausa de archivos. */
        reloadAuthenticated(state.track ?? track);
      } else {
        void el.play().then(() => {
          set({ isPlaying: true });
          updateMediaPlayback(true, el.currentTime, el.duration || track.durationSec || 0);
        });
        countPlayOnce(state.track ?? track);
      }
      return;
    }
    cleanupBlob();
    retriedTrack = null;
    const recent = pushRecent(state.recent, track);
    saveRecent(recent);
    set({ track, queue: newQueue, position: 0, duration: track.durationSec ?? 0, recent, playbackError: null, radioMode: keepRadio ? state.radioMode : null, radioGenre: keepRadio ? state.radioGenre : null });
    updateMediaMetadata(track);
    if (usesAuthenticatedSource(track, hasSession())) {
      // Pista privada con sesión: un <audio src> no envía Authorization y el backend respondería 403. Se descarta el audio
      // anterior y se descarga con Authorization desde el principio (el mismo mecanismo que usa retryWithAuth).
      clearAudioSource(el);
      retriedTrack = track.audioUrl; // si el blob falla al decodificar no se reintenta en bucle
      set({ isPlaying: false });
      void loadAuthenticated(track, { autoplay: true });
    } else {
      el.src = track.audioUrl;
      el.playbackRate = get().speed; // load() resetea a defaultPlaybackRate; lo reforzamos
      void el.play().then(() => {
        set({ isPlaying: true });
        updateMediaPlayback(true, 0, track.durationSec ?? 0);
      }).catch(() => set({ isPlaying: false }));
    }
    countedKey = null; // canción nueva: su reproducción todavía no se contó
    countPlayOnce(track);
    saveSession({ track, queue: newQueue, position: 0, duration: track.durationSec ?? 0 });
  },

  toggle: () => {
    if (!audioEl || !get().track) return;
    ensureAudioRunning();
    const el = audioEl;
    if (el.paused) {
      const current = get().track;
      /* Pista privada sin fuente válida (descarga fallida por un 429, p. ej.): se reintenta por el flujo autenticado en vez de un el.play() vacío. */
      if (current && needsAuthenticatedReload(current, el)) {
        reloadAuthenticated(current);
        return;
      }
      void el.play().then(() => {
        set({ isPlaying: true });
        updateMediaPlayback(true, el.currentTime, el.duration || 0);
      });
      if (current) countPlayOnce(current); // sesión restaurada: la primera reproducción sí cuenta
    } else {
      el.pause();
      set({ isPlaying: false });
      updateMediaPlayback(false, el.currentTime, el.duration || 0);
    }
  },

  seek: (seconds) => {
    if (!audioEl) return;
    audioEl.currentTime = seconds;
    set({ position: seconds });
  },

  setVolume: (v) => {
    if (audioEl) audioEl.volume = v;
    saveVolume(v);
    set({ volume: v, muted: v === 0 });
  },

  setSpeed: (v) => {
    if (!SPEEDS.includes(v)) return;
    if (audioEl) {
      audioEl.defaultPlaybackRate = v;
      audioEl.playbackRate = v;
    }
    saveSpeed(v);
    set({ speed: v });
  },

  toggleMute: () => {
    if (!audioEl) return;
    const muted = !get().muted;
    audioEl.muted = muted;
    set({ muted });
  },

  /* ── Orden aleatorio persistido ──
     Con la cola suficientemente larga evita repetir el tema actual; no
     reordena la cola (la lista visible queda como referencia del orden). */
  toggleShuffle: () => {
    const shuffle = !get().shuffle;
    saveShuffle(shuffle);
    set({ shuffle });
  },

  syncTime: (position, duration) => {
    set({ position, duration });
    // Timer de sueño: pausa cuando se cumple el plazo (se evalúa en cada timeupdate).
    const { sleepAt, isPlaying } = get();
    if (isPlaying && sleepAt !== null && Date.now() >= sleepAt) {
      if (audioEl) audioEl.pause();
      set({ isPlaying: false, sleepAt: null });
      updateMediaPlayback(false, position, duration);
      return;
    }
    // Barato y mantiene la posición del OS al día (throttle interno del navegador).
    if (get().isPlaying) updateMediaPlayback(true, position, duration);
    // Persistencia de la sesión (throttle de ~1s para no escribir en cada timeupdate).
    const now = Date.now();
    if (now - lastSessionSaveAt > 1000) {
      lastSessionSaveAt = now;
      const { track, queue } = get();
      saveSession({ track, queue, position, duration });
    }
  },

  next: () => {
    const { queue, track, shuffle } = get();
    if (!queue.length || !track) return;
    const idx = queue.findIndex((t) => t.id === track.id && t.audioUrl === track.audioUrl);
    let targetIdx: number;
    if (shuffle && queue.length > 1) {
      // Aleatorio entre las DEMÁS pistas (nunca repite la que recién sonó).
      do {
        targetIdx = Math.floor(Math.random() * queue.length);
      } while (targetIdx === idx);
    } else {
      targetIdx = (idx + 1) % queue.length;
    }
    const nextTrack = queue[targetIdx];
    if (nextTrack) get().play(nextTrack, queue, { keepRadio: true });
  },

  prev: () => {
    const { queue, track } = get();
    if (!queue.length || !track) return;
    const idx = queue.findIndex((t) => t.id === track.id && t.audioUrl === track.audioUrl);
    const prevTrack = queue[(idx - 1 + queue.length) % queue.length];
    if (prevTrack) get().play(prevTrack, queue, { keepRadio: true });
  },

  stop: () => {
    if (audioEl) clearAudioSource(audioEl);
    cleanupBlob();
    updateMediaMetadata(null);
    updateMediaPlayback(false, 0, 0);
    clearSession();
    countedKey = null;
    set({ track: null, isPlaying: false, playbackError: null, position: 0, duration: 0, radioMode: null, radioPage: 0, radioGenre: null });
  },

  /** Fallback: el stream directo falló (privado sin header) → blob autenticado.
   *  Funciona con URLs relativas (mismo origen) Y absolutas (API en otro
   *  origen, p. ej. VITE_API_BASE_URL=http://localhost:4000/api). */
  retryWithAuth: async () => {
    const { track } = get();
    if (!audioEl || !track || !track.audioUrl) return;
    // Solo reintentamos streams del API (http/https o ruta relativa), nunca blobs/data.
    if (/^(blob:|data:)/.test(track.audioUrl)) return;
    if (retriedTrack === track.audioUrl) return; // solo un intento por pista
    retriedTrack = track.audioUrl;
    /* Un <audio> no dice POR QUÉ falló la carga directa. Antes de bajar el archivo ENTERO como blob se averigua con un sondeo de 1 byte: un 429
       (o un 401/403/404, o la red caída) NO justifica la descarga completa; solo un archivo realmente accesible sigue al fallback autenticado
       (necesario para pistas privadas). Los fallos transitorios permiten que el usuario vuelva a intentarlo con play. */
    const fail = (error: AudioSourceError) => {
      if (error.status === 429) noteRateLimit(error.retryAfterMs, 'files');
      set({ isPlaying: false, playbackError: audioErrorMessage(error) });
      if (isTransientAudioError(error)) retriedTrack = null;
    };
    if (rateLimitRemainingMs('files') > 0) return fail(new AudioSourceError(429, 'pausa vigente'));
    const probe = await probeAudioAccess(track.audioUrl, getAccessTokenSync(), new AbortController().signal);
    if (get().track?.audioUrl !== track.audioUrl) return; // cambió la pista mientras se sondeaba
    if (!probe.ok) return fail(probe.error);
    await loadAuthenticated(track, { autoplay: true });
  },

  clearRecent: () => {
    saveRecent([]);
    set({ recent: [] });
  },

  /* ── Bloqueo de usuario (v0.26): purga de la música del autor ──
     Se llama al confirmar un bloqueo desde el perfil. Nunca toca pistas
     propias (no llevan community.authorId) ni prefs del dispositivo. */
  purgeAuthor: (authorId) => {
    const state = get();
    const isBy = (t: PlayerTrack | null) => t?.community?.authorId === authorId;
    const queue = state.queue.filter((t) => !isBy(t));
    const recent = state.recent.filter((t) => !isBy(t));
    const removed = state.queue.length - queue.length;
    const currentRemoved = isBy(state.track);
    if (!removed && !currentRemoved) return 0;
    saveRecent(recent);
    set({ recent });
    if (currentRemoved) {
      const next = queue[0];
      if (next) {
        get().play(next, queue, { keepRadio: state.radioMode !== null });
      } else {
        get().stop();
      }
      return removed + 1;
    }
    set({ queue });
    saveSession({ track: state.track, queue, position: state.position, duration: state.duration });
    return removed;
  },

  hardReset: () => {
    if (audioEl) clearAudioSource(audioEl);
    cleanupBlob();
    retriedTrack = null;
    lastClearedQueue = null;
    pendingSession = null;
    countedKey = null;
    updateMediaMetadata(null);
    updateMediaPlayback(false, 0, 0);
    clearSession();
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      /* storage no disponible: no rompe nada */
    }
    set({
      track: null,
      queue: [],
      isPlaying: false,
      playbackError: null,
      position: 0,
      duration: 0,
      recent: [],
      shuffle: false,
      sleepAt: null,
      sleepEndOfTrack: false,
      sessionRestored: false,
      radioMode: null,
      radioPage: 0,
      radioGenre: null,
    });
  },

  setSleepTimer: (minutes) => {
    set({ sleepAt: minutes && minutes > 0 ? Date.now() + minutes * 60_000 : null, sleepEndOfTrack: false });
  },

  setSleepEndOfTrack: (v) => {
    set({ sleepEndOfTrack: v, sleepAt: v ? null : get().sleepAt });
  },

  clearSleep: () => {
    set({ sleepAt: null, sleepEndOfTrack: false });
  },

  acknowledgeRestore: () => set({ sessionRestored: false }),

  /* ── Radio de la comunidad: cola infinita sobre paginación real ── */
  startRadio: (mode, tracksIn, opts) => {
    const tracks = tracksIn.map(normalizeTrack);
    if (!tracks.length) return;
    const state = get();
    const first = tracks[0];
    set({ radioMode: mode, radioPage: 1, radioGenre: opts?.genre ?? null });
    // Si la radio arranca justo con el tema que ya está cargado, adoptamos la
    // cola nueva sin reiniciar el tema (play() con sameTrack solo alterna).
    const sameTrack = state.track?.id === first.id && state.track?.audioUrl === first.audioUrl;
    if (sameTrack) {
      set({ queue: tracks });
      saveSession({ track: state.track, queue: tracks, position: state.position, duration: state.duration });
      if (!state.isPlaying) get().toggle();
      return;
    }
    get().play(first, tracks, { keepRadio: true });
  },

  appendRadioPage: (tracksIn) => {
    const tracks = tracksIn.map(normalizeTrack);
    if (!tracks.length) return 0;
    const { queue, radioMode, radioPage } = get();
    if (!radioMode) return 0;
    const seen = new Set(queue.map((t) => `${t.id}|${t.audioUrl}`));
    const fresh = tracks.filter((t) => !seen.has(`${t.id}|${t.audioUrl}`));
    // La página se consume siempre (aunque traiga repetidos) para no pedir la
    // misma página infinitamente.
    set({ queue: [...queue, ...fresh], radioPage: radioPage + 1 });
    // La sesión persistida también conoce la cola extendida.
    const { track, position, duration } = get();
    saveSession({ track, queue: [...queue, ...fresh], position, duration });
    return fresh.length;
  },

  /* ── Cola manual: "reproducir a continuación" ──
     Inserta la pista justo después de la que suena (o la reproduce si no hay
     nada sonando). Devuelve false si la pista ya sonaba (nada que hacer). */
  playNext: (trackIn) => {
    const track = normalizeTrack(trackIn);
    const state = get();
    if (!state.track || !state.queue.length) {
      get().play(track, [track]);
      return true;
    }
    const isCurrent = state.track.id === track.id && state.track.audioUrl === track.audioUrl;
    if (isCurrent) return false;
    const idx = state.queue.findIndex((t) => t.id === state.track!.id && t.audioUrl === state.track!.audioUrl);
    const at = idx >= 0 ? idx : 0;
    // Si ya estaba en la cola (en cualquier posición) la movemos acá: sin duplicados.
    const trackKey = `${track.id}|${track.audioUrl}`;
    const withoutDupe = state.queue.filter((t, i) => i === at || `${t.id}|${t.audioUrl}` !== trackKey);
    const insertAt = Math.min(at + 1, withoutDupe.length);
    const queue = [...withoutDupe.slice(0, insertAt), track, ...withoutDupe.slice(insertAt)];
    set({ queue });
    saveSession({ track: state.track, queue, position: state.position, duration: state.duration });
    return true;
  },

  /* ── Cola manual: "agregar a la cola" (al final).
     Devuelve false si ya estaba (para avisar "ya está en la cola"). */
  addToQueue: (trackIn) => {
    const track = normalizeTrack(trackIn);
    const state = get();
    if (!state.track || !state.queue.length) {
      get().play(track, [track]);
      return true;
    }
    const isCurrent = state.track.id === track.id && state.track.audioUrl === track.audioUrl;
    if (isCurrent) return false;
    const dupe = state.queue.some((t) => t.id === track.id && t.audioUrl === track.audioUrl);
    if (dupe) return false;
    const queue = [...state.queue, track];
    set({ queue });
    saveSession({ track: state.track, queue, position: state.position, duration: state.duration });
    return true;
  },

  /* ── Cola manual: quitar una pista de la cola (nunca la que suena). ── */
  removeFromQueue: (track) => {
    const state = get();
    const isCurrent = state.track?.id === track.id && state.track?.audioUrl === track.audioUrl;
    if (isCurrent) return false;
    const queue = state.queue.filter((t) => !(t.id === track.id && t.audioUrl === track.audioUrl));
    if (queue.length === state.queue.length) return false;
    set({ queue });
    saveSession({ track: state.track, queue, position: state.position, duration: state.duration });
    return true;
  },

  /* ── Cola manual: reordenar (drag & drop o botones arriba/abajo).
     `from`/`to` son índices de la cola actual; el tema en curso no se deja
     mover (la fila no es arrastrable) para no "perder" lo que suena.
     Devuelve true si la cola cambió. ── */
  moveInQueue: (from, to) => {
    const state = get();
    const { queue, track } = state;
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return false;
    if (track && from === queue.findIndex((t) => t.id === track.id && t.audioUrl === track.audioUrl)) return false;
    const moving = queue[from];
    const rest = queue.filter((_, i) => i !== from);
    const next = [...rest.slice(0, to), moving, ...rest.slice(to)];
    set({ queue: next });
    saveSession({ track, queue: next, position: state.position, duration: state.duration });
    return true;
  },

  /* ── Vaciar la cola conservando el tema en curso (con deshacer). ──
     Lo quitado queda en memoria (módulo) para un único undo. */
  clearQueue: () => {
    const state = get();
    const { queue, track } = state;
    if (!track) return 0;
    const currentKey = `${track.id}|${track.audioUrl}`;
    const removed = queue.filter((t) => `${t.id}|${t.audioUrl}` !== currentKey);
    if (!removed.length) return 0;
    lastClearedQueue = removed;
    const next = queue.filter((t) => `${t.id}|${t.audioUrl}` === currentKey);
    set({ queue: next });
    saveSession({ track, queue: next, position: state.position, duration: state.duration });
    return removed.length;
  },

  undoClearQueue: () => {
    const state = get();
    const removed = lastClearedQueue;
    lastClearedQueue = null;
    if (!removed || !state.track) return false;
    /* Sin duplicados con lo que quedó en la cola. */
    const seen = new Set(state.queue.map((t) => `${t.id}|${t.audioUrl}`));
    const restored = removed.filter((t) => !seen.has(`${t.id}|${t.audioUrl}`));
    const next = [...state.queue, ...restored];
    set({ queue: next });
    saveSession({ track: state.track, queue: next, position: state.position, duration: state.duration });
    return restored.length > 0;
  },

  /* ── Reacción (me gusta) del tema en curso: actualiza pista + entradas de
     cola con el mismo id (y la sesión persistida) desde un único lugar,
     compartido por el botón del reproductor y el atajo "L". ── */
  setTrackReaction: (liked, count) => {
    const state = get();
    const track = state.track;
    if (!track?.community) return;
    const reaction = liked ? ('LIKE' as const) : null;
    const patch = (t: PlayerTrack): PlayerTrack =>
      t.community && t.id === track.id
        ? { ...t, community: { ...t.community, viewerReaction: reaction, likesCount: count } }
        : t;
    set({
      track: patch(track),
      queue: state.queue.map(patch),
    });
    const { track: t2, queue, position, duration } = get();
    saveSession({ track: t2, queue, position, duration });
  },

  /* ── Renombraron una canción: pisa el título viejo en pista en curso, cola
     y recientes (la sesión persistida también, para que al recargar no
     vuelva el nombre anterior). El MediaSession se refresca si es el tema
     que está sonando. ── */
  renameTrack: (id, title) => {
    const state = get();
    const touched =
      state.track?.id === id || state.queue.some((t) => t.id === id) || state.recent.some((t) => t.id === id);
    if (!touched) return;
    const patch = (t: PlayerTrack): PlayerTrack => (t.id === id ? { ...t, title } : t);
    set({
      track: state.track ? patch(state.track) : null,
      queue: state.queue.map(patch),
      recent: state.recent.map(patch),
    });
    const { track, queue, position, duration } = get();
    saveSession({ track, queue, position, duration });
    if (track?.id === id) updateMediaMetadata(track);
  },

  /* ── Canción propia enviada a la Papelera / restaurada: ver la declaración. Al restaurar solo se quita la marca: la pista
     queda con `isPublic: false` (se sigue oyendo con descarga autenticada y las propias no cuentan), sin tocar nada más. ── */
  setTrackTrashed: (id, trashed) => {
    const state = get();
    const touched =
      state.track?.id === id || state.queue.some((t) => t.id === id) || state.recent.some((t) => t.id === id);
    if (!touched) return;
    const patch = (t: PlayerTrack): PlayerTrack => {
      if (t.id !== id) return t;
      if (!trashed) {
        const { trashed: _trashed, ...rest } = t;
        return rest;
      }
      return { ...t, trashed: true, isPublic: false };
    };
    set({
      track: state.track ? patch(state.track) : null,
      queue: state.queue.map(patch),
      recent: state.recent.map(patch),
    });
    const { track, queue, position, duration } = get();
    saveSession({ track, queue, position, duration });
  },
}));

/* ── Registro único de handlers de MediaSession (teclas/auriculares/lock screen) ── */
let sessionHandlersRegistered = false;

function registerMediaSessionHandlers() {
  const ms = mediaSession();
  if (!ms || sessionHandlersRegistered) return;
  sessionHandlersRegistered = true;
  const s = () => usePlayerStore.getState();
  try {
    ms.setActionHandler('play', () => s().toggle());
    ms.setActionHandler('pause', () => s().toggle());
    ms.setActionHandler('previoustrack', () => s().prev());
    ms.setActionHandler('nexttrack', () => s().next());
    ms.setActionHandler('seekbackward', (details) => s().seek(Math.max(0, s().position - (details.seekOffset || 10))));
    ms.setActionHandler('seekforward', (details) => s().seek(s().position + (details.seekOffset || 10)));
    ms.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') s().seek(details.seekTime);
    });
  } catch {
    /* Algunos navegadores no soportan todos los handlers: omitimos */
  }
}
