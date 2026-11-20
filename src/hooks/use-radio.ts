
/**
 * MELODYA WEB — useRadioWatcher: montado en el PlayerBar (siempre presente
 * mientras hay reproductor). Mientras la radio está encendida, cuando quedan
 * ≤2 temas por delante en la cola pide la página siguiente del feed de la
 * comunidad y la agrega (appendRadioPage). CLIENT-ONLY, sin endpoints nuevos.
 *
 * Además avisa lo que hace la radio (toasts sutiles, una vez por evento):
 *  • sumó una página → "La radio sumó N temas" (para que se sepa que sigue viva).
 *  • el feed se agotó → "La radio recorrió todo el feed" (la cola sigue igual).
 */
import { useEffect, useRef } from 'react';
import { usePlayerStore } from '@/stores/player';
import { fetchRadioPage, type RadioSort } from '@/lib/radio';
import { useToast } from '@/hooks/use-toast';

const MODE_TO_SORT: Record<string, RadioSort> = {
  'community-newest': 'newest',
  'community-most_liked': 'most_liked',
  'community-most_played': 'most_played',
};

const PRELOAD_MARGIN = 2;

export function useRadioWatcher() {
  const radioMode = usePlayerStore((s) => s.radioMode);
  const radioGenre = usePlayerStore((s) => s.radioGenre);
  const queue = usePlayerStore((s) => s.queue);
  const track = usePlayerStore((s) => s.track);
  const { toast } = useToast();
  const busy = useRef(false);
  const noMore = useRef(false);
  /* Un toast por evento, no por render: guardamos lo ya avisado. */
  const announced = useRef<'exhausted' | null>(null);

  /* Radio nueva → rehabilitar la extensión de la cola. */
  useEffect(() => {
    if (radioMode) {
      noMore.current = false;
      announced.current = null;
    }
  }, [radioMode]);

  useEffect(() => {
    if (!radioMode || !track || noMore.current || busy.current) return;
    const idx = queue.findIndex((t) => t.id === track.id && t.audioUrl === track.audioUrl);
    if (idx < 0) return;
    const remaining = queue.length - 1 - idx;
    if (remaining > PRELOAD_MARGIN) return;

    const sort = MODE_TO_SORT[radioMode];
    if (!sort) return;
    const nextPage = usePlayerStore.getState().radioPage + 1;
    busy.current = true;
    fetchRadioPage(sort, nextPage, radioGenre)
      .then((tracks) => {
        if (!tracks.length) {
          // Comunidad agotada: la cola sigue igual, avisamos una sola vez.
          noMore.current = true;
          if (announced.current !== 'exhausted') {
            announced.current = 'exhausted';
            toast({
              title: '📻 La radio recorrió todo el feed',
              description: 'Ya escuchaste todo lo publicado. La cola sigue con lo cargado.',
            });
          }
          return;
        }
        const fresh = usePlayerStore.getState().appendRadioPage(tracks);
        if (fresh > 0) {
          toast({
            title: '📻 La radio sumó más música',
            description: `${fresh} ${fresh === 1 ? 'canción nueva' : 'canciones nuevas'} en la cola.`,
          });
        }
      })
      .catch(() => {
        /* red interrumpida: se reintenta en el próximo cambio de pista */
      })
      .finally(() => {
        busy.current = false;
      });
  }, [radioMode, radioGenre, track, queue, toast]);
}
