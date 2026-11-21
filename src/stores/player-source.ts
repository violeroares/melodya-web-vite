/**
 * MELODYA WEB — Origen del audio del reproductor: URL directa o descarga autenticada.
 *
 * Un <audio src="…"> NO puede enviar el header Authorization. Para una pista PRIVADA el backend rechaza (403) toda solicitud
 * anónima, así que asignar la URL directa provocaba un 403 en consola y recién después el reproductor se recuperaba
 * descargando el archivo con Authorization (blob). Este módulo concentra la decisión y el ciclo de vida de esa descarga para
 * que TODOS los caminos del reproductor (play, restauración de sesión, remontaje, reintento) usen el mismo mecanismo:
 *
 *  • usesAuthenticatedSource: pista con `isPublic === false` y sesión → descarga autenticada desde el principio.
 *    `isPublic === true` o desconocido (`undefined`) → URL directa, como siempre.
 *  • createAuthSource: descarga con AbortController, protege contra respuestas viejas (cambio de pista) y administra la
 *    URL blob vigente (se revoca al soltarla). Una respuesta obsoleta NUNCA crea una URL blob ni reemplaza el audio nuevo.
 *
 * Módulo puro (sin React, zustand ni alias): se prueba con dobles de fetch/URL.
 */

export interface SourceTrack {
  audioUrl: string;
  isPublic?: boolean;
}

/** ¿Hay que descargar el audio con Authorization en vez de asignar la URL al <audio>? */
export function usesAuthenticatedSource(track: SourceTrack | null | undefined, hasSession: boolean): boolean {
  if (!track?.audioUrl || /^(blob:|data:)/.test(track.audioUrl)) return false;
  return track.isPublic === false && hasSession;
}

/**
 * El backend rechazó (o no pudimos hacer) la descarga/consulta del audio. status 0 = sin respuesta (red / timeout).
 * `retryAfterMs` solo viene en un 429 con Retry-After legible.
 */
export class AudioSourceError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'AudioSourceError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Mensaje para el usuario según el motivo (autorización, rate limit, red/servidor: NO se confunden entre sí). */
export function audioErrorMessage(err: unknown): string {
  const status = err instanceof AudioSourceError ? err.status : 0;
  if (status === 401) return 'Tu sesión expiró. Iniciá sesión de nuevo para escuchar esta canción.';
  if (status === 403) return 'No tenés permiso para escuchar este audio.';
  if (status === 404) return 'No encontramos el audio de esta canción.';
  if (status === 429) return 'Hay muchas solicitudes de audio en este momento. Esperá unos segundos y volvé a darle play.';
  if (status === 0 && err instanceof AudioSourceError) return 'No pudimos conectar para cargar el audio. Revisá tu conexión y volvé a intentar.';
  return 'No pudimos cargar el audio. Probá de nuevo en un momento.';
}

/** ¿Un fallo del audio es transitorio (conviene permitir otro intento del usuario) y no un problema de permisos? */
export function isTransientAudioError(err: unknown): boolean {
  const status = err instanceof AudioSourceError ? err.status : 0;
  return status === 0 || status === 429 || status >= 500;
}

/** `Retry-After` (segundos) → ms; solo el formato numérico (módulo puro: sin dependencias). */
function retryAfterMsOf(res: { headers?: { get?: (k: string) => string | null } }): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  if (!raw || !/^\d+(\.\d+)?$/.test(raw.trim())) return undefined;
  return Math.min(Number(raw) * 1000, 15 * 60_000);
}

export interface AuthSourceDeps {
  /** Descarga el archivo con las credenciales vigentes. Debe rechazar con AudioSourceError si el servidor responde error. */
  fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

export type AuthSourceResult = { status: 'ready'; url: string } | { status: 'stale' };

export function createAuthSource(deps: AuthSourceDeps) {
  let current: string | null = null;
  let controller: AbortController | null = null;
  let loadingUrl: string | null = null;
  let generation = 0;

  const release = () => {
    if (current) {
      deps.revokeObjectURL(current);
      current = null;
    }
  };

  /** Invalida cualquier descarga en curso: se aborta y su respuesta, si llega, se descarta. */
  const cancel = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    loadingUrl = null;
  };

  return {
    /** URL blob vigente (ya cargada), si existe. */
    get blobUrl(): string | null {
      return current;
    },
    /** ¿Hay una descarga en curso de ESTA URL? (el remontaje no debe duplicarla). */
    isLoading(audioUrl: string): boolean {
      return loadingUrl === audioUrl;
    },
    cancel,
    release,
    /** Cancela, revoca la URL anterior y descarta todo lo pendiente. */
    reset() {
      cancel();
      release();
    },
    /**
     * Descarga `audioUrl`. Cancela la descarga anterior. Devuelve `stale` si, mientras tanto, se pidió otra pista o se
     * canceló (no se crea ninguna URL blob). Un error real de la descarga se propaga (AudioSourceError).
     */
    async load(audioUrl: string): Promise<AuthSourceResult> {
      cancel();
      const mine = generation;
      const mineController = new AbortController();
      controller = mineController;
      loadingUrl = audioUrl;
      let blob: Blob;
      try {
        blob = await deps.fetchBlob(audioUrl, mineController.signal);
      } catch (err) {
        if (mine !== generation) return { status: 'stale' };
        // La descarga terminó (con error): ya no está «en curso». Si quedara marcada, un reintento de la misma pista creería que sigue
        // cargando y nunca volvería a pedirla.
        controller = null;
        loadingUrl = null;
        throw err;
      }
      if (mine !== generation) return { status: 'stale' };
      controller = null;
      loadingUrl = null;
      release();
      current = deps.createObjectURL(blob);
      return { status: 'ready', url: current };
    },
  };
}

/** fetch con Authorization; rechaza con AudioSourceError(status) si el servidor no responde 2xx (status 0 = red). Un AbortError se propaga tal cual. */
export async function fetchAudioBlob(
  url: string,
  token: string | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new AudioSourceError(0, 'stream sin conexión');
  }
  if (!res.ok) throw new AudioSourceError(res.status, `stream ${res.status}`, res.status === 429 ? retryAfterMsOf(res) : undefined);
  return res.blob();
}

/**
 * Sondeo BARATO de acceso al audio (1 byte con Range + Authorization) para decidir qué hacer cuando la carga directa del <audio> falló y no se
 * puede leer el motivo (un <audio> no expone el estado HTTP). Distingue 429 / 401 / 403 / 404 / 5xx / red de un archivo realmente accesible,
 * SIN descargar el audio completo. Solo un 200/206 devuelve `{ ok: true }`; el cuerpo nunca se lee (se cancela).
 */
export async function probeAudioAccess(
  url: string,
  token: string | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; error: AudioSourceError }> {
  const headers: Record<string, string> = { Range: 'bytes=0-0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return { ok: false, error: new AudioSourceError(0, 'sondeo sin conexión') };
  }
  try {
    await res.body?.cancel?.();
  } catch {
    /* ya cerrado */
  }
  if (res.ok) return { ok: true };
  return { ok: false, error: new AudioSourceError(res.status, `sondeo ${res.status}`, res.status === 429 ? retryAfterMsOf(res) : undefined) };
}
