
/**
 * MELODYA WEB — Reacción (me gusta) del tema en curso, compartida por:
 *  • el botón ❤️ del reproductor expandido,
 *  • el atajo de teclado "L" (PlayerBar).
 * El estado optimista vive en el playerStore (setTrackReaction) para que
 * reproductor, cola y sesión persistida se mantengan sincronizados desde
 * un único lugar. Contrato real: POST /songs/:id/react { type: 'LIKE' }.
 */
import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { songsApi } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { toast } from '@/hooks/use-toast';

export type LikeOutcome = 'no-track' | 'guest' | 'ok' | 'error';

/** Toggle del me gusta del tema en curso (solo pistas con metadatos de comunidad). */
export async function toggleCurrentTrackLike(): Promise<LikeOutcome> {
  const { track, setTrackReaction } = usePlayerStore.getState();
  if (!track?.community) return 'no-track';
  if (!useAuthStore.getState().user) return 'guest';

  const liked = track.community.viewerReaction === 'LIKE';
  const nextLiked = !liked;
  const nextCount = Math.max(0, (track.community.likesCount ?? 0) + (nextLiked ? 1 : -1));
  // Optimista: primero actualizamos el store, luego confirmamos contra la API.
  setTrackReaction(nextLiked, nextCount);
  try {
    await songsApi.react(track.id, 'LIKE');
    void queryClient.invalidateQueries({ queryKey: ['community'] });
    return 'ok';
  } catch {
    // Rollback del optimismo.
    setTrackReaction(liked, track.community.likesCount ?? 0);
    return 'error';
  }
}

/** Toast de resultado para el atajo de teclado (el botón maneja sus propios textos). */
export function toastLikeOutcome(outcome: LikeOutcome, title: string) {
  if (outcome === 'error') {
    toast({ title: 'No pudimos registrar tu reacción', description: 'Probá de nuevo en un momento.', variant: 'destructive' });
    return;
  }
  if (outcome === 'ok') {
    const liked = usePlayerStore.getState().track?.community?.viewerReaction === 'LIKE';
    toast({
      title: liked ? 'Me gusta guardado ❤️' : 'Quitaste tu me gusta',
      description: liked ? `"${title}" quedó en tus favoritas de la comunidad.` : `Ya no está "${title}" entre tus favoritas.`,
    });
  }
}
