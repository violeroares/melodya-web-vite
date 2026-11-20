/**
 * MELODYA WEB — Canción propia en la Papelera, dentro del mismo detalle (#/songs/:id).
 *
 * Lógica pura (sin React) para que SongDetailView no repita reglas y se pueda probar:
 *  • el backend entrega la canción en la Papelera SOLO a su dueño (GET /songs/:id → `deletedAt` con fecha); a cualquier otro le
 *    responde 404, y Comunidad nunca la muestra;
 *  • en la Papelera se puede escuchar y leer la letra; todo lo que modifica, comparte, descarga o publica queda cerrado
 *    (el backend también lo rechaza: la interfaz solo evita ofrecer lo que fallaría);
 *  • restaurar refresca detalle, Biblioteca, Papelera y Comunidad.
 */
import { keysToInvalidate } from '../library/trash-utils';

interface SongLike {
  deletedAt?: string | null;
  visibility?: 'PUBLIC' | 'PRIVATE' | string;
}

/** ¿La canción está en la Papelera? (`deletedAt` con fecha; null/ausente = activa). */
export function isSongTrashed(song: SongLike | null | undefined): boolean {
  return Boolean(song?.deletedAt);
}

/** Lo que el detalle ofrece según el estado de la canción y quién la mira. */
export interface SongDetailAccess {
  trashed: boolean;
  /** Banner «Esta canción está en la Papelera» + acción Restaurar (solo el dueño la ve en la Papelera). */
  showTrashBanner: boolean;
  /** Editar, portada, visibilidad, proyecto, otra versión, versión activa y enviar a la Papelera. */
  canModify: boolean;
  /** Descargas MP3/WAV (menú y filas de versiones). */
  canDownload: boolean;
  /** Compartir (el enlace no serviría a nadie más: Comunidad no la muestra). */
  canShare: boolean;
  /** Remix, reacciones, comentarios, «más del autor/género» y cola: todo lo que vive en Comunidad. */
  showCommunity: boolean;
  /** Hay que pedir el detalle público (GET /community/songs/:id): nunca para una canción en la Papelera. */
  fetchCommunity: boolean;
}

export function songDetailAccess(song: SongLike | null | undefined, isOwner: boolean): SongDetailAccess {
  const trashed = isSongTrashed(song);
  const publicAndActive = song?.visibility === 'PUBLIC' && !trashed;
  return {
    trashed,
    showTrashBanner: trashed && isOwner,
    canModify: isOwner && !trashed,
    canDownload: isOwner && !trashed,
    canShare: !trashed,
    showCommunity: publicAndActive,
    fetchCommunity: publicAndActive,
  };
}

/**
 * Detalle propio fallido: ¿se intenta el detalle público? Solo cuando la canción «no es tuya / no existe para vos» (404/403).
 * Un corte de red, un 5xx o un 401 se muestran como error en vez de caer a Comunidad y terminar en un 404 engañoso.
 */
export function shouldFallbackToCommunity(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

/** Claves de react-query a refrescar al restaurar desde el detalle: la canción, sus versiones, Biblioteca, Papelera y Comunidad. */
export function restoreInvalidationKeys(songId: string): ReadonlyArray<readonly string[]> {
  return [['song', songId], ['generations'], ...keysToInvalidate('songs')];
}
