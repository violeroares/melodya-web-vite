/**
 * MELODYA WEB — Datos y acciones públicas compartidas entre la landing (invitado) y el inicio (autenticado).
 * Una sola definición de las consultas de planes y de comunidad, de cómo una canción de la comunidad se vuelve un tema del reproductor y de
 * las acciones del player: la landing y HomeView las reutilizan, no las duplican. Mismas claves de React Query que siempre.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { billingApi, communityApi, songsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { mostPurchasedId } from '@/features/billing/PricingView';
import type { CommunitySong } from '@/types';

export function communityTrack(song: CommunitySong): PlayerTrack | null {
  const audioUrl = apiFileUrl(song.audioUrl);
  if (!audioUrl) return null;
  const myId = useAuthStore.getState().user?.id;
  return {
    id: song.id,
    title: song.title,
    artist: song.author?.name ?? 'Comunidad Melodya',
    coverUrl: song.coverUrl,
    audioUrl,
    durationSec: song.durationSec,
    isPublic: true,
    own: !!myId && song.author?.id === myId,
    community: {
      likesCount: song.likesCount,
      viewerReaction: song.viewerReaction ?? null,
      authorId: song.author?.id ?? null,
    },
    onPlayed: () => {
      songsApi.registerPlay(song.id).catch(() => undefined);
    },
  };
}

/** Player: play + "¿es el tema que está sonando?" */
export function usePlayerActions() {
  const play = usePlayerStore((s) => s.play);
  const currentId = usePlayerStore((s) => s.track?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isCurrent = (id: string) => currentId === id && isPlaying;
  return { play, isCurrent };
}

/** Canciones más gustadas de la comunidad (preview público de la landing). */
export function useCommunityPreview() {
  return useQuery({
    queryKey: ['community', 'preview'],
    queryFn: () => communityApi.feed({ sort: 'most_liked', limit: 4 }),
    staleTime: 60_000,
  });
}

/** Planes del backend, ordenados, y el más comprado («Más popular»). El precio puede ser personal: misma clave que la página de planes. */
export function usePublicPlans() {
  const userId = useAuthStore((s) => s.user?.id ?? 'anon');
  const query = useQuery({ queryKey: ['plans', userId], queryFn: () => billingApi.plans(), staleTime: 5 * 60_000 });
  const plans = React.useMemo(() => [...(query.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [query.data]);
  const popularPlanId = React.useMemo(() => mostPurchasedId(plans), [plans]);
  return { query, plans, popularPlanId };
}
