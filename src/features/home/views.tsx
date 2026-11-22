
/**
 * MELODYA WEB — Inicio autenticado (la landing pública vive en features/landing):
 *  • HomeView: hub creativo (autenticado) — bienvenida + CTA crear + generaciones
 *    en curso + canciones recientes + comunidad + novedades del CMS.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Music4, Play, Pause, Heart, ArrowRight, MessageCircle } from 'lucide-react';
import { Link } from '@/lib/router';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { communityApi, generationApi, songsApi } from '@/lib/api';
import { communityTrack, usePlayerActions } from './public-data';
import { apiFileUrl } from '@/lib/api/client';
import { formatNumber, formatRelative, formatDuration } from '@/hooks';
import { toUserMessage } from '@/lib/errors';
import { BannerSlot, useBanners } from '@/components/banners';
import {
  CoverArt, SectionHeader, EmptyState, ErrorState, LoadingCards, LoadingRows, EqualizerBars,
} from '@/components/common';
import { cn } from '@/lib/utils';
import { Rail } from '@/components/common/Rail';
import { HomeOrbit } from './HomeOrbit';
import { HomeGreeting } from './HomeGreeting';
import type { CommunitySong, Generation, Song } from '@/types';

/* ═══════════════ Helpers locales ═══════════════ */

/* Etiqueta de una generación en el home:
 * 1) el título ACTUAL de la canción (si el usuario la renombró desde la
 *    biblioteca, el home tiene que reflejar el nombre nuevo);
 * 2) el título pedido al generar (requestedTitle es solo la foto del momento);
 * 3) la idea del prompt o un fallback genérico. */
function generationLabel(g: Generation): string {
  if (g.song?.title) return g.song.title;
  if (g.requestedTitle) return g.requestedTitle;
  const idea = g.inputs?.find((i) => i.text)?.text;
  if (idea) return idea.length > 64 ? `${idea.slice(0, 64)}…` : idea;
  return 'Tu nueva canción';
}

function songTrack(song: Song, artist: string): PlayerTrack | null {
  const audioUrl = apiFileUrl(song.currentVersion?.audioUrl ?? null);
  if (!audioUrl) return null;
  return {
    id: song.id,
    title: song.title,
    artist,
    coverUrl: song.coverUrl,
    audioUrl,
    durationSec: song.currentVersion?.durationSec ?? null,
    isPublic: song.visibility === 'PUBLIC',
    own: true,
  };
}

/** Link "ver más" con flechita. */
function MoreLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 rounded-full text-sm font-medium text-amber-strong underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      {children}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   HOME (autenticado)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Portada redonda de una canción terminada (la API de generaciones no trae la portada: se pide la canción). */
function RoundCover({ songId, className = 'h-9 w-9' }: { songId: string; className?: string }) {
  const { data: song } = useQuery({ queryKey: ['song', songId, 'done'], queryFn: () => songsApi.get(songId), staleTime: 60_000 });
  return <CoverArt id={songId} src={song?.coverUrl} alt="" className={cn('shrink-0', className)} rounded="rounded-full" />;
}

/** Rótulo de sección (design-V2, crear.html): mayúsculas con punto dorado. */
function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
        <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Fila-cápsula (design-V2, crear.html): sale del borde izquierdo del contenido (se compensa el padding de la página). */
const CAPSULE_ROW =
  '-ml-4 flex h-[76px] w-[calc(100%+1rem)] items-center gap-3.5 rounded-r-[40px] bg-[var(--m-capsule-tint)] pr-5 pl-6 text-left sm:-ml-6 sm:w-[calc(100%+1.5rem)] sm:pl-8';

/** Generaciones en curso + últimas terminadas.
 *  Una misma canción puede tener varias generaciones (re-generaciones y
 *  versiones): la lista muestra cada canción UNA sola vez — la generación
 *  más reciente de cada una — para no ver "la misma canción repetida". */
function ContinueCreating() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['generations', 'recent'],
    queryFn: () => generationApi.list({ pageSize: 12 }),
  });

  if (isLoading) {
    return (
      <section aria-busy="true" aria-label="Generaciones recientes">
        <SectionLabel>Seguí creando</SectionLabel>
        <LoadingRows count={2} />
      </section>
    );
  }

  if (isError) {
    return (
      <section aria-label="Generaciones recientes">
        <SectionLabel>Seguí creando</SectionLabel>
        <ErrorState message={toUserMessage(error, 'No pudimos cargar tus generaciones.')} onRetry={() => void refetch()} />
      </section>
    );
  }

  const gens = data?.items ?? [];
  /* En curso: una tarjeta por canción (o por generación nueva sin canción aún). */
  const activeSeen = new Set<string>();
  const active = gens.filter((g) => {
    if (g.status !== 'PENDING' && g.status !== 'PROCESSING') return false;
    const key = g.songId ?? g.song?.id ?? g.id;
    if (activeSeen.has(key)) return false;
    activeSeen.add(key);
    return true;
  });
  /* Terminadas: la generación más reciente de cada canción, sin repetir
   * ninguna que ya esté sonando arriba ("Generando..."). */
  const activeSongIds = new Set(
    active.map((g) => g.songId ?? g.song?.id).filter((id): id is string => Boolean(id)),
  );
  const seenSongs = new Set<string>();
  const done: Generation[] = [];
  for (const g of gens) {
    const songId = g.songId ?? g.song?.id;
    if (g.status !== 'COMPLETED' || !songId) continue;
    if (activeSongIds.has(songId) || seenSongs.has(songId)) continue;
    seenSongs.add(songId);
    done.push(g);
    if (done.length >= 3) break;
  }
  if (!active.length && !done.length) return null;

  return (
    <section aria-labelledby="home-creando">
      <SectionLabel action={<MoreLink to="/library">Ver todas</MoreLink>}>
        <span id="home-creando">Seguí creando</span>
      </SectionLabel>
      <div className="flex flex-col gap-3">
        {active.map((g) => (
          <div key={g.id} className={CAPSULE_ROW} aria-live="polite">
            <span className="relative flex size-[46px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
              <Music4 className="relative h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate font-display text-lg font-bold text-foreground">Generando…</span>
              <span className="block truncate text-[13px] text-muted-foreground">
                {generationLabel(g)} · {formatRelative(g.createdAt)}
              </span>
            </span>
            <EqualizerBars className="shrink-0" />
          </div>
        ))}
        {done.map((g) => {
          const songId = g.songId ?? g.song?.id;
          if (!songId) return null;
          return (
            <Link key={g.id} to={`/songs/${songId}`} className={cn(CAPSULE_ROW, 'transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-foreground')}>
              <RoundCover songId={songId} className="size-[46px]" />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate font-display text-lg font-bold text-foreground">{generationLabel(g)}</span>
                <span className="block truncate text-[13px] text-muted-foreground">Lista · {formatRelative(g.completedAt ?? g.createdAt)}</span>
              </span>
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold text-on-gold">
                <ArrowRight className="h-4 w-4" />
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** Escuchadas recientemente (historial local del player, CLIENT-ONLY). */
function ContinueListening() {
  const recent = usePlayerStore((s) => s.recent);
  const { play, isCurrent } = usePlayerActions();

  if (recent.length < 2) return null; // una sola pista no aporta fila

  return (
    <section aria-labelledby="home-recientes">
      <SectionHeader
        title="Seguí escuchando"
        subtitle="Lo último que sonó en tus altavoces"
      />
      <div className="scrollbar-none -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {recent.map((t) => (
          <button
            key={`${t.id}-${t.audioUrl}`}
            type="button"
            onClick={() => play(t, recent)}
            aria-label={`Reproducir ${t.title}, de ${t.artist}`}
            className="lift group flex w-44 shrink-0 snap-start flex-col text-left sm:w-48"
          >
            <div className="relative">
              <CoverArt
                id={t.id}
                src={t.coverUrl}
                alt={`Portada de ${t.title}`}
                className="aspect-square w-full transition-transform duration-300"
                rounded="rounded-cover"
              />
              {/* La tarjeta entera es el botón: la insignia es solo visual (abajo a la derecha, siempre visible) */}
              <span aria-hidden className="absolute bottom-2 right-2 z-[1] flex size-11 items-center justify-center rounded-full gradient-warm text-primary-foreground">
                {isCurrent(t.id) ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 translate-x-px fill-current" />}
              </span>
            </div>
            <p className={cn('mt-2 truncate text-sm font-semibold', isCurrent(t.id) ? 'text-amber-strong' : 'text-foreground')}>{t.title}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.artist}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Canciones recientes de la biblioteca del usuario. */
function RecentSongs() {
  const user = useAuthStore((s) => s.user);
  const { play, isCurrent } = usePlayerActions();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['songs', 'recent'],
    queryFn: () => songsApi.list({ pageSize: 8 }),
  });

  const artist = user?.name ?? 'Vos';
  const songs = data?.items ?? [];
  const queue = songs
    .map((s) => songTrack(s, artist))
    .filter((t): t is PlayerTrack => t !== null);

  return (
    <section aria-labelledby="home-canciones">
      <SectionLabel action={<MoreLink to="/library">Ver biblioteca</MoreLink>}>
        <span id="home-canciones">Tus canciones recientes</span>
      </SectionLabel>

      {isLoading ? (
        <LoadingCards count={8} cover className="gap-x-3 gap-y-[18px]" />
      ) : isError ? (
        <ErrorState message={toUserMessage(error, 'No pudimos cargar tus canciones.')} onRetry={() => void refetch()} />
      ) : songs.length === 0 ? (
        <EmptyState
          variant="studio"
          icon={<Music4 className="h-7 w-7" />}
          title="Todavía no hay canciones"
          description="Creá tu primera canción y va a aparecer acá, lista para escuchar y compartir."
          actionLabel="Crear mi primera canción"
          actionTo="/create"
        />
      ) : (
        /* Carrusel como los de la Comunidad (design-V2, feed.html): portadas redondas, flechas atrás/adelante y gesto táctil */
        <Rail labelId="home-canciones" arrowClassName="top-[3.625rem] sm:top-[4.125rem]">
          {songs.map((song) => {
            const playable = Boolean(song.currentVersion?.audioUrl);
            // eslint-disable-next-line react-hooks/purity -- insignia «nueva»: depende del reloj al renderizar
            const isNew = Date.now() - new Date(song.createdAt).getTime() < 48 * 3_600_000;
            return (
              <li key={song.id} className="lift group flex w-40 shrink-0 snap-start flex-col items-center p-1.5 text-center sm:w-44">
                <div className="relative">
                  <CoverArt
                    id={song.id}
                    src={song.coverUrl}
                    alt={`Portada de ${song.title}`}
                    className={cn('size-36 sm:size-40', isNew && 'ring-2 ring-primary ring-offset-[3px] ring-offset-background')}
                    rounded="rounded-full"
                    showVinyl
                  />
                  {/* Overlay-link: abre la canción; el play queda encima con stopPropagation */}
                  <Link to={`/songs/${song.id}`} aria-label={`Abrir ${song.title}`} className="absolute inset-0 z-[1] rounded-full" />
                  {playable && (
                    /* Igual al botón de «Destacada» de feed.html: círculo naranja sólido, ícono navy y un aro del color del fondo que lo recorta del borde */
                    <button
                      type="button"
                      aria-label={`${isCurrent(song.id) ? 'Pausar' : 'Reproducir'} ${song.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const track = songTrack(song, artist);
                        if (track) play(track, queue);
                      }}
                      className="absolute -right-1 -bottom-1 z-[2] flex size-[52px] items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_0_5px_var(--background)] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
                    >
                      {isCurrent(song.id) ? <Pause className="h-[18px] w-[18px] fill-current" aria-hidden /> : <Play className="h-[18px] w-[18px] translate-x-px fill-current" aria-hidden />}
                    </button>
                  )}
                </div>
                <Link to={`/songs/${song.id}`} title={song.title} className="mt-3 block w-full truncate text-sm leading-tight font-semibold text-foreground transition-colors hover:text-amber-strong">
                  {song.title}
                </Link>
                <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                  {isNew && <span className="text-[11.5px] font-semibold text-label">Nueva</span>}
                  <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title="Reproducciones">
                    <Play className="h-3 w-3" aria-hidden />
                    {formatNumber(song.playsCount ?? 0)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title="Me gusta">
                    <Heart className="h-3 w-3" aria-hidden />
                    {formatNumber(song.likesCount ?? 0)}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title="Comentarios">
                    <MessageCircle className="h-3 w-3" aria-hidden />
                    {formatNumber(song.commentsCount ?? 0)}
                  </span>
                </div>
              </li>
            );
          })}
        </Rail>
      )}
    </section>
  );
}

/** Lo último de la comunidad. */
function CommunityHighlights() {
  const { play, isCurrent } = usePlayerActions();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['community', 'home'],
    queryFn: () => communityApi.feed({ sort: 'newest', limit: 4 }),
    staleTime: 60_000,
  });

  const songs = data?.items ?? [];
  const queue = songs
    .map((s) => communityTrack(s))
    .filter((t): t is PlayerTrack => t !== null);

  /* Fila de canción (se usa en la tarjeta única de celular y en las dos tarjetas de md en adelante) */
  const renderRow = (song: CommunitySong) => {
          const playable = Boolean(apiFileUrl(song.audioUrl));
          const current = isCurrent(song.id);
          return (
            /* Sin padding vertical en la tarjeta: la primera y la última fila lo llevan adentro, así el color del hover llega hasta el borde y las esquinas */
            <li key={song.id} className="group relative flex h-[76px] items-center gap-3.5 border-b border-[var(--m-separator)] pr-3 pl-4 transition-colors first:h-[82px] first:pt-1.5 last:h-[82px] last:border-b-0 last:pb-1.5 only:h-[88px] hover:bg-surface-2/50">
              {/* Overlay-link: toda la fila abre el detalle de la canción (en la Comunidad); el play queda encima y no navega */}
              <Link
                to={`/songs/${song.id}`}
                aria-label={`Ver ${song.title}, de ${song.author?.name ?? 'la comunidad'}`}
                className="absolute inset-0 z-[1] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
              />
              <CoverArt
                id={song.id}
                src={song.coverUrl}
                alt={`Portada de ${song.title}`}
                className={cn('size-[52px] shrink-0', current && 'ring-2 ring-primary ring-offset-2 ring-offset-[var(--m-input)]')}
                rounded="rounded-full"
              />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate font-display text-base font-bold text-foreground transition-colors group-hover:text-amber-strong">{song.title}</p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {/* Autor como en las tarjetas de la Comunidad: color de etiqueta y semibold; lleva al perfil (por encima del enlace de la fila) */}
                  {song.author?.id ? (
                    <Link
                      to={`/user/${encodeURIComponent(song.author.id)}`}
                      className="relative z-[2] rounded-sm font-semibold text-label hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-foreground"
                    >
                      {song.author.name}
                    </Link>
                  ) : (
                    <span className="font-semibold text-label">{song.author?.name}</span>
                  )}
                  {song.durationSec ? ` · ${formatDuration(song.durationSec)}` : ''}
                </p>
              </div>
              {playable && (
                <button
                  type="button"
                  aria-label={`${current ? 'Pausar' : 'Reproducir'} ${song.title}, de ${song.author?.name ?? 'la comunidad'}`}
                  onClick={() => {
                    const track = communityTrack(song);
                    if (track) play(track, queue);
                  }}
                  className={cn(
                    'relative z-[2] flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-foreground',
                    current ? 'border-primary bg-primary text-primary-foreground' : 'border-line text-foreground hover:bg-surface-2',
                  )}
                >
                  {current ? <Pause className="h-4 w-4 fill-current" aria-hidden /> : <Play className="h-4 w-4 translate-x-px fill-current" aria-hidden />}
                </button>
              )}
            </li>
          );
  };

  return (
    <section aria-labelledby="home-comunidad">
      <SectionLabel action={<MoreLink to="/community">Explorar comunidad</MoreLink>}>
        <span id="home-comunidad">De la comunidad</span>
      </SectionLabel>

      {isLoading ? (
        <LoadingRows count={4} />
      ) : isError ? (
        <ErrorState message={toUserMessage(error, 'No pudimos cargar la comunidad.')} onRetry={() => void refetch()} />
      ) : songs.length > 0 ? (
        /* design-V2 (biblioteca.html): tarjetas con filas separadas; portada redonda, título, detalle y play con borde.
           Celular: una sola tarjeta. Desde md: dos tarjetas independientes lado a lado (la primera mitad de las canciones a la izquierda). */
        <>
          <ul className="overflow-hidden rounded-t-[28px] rounded-b-[14px] border-[1.5px] border-[var(--m-border)] bg-[var(--m-input)] md:hidden">{songs.map(renderRow)}</ul>
          <div className="hidden gap-4 md:grid md:grid-cols-2 md:items-start">
            {[songs.slice(0, Math.ceil(songs.length / 2)), songs.slice(Math.ceil(songs.length / 2))]
              .filter((group) => group.length > 0)
              .map((group, g) => (
                <ul key={g} className="overflow-hidden rounded-t-[28px] rounded-b-[14px] border-[1.5px] border-[var(--m-border)] bg-[var(--m-input)]">
                  {group.map(renderRow)}
                </ul>
              ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Novedades del CMS (solo si hay banners SLIDER activos). */
function NovedadesMelodya() {
  const { data } = useBanners('SLIDER');
  const banners = data?.items ?? [];
  if (!banners.length) return null;
  return (
    <section aria-labelledby="home-novedades">
      <SectionLabel>
        <span id="home-novedades">Novedades Melodya</span>
      </SectionLabel>
      <BannerSlot position="SLIDER" />
    </section>
  );
}

export function HomeView() {
  return (
    <div className="view-in mx-auto w-full max-w-7xl space-y-12">
      {/* ── Bienvenida + CTA crear (elemento dominante) ── */}
      <section aria-label="Crear una canción">
        {/* En desktop el saludo vive en el Header; en mobile va acá */}
        <div className="mb-1 md:hidden [&>div]:justify-center">
          <HomeGreeting />
        </div>
        <p className="mt-1 text-center font-display text-2xl font-bold leading-tight tracking-tight sm:text-[20px]">¿Qué creamos hoy?</p>
        <p className="text-center text-sm text-muted-foreground">Contanos tu idea y en unos minutos la escuchás.</p>

        <HomeOrbit />
      </section>

      {/* ── Generaciones en curso / últimas ── */}
      <ContinueCreating />

      {/* ── Escuchadas recientemente (historial local) ── */}
      {/* <ContinueListening /> */}

      {/* ── Canciones recientes ── */}
      <RecentSongs />

      {/* ── Promo del CMS (entre secciones) ── */}
      <BannerSlot position="PROMO" />

      {/* ── Comunidad ── */}
      <CommunityHighlights />

      {/* ── Novedades ── */}
      <NovedadesMelodya />
    </div>
  );
}
