import { radioUrl } from '@/lib/links';

/**
 * MELODYA WEB — Radio de la comunidad (CLIENT-ONLY sobre el contrato real):
 * usa la paginación de GET /community/songs para armar una cola infinita.
 * Cuando quedan ≤2 temas por delante, useRadioWatcher (PlayerBar) agrega la
 * página siguiente. Cero endpoints inventados: sort/genre/search reales.
 */
import { communityApi, songsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { toast } from '@/hooks/use-toast';
import type { CommunitySong } from '@/types';

export type RadioSort = 'newest' | 'most_played' | 'most_liked';

export const RADIO_PAGE_SIZE = 12;

export const RADIO_SORT_LABELS: Record<RadioSort, string> = {
  newest: 'Novedades',
  most_liked: 'Las más queridas',
  most_played: 'Las más escuchadas',
};

/** Misma regla de mapeo que el feed/community: registra la reproducción. */
export function radioTrack(s: CommunitySong): PlayerTrack | null {
  const audioUrl = apiFileUrl(s.audioUrl);
  if (!audioUrl) return null;
  /* own: la canción es del usuario actual → se puede referenciar en colecciones. */
  const myId = useAuthStore.getState().user?.id;
  return {
    id: s.id,
    title: s.title,
    artist: s.author.name,
    coverUrl: apiFileUrl(s.coverUrl),
    audioUrl,
    durationSec: s.durationSec,
    isPublic: true,
    own: !!myId && s.author?.id === myId,
    community: {
      likesCount: s.likesCount,
      viewerReaction: s.viewerReaction ?? null,
    },
    onPlayed: () => {
      void songsApi.registerPlay(s.id);
    },
  };
}

/** Link público que enciende la radio al abrirse (/community?radio=<sort>&genre=<g>). */
export function radioShareUrl(sort: RadioSort, genre?: string | null): string {
  return radioUrl(sort, genre);
}

/** ¿El valor de ?radio= es un sort válido de la radio? */
export function isRadioSort(v: string | null | undefined): v is RadioSort {
  return v === 'newest' || v === 'most_played' || v === 'most_liked';
}

/** Enciende la radio con el sort pedido (y género opcional: filtro real del
 * feed, "contains") — toast de confirmación es-AR. */
export async function startCommunityRadio(sort: RadioSort, genre?: string | null) {
  try {
    const res = await communityApi.feed({ sort, genre: genre ?? undefined, page: 1, limit: RADIO_PAGE_SIZE });
    const tracks = res.items.map(radioTrack).filter((t): t is PlayerTrack => t !== null);
    if (!tracks.length) {
      toast({
        title: 'La radio está en silencio',
        description: genre
          ? `Todavía no hay canciones escuchables publicadas de ${genre}.`
          : 'Todavía no hay canciones escuchables publicadas en la comunidad.',
      });
      return;
    }
    usePlayerStore.getState().startRadio(`community-${sort}`, tracks, { genre: genre ?? null });
    toast({
      title: '📻 Radio encendida',
      description: genre
        ? `${RADIO_SORT_LABELS[sort]} de la comunidad · solo ${genre}. Se van sumando canciones solas.`
        : `${RADIO_SORT_LABELS[sort]} de la comunidad. Se van sumando canciones solas.`,
    });
  } catch {
    toast({
      title: 'No pudimos encender la radio',
      description: 'Probá de nuevo en un momento.',
      variant: 'destructive',
    });
  }
}

/** Página siguiente del feed para extender la cola (uso interno del watcher). */
export async function fetchRadioPage(sort: RadioSort, page: number, genre?: string | null): Promise<PlayerTrack[]> {
  const res = await communityApi.feed({ sort, genre: genre ?? undefined, page, limit: RADIO_PAGE_SIZE });
  return res.items.map(radioTrack).filter((t): t is PlayerTrack => t !== null);
}
