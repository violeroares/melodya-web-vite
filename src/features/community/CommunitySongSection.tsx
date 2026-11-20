
/**
 * MELODYA WEB — CommunitySongSection: sección con una grilla de tarjetas de canción de la comunidad
 * (las mismas de «Toda la comunidad»). Usada en el detalle para «Más del autor» y «Más del género».
 */
import type { ReactNode } from 'react';
import { navigate } from '@/lib/router';
import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/hooks/use-toast';
import { SongCard, communityTrack, useCommunityReaction } from '@/features/community/CommunityView';
import type { CommunitySong } from '@/types';

export function CommunitySongSection({
  id,
  title,
  action,
  songs,
  onReport,
}: {
  /** Id del rótulo (aria-labelledby de la sección). */
  id: string;
  title: ReactNode;
  action?: ReactNode;
  songs: CommunitySong[];
  /** Abre la denuncia de una canción ajena. */
  onReport: (song: CommunitySong) => void;
}) {
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const play = usePlayerStore((s) => s.play);
  const playNext = usePlayerStore((s) => s.playNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const currentId = usePlayerStore((s) => s.track?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const reactMutation = useCommunityReaction();
  const queue = songs.map((s) => communityTrack(s)).filter((t) => t !== null);

  const onReact = (song: CommunitySong, type: 'LIKE' | 'DISLIKE') => {
    if (!user) {
      toast({ title: 'Ingresá para reaccionar', description: 'Creá tu cuenta gratis y dejá tu me gusta a otros melodiosos.' });
      navigate('/login');
      return;
    }
    reactMutation.mutate({ id: song.id, type });
  };

  const onQueue = (song: CommunitySong, mode: 'next' | 'end') => {
    const track = communityTrack(song);
    if (!track) return;
    const ok = mode === 'next' ? playNext(track) : addToQueue(track);
    toast(
      ok
        ? { title: mode === 'next' ? 'Suena a continuación 🎧' : 'Agregada a la cola ➕', description: `"${track.title}" de ${track.artist}` }
        : { title: 'Ya está en la cola', description: `"${track.title}" ya estaba esperando su turno.` }
    );
  };

  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
          <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
          <span id={id}>{title}</span>
        </h2>
        {action}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-[18px] md:grid-cols-4">
        {songs.map((song) => (
          <SongCard
            key={song.id}
            song={song}
            playing={Boolean(isPlaying && currentId === song.id)}
            onPlay={() => {
              const track = communityTrack(song);
              if (track) play(track, queue.length ? queue : [track]);
            }}
            onReact={(type) => onReact(song, type)}
            onOpen={() => navigate(`/songs/${encodeURIComponent(song.id)}`)}
            onAuthor={() => navigate(`/user/${encodeURIComponent(song.author.id)}`)}
            onPlayNext={() => onQueue(song, 'next')}
            onAddToQueue={() => onQueue(song, 'end')}
            onReport={song.author.id !== user?.id ? () => onReport(song) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
