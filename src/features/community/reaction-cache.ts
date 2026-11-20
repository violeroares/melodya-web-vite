/**
 * Reacciones (Me gusta / No me gusta) de Comunidad: actualización optimista de las cachés de React Query.
 * Lógica pura (sin React ni componentes): se prueba con un `QueryClient` real (tests/community-reaction-cache.test.mjs).
 *
 * Contrato real: POST /songs/:id/react { type } es un TOGGLE atómico del backend (repetir el mismo tipo quita la reacción).
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { CommunitySong, CommunitySongDetail, Paginated } from '@/types';

export type ReactionType = 'LIKE' | 'DISLIKE';

/** Toggle de reacción con conteo optimista (POST /songs/:id/react repite = quita). */
export function applyReaction(song: CommunitySong, type: ReactionType): CommunitySong {
  const prev = song.viewerReaction ?? null;
  const next = prev === type ? null : type;
  const likesCount = Math.max(0, song.likesCount + (next === 'LIKE' ? 1 : 0) - (prev === 'LIKE' ? 1 : 0));
  const dislikesCount = Math.max(0, song.dislikesCount + (next === 'DISLIKE' ? 1 : 0) - (prev === 'DISLIKE' ? 1 : 0));
  return { ...song, viewerReaction: next, likesCount, dislikesCount };
}

type CommunityFeedData = InfiniteData<Paginated<CommunitySong>>;

/**
 * Actualiza una canción en todas las cachés de comunidad (feed paginado + detalle).
 *
 * Bajo ['community','feed',…] conviven consultas de FORMA distinta: feeds infinitos ({ pages: [{ items }] }) y listas simples ({ items }, p. ej. el
 * `authorsPool` de Descubrir). El actualizador no puede suponer una: si la estructura no es la esperada devuelve `old` sin tocar. Antes asumía
 * `old.pages` y, con una lista simple en caché, `onMutate` lanzaba («reading 'map'») ANTES de enviar el POST, así que el Me gusta no se registraba.
 */
export function updateSongInCaches(qc: QueryClient, songId: string, updater: (song: CommunitySong) => CommunitySong) {
  const touch = (it: CommunitySong) => (it.id === songId ? updater(it) : it);
  const mapItems = <T extends { items?: unknown }>(box: T): T =>
    Array.isArray(box.items) ? { ...box, items: (box.items as CommunitySong[]).map(touch) } : box;

  qc.setQueriesData<CommunityFeedData | Paginated<CommunitySong>>({ queryKey: ['community', 'feed'] }, (old) => {
    if (!old || typeof old !== 'object') return old;
    // feed infinito: { pages: [{ items }] }
    if ('pages' in old && Array.isArray(old.pages)) {
      return { ...old, pages: old.pages.map((page) => (page && typeof page === 'object' ? mapItems(page) : page)) };
    }
    // lista simple: { items }
    if ('items' in old && Array.isArray(old.items)) return mapItems(old);
    return old;
  });
  // canciones de un creador (perfil público): lista simple, no paginada
  qc.setQueriesData<Paginated<CommunitySong>>(
    { queryKey: ['community', 'user'], predicate: (q) => q.queryKey[3] === 'songs' },
    (old) => (old && typeof old === 'object' && Array.isArray(old.items) ? mapItems(old) : old)
  );
  qc.setQueryData<CommunitySongDetail>(['community', 'song', songId], (old) =>
    old && old.id === songId ? (updater(old) as CommunitySongDetail) : old
  );
}

/**
 * Opciones de la mutación de reacción (las usa `useCommunityReaction`). `react` es la llamada al backend y `onError` el aviso al usuario:
 * así la mutación completa se puede probar sin componentes.
 */
export function communityReactionOptions(
  qc: QueryClient,
  react: (id: string, type: ReactionType) => Promise<unknown>,
  onError: (err: unknown) => void
) {
  return {
    mutationFn: ({ id, type }: { id: string; type: ReactionType }) => react(id, type),
    onMutate: async ({ id, type }: { id: string; type: ReactionType }) => {
      await qc.cancelQueries({ queryKey: ['community'] });
      updateSongInCaches(qc, id, (song) => applyReaction(song, type));
    },
    onError,
    onSettled: () => {
      // re-sincroniza los contadores reales (el toggle es del backend)
      void qc.invalidateQueries({ queryKey: ['community'] });
    },
  };
}
