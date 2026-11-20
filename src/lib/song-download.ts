/**
 * MELODYA WEB — Descarga explícita de audio (E6): POST /songs/:id/versions/:versionId/download.
 *
 * Es el ÚNICO camino de «Descargar». La reproducción sigue usando `GET /files/:id/stream` y no pasa por acá: no consume cupo.
 * Formatos: MP3 (por omisión) y WAV. El WAV se convierte bajo demanda (la primera vez que el usuario Pro lo pide) y queda guardado; si todavía no está
 * listo responde 422 WAV_NOT_READY y la interfaz muestra el estado de procesamiento (ver lib/capabilities → wavMenuState).
 *
 * Idempotencia: cada intento lleva una `clientRequestId`. Si el intento falla (corte de red, error del servidor) el próximo clic sobre
 * la misma versión REUSA la clave, así el servidor no vuelve a consumir una unidad por una descarga que ya registró; al terminar bien
 * se descarta la clave.
 */
import { API_BASE, ApiError } from '@/lib/api/client';
import { songsApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { downloadFilename } from '@/lib/audio-download';

const pendingKeys = new Map<string, string>();

const newKey = () => `dl-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

/** Arma el ApiError del servidor a partir de la respuesta JSON de error (conserva `details` para LIMIT_EXCEEDED y CAPABILITY_NOT_IN_PLAN). */
export function downloadApiError(status: number, json: unknown): ApiError {
  const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  return new ApiError(status, e?.code ?? 'ERROR', e?.message ?? 'No pudimos descargar la canción', e?.details);
}

export type DownloadFormat = 'mp3' | 'wav';

export interface DownloadSongInput {
  songId: string;
  /** Formato a bajar (por omisión MP3). */
  format?: DownloadFormat;
  /** Si falta se usa la versión activa de la canción. */
  versionId?: string | null;
  title?: string | null;
}

/** Descarga el audio (MP3 o WAV) de una versión propia. Lanza ApiError con el detalle del servidor si se rechaza. */
export async function downloadSongAudio({ songId, versionId, title, format = 'mp3' }: DownloadSongInput): Promise<{ filename: string; replayed: boolean }> {
  let version = versionId ?? null;
  if (!version) {
    const song = await songsApi.get(songId);
    version = song.currentVersionId ?? song.currentVersion?.id ?? null;
  }
  if (!version) throw new ApiError(404, 'NOT_FOUND', 'Esta canción todavía no tiene audio para descargar');

  const slot = `${songId}|${version}|${format}`;
  const clientRequestId = pendingKeys.get(slot) ?? newKey();
  pendingKeys.set(slot, clientRequestId);

  const token = useAuthStore.getState().accessToken;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/songs/${encodeURIComponent(songId)}/versions/${encodeURIComponent(version)}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ format, clientRequestId }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'No pudimos conectar con Melodya. Revisá tu conexión.'); // la clave queda guardada: el reintento no consume otra unidad
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    // Un rechazo del servidor (capacidad, cupo, formato) no registró nada: la próxima solicitud es nueva.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) pendingKeys.delete(slot);
    throw downloadApiError(res.status, json);
  }
  const blob = await res.blob();
  pendingKeys.delete(slot);

  const filename = downloadFilename(title, res.headers.get('Content-Type'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename, replayed: res.headers.get('X-Download-Replayed') === 'true' };
}
