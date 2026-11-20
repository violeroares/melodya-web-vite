/**
 * Vista de la atribución de un remix («Hecho a partir de»). Lógica pura (probada con `node --test`).
 *
 * La atribución COMPLETA vive en `SongOrigin` (modalidad, número de versión, autor, canción) y no se toca; esta vista elige solo lo que se muestra:
 * la canción original y su autor. No se muestra la versión ni la modalidad (Cover / configuración reutilizada).
 * Si el original ya no es accesible para quien mira (Papelera, privado, bloqueo, borrado) el servidor solo envía `{ kind, available: false }`:
 * la vista no lleva título, autor, portada ni enlaces.
 */
import type { SongOrigin } from '@/types';

export type AttributionView =
  | { available: true; songId: string; title: string; authorId: string | null; authorName: string | null; coverUrl: string | null }
  | { available: false };

export function remixAttributionView(origin: SongOrigin | null | undefined): AttributionView | null {
  if (!origin) return null;
  if (!origin.available || !origin.song) return { available: false };
  return {
    available: true,
    songId: origin.song.id,
    title: origin.song.title,
    coverUrl: origin.song.coverUrl ?? null,
    authorId: origin.author?.id ?? null,
    authorName: origin.author?.name ?? null,
  };
}

/** Rutas de navegación (hash-router de la aplicación). */
export const originSongPath = (songId: string): string => `/songs/${encodeURIComponent(songId)}`;
export const originAuthorPath = (authorId: string): string => `/user/${encodeURIComponent(authorId)}`;
