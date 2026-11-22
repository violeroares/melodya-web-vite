'use client';

/**
 * MELODYA WEB — Biblioteca › Canciones.
 * BACKEND GAP: GET /songs no expone búsqueda ni filtros (solo paginación) →
 * la búsqueda por título y el orden "más gustadas" se resuelven client-side
 * sobre la página cargada.
 */
import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Music4, Play, Pause, Plus, Search, Trash2, Users, Heart, MoreVertical, Shuffle, SlidersHorizontal, PlayCircle, ListStart, ListEnd, LayoutGrid, List, MessageCircle, ThumbsDown } from 'lucide-react';
import { communityApi, songsApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { apiFileUrl } from '@/lib/api/client';
import { navigate } from '@/lib/router';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { formatDuration, formatNumber, formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import type { Song } from '@/types';
import { CoverArt, EmptyState, ErrorState, LoadingCards } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RemixMenu } from '@/features/song/RemixMenu';
import { ConfirmDialog, LIST_MENU_COMFORTABLE_MOBILE, TabCtaButton } from './library-utils';

type SortKey = 'recientes' | 'gustadas' | 'escuchadas';
type VisKey = 'todas' | 'publicas' | 'privadas';
type ViewMode = 'grid' | 'list';

const VIEW_KEY = 'melodya:songs-view';

const VIS_OPTIONS: ReadonlyArray<{ key: VisKey; label: string }> = [
  { key: 'todas', label: 'Todas' },
  { key: 'publicas', label: 'En comunidad' },
  { key: 'privadas', label: 'Privadas' },
];

const visPill = (active: boolean) =>
  cn(
    'inline-flex h-11 items-center rounded-full border-[1.5px] px-3.5 text-[13.5px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
    active ? 'border-selected bg-selected font-bold text-on-selected' : 'border-line font-medium text-foreground hover:bg-accent'
  );

/** Vista elegida (grilla o lista), recordada en este navegador. */
function readView(): ViewMode {
  if (typeof window === 'undefined') return 'grid';
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/** Canción propia → pista del player global (sin audio aún → audioUrl vacía). */
function songTrack(s: Song): PlayerTrack {
  return {
    id: s.id,
    title: s.title,
    artist: 'Vos',
    coverUrl: apiFileUrl(s.coverUrl),
    audioUrl: apiFileUrl(s.currentVersion?.audioUrl ?? null) ?? '',
    durationSec: s.currentVersion?.durationSec ?? null,
    isPublic: s.visibility === 'PUBLIC',
    own: true,
  };
}

export function SongsTab() {
  const play = usePlayerStore((s) => s.play);
  const playNext = usePlayerStore((s) => s.playNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('recientes');
  const [vis, setVis] = useState<VisKey>('todas');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Song | null>(null);
  const [view, setViewState] = useState<ViewMode>(readView);
  const setView = (v: ViewMode) => {
    setViewState(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* sin almacenamiento: la elección vale solo para esta visita */
    }
  };
  const currentId = usePlayerStore((s) => s.track?.id ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlayback = usePlayerStore((s) => s.toggle);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['songs'],
    queryFn: () => songsApi.list({ pageSize: 50 }),
  });
  const songs = useMemo(() => data?.items ?? [], [data]);

  /* El listado propio no trae tu reacción; se toma de las canciones públicas del autor en la comunidad
     (misma caché que el perfil público, así las reacciones optimistas también llegan acá). */
  const myId = useAuthStore((s) => s.user?.id);
  const myCommunity = useQuery({
    queryKey: ['community', 'user', myId, 'songs'],
    queryFn: () => communityApi.feed({ authorId: myId, limit: 50 }),
    enabled: Boolean(myId),
    staleTime: 60_000,
  });
  const likedIds = useMemo(
    () => new Set((myCommunity.data?.items ?? []).filter((s) => s.viewerReaction === 'LIKE').map((s) => s.id)),
    [myCommunity.data]
  );

  // Filtro y orden client-side (ver BACKEND GAP arriba).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q ? songs.filter((s) => s.title.toLowerCase().includes(q)) : songs;
    if (vis === 'publicas') list = list.filter((s) => s.visibility === 'PUBLIC');
    if (vis === 'privadas') list = list.filter((s) => s.visibility === 'PRIVATE');
    if (sort === 'gustadas') {
      return [...list].sort((a, b) => b.likesCount - a.likesCount || b.playsCount - a.playsCount);
    }
    if (sort === 'escuchadas') {
      return [...list].sort((a, b) => b.playsCount - a.playsCount || b.likesCount - a.likesCount);
    }
    return list; // "recientes": el backend ya ordena por updatedAt desc
  }, [songs, search, sort, vis]);

  const removeMutation = useMutation({
    mutationFn: (id: string) => songsApi.remove(id),
    onSuccess: (_res, id) => {
      usePlayerStore.getState().setTrackTrashed(id, true); // si estaba en la cola o sonando, sigue oyéndose sin contar ni compartir
      void qc.invalidateQueries({ queryKey: ['songs'] });
      toast({ title: 'Canción enviada a la Papelera', description: 'La restaurás desde Biblioteca › Papelera.' });
      setToDelete(null);
    },
    onError: (err) => {
      toast({ title: 'No pudimos eliminar la canción', description: toUserMessage(err), variant: 'destructive' });
    },
  });

  const playSong = (song: Song) => {
    const audioUrl = apiFileUrl(song.currentVersion?.audioUrl ?? null);
    if (!audioUrl) return;
    const queue = visible
      .filter((s) => s.currentVersion?.audioUrl)
      .map((s) => songTrack(s));
    play(songTrack(song), queue);
  };

  /* "Reproducir a continuación" / "Agregar a la cola" desde el menú de la tarjeta. */
  const queueSong = (song: Song, mode: 'next' | 'end') => {
    const track = songTrack(song);
    if (!track.audioUrl) return;
    const ok = mode === 'next' ? playNext(track) : addToQueue(track);
    if (ok) {
      toast({
        title: mode === 'next' ? 'Suena a continuación 🎧' : 'Agregada a la cola ➕',
        description: `"${track.title}"`,
      });
    } else {
      toast({ title: 'Ya está en la cola', description: `"${track.title}" ya estaba esperando su turno.` });
    }
  };

  // Cola de lo visible (solo canciones con audio listo)
  const visibleQueue = useMemo(
    () => visible.filter((s) => s.currentVersion?.audioUrl).map((s) => songTrack(s)),
    [visible]
  );

  const playAll = () => {
    if (!visibleQueue.length) return;
    play(visibleQueue[0], visibleQueue);
  };

  const playShuffle = () => {
    if (!visibleQueue.length) return;
    // Fisher-Yates sobre una copia: arranca en una pista al azar con la cola mezclada.
    const shuffled = [...visibleQueue];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    play(shuffled[0], shuffled);
  };

  const activeFilters = (vis !== 'todas' ? 1 : 0) + (sort !== 'recientes' ? 1 : 0);

  /* Selector de orden: compartido entre la barra (desde sm) y el diálogo de filtros (mobile). */
  const sortSelect = (className: string) => (
    <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
      <SelectTrigger aria-label="Ordenar canciones" className={cn('h-11 min-w-0 flex-1 rounded-full border-line bg-transparent px-3 text-[12.5px] font-medium text-foreground sm:px-4 sm:text-[13.5px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="recientes">Recientes</SelectItem>
        <SelectItem value="gustadas">Más gustadas</SelectItem>
        <SelectItem value="escuchadas">Más escuchadas</SelectItem>
      </SelectContent>
    </Select>
  );

  /* Selector grilla/lista: en mobile junto al buscador; desde sm a la derecha de los filtros. */
  const viewToggle = (
    <div className="flex items-center gap-2" role="group" aria-label="Cambiar vista">
    {(
      [
        { key: 'grid', label: 'Vista de grilla', icon: LayoutGrid },
        { key: 'list', label: 'Vista de lista', icon: List },
      ] as const
    ).map(({ key, label, icon: Icon }) => (
      <button
        key={key}
        type="button"
        onClick={() => setView(key)}
        aria-pressed={view === key}
        aria-label={label}
        title={label}
        className={cn(
          'flex size-11 items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
          view === key ? 'border-selected bg-selected text-on-selected' : 'border-line text-foreground hover:bg-accent'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    ))}
  </div>
  );

  return (
    <section aria-label="Tus canciones">
      {/* Grilla de 2 columnas. Mobile: título + acciones / buscador + filtros. Desde sm: título + acciones / buscador / visibilidad + orden + vista. Los wrappers "contents" no generan caja. */}
      <div className="mb-5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-4 sm:gap-x-3">
      <div className="contents">
        <div className="max-sm:contents sm:col-start-1 sm:row-start-1">
          <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label max-sm:col-start-1 max-sm:row-start-1">
            <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
            Canciones
          </h2>
          <p className="mt-1 hidden text-sm text-muted-foreground sm:block">Todo lo que generaste con Melodya, listo para escuchar.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 col-start-2 row-start-1 justify-end max-sm:flex-nowrap">
          {visibleQueue.length > 1 && (
            <>
              <TabCtaButton icon={PlayCircle} onClick={playAll} kind="ghost">
                Reproducir todo
              </TabCtaButton>
              <TabCtaButton icon={Shuffle} onClick={playShuffle} kind="ghost" ariaLabel="Reproducir en orden aleatorio">
                Aleatorio
              </TabCtaButton>
            </>
          )}
        </div>
      </div>

      {/* Búsqueda client-side + visibilidad + orden (BACKEND GAP: /songs sin search) */}
      <div className="contents">
        {/* Mobile: input + filtros + vista (grilla/lista) en su propia fila (el input ocupa todo el ancho que dejan los botones). Desde sm: "contents". */}
        <div className="col-span-2 row-start-2 flex items-center gap-2 sm:contents">
        <div className="relative min-w-0 flex-1 sm:col-span-2 sm:row-start-2">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por título…"
            aria-label="Buscar canciones por título"
            className="h-11 rounded-full pl-9 text-sm font-normal"
          />
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          aria-label={activeFilters ? `Filtros, ${activeFilters} activos` : 'Filtros'}
          aria-haspopup="dialog"
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:hidden"
        >
          <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />
          {activeFilters > 0 && (
            <span aria-hidden className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-[#131C33] ring-2 ring-background">
              {activeFilters}
            </span>
          )}
        </button>
        <div className="sm:hidden">{viewToggle}</div>
        </div>
        {/* Fila de filtros (solo desde sm; en mobile viven en el diálogo): visibilidad + orden a la izquierda, vista a la derecha */}
        <div className="col-span-2 row-start-3 flex items-center justify-between gap-3 max-sm:hidden">
          <div className="flex flex-wrap items-center gap-2">
            {/* Visibilidad (client-side, honesto sobre lo cargado) */}
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por visibilidad">
              {VIS_OPTIONS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setVis(v.key)}
                  aria-pressed={vis === v.key}
                  className={visPill(vis === v.key)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {sortSelect('sm:w-44 sm:flex-none')}
          </div>
          {viewToggle}
        </div>
      </div>
      </div>

      {/* Mobile: visibilidad y orden dentro del diálogo de filtros (como en Comunidad) */}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Filtros</DialogTitle>
            <DialogDescription>Afiná qué canciones ves y en qué orden.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-label">Visibilidad</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por visibilidad">
                {VIS_OPTIONS.map((v) => (
                  <button key={v.key} type="button" onClick={() => setVis(v.key)} aria-pressed={vis === v.key} className={visPill(vis === v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-label">Ordenar por</p>
              {sortSelect('w-full')}
            </div>
          </div>
          <DialogFooter className="mt-4 flex-row gap-2 sm:justify-between">
            <Button
              variant="ghost"
              className="max-sm:flex-1"
              onClick={() => {
                setVis('todas');
                setSort('recientes');
              }}
              disabled={activeFilters === 0}
            >
              Limpiar
            </Button>
            <Button className="max-sm:flex-1" onClick={() => setFiltersOpen(false)}>
              Listo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mobile: encabezado «Tus canciones» con el conteo (los botones de vista están junto al buscador) */}
      {!isLoading && !isError && visible.length > 0 && (
        <div className="mb-3 flex items-center justify-between gap-3 sm:hidden">
          <h3 className="flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-label">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-gold" />
            Tus canciones
            <span className="font-normal normal-case tracking-normal text-muted-foreground">{visible.length}</span>
          </h3>
        </div>
      )}

      {isLoading ? (
        <LoadingCards count={8} cover className="gap-x-3 gap-y-[18px]" />
      ) : isError ? (
        <ErrorState message={toUserMessage(error)} onRetry={() => void refetch()} />
      ) : songs.length === 0 ? (
        <EmptyState
          variant="studio"
          icon={<Music4 className="h-7 w-7" />}
          title="Todavía no tenés canciones."
          description="Contanos tu idea y Melodya la convierte en música: letra, voz y portada incluidas."
          actionLabel="Crear mi primera canción"
          actionTo="/create"
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Search className="h-7 w-7" />}
          title="No encontramos esa canción."
          description="Probá con otra parte del título o mirá todas tus canciones."
          actionLabel="Ver todas"
          onAction={() => setSearch('')}
        />
      ) : view === 'list' ? (
        <SongList
          songs={visible}
          currentId={currentId}
          isPlaying={isPlaying}
          onPlay={playSong}
          onToggle={togglePlayback}
          onDelete={setToDelete}
          onQueue={queueSong}
        />
      ) : (
        <div className="stagger grid grid-cols-2 gap-x-3 gap-y-[18px] sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visible.map((song) => (
            <SongCard
              key={song.id}
              song={song}
              liked={likedIds.has(song.id)}
              current={currentId === song.id}
              playing={currentId === song.id && isPlaying}
              onPlay={() => (currentId === song.id ? togglePlayback() : playSong(song))}
              onDelete={() => setToDelete(song)}
              onQueue={(mode) => queueSong(song, mode)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`¿Enviar "${toDelete?.title ?? ''}" a la Papelera?`}
        actionLabel="Enviar a la Papelera"
        description="Deja de aparecer en tu biblioteca y en la Comunidad, pero se conserva completa: la restaurás desde la Papelera."
        onConfirm={() => toDelete && removeMutation.mutate(toDelete.id)}
        pending={removeMutation.isPending}
      />
    </section>
  );
}

/** Vista de lista (design-V2): "En generación" arriba y una tabla con título, fecha y duración. */
function SongList({
  songs,
  currentId,
  isPlaying,
  onPlay,
  onToggle,
  onDelete,
  onQueue,
}: {
  songs: Song[];
  currentId: string | null;
  isPlaying: boolean;
  onPlay: (song: Song) => void;
  onToggle: () => void;
  onDelete: (song: Song) => void;
  onQueue: (song: Song, mode: 'next' | 'end') => void;
}) {
  const generating = songs.filter((s) => !s.currentVersion?.audioUrl);
  const ready = songs.filter((s) => s.currentVersion?.audioUrl);
  const rows = (list: Song[]) => (
    <ul className="divide-y divide-border/60">
      {list.map((song) => (
        <SongRow
          key={song.id}
          song={song}
          current={currentId === song.id}
          playing={currentId === song.id && isPlaying}
          onPlay={() => (currentId === song.id ? onToggle() : onPlay(song))}
          onDelete={() => onDelete(song)}
          onQueue={(mode) => onQueue(song, mode)}
        />
      ))}
    </ul>
  );
  return (
    <div className="space-y-6">
      {generating.length > 0 && (
        <section aria-labelledby="songs-generating" className="space-y-2">
          <h3 id="songs-generating" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-label">
            <span aria-hidden className="size-1.5 rounded-full bg-gold" />
            En generación
          </h3>
          <div className="overflow-hidden rounded-cover border border-border/70 bg-surface">{rows(generating)}</div>
        </section>
      )}
      {ready.length > 0 && (
        <section aria-labelledby="songs-ready" className="space-y-2">
          <div className="flex items-baseline justify-between gap-3 max-sm:hidden">
            <h3 id="songs-ready" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-label">
              <span aria-hidden className="size-1.5 rounded-full bg-gold" />
              Tus canciones
            </h3>
            <span className="text-xs text-muted-foreground">{ready.length} {ready.length === 1 ? 'canción' : 'canciones'}</span>
          </div>
          <div className="overflow-hidden rounded-cover border border-border/70 bg-surface">
            <div
              aria-hidden
              className="hidden grid-cols-[minmax(0,1fr)_9rem_5rem_6.5rem] gap-4 border-b border-border/60 px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground md:grid"
            >
              <span>Título</span>
              <span>Creada</span>
              <span>Duración</span>
              <span />
            </div>
            {rows(ready)}
          </div>
        </section>
      )}
    </div>
  );
}

function SongRow({
  song,
  current,
  playing,
  onPlay,
  onDelete,
  onQueue,
}: {
  song: Song;
  current: boolean;
  playing: boolean;
  onPlay: () => void;
  onDelete: () => void;
  onQueue: (mode: 'next' | 'end') => void;
}) {
  const audioUrl = song.currentVersion?.audioUrl ?? null;
  const genre = song.currentVersion?.genre ?? null;
  const subtitle = [genre, song.currentVersion ? `v${song.currentVersion.versionNumber}` : null].filter(Boolean).join(' · ');
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-surface-2/50 md:grid-cols-[minmax(0,1fr)_9rem_5rem_6.5rem]',
        current && 'bg-amber/5'
      )}
    >
      <button
        type="button"
        onClick={() => navigate(`/songs/${song.id}`)}
        aria-label={`Ver detalle de ${song.title}`}
        className="flex min-w-0 cursor-pointer items-center gap-3 rounded-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
      >
        <CoverArt
          id={song.id}
          src={song.coverUrl}
          alt=""
          requireAuth={song.visibility === 'PRIVATE'}
          className={cn('size-12 shrink-0', current && 'ring-2 ring-primary')}
          rounded="rounded-full"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">{song.title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{subtitle || 'Sin género'}</span>
            {song.visibility === 'PUBLIC' && (
              <span className="inline-flex shrink-0 items-center gap-1 text-amber-strong" title="Publicada en la comunidad">
                <Users className="h-3 w-3" aria-hidden />
                <span className="sr-only">En comunidad</span>
              </span>
            )}
            <span className="shrink-0 md:hidden">· {audioUrl ? formatRelative(song.createdAt) : 'generando…'}</span>
          </span>
        </span>
      </button>

      <span className="hidden text-sm text-muted-foreground md:block">{audioUrl ? formatRelative(song.createdAt) : 'Ahora'}</span>
      <span className="hidden text-sm tabular-nums text-muted-foreground md:block">
        {audioUrl ? formatDuration(song.currentVersion?.durationSec) : '—'}
      </span>

      <div className="flex items-center justify-end gap-1.5">
        {audioUrl ? (
          <button
            type="button"
            onClick={onPlay}
            aria-label={playing ? `Pausar ${song.title}` : `Reproducir ${song.title}`}
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber',
              current ? 'border-primary bg-primary text-primary-foreground' : 'border-line text-foreground hover:bg-accent'
            )}
          >
            {playing ? <Pause className="h-4 w-4" fill="currentColor" aria-hidden /> : <Play className="h-4 w-4 translate-x-px" fill="currentColor" aria-hidden />}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-xs font-medium text-amber-strong">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber/30 border-t-amber" aria-hidden />
            generando…
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Opciones de ${song.title}`}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground"
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
            <DropdownMenuItem onClick={() => navigate(`/songs/${song.id}`)} className="cursor-pointer rounded-lg">
              <Eye className="h-4 w-4 text-amber-strong" aria-hidden />
              Ver detalle
            </DropdownMenuItem>
            {/* Remix de una canción propia (Versionar o Reutilizar configuración): crea una canción NUEVA. «Otra versión» se pide desde el detalle. */}
            {audioUrl && <RemixMenu songId={song.id} />}
            {audioUrl && (
              <>
                <DropdownMenuItem onClick={() => onQueue('next')} className="cursor-pointer gap-2 rounded-lg">
                  <ListStart className="h-4 w-4 text-amber-strong" aria-hidden />
                  Reproducir a continuación
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onQueue('end')} className="cursor-pointer gap-2 rounded-lg">
                  <ListEnd className="h-4 w-4 text-amber-strong" aria-hidden />
                  Agregar a la cola
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={onDelete} className="cursor-pointer gap-2 rounded-lg text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function SongCard({
  song,
  liked,
  current,
  playing,
  onPlay,
  onDelete,
  onQueue,
}: {
  song: Song;
  /** El usuario le dio me gusta a esta canción. */
  liked: boolean;
  current: boolean;
  playing: boolean;
  onPlay: () => void;
  onDelete: () => void;
  onQueue: (mode: 'next' | 'end') => void;
}) {
  const audioUrl = song.currentVersion?.audioUrl ?? null;
  const versionNumber = song.currentVersion?.versionNumber ?? null;

  /* Mismo estilo visual que las tarjetas de /community: portada con esquinas 28/28/14/14, insignia ▶ neutra con borde blanco,
     título en una línea, opciones al costado del texto y una fila de métricas; se conservan todos los elementos propios de la biblioteca. */
  return (
    <article className="lift group flex flex-col gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => navigate(`/songs/${song.id}`)}
          aria-label={`Ver ${song.title}`}
          className={cn(
            'block w-full cursor-pointer rounded-[28px_28px_14px_14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            current && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
          )}
        >
          <CoverArt id={song.id} src={song.coverUrl} alt="" requireAuth={song.visibility === 'PRIVATE'} className="aspect-square w-full transition-transform duration-300" rounded="rounded-[28px_28px_14px_14px]" />
        </button>

        {song.visibility === 'PUBLIC' && (
          /* Cápsula como la de los ítems del sidebar («Con Melodya» en Letras): sale del borde izquierdo, ícono en círculo de acento.
             Va dentro de una capa recortada con la forma de la portada (esquinas 28/28/14/14) para que su lado plano no sobresalga de la curva,
             y con un fondo sólido debajo del tinte para que el texto se lea sobre cualquier imagen. */
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[28px_28px_14px_14px]">
            <span
              className="absolute top-3 left-0 inline-flex items-center gap-1.5 rounded-full rounded-l-none bg-background bg-[image:linear-gradient(var(--m-capsule-tint),var(--m-capsule-tint))] py-0.5 pr-3 pl-1 text-xs font-bold text-foreground"
              title="Publicada en la comunidad"
            >
              <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Users className="h-3.5 w-3.5" />
              </span>
              En comunidad
            </span>
          </div>
        )}

        {audioUrl ? (
          <button
            type="button"
            onClick={onPlay}
            aria-label={playing ? `Pausar ${song.title}` : `Reproducir ${song.title}`}
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
        ) : (
          <span className="absolute right-2 bottom-2 z-10 inline-flex items-center gap-1.5 rounded-full border border-amber/40 bg-background/85 px-2.5 py-1 text-xs font-medium text-amber-strong">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber/30 border-t-amber" aria-hidden />
            generando…
          </span>
        )}
      </div>

      <div className="flex min-w-0 items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <button
            type="button"
            onClick={() => navigate(`/songs/${song.id}`)}
            aria-label={`Ver detalle de ${song.title}`}
            className="block w-full min-w-0 cursor-pointer rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <h3 className="truncate text-[15px] font-semibold leading-tight text-foreground">{song.title}</h3>
          </button>

          {versionNumber !== null && <p className="line-clamp-1 text-[13px] leading-[1.3] font-semibold text-label">v{versionNumber}</p>}
          {song.currentVersion?.genre ? <p className="line-clamp-1 text-[12.5px] leading-[1.3] text-muted-foreground">{song.currentVersion.genre}</p> : null}

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-xs tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1" title="Reproducciones" aria-label={`${song.playsCount ?? 0} reproducciones`}>
              <Play className="h-3.5 w-3.5" aria-hidden /> {formatNumber(song.playsCount ?? 0)}
            </span>
            <span className={cn('inline-flex items-center gap-1', liked && 'text-label')} title="Me gusta" aria-label={`${song.likesCount ?? 0} me gusta${liked ? ', te gusta' : ''}`}>
              <Heart className={cn('h-3.5 w-3.5', liked && 'fill-current')} aria-hidden /> {formatNumber(song.likesCount ?? 0)}
            </span>
            <span className="inline-flex items-center gap-1" title="No me gusta" aria-label={`${song.dislikesCount ?? 0} no me gusta`}>
              <ThumbsDown className="h-3.5 w-3.5" aria-hidden /> {formatNumber(song.dislikesCount ?? 0)}
            </span>
            <span className="inline-flex items-center gap-1" title="Comentarios" aria-label={`${song.commentsCount ?? 0} comentarios`}>
              <MessageCircle className="h-3.5 w-3.5" aria-hidden /> {formatNumber(song.commentsCount ?? 0)}
            </span>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Opciones de ${song.title}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
            <DropdownMenuItem onClick={() => navigate(`/songs/${song.id}`)} className="cursor-pointer rounded-lg">
              <Eye className="h-4 w-4 text-amber-strong" aria-hidden />
              Ver detalle
            </DropdownMenuItem>
            {/* Remix de una canción propia (Versionar o Reutilizar configuración): crea una canción NUEVA. «Otra versión» se pide desde el detalle. */}
            {audioUrl && <RemixMenu songId={song.id} />}
            {audioUrl && (
              <>
                <DropdownMenuItem onClick={() => onQueue('next')} className="cursor-pointer gap-2 rounded-lg">
                  <ListStart className="h-4 w-4 text-amber-strong" aria-hidden />
                  Reproducir a continuación
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onQueue('end')} className="cursor-pointer gap-2 rounded-lg">
                  <ListEnd className="h-4 w-4 text-amber-strong" aria-hidden />
                  Agregar a la cola
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={onDelete} className="cursor-pointer gap-2 rounded-lg text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
