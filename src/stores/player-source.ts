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

/** El backend rechazó (o no pudimos hacer) la descarga autenticada del audio. */
export class AudioSourceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AudioSourceError';
    this.status = status;
  }
}

/** Mensaje para el usuario según el motivo (sin convertir los errores de autenticación en un fallo genérico). */
export function audioErrorMessage(err: unknown): string {
  const status = err instanceof AudioSourceError ? err.status : 0;
  if (status === 401) return 'Tu sesión expiró. Iniciá sesión de nuevo para escuchar esta canción.';
  if (status === 403) return 'No tenés permiso para escuchar este audio.';
  if (status === 404) return 'No encontramos el audio de esta canción.';
  return 'No pudimos cargar el audio. Probá de nuevo en un momento.';
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

/** fetch con Authorization; rechaza con AudioSourceError(status) si el servidor no responde 2xx. */
export async function fetchAudioBlob(
  url: string,
  token: string | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok) throw new AudioSourceError(res.status, `stream ${res.status}`);
  return res.blob();
}
