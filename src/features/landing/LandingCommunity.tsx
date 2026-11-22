/**
 * MELODYA WEB — Sección «Comunidad» de la landing pública: las canciones más gustadas, del backend (mismo feed que usaba la landing anterior).
 * Reutiliza la consulta (useCommunityPreview), la conversión a tema del reproductor (communityTrack) y el reproductor global: se puede escuchar
 * sin iniciar sesión. Si la consulta falla o no hay canciones, la sección no se muestra (igual que antes).
 */
import React from 'react';
import { Headphones, Heart, Pause, Play } from 'lucide-react';
import { Link, navigate } from '@/lib/router';
import { apiFileUrl } from '@/lib/api/client';
import { formatNumber } from '@/hooks';
import { CoverArt } from '@/components/common';
import type { PlayerTrack } from '@/stores/player';
import { communityTrack, useCommunityPreview, usePlayerActions } from '@/features/home/public-data';

export function LandingCommunity() {
  const { play, isCurrent } = usePlayerActions();
  const { data, isLoading } = useCommunityPreview();
  const songs = data?.items ?? [];
  const queue = songs.map((s) => communityTrack(s)).filter((t): t is PlayerTrack => t !== null);

  if (!isLoading && songs.length === 0) return null;

  return (
    <section className="community section" id="comunidad" aria-labelledby="landing-comunidad">
      <header>
        <p className="eyebrow">● LO QUE ESTÁ SONANDO</p>
        <h2 id="landing-comunidad">Hecho por personas<br /><span>como vos.</span></h2>
        <p className="section-intro">Canciones que la comunidad está amando ahora. Escuchalas sin crear una cuenta.</p>
      </header>

      {isLoading ? (
        <div className="song-grid" aria-busy="true" aria-label="Cargando canciones">
          {[0, 1, 2, 3].map((i) => <div key={i} className="song-card is-loading" aria-hidden="true" />)}
        </div>
      ) : (
        <>
          <div className="song-grid">
            {songs.map((song) => {
              const playable = Boolean(apiFileUrl(song.audioUrl));
              const playing = isCurrent(song.id);
              return (
                <article key={song.id} className="song-card">
                  <div className="song-cover">
                    <CoverArt id={song.id} src={song.coverUrl} alt={`Portada de ${song.title}`} className="aspect-square w-full" rounded="rounded-cover" showVinyl />
                    {playable && (
                      <button
                        type="button"
                        className="song-play"
                        aria-label={`${playing ? 'Pausar' : 'Reproducir'} ${song.title}, de ${song.author?.name ?? 'la comunidad'}`}
                        onClick={() => {
                          const track = communityTrack(song);
                          if (track) play(track, queue);
                        }}
                      >
                        {playing ? <Pause size={20} fill="currentColor" aria-hidden="true" /> : <Play size={20} fill="currentColor" aria-hidden="true" />}
                      </button>
                    )}
                  </div>
                  <h3><Link to={`/songs/${song.id}`} title={song.title}>{song.title}</Link></h3>
                  <p className="song-author">de {song.author?.name ?? 'la comunidad'}</p>
                  <p className="song-likes"><Heart size={14} aria-hidden="true" />{formatNumber(song.likesCount)} me gusta</p>
                </article>
              );
            })}
          </div>
          <div className="community-more">
            <button type="button" className="button outline" onClick={() => navigate('/community')}>
              <Headphones size={18} aria-hidden="true" />
              Ver toda la comunidad
            </button>
          </div>
        </>
      )}
    </section>
  );
}
