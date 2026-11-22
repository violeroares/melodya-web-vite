'use client';

/**
 * MELODYA WEB — CommunityView: feed público de la comunidad (ruta #/community).
 *
 * Contratos reales usados (melodya-backend v0.13 — MELODYA_WEB_AUDIT §2.10 y §9):
 *  • GET    /community/songs?sort=newest|most_played|most_liked&genre&style&authorId&search&page&limit
 *  • GET    /community/songs/:id            → detalle + lyrics + allowComments + author.followersCount + viewerIsFollowing
 *  • GET    /community/songs/:id/comments   → comentarios paginados (page, limit)
 *  • POST   /songs/:id/react                → toggle LIKE | DISLIKE (🔒)
 *  • POST   /songs/:id/comments · DELETE /songs/:id/comments/:commentId (🔒, propios)
 *  • POST   /songs/:id/play                 → registra reproducción (auth opcional)
 *  • POST / DELETE /users/:id/follow        → seguir / dejar de seguir (🔒)
 *  • POST   /reports                       → denunciar canción/comentario/usuario (🔒, v0.18.0)
 *
 * URL: #/community?song=<id> redirige al detalle (/songs/:id) · ?author=<userId> filtra por creador.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Clock, Flag, Headphones, Heart, ListEnd, ListStart, Loader2, MessageCircle, MoreVertical, Pause, Play, PlayCircle, Radio, Search, Share2, Shuffle,
  UserCheck, Users, X, SlidersHorizontal, type LucideIcon,
} from 'lucide-react';
import { shareContent } from '@/lib/share';
import { isRadioSort, radioShareUrl, startCommunityRadio } from '@/lib/radio';
import { communityApi, songsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { Link, navigate, useRoute } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { formatNumber, useDebounce } from '@/hooks';
import { BannerSlot } from '@/components/banners';
import { CoverArt, EmptyState, EqualizerBars, ErrorState, LoadingCards } from '@/components/common';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RemixMenu } from '@/features/song/RemixMenu';
import { remixMenuState } from '@/features/creator/remix-source';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { ReportDialog, type ReportTarget } from '@/features/community/ReportDialog';
import { CommunityDiscover, CreatorsRail } from '@/features/community/CommunityDiscover';
import { communityReactionOptions } from '@/features/community/reaction-cache';
import type { CommunitySong } from '@/types';

/* ── constantes ── */
const SORTS: Array<{ value: 'newest' | 'most_played' | 'most_liked'; label: string; icon: LucideIcon }> = [
  { value: 'newest', label: 'Lo más nuevo', icon: Clock },
  { value: 'most_played', label: 'Más escuchados', icon: Headphones },
  { value: 'most_liked', label: 'Más queridos', icon: Heart },
];
const FEED_PAGE_SIZE = 12;

/* ── helpers ── */

/** Canción del feed → pista del player global (POST /songs/:id/play registra la reproducción). */
export function communityTrack(song: CommunitySong): PlayerTrack | null {
  const audioUrl = apiFileUrl(song.audioUrl);
  if (!audioUrl) return null;
  /* own: la canción es del usuario actual → se puede referenciar en colecciones. */
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

/** Reacción (LIKE/DISLIKE) con actualización optimista del feed y del detalle (lógica en reaction-cache.ts). */
export function useCommunityReaction() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation(
    communityReactionOptions(qc, (id, type) => songsApi.react(id, type), (err) => {
      toast({ title: 'No pudimos registrar tu reacción', description: toUserMessage(err), variant: 'destructive' });
    })
  );
}

/** Guarda de invitado: toast + derivar a /login. Devuelve true si hay sesión. */
function useAuthPrompt() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  return (title: string, description?: string): boolean => {
    if (user) return true;
    toast({ title, description });
    navigate('/login');
    return false;
  };
}

/* ══════════════ Tarjeta del feed ══════════════ */
export function SongCard({
  song,
  playing,
  onPlay,
  onReact,
  onOpen,
  onAuthor,
  onPlayNext,
  onAddToQueue,
  onReport,
}: {
  song: CommunitySong;
  playing: boolean;
  onPlay: () => void;
  onReact: (type: 'LIKE' | 'DISLIKE') => void;
  onOpen: () => void;
  onAuthor: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  /** Denunciar la canción (solo contenido ajeno; undefined la oculta). */
  onReport?: () => void;
}) {
  const liked = song.viewerReaction === 'LIKE';
  const disliked = song.viewerReaction === 'DISLIKE';
  const playable = Boolean(apiFileUrl(song.audioUrl));

  /* Mismo estilo que las tarjetas de los carruseles («Lo más nuevo»…, design-V2 feedV2): portada con esquinas 28/28/14/14, insignia ▶ neutra con
     borde blanco, título en una línea, autor en color de etiqueta, género debajo y una fila con reproducciones, ♡ y comentarios. */
  return (
    <article className="lift group flex flex-col gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Ver ${song.title}, de ${song.author.name}`}
          className={cn(
            'block w-full rounded-[28px_28px_14px_14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            playing && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
          )}
        >
          <CoverArt
            id={song.id}
            src={song.coverUrl}
            alt={`Portada de ${song.title}`}
            className="aspect-square w-full transition-transform duration-300"
            rounded="rounded-[28px_28px_14px_14px]"
          />
        </button>
        {playable && (
          <button
            type="button"
            aria-label={playing ? `Pausar ${song.title}` : `Escuchá ${song.title}`}
            onClick={onPlay}
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

      <div className="flex min-w-0 items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {playing && playable && (
              <button
                type="button"
                onClick={onPlay}
                aria-label={`Pausar ${song.title}`}
                title="Sonando ahora: tocá para pausar"
                className="eq-btn shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <EqualizerBars className="shrink-0" />
              </button>
            )}
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="block truncate text-[15px] font-semibold leading-tight text-foreground">{song.title}</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onAuthor}
            aria-label={`Ver perfil de ${song.author.name}`}
            title={`Ver perfil de ${song.author.name}`}
            className="line-clamp-1 max-w-full rounded-sm text-left text-[13px] leading-[1.3] font-semibold text-label transition-colors hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {song.author.name}
          </button>
          {song.genre ? <p className="line-clamp-1 text-[12.5px] leading-[1.3] text-muted-foreground">{song.genre}</p> : null}
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-xs tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1" title="Reproducciones">
              <Play className="h-3.5 w-3.5" aria-hidden />
              {formatNumber(song.playsCount)}
            </span>
            <button
              type="button"
              onClick={() => onReact('LIKE')}
              aria-pressed={liked}
              aria-label={liked ? `Quitar me gusta de ${song.title}` : `Me gusta ${song.title}`}
              title="Me gusta"
              className={cn(
                'inline-flex items-center gap-1 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
              className="inline-flex items-center gap-1 rounded-full transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              {formatNumber(song.commentsCount)}
            </button>
          </p>
        </div>

        {playable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Más opciones de ${song.title}`}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreVertical className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" variant="list">
              <DropdownMenuItem onClick={onPlayNext} className="cursor-pointer gap-2 rounded-lg">
                <ListStart className="h-4 w-4 text-amber-strong" aria-hidden />
                Reproducir a continuación
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onAddToQueue} className="cursor-pointer gap-2 rounded-lg">
                <ListEnd className="h-4 w-4 text-amber-strong" aria-hidden />
                Agregar a la cola
              </DropdownMenuItem>
              {/* Remix: solo canciones que su dueño permite remixar (el servidor vuelve a validar al abrir la plantilla y al generar) */}
              {remixMenuState({ isOwner: false, signedIn: Boolean(useAuthStore.getState().user), visibility: 'PUBLIC', allowRemix: song.allowRemix, hasAudio: Boolean(song.audioUrl) }).visible && <RemixMenu songId={song.id} />}
              {/* v0.18.0 — denuncia de la canción (solo contenido ajeno) */}
              {onReport && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onReport} className="cursor-pointer gap-2 rounded-lg text-destructive focus:text-destructive">
                    <Flag className="h-4 w-4" aria-hidden />
                    Denunciar
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </article>
  );
}

/* ══════════════ Vista principal ══════════════ */
export function CommunityView() {
  const route = useRoute();
  const songParam = route.query.get('song');
  const authorParam = route.query.get('author');

  const user = useAuthStore((s) => s.user);
  const play = usePlayerStore((s) => s.play);
  const playNext = usePlayerStore((s) => s.playNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const currentTrack = usePlayerStore((s) => s.track);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const { toast } = useToast();
  const guard = useAuthPrompt();
  const reactMutation = useCommunityReaction();

  /* ── filtros: orden, búsqueda, género y alcance. El autor vive en la URL
     (?author=) para links directos; el click normal navega a /user/:id
     (perfil público completo, v0.22.0). ── */
  const [sort, setSort] = useState<'newest' | 'most_played' | 'most_liked'>('newest');
  /* v0.22.0 — "Todo" (feed completo) · "Siguiendo" (solo creadores que sigo). */
  const [scope, setScope] = useState<'all' | 'following'>('all');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput.trim(), 350);
  const [genre, setGenre] = useState<string | null>(null);
  const authorId = authorParam ?? null;
  const [filtersOpen, setFiltersOpen] = useState(false);
  /* nombres recordados al hacer clic en un autor (para mostrar el chip antes de que llegue el feed) */
  const [authorNames, setAuthorNames] = useState<Record<string, string>>({});

  /* ── v0.18.0 — denuncia de contenido: un solo ReportDialog para toda la vista
     (tarjetas del feed + dialog de detalle + comentarios). ── */
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const openSongReport = (song: CommunitySong) => {
    if (!guard('Ingresá para denunciar contenido', 'Creá tu cuenta para ayudarnos a cuidar la comunidad.')) return;
    setReportTarget({ type: 'SONG', id: song.id, title: `«${song.title}»` });
  };

  /* ── detalle: una única pantalla (/songs/:id) para todas las canciones. Los links
     viejos (#/community?song=<id>[&comment=<id>]) se redirigen ahí. ── */
  const openSong = (id: string) => navigate(`/songs/${encodeURIComponent(id)}`);
  const commentParam = route.query.get('comment');
  useEffect(() => {
    if (!songParam) return;
    navigate(`/songs/${encodeURIComponent(songParam)}${commentParam ? `?comment=${encodeURIComponent(commentParam)}` : ''}`, { replace: true });
  }, [songParam, commentParam]);

  /* ── link compartido de la radio (#/community?radio=<sort>&genre=<g>):
     enciende la radio al entrar y limpia los parámetros (para que "atrás" no
     la reencienda). El guard por-valor evita el doble disparo (StrictMode/
     re-renders) pero permite re-encender si el usuario vuelve a entrar con
     ?radio= (param vuelve a aparecer). ── */
  const radioParam = route.query.get('radio');
  const radioGenreParam = route.query.get('genre');
  const radioFiredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isRadioSort(radioParam)) {
      radioFiredForRef.current = null;
      return;
    }
    const genre = radioGenreParam?.trim() || null;
    const firedKey = `${radioParam}|${genre ?? ''}`;
    if (radioFiredForRef.current === firedKey) return;
    radioFiredForRef.current = firedKey;
    const params = new URLSearchParams(route.query);
    params.delete('radio');
    params.delete('genre');
    const qs = params.toString();
    navigate(`/community${qs ? `?${qs}` : ''}`, { replace: true });
    void startCommunityRadio(radioParam, genre);
  }, [radioParam, radioGenreParam, route.query]);

  /* ── feed paginado estilo infinito (GET /community/songs) ── */
  const feedQuery = useInfiniteQuery({
    queryKey: ['community', 'feed', { sort, genre, search: search || null, authorId, scope }],
    queryFn: ({ pageParam }) =>
      communityApi.feed({
        sort,
        genre: genre ?? undefined,
        search: search || undefined,
        authorId: authorId ?? undefined,
        scope,
        page: pageParam,
        limit: FEED_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.pagination.page < last.pagination.pages ? last.pagination.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => feedQuery.data?.pages.flatMap((p) => p.items) ?? [], [feedQuery.data]);
  const total = feedQuery.data?.pages[0]?.pagination.total ?? 0;

  /* v0.22.0 — a quién seguís (fila de creadores con acceso directo a su perfil). */
  const myFollowsQuery = useQuery({
    queryKey: ['community', 'my-follows', 'row'],
    queryFn: () => communityApi.userFollows(user?.id ?? '', { limit: 30 }),
    enabled: Boolean(user),
    staleTime: 60_000,
  });
  const myFollows = myFollowsQuery.data?.items ?? [];

  /* Cola del player: todas las canciones cargadas del feed */
  const queue = useMemo(
    () => items.map((s) => communityTrack(s)).filter((t): t is PlayerTrack => t !== null),
    [items]
  );

  /* BACKEND GAP: no existe endpoint de lista de géneros → los chips se derivan de
     los géneros presentes en las canciones cargadas del feed (máx. 10). */
  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const s of items) {
      const g = s.genre?.trim();
      if (g) set.add(g);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es')).slice(0, 10);
  }, [items]);

  /* Nombre del autor del filtro: del propio feed si está cargado, si no el recordado al hacer clic */
  const authorName = useMemo(
    () => (authorId ? (items.find((s) => s.author.id === authorId)?.author.name ?? authorNames[authorId] ?? null) : null),
    [items, authorId, authorNames]
  );

  /* ── handlers ── */
  const isCurrentPlaying = (song: CommunitySong) => Boolean(isPlaying && currentTrack?.id === song.id);

  const onPlaySong = (song: CommunitySong) => {
    const track = communityTrack(song);
    if (!track) return;
    play(track, queue);
  };

  /* Descubrimiento (destacada + carruseles): misma reproducción, con la lista del carrusel como cola.
     Si la canción ya suena, el botón pausa/reanuda como en la grilla. */
  const onPlayFrom = (song: CommunitySong, list: CommunitySong[]) => {
    if (isCurrentPlaying(song)) {
      usePlayerStore.getState().toggle();
      return;
    }
    const track = communityTrack(song);
    if (!track) return;
    const tracks = list.map((s) => communityTrack(s)).filter((tr): tr is PlayerTrack => tr !== null);
    play(track, tracks.length ? tracks : [track]);
  };

  /* "Reproducir a continuación" / "Agregar a la cola" (store del player). */
  const onQueueSong = (song: CommunitySong, mode: 'next' | 'end') => {
    const track = communityTrack(song);
    if (!track) return;
    const ok = mode === 'next' ? playNext(track) : addToQueue(track);
    if (ok) {
      toast({
        title: mode === 'next' ? 'Suena a continuación 🎧' : 'Agregada a la cola ➕',
        description: `"${track.title}" de ${track.artist}`,
      });
    } else {
      toast({ title: 'Ya está en la cola', description: `"${track.title}" ya estaba esperando su turno.` });
    }
  };

  const onReact = (song: CommunitySong, type: 'LIKE' | 'DISLIKE') => {
    if (!guard('Ingresá para reaccionar', 'Creá tu cuenta gratis y dejá tu me gusta a otros melodiosos.')) return;
    reactMutation.mutate({ id: song.id, type });
  };

  /* v0.22.0 — click en el autor → PERFIL PÚBLICO completo (bio, stats,
   * canciones, seguidos/seguidores, bloqueo) en vez del filtro del feed. */
  const handleAuthor = (id: string, name?: string | null) => {
    if (name) setAuthorNames((prev) => (prev[id] === name ? prev : { ...prev, [id]: name }));
    navigate(`/user/${encodeURIComponent(id)}`);
  };

  const clearAuthor = () => {
    navigate('/community', { replace: true });
  };

  const hasFilters = Boolean(genre || search || authorId);
  /* Vista de descubrimiento: sólo sin filtros, búsqueda ni autor, y en «Descubrí». */
  const discoverMode = scope === 'all' && !hasFilters;
  const activeFilters = (genre ? 1 : 0) + (authorId ? 1 : 0);
  const clearAllFilters = () => {
    setSearchInput('');
    setGenre(null);
    if (authorId) clearAuthor();
  };

  const genrePill = (active: boolean) =>
    cn(
      'min-h-10 rounded-full border-[1.5px] px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)]',
      active
        ? 'border-primary bg-primary font-bold text-primary-foreground'
        : 'border-line text-foreground hover:bg-accent'
    );

  /* Fila de creadores que seguís: sólo en «Siguiendo» y si hay alguno. */
  const showFollowRow = !!user && myFollows.length > 0 && scope === 'following';

  return (
    <div className="view-in mx-auto w-full max-w-7xl space-y-[18px]">
      {/* banner del CMS (renderiza null si no hay banner activo para la posición). En «Descubrí» va después de los
          creadores (más abajo); en «Siguiendo» va debajo de la fila de creadores seguidos; con búsqueda/filtros,
          donde no hay carruseles, queda arriba. */}
      {!discoverMode && !showFollowRow && <BannerSlot position="COMMUNITY" />}

      <header className="space-y-1">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-foreground">Comunidad</h1>
        <p className="text-sm text-muted-foreground">Descubrí lo que están creando otros melodiosos</p>
      </header>

      {/* v0.22.0 — alcance del feed: todo lo que sube la comunidad o solo lo de quienes seguís */}
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Alcance del feed">
        {(
          [
            { value: 'all', label: 'Descubrí', hint: 'Toda la comunidad' },
            { value: 'following', label: 'Siguiendo', hint: 'Lo que suben tus creadores' },
          ] as const
        ).map((t) => {
          const active = scope === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setScope(t.value)}
              title={t.hint}
              className={cn(
                'inline-flex h-10 items-center rounded-[20px] border-[1.5px] px-[18px] text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'border-primary bg-primary font-bold text-[#131C33]'
                  : 'border-foreground/50 font-medium text-foreground hover:bg-foreground/10'
              )}
            >
              {t.value === 'following' ? (
                <span className="inline-flex items-center gap-1.5">
                  <UserCheck className="h-3.5 w-3.5" aria-hidden />
                  {t.label}
                </span>
              ) : (
                t.label
              )}
            </button>
          );
        })}
        {scope === 'following' && user && myFollows.length > 0 && (
          <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">
            Seguís a {myFollows.length} {myFollows.length === 1 ? 'creador' : 'creadores'} ·{' '}
            <Link to="/profile/community" className="font-medium text-amber-strong underline-offset-4 hover:underline">
              gestionar
            </Link>
          </span>
        )}
      </div>

      {/* fila de creadores que seguís (acceso directo a su perfil) */}
      {showFollowRow && (
        <section aria-labelledby="rail-following" className="space-y-3">
          <h2 id="rail-following" className="sr-only">Creadores que seguís</h2>
          <CreatorsRail labelId="rail-following" authors={myFollows} onAuthor={handleAuthor} />
        </section>
      )}

      {showFollowRow && <BannerSlot position="COMMUNITY" />}

      {/* descubrimiento: canción destacada, carruseles y creadores (datos reales del feed) */}
      {discoverMode && (
        <CommunityDiscover
          newestFromFeed={sort === 'newest' ? items : undefined}
          isCurrentPlaying={isCurrentPlaying}
          onPlay={onPlayFrom}
          onOpen={(song) => openSong(song.id)}
          onAuthor={handleAuthor}
          onReact={(song) => onReact(song, 'LIKE')}
        />
      )}

      {discoverMode && <BannerSlot position="COMMUNITY" />}

      {discoverMode && (
        <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label pt-2">
          <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
          Toda la comunidad
        </h2>
      )}

      {/* orden + búsqueda */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Segmentado (design-V2): el mismo selector de grupo del sistema */}
        <SegmentedTabs
          tabs={SORTS.map((o) => ({ key: o.value, label: o.label, icon: o.icon }))}
          value={sort}
          onChange={setSort}
          ariaLabel="Orden del feed"
          className="w-full lg:w-auto"
        />
        {/* búsqueda (campo) · filtros (círculo dorado aparte) */}
        <div className="flex w-full items-center gap-2 lg:w-auto">
          <div className="relative min-w-0 flex-1 lg:w-80 lg:flex-none">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              type="search"
              placeholder="Buscá por título o creador…"
              aria-label="Buscar canciones en la comunidad"
              className="h-11 rounded-full pl-10 text-base font-normal md:text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            aria-label={activeFilters ? `Filtros, ${activeFilters} activos` : 'Filtros'}
            aria-haspopup="dialog"
            className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />
            {activeFilters > 0 && (
              <span aria-hidden className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-[#131C33] ring-2 ring-background">
                {activeFilters}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* filtros activos (sólo si hay alguno); el resto vive en el diálogo de filtros */}
      {(genre || authorId) && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filtros activos">
          {genre && (
            <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">
              {genre}
              <button type="button" onClick={() => setGenre(null)} aria-label={`Quitar filtro de género ${genre}`} className="-mr-2 flex size-8 items-center justify-center rounded-full hover:bg-primary-foreground/15 focus-visible:outline-2 focus-visible:outline-primary-foreground">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </span>
          )}
          {authorId && (
            <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">
              <Users className="h-4 w-4" aria-hidden />
              Autor: {authorName ?? 'Creador'}
              <button type="button" onClick={clearAuthor} aria-label="Quitar filtro de autor" className="-mr-2 flex size-8 items-center justify-center rounded-full hover:bg-primary-foreground/15 focus-visible:outline-2 focus-visible:outline-primary-foreground">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </span>
          )}
        </div>
      )}

      {/* diálogo de filtros: género (derivado del feed) + autor */}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Filtros</DialogTitle>
            <DialogDescription>Afiná lo que ves en la comunidad.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-label">Género</p>
              {genres.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setGenre(null)} aria-pressed={!genre} className={genrePill(!genre)}>
                    Todos
                  </button>
                  {genres.map((g) => (
                    <button key={g} type="button" onClick={() => setGenre(genre === g ? null : g)} aria-pressed={genre === g} className={genrePill(genre === g)}>
                      {g}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Todavía no hay géneros para filtrar.</p>
              )}
            </div>
            {authorId && (
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-label">Autor</p>
                <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground">
                  <Users className="h-4 w-4" aria-hidden />
                  {authorName ?? 'Creador'}
                  <button type="button" onClick={clearAuthor} aria-label="Quitar filtro de autor" className="-mr-2 flex size-8 items-center justify-center rounded-full hover:bg-primary-foreground/15 focus-visible:outline-2 focus-visible:outline-primary-foreground">
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </span>
              </div>
            )}
          </div>
          <DialogFooter className="mt-4 flex-row gap-2 sm:justify-between">
            <Button
              variant="ghost"
              className="max-sm:flex-1"
              onClick={() => {
                setGenre(null);
                if (authorId) clearAuthor();
              }}
              disabled={!genre && !authorId}
            >
              Limpiar
            </Button>
            <Button className="max-sm:flex-1" onClick={() => setFiltersOpen(false)}>
              Listo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* barra de reproducción del feed (solo con resultados reproducibles) */}
      {queue.length > 1 && (
        <div className="flex items-center justify-between gap-3 sm:flex-wrap [--off:calc((100cqw-min(100cqw,80rem))/2+1rem)] sm:[--off:calc((100cqw-min(100cqw,80rem))/2+1.5rem)] ml-[calc(-1*var(--off))] w-[calc(100%+var(--off))] rounded-r-[36px] bg-[var(--m-capsule-tint)] py-3 pr-4 pl-[calc(var(--off)+1rem)] sm:pr-6 sm:pl-[calc(var(--off)+1.5rem)] text-foreground">
          <p className="min-w-0 font-display text-xs leading-tight font-bold sm:text-sm">
            {formatNumber(total)} {total === 1 ? 'canción' : 'canciones'} en la comunidad
          </p>
          <div className="flex shrink-0 items-center gap-2 sm:flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void startCommunityRadio(sort, genre)}
              aria-label={`Encender la radio infinita: ${SORTS.find((s) => s.value === sort)?.label ?? ''}${genre ? ` · solo ${genre}` : ''}`}
              className="group h-10 rounded-[20px] border-[1.5px] border-primary bg-primary px-[18px] text-sm font-bold text-[#131C33] transition-colors hover:border-primary hover:bg-primary hover:text-[#131C33] hover:brightness-95 max-sm:size-10 max-sm:gap-0 max-sm:px-0"
            >
              <Radio className="h-4 w-4 transition-transform" aria-hidden />
              {genre ? (
                <span className="max-w-32 truncate max-sm:sr-only">Radio de {genre}</span>
              ) : (
                <span className="max-sm:sr-only">Radio infinita</span>
              )}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Compartir el link de la radio"
                  onClick={() => {
                    void shareContent({
                      title: 'Radio de la comunidad · Melodya',
                      text: genre
                        ? `Entrá y escuchá la radio infinita de ${genre} 📻`
                        : 'Entrá y escuchá la radio infinita de la comunidad 📻',
                      url: radioShareUrl(sort, genre),
                    }).then((outcome) => {
                      if (outcome === 'shared') return;
                      if (outcome === 'copied') {
                        toast({
                          title: 'Link de la radio copiado 📻',
                          description: 'Quien lo abra entra directo a la radio encendida.',
                        });
                      } else {
                        toast({ title: 'No pudimos compartir el link', variant: 'destructive' });
                      }
                    });
                  }}
                  className="h-10 rounded-[20px] border-[1.5px] border-foreground/50 bg-transparent px-[18px] text-sm font-medium text-foreground transition-colors hover:border-foreground/50 hover:bg-foreground/10 hover:text-foreground max-sm:size-10 max-sm:gap-0 max-sm:px-0 px-0 w-10 max-sm:px-0"
                >
                  <Share2 className="h-4 w-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Compartir la radio (link con autoplay)</TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              onClick={() => play(queue[0], queue)}
              className="h-10 rounded-[20px] border-[1.5px] border-foreground/50 bg-transparent px-[18px] text-sm font-medium text-foreground transition-colors hover:border-foreground/50 hover:bg-foreground/10 hover:text-foreground max-sm:size-10 max-sm:gap-0 max-sm:px-0"
            >
              <PlayCircle className="h-4 w-4" aria-hidden />
              <span className="max-sm:sr-only">Reproducir todo</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Fisher-Yates: arranca en una pista al azar con la cola mezclada.
                const shuffled = [...queue];
                for (let i = shuffled.length - 1; i > 0; i--) {
                  const j = Math.floor(Math.random() * (i + 1));
                  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
                play(shuffled[0], shuffled);
              }}
              aria-label="Reproducir en orden aleatorio"
              className="h-10 rounded-[20px] border-[1.5px] border-foreground/50 bg-transparent px-[18px] text-sm font-medium text-foreground transition-colors hover:border-foreground/50 hover:bg-foreground/10 hover:text-foreground max-sm:size-10 max-sm:gap-0 max-sm:px-0"
            >
              <Shuffle className="h-4 w-4" aria-hidden />
              <span className="max-sm:sr-only">Aleatorio</span>
            </Button>
          </div>
        </div>
      )}

      {/* resultados */}
      {feedQuery.isPending ? (
        <LoadingCards count={8} cover className="grid-cols-2 gap-x-3 gap-y-[18px] md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4" />
      ) : feedQuery.isError ? (
        <ErrorState message={toUserMessage(feedQuery.error, 'No pudimos cargar la comunidad.')} onRetry={() => void feedQuery.refetch()} />
      ) : items.length === 0 ? (
        scope === 'following' && !user ? (
          <EmptyState
            variant="studio"
            actionIcon={null}
            icon={<UserCheck className="h-7 w-7" />}
            title="Seguí a tus creadores favoritos"
            description="Ingresá para seguir a quien te gusta y ver acá todo lo que publican, en un solo feed."
            actionLabel="Ingresar"
            actionTo="/login"
          />
        ) : scope === 'following' && myFollows.length === 0 ? (
          <EmptyState
            variant="studio"
            actionIcon={null}
            icon={<UserCheck className="h-7 w-7" />}
            title="Todavía no seguís a nadie"
            description="Tocá el nombre de un creador en cualquier canción y seguilo: su música aparece acá."
            actionLabel="Explorar la comunidad"
            onAction={() => setScope('all')}
          />
        ) : scope === 'following' && items.length === 0 ? (
          <EmptyState
            icon={<UserCheck className="h-7 w-7" />}
            title="Tus creadores todavía no subieron nada"
            description="Cuando publiquen una canción nueva, aparece acá primero."
            actionLabel="Volver a descubrir"
            onAction={() => setScope('all')}
          />
        ) : hasFilters ? (
          <EmptyState
            icon={<Users className="h-7 w-7" />}
            title="No encontramos nada con esos filtros"
            description="Probá con otro género, otra búsqueda o quitá los filtros para ver todo."
            actionLabel="Quitar filtros"
            onAction={clearAllFilters}
          />
        ) : (
          <EmptyState
            variant="studio"
            icon={<Users className="h-7 w-7" />}
            title="Todavía no hay canciones publicadas"
            description="Sé el primero: creá y publicá tu canción para inspirar a los demás melodiosos."
            actionLabel="Crear mi canción"
            actionTo="/create"
          />
        )
      ) : (
        <>
          <div role="feed" aria-label="Canciones de la comunidad" className="stagger grid grid-cols-2 gap-x-3 gap-y-[18px] md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((song) => (
              <SongCard
                key={song.id}
                song={song}
                playing={isCurrentPlaying(song)}
                onPlay={() => onPlaySong(song)}
                onReact={(type) => onReact(song, type)}
                onOpen={() => openSong(song.id)}
                onAuthor={() => handleAuthor(song.author.id, song.author.name)}
                onPlayNext={() => onQueueSong(song, 'next')}
                onAddToQueue={() => onQueueSong(song, 'end')}
                onReport={song.author.id !== user?.id ? () => openSongReport(song) : undefined}
              />
            ))}
          </div>

          {/* paginación estilo infinito */}
          <div className="flex flex-col items-center gap-2 pt-2">
            {feedQuery.hasNextPage && (
              <Button
                variant="outline"
                className="h-10 rounded-[20px] border-[1.5px] border-foreground/50 bg-transparent px-[18px] text-sm font-medium text-foreground transition-colors hover:border-foreground/50 hover:bg-foreground/10 hover:text-foreground"
                onClick={() => void feedQuery.fetchNextPage()}
                disabled={feedQuery.isFetchingNextPage}
              >
                {feedQuery.isFetchingNextPage ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Cargando…
                  </>
                ) : (
                  'Cargar más'
                )}
              </Button>
            )}
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {formatNumber(total)} {total === 1 ? 'canción' : 'canciones'}
            </p>
          </div>
        </>
      )}

      {/* v0.18.0 — dialog de denuncia (canción / comentario / usuario) */}
      <ReportDialog
        open={reportTarget !== null}
        target={reportTarget}
        onOpenChange={(open) => {
          if (!open) setReportTarget(null);
        }}
      />
    </div>
  );
}
