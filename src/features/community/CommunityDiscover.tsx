
/**
 * MELODYA WEB — Descubrimiento de la Comunidad (ruta #/community, vista por defecto).
 *
 * Inspirado en la referencia mobile de Social: canción destacada, carruseles horizontales de
 * canciones y fila de creadores con avatares circulares. Sólo usa datos reales del feed:
 *  • GET /community/songs?sort=most_played|most_liked|newest (primera página, sin endpoints nuevos).
 *  • Destacada: la canción reproducible más escuchada de la comunidad (`playsCount` real). Si todavía
 *    nadie escuchó nada, la más reciente.
 *  • Carruseles: «Lo más nuevo», «Más escuchadas», «Más queridas» (los tres órdenes que ya ofrece el
 *    backend) y «De {género}» sólo con géneros presentes en esas canciones (mín. 3).
 *  • Creadores: autores únicos de esas canciones, en orden de aparición. Sin rankings ni seguidores
 *    inventados.
 *
 * Reproducir, abrir el detalle, ir al perfil y las restricciones de sesión usan los mismos handlers
 * que la grilla de la Comunidad (los recibe por props).
 */
import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Heart, MessageCircle, Pause, Play } from 'lucide-react';
import { communityApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/hooks';
import { AuthAvatar, CoverArt, EqualizerBars } from '@/components/common';
import { Rail } from '@/components/common/Rail';
import { Skeleton } from '@/components/ui/skeleton';
import type { CommunitySong } from '@/types';

type Sort = 'newest' | 'most_played' | 'most_liked';

/** Cantidad de canciones por carrusel: una sola página corta, sin carga incremental. */
const RAIL_SIZE = 12;
const MIN_GENRE_SONGS = 3;
const MAX_GENRE_RAILS = 2;
const MAX_AUTHORS = 10;
/** Canciones recientes que se piden solo para juntar creadores: los carruseles traen pocas canciones y no alcanzaban para llenar la fila. */
const AUTHORS_POOL = 50;
const AUTHORS_MAX_PAGES = 4;

export interface CommunityDiscoverProps {
  /** Si el feed principal ya tiene «Lo más nuevo» cargado se reutiliza en vez de pedirlo de nuevo. */
  newestFromFeed?: CommunitySong[];
  isCurrentPlaying: (song: CommunitySong) => boolean;
  /** Reproduce `song` con `list` como cola (mismo flujo que la grilla). */
  onPlay: (song: CommunitySong, list: CommunitySong[]) => void;
  onOpen: (song: CommunitySong) => void;
  onAuthor: (id: string, name: string) => void;
  /** Alterna el me gusta (mismo handler y actualización optimista que la grilla). */
  onReact: (song: CommunitySong) => void;
}

/** Primera página de un orden. Misma forma de caché que el feed (['community','feed',…]) para que las
 *  reacciones optimistas también actualicen estas tarjetas. */
function useRail(sort: Sort, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['community', 'feed', { rail: sort }],
    queryFn: ({ pageParam }) => communityApi.feed({ sort, page: pageParam, limit: RAIL_SIZE }),
    initialPageParam: 1,
    getNextPageParam: () => undefined,
    enabled,
    staleTime: 60_000,
  });
}

const playable = (s: CommunitySong) => Boolean(apiFileUrl(s.audioUrl));

/* ── Encabezado de sección (estilo `.lbl` de V2: mayúsculas, 13px, +0.08em, punto dorado) ── */
function SectionLabel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
      <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
      {children}
    </h2>
  );
}

/* ── Tarjeta de canción del carrusel ── */
function RailCard({
  song,
  playing,
  onPlay,
  onOpen,
  onAuthor,
  onReact,
}: {
  song: CommunitySong;
  playing: boolean;
  onPlay: () => void;
  onOpen: () => void;
  onAuthor: () => void;
  onReact: () => void;
}) {
  const canPlay = playable(song);
  const liked = song.viewerReaction === 'LIKE';
  /* Diseño de feedV2 (design-V2): portada cuadrada con esquinas 28/28/14/14, insignia ▶ neutra (velo oscuro + glifo blanco; naranja solo si
     es la que suena), título, autor (color de etiqueta) y género debajo. Reproducciones, ♡ y comentarios siguen juntos en una fila. */
  return (
    <li className="flex w-[8.75rem] shrink-0 snap-start flex-col gap-2 sm:w-44 lg:w-48">
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Ver ${song.title}, de ${song.author.name}`}
          className={cn(
            'block w-full rounded-[28px_28px_14px_14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
            playing && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
          )}
        >
          <CoverArt id={song.id} src={song.coverUrl} alt="" className="aspect-square w-full" rounded="rounded-[28px_28px_14px_14px]" />
        </button>
        {canPlay && (
          <button
            type="button"
            onClick={onPlay}
            aria-label={playing ? `Pausar ${song.title}` : `Escuchá ${song.title}`}
            className="group/pb absolute right-0 bottom-0 z-[2] flex size-[52px] items-center justify-center focus-visible:outline-none"
          >
            <span
              aria-hidden
              className={cn(
                'flex size-8 items-center justify-center rounded-full border-[1.5px] border-white transition-transform group-active/pb:scale-95 group-focus-visible/pb:ring-2 group-focus-visible/pb:ring-foreground group-focus-visible/pb:ring-offset-2 group-focus-visible/pb:ring-offset-background',
                playing ? 'bg-primary text-primary-foreground' : 'bg-black/55 text-white'
              )}
            >
              {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 translate-x-px fill-current" />}
            </span>
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <p className="flex items-center gap-1.5 text-[15px] leading-tight font-semibold">
            {playing && <EqualizerBars className="shrink-0" />}
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 truncate rounded-sm text-left focus-visible:outline-2 focus-visible:outline-foreground"
            >
              {song.title}
            </button>
          </p>
          <button
            type="button"
            onClick={onAuthor}
            className="line-clamp-1 max-w-full rounded-sm text-left text-[13px] leading-[1.3] font-semibold text-label transition-colors hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-foreground"
          >
            {song.author.name}
          </button>
          {song.genre && <p className="line-clamp-1 text-[12.5px] leading-[1.3] text-muted-foreground">{song.genre}</p>}
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-xs tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1" title="Reproducciones">
              <Play className="h-3.5 w-3.5" aria-hidden />
              {formatNumber(song.playsCount)}
            </span>
            <button
              type="button"
              onClick={onReact}
              aria-pressed={liked}
              aria-label={liked ? `Quitar me gusta de ${song.title}` : `Me gusta ${song.title}`}
              title="Me gusta"
              className={cn(
                'inline-flex items-center gap-1 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
                liked ? 'text-label' : 'hover:text-foreground'
              )}
            >
              <Heart key={liked ? 'on' : 'off'} className={cn('h-3.5 w-3.5', liked && 'fill-current heart-pop')} aria-hidden />
              {formatNumber(song.likesCount)}
            </button>
            <button
              type="button"
              onClick={onOpen}
              aria-label={`${song.commentsCount} comentarios, ver ${song.title}`}
              title="Comentarios"
              className="inline-flex items-center gap-1 rounded-full transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              {formatNumber(song.commentsCount)}
            </button>
          </p>
        </div>
      </div>
    </li>
  );
}

/* ── Canción destacada ── */
function Featured({
  song,
  reason,
  playing,
  onPlay,
  onOpen,
  onAuthor,
  onReact,
}: {
  song: CommunitySong;
  reason: 'most_played' | 'newest';
  playing: boolean;
  onPlay: () => void;
  onOpen: () => void;
  onAuthor: () => void;
  onReact: () => void;
}) {
  const liked = song.viewerReaction === 'LIKE';
  /* Estilo de «Destacada» (design-V2, feed.html): portada con franja navy translúcida abajo, rótulo en mayúsculas, título en
     Bricolage y el botón de reproducir colgando del borde inferior con un aro del color del fondo. */
  return (
    <section aria-label="Canción destacada" className="relative mb-4">
      <div className="relative overflow-hidden rounded-[28px_28px_14px_14px] bg-surface">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Ver ${song.title}, de ${song.author.name}`}
          className="block w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
        >
          <CoverArt id={song.id} src={song.coverUrl} alt="" className="aspect-[4/3] w-full sm:aspect-[21/9] lg:aspect-[3/1]" rounded="rounded-none" />
        </button>
        {/* Franja plana sobre la portada: garantiza el contraste del texto sin degradados */}
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 bg-[rgba(19,28,51,.72)] pt-5 pr-24 pb-[18px] pl-5">
          <div className="min-w-0 flex-1 text-[#F3E5E2]">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em]">
              {reason === 'most_played' ? 'Más escuchada' : 'Destacada · la más reciente'}
            </p>
            <p className="mt-0.5 truncate font-display text-[22px] leading-[1.1] font-bold sm:text-[28px]">{song.title}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[rgba(243,229,226,.85)]">
              <button
                type="button"
                onClick={onAuthor}
                className="truncate rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[#F3E5E2]"
              >
                {song.author.name}
              </button>
              {song.genre && <span aria-hidden>· {song.genre}</span>}
              {song.playsCount > 0 && <span className="hidden sm:inline">· {formatNumber(song.playsCount)} reproducciones</span>}
              <button
                type="button"
                onClick={onReact}
                aria-pressed={liked}
                aria-label={liked ? `Quitar me gusta de ${song.title}` : `Me gusta ${song.title}`}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[13px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3E5E2]',
                  liked ? 'text-[#FF8A70]' : 'text-[#F3E5E2] hover:bg-white/10'
                )}
              >
                <Heart key={liked ? 'on' : 'off'} className={cn('h-4 w-4', liked && 'fill-current heart-pop')} aria-hidden />
                {formatNumber(song.likesCount)}
              </button>
            </p>
          </div>
        </div>
      </div>
      {playable(song) && (
        <button
          type="button"
          onClick={onPlay}
          aria-label={playing ? `Pausar ${song.title}` : `Escuchá ${song.title}`}
          className="absolute right-4 -bottom-3.5 flex size-[60px] items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_0_5px_var(--background)] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
        >
          {playing ? <Pause className="h-[18px] w-[18px] fill-current" aria-hidden /> : <Play className="h-[18px] w-[18px] translate-x-px fill-current" aria-hidden />}
        </button>
      )}
    </section>
  );
}

function RailSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="w-[8.75rem] shrink-0 space-y-2 sm:w-44 lg:w-48">
          <Skeleton className="aspect-square w-full rounded-cover" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/* ── Carrusel de creadores (avatares circulares con aro dorado): lo usan «Descubrí» y la fila de «Siguiendo» ── */
export function CreatorsRail({
  labelId,
  authors,
  onAuthor,
}: {
  labelId: string;
  authors: Array<{ id: string; name: string; avatarUrl?: string | null }>;
  onAuthor: (id: string, name: string) => void;
}) {
  return (
    <Rail labelId={labelId}>
      {authors.map((a) => (
        <li key={a.id} className="w-[6.5rem] shrink-0 snap-start sm:w-[7.5rem]">
          <button
            type="button"
            onClick={() => onAuthor(a.id, a.name)}
            aria-label={`Ver el perfil de ${a.name}`}
            className="group flex w-full flex-col items-center gap-3.5 rounded-[20px] px-2 pt-3 pb-1 focus-visible:outline-2 focus-visible:outline-foreground"
          >
            {/* Avatar como en «Perfil» (design-V2): foto circular con un aro dorado separado por un hueco del color del fondo (4 px + 2,5 px) */}
            <span className="rounded-full transition-transform duration-200 ease-out group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
              <AuthAvatar src={a.avatarUrl} name={a.name} className="size-20 border-0 shadow-[0_0_0_4px_var(--background),0_0_0_6.5px_var(--m-gold)] sm:size-24" fallbackClassName="bg-surface text-[22px] text-foreground sm:text-[26px] dark:text-foreground" />
            </span>
            <span className="line-clamp-2 w-full break-words text-center text-[13px] font-medium leading-tight">{a.name}</span>
          </button>
        </li>
      ))}
    </Rail>
  );
}

export function CommunityDiscover({ newestFromFeed, isCurrentPlaying, onPlay, onOpen, onAuthor, onReact }: CommunityDiscoverProps) {
  const played = useRail('most_played');
  const liked = useRail('most_liked');
  const newestQuery = useRail('newest', !newestFromFeed);

  const flat = (q: { data?: { pages: Array<{ items: CommunitySong[] }> } }) => q.data?.pages.flatMap((p) => p.items) ?? [];
  const mostPlayed = useMemo(() => flat(played), [played.data]);
  const mostLiked = useMemo(() => flat(liked), [liked.data]);
  const newest = useMemo(
    () => (newestFromFeed ? newestFromFeed.slice(0, RAIL_SIZE) : flat(newestQuery)),
    [newestFromFeed, newestQuery.data]
  );

  /* Creadores: se recorren páginas del feed reciente hasta juntar MAX_AUTHORS autores distintos (o no quedar más páginas). */
  const authorsPool = useQuery({
    queryKey: ['community', 'feed', { authorsPool: AUTHORS_POOL }],
    queryFn: async () => {
      const authors = new Set<string>();
      const items: CommunitySong[] = [];
      for (let page = 1; page <= AUTHORS_MAX_PAGES; page++) {
        const res = await communityApi.feed({ sort: 'newest', page, limit: AUTHORS_POOL });
        for (const s of res.items) {
          items.push(s);
          if (s.author?.id) authors.add(s.author.id);
        }
        if (authors.size >= MAX_AUTHORS || page >= res.pagination.pages) break;
      }
      return { items };
    },
    staleTime: 60_000,
  });

  const loading = (played.isPending || liked.isPending || (!newestFromFeed && newestQuery.isPending)) && !mostPlayed.length && !newest.length;

  /* Destacada: la reproducible más escuchada; sin reproducciones registradas, la más reciente. */
  const featured = useMemo(() => {
    const top = mostPlayed.find((s) => playable(s) && s.playsCount > 0);
    if (top) return { song: top, reason: 'most_played' as const };
    const latest = newest.find(playable) ?? mostPlayed.find(playable);
    return latest ? { song: latest, reason: 'newest' as const } : null;
  }, [mostPlayed, newest]);

  /* Universo de canciones conocidas (sin repetir) para géneros y creadores. */
  const universe = useMemo(() => {
    const seen = new Set<string>();
    const out: CommunitySong[] = [];
    for (const s of [...newest, ...mostPlayed, ...mostLiked]) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  }, [newest, mostPlayed, mostLiked]);

  const genreRails = useMemo(() => {
    const by = new Map<string, CommunitySong[]>();
    for (const s of universe) {
      const g = s.genre?.trim();
      if (!g) continue;
      by.set(g, [...(by.get(g) ?? []), s]);
    }
    return [...by.entries()]
      .filter(([, list]) => list.length >= MIN_GENRE_SONGS)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_GENRE_RAILS);
  }, [universe]);

  const authors = useMemo(() => {
    const seen = new Set<string>();
    const out: CommunitySong['author'][] = [];
    for (const s of [...universe, ...(authorsPool.data?.items ?? [])]) {
      if (!s.author?.id || seen.has(s.author.id)) continue;
      seen.add(s.author.id);
      out.push(s.author);
    }
    return out.slice(0, MAX_AUTHORS);
  }, [universe, authorsPool.data]);

  const rails: Array<{ id: string; title: string; songs: CommunitySong[] }> = [
    { id: 'rail-newest', title: 'Lo más nuevo', songs: newest },
    { id: 'rail-played', title: 'Más escuchadas', songs: mostPlayed.filter((s) => s.playsCount > 0) },
    { id: 'rail-liked', title: 'Más queridas', songs: mostLiked.filter((s) => s.likesCount > 0) },
    ...genreRails.map(([g, songs]) => ({ id: `rail-genre-${g}`, title: `De ${g}`, songs })),
  ].filter((r) => r.songs.length > 0);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Cargando descubrimiento">
        <Skeleton className="aspect-[4/3] w-full rounded-[28px_28px_14px_14px] sm:aspect-[21/9]" />
        <RailSkeleton />
      </div>
    );
  }

  /* Sin canciones (o error de carga): el estado vacío / de error lo muestra el feed completo de abajo. */
  if (!featured && rails.length === 0) return null;

  return (
    <div className="space-y-8">
      {featured && (
        <Featured
          song={featured.song}
          reason={featured.reason}
          playing={isCurrentPlaying(featured.song)}
          onPlay={() => onPlay(featured.song, [featured.song, ...universe.filter((s) => s.id !== featured.song.id)])}
          onOpen={() => onOpen(featured.song)}
          onAuthor={() => onAuthor(featured.song.author.id, featured.song.author.name)}
          onReact={() => onReact(featured.song)}
        />
      )}

      {rails.map((r) => (
        <section key={r.id} className="space-y-3">
          <SectionLabel id={r.id}>{r.title}</SectionLabel>
          <Rail labelId={r.id} arrowClassName="top-[4.125rem] lg:top-[4.625rem]">
            {r.songs.map((s) => (
              <RailCard
                key={s.id}
                song={s}
                playing={isCurrentPlaying(s)}
                onPlay={() => onPlay(s, r.songs)}
                onOpen={() => onOpen(s)}
                onAuthor={() => onAuthor(s.author.id, s.author.name)}
                onReact={() => onReact(s)}
              />
            ))}
          </Rail>
        </section>
      ))}

      {authors.length > 0 && (
        <section className="space-y-3">
          <SectionLabel id="rail-authors">Creadores</SectionLabel>
          <CreatorsRail labelId="rail-authors" authors={authors} onAuthor={onAuthor} />
        </section>
      )}
    </div>
  );
}
