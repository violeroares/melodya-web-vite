
/**
 * MELODYA WEB — Biblioteca › Letras (Songwriting Studio).
 * Búsqueda server-side con debounce (350ms) + filtro de origen (source).
 * El origen lo asigna el backend: MANUAL al crear, AI_GENERATED cuando la genera Melodya.
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, MoreVertical, Pencil, Plus, Search, SlidersHorizontal, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { lyricsApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { formatRelative, useDebounce } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import type { UserLyric } from '@/types';
import { LyricsStudio, type StudioOutcome } from '@/features/creator/LyricsStudio';
import { Chip, EmptyState, ErrorState, LoadingRows, SectionHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { LOCKED_CONTROL, RequiredPlanBadge } from '@/components/common/PlanGate';
import { ConfirmDialog, EyeSolid, Field, LIST_MENU_COMFORTABLE_MOBILE, LyricBody, PencilSolid, TabCtaButton, TrashSolid, ViewToggle, parseTagList, useViewMode } from './library-utils';

type SourceFilter = 'all' | 'MANUAL' | 'AI_GENERATED';

const SOURCE_FILTERS: Array<{ key: SourceFilter; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'MANUAL', label: 'Mías' },
  { key: 'AI_GENERATED', label: 'Con Melodya' },
];

export function LyricsTab() {
  const [view, setView] = useViewMode('melodya:lyrics-view');
  const list = view === 'list';
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 350);
  const [source, setSource] = useState<SourceFilter>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserLyric | null>(null);
  const [viewing, setViewing] = useState<UserLyric | null>(null);
  const [toDelete, setToDelete] = useState<UserLyric | null>(null);

  /* Estudio de letras (asistente a pantalla completa) — un solo mount en la tab.
   * studioSeed fuerza remount en cada apertura: cada sesión del estudio arranca
   * limpia con la idea/género que la disparó (crear, form de nueva letra o ver una).
   * prefill inyecta el outcome del estudio en el form abierto (crear/editar). */
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioSeed, setStudioSeed] = useState(0);
  const [studioGenre, setStudioGenre] = useState('');
  const [studioOrigin, setStudioOrigin] = useState<'header' | 'view'>('header');
  const [studioTarget, setStudioTarget] = useState<UserLyric | null>(null);
  const [prefill, setPrefill] = useState<StudioOutcome | null>(null);

  /** `target` = letra guardada a mejorar: viaja completa al estudio (existingLyrics/existingTitle). */
  // El asistente de letras (LYRICS_AI) no se abre si el plan no lo incluye: se muestra el aviso de upgrade.
  const lyricsGate = usePlanGate('LYRICS_AI');
  const openStudio = (origin: 'header' | 'view', genre: string, target?: UserLyric) => {
    if (lyricsGate.locked) {
      lyricsGate.prompt();
      return;
    }
    setStudioOrigin(origin);
    setStudioTarget(target ?? null);
    setStudioGenre(genre);
    setStudioSeed((s) => s + 1);
    setStudioOpen(true);
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['lyrics', { search: debouncedSearch, source }],
    queryFn: () =>
      lyricsApi.list({
        search: debouncedSearch.trim() || undefined,
        source: source === 'all' ? undefined : source,
        pageSize: 50,
      }),
  });
  const lyrics = data?.items ?? [];

  const createMutation = useMutation({
    mutationFn: (body: { title: string; lyrics: string; genre?: string; tags: string[] }) => lyricsApi.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lyrics'] });
      toast({ title: 'Letra guardada' });
      setCreating(false);
    },
    onError: (err) => toast({ title: 'No pudimos guardar la letra', description: toUserMessage(err), variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { title: string; lyrics: string; genre: string | null; tags: string[] } }) => lyricsApi.update(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lyrics'] });
      toast({ title: 'Letra actualizada' });
      setEditing(null);
    },
    onError: (err) => toast({ title: 'No pudimos actualizar la letra', description: toUserMessage(err), variant: 'destructive' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => lyricsApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lyrics'] });
      toast({ title: 'Letra enviada a la Papelera', description: 'La restaurás desde Biblioteca › Papelera.' });
      setToDelete(null);
    },
    onError: (err) => toast({ title: 'No pudimos eliminar la letra', description: toUserMessage(err), variant: 'destructive' }),
  });

  return (
    <section aria-label="Tus letras">
      <SectionHeader
        title="Letras"
        subtitle="Tus canciones escritas a mano y las que soñó Melodya, en un solo lugar."
        hideSubtitleOnMobile
        action={
          <div className="flex flex-wrap items-center gap-2">
            <TabCtaButton icon={Plus} onClick={() => setCreating(true)}>
              Nueva letra
            </TabCtaButton>
            <TabCtaButton icon={Sparkles} kind="ghost" iconOnlyOnMobile={false} locked={lyricsGate.locked} badge={<RequiredPlanBadge capability="LYRICS_AI" />} onClick={() => openStudio('header', '')}>
              Crear con Melodya
            </TabCtaButton>
          </div>
        }
      />

      {/* Búsqueda (server-side con debounce) + pills de origen. En mobile las pills viven en el diálogo de filtros (como en Comunidad). */}
      <div className="mb-5 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por título o contenido…"
              aria-label="Buscar letras"
              className="h-11 rounded-full pl-9 text-sm font-normal"
            />
            {isFetching && (
              <span className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" aria-hidden>
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber/30 border-t-amber" />
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            aria-label={source !== 'all' ? 'Filtros, 1 activo' : 'Filtros'}
            aria-haspopup="dialog"
            className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:hidden"
          >
            <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />
            {source !== 'all' && (
              <span aria-hidden className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-[#131C33] ring-2 ring-background">
                1
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 max-sm:hidden">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por origen">
            {SOURCE_FILTERS.map((f) => (
              <Chip key={f.key} active={source === f.key} onClick={() => setSource(f.key)}>
                {f.key === 'MANUAL' && <FileText className="h-3 w-3" aria-hidden />}
                {f.key === 'AI_GENERATED' && <Sparkles className="h-3 w-3" aria-hidden />}
                {f.label}
              </Chip>
            ))}
          </div>
          <ViewToggle view={view} onChange={setView} />
        </div>
      </div>

      {/* Filtros en mobile: origen de la letra */}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Filtros</DialogTitle>
            <DialogDescription>Afiná qué letras ves.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-label">Origen</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por origen">
              {SOURCE_FILTERS.map((f) => (
                <Chip key={f.key} active={source === f.key} onClick={() => setSource(f.key)}>
                  {f.key === 'MANUAL' && <FileText className="h-3 w-3" aria-hidden />}
                  {f.key === 'AI_GENERATED' && <Sparkles className="h-3 w-3" aria-hidden />}
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>
          <DialogFooter className="mt-4 flex-row gap-2 sm:justify-between">
            <Button variant="ghost" className="max-sm:flex-1" onClick={() => setSource('all')} disabled={source === 'all'}>
              Limpiar
            </Button>
            <Button className="max-sm:flex-1" onClick={() => setFiltersOpen(false)}>
              Listo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <LoadingRows count={5} />
      ) : isError ? (
        <ErrorState message={toUserMessage(error)} onRetry={() => void refetch()} />
      ) : lyrics.length === 0 ? (
        search.trim() || source !== 'all' ? (
          <EmptyState
            icon={<Search className="h-7 w-7" />}
            title="No encontramos letras."
            description="Probá con otra búsqueda o cambiá el filtro de origen."
            actionLabel="Limpiar filtros"
            onAction={() => { setSearch(''); setSource('all'); }}
          />
        ) : (
          <EmptyState
            variant="studio"
            icon={<FileText className="h-7 w-7" />}
            title="Todavía no tenés letras."
            description="Escribí tu primera letra y usala en tus generaciones, o dejá que Melodya te inspire."
            actionLabel="Escribir mi primera letra"
            onAction={() => setCreating(true)}
          />
        )
      ) : (
        <ul className={cn(list ? 'flex flex-col gap-2' : 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3')}>
          {lyrics.map((lyric) => (
            <li key={lyric.id}>
              {/* design-V2 › Biblioteca › Letras: tarjeta con ícono circular (con destello dorado si la escribió Melodya),
                  título, origen · fecha, géneros/etiquetas en píldoras y vista previa de una línea. */}
              <article
                className={cn(
                  'group relative flex h-full gap-3.5 overflow-hidden rounded-cover border border-[var(--m-border)] bg-[var(--m-input)] p-4 pr-12 transition-colors hover:border-amber/40',
                  list && 'items-center py-3 sm:pr-3'
                )}
              >
                <span aria-hidden className="relative flex size-12 shrink-0 items-center justify-center self-start rounded-full bg-primary text-[#131C33]">
                  {/* Íconos exactos del diseño V2: «notes» (tres líneas) y el destello de Melodya */}
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 18H3" />
                    <path d="M17 6H3" />
                    <path d="M21 12H3" />
                  </svg>
                  {lyric.source === 'AI_GENERATED' && (
                    <span className="absolute -top-1 -right-1 flex size-[22px] items-center justify-center rounded-full bg-gold text-[#131C33] ring-[2.5px] ring-[var(--m-input)]">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 1.5c.6 4.8 2.7 7.6 10.5 10.5-7.8 2.9-9.9 5.7-10.5 10.5-.6-4.8-2.7-7.6-10.5-10.5C9.3 9.1 11.4 6.3 12 1.5z" />
                      </svg>
                    </span>
                  )}
                </span>
                <div className={'flex min-w-0 flex-1 flex-col gap-1.5'}>
                  <button
                    type="button"
                    onClick={() => setViewing(lyric)}
                    className={'block w-full min-w-0 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber'}
                    aria-label={`Ver letra ${lyric.title}`}
                  >
                    <h3 className="line-clamp-2 text-wrap! font-display text-lg font-bold leading-[1.2] text-foreground">{lyric.title}</h3>
                    {/* Origen («Escrita por vos» / «Con Melodya») · fecha */}
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] leading-[1.35] text-muted-foreground">
                      <span className="font-semibold text-label">{lyric.source === 'MANUAL' ? 'Escrita por vos' : 'Con Melodya'}</span>
                      <span aria-hidden>·</span>
                      <span className="whitespace-nowrap">{formatRelative(lyric.updatedAt)}</span>
                    </p>
                    <p className={cn('mt-2 line-clamp-2 min-h-[2.5em] text-[13px] leading-tight whitespace-pre-line text-muted-foreground', list && 'hidden')}>
                      {lyric.lyrics.replace(/\[.*?\]/g, '').trim()}
                    </p>
                  </button>
                  {(lyric.genre || lyric.tags.length > 0) && (
                    <div className={'flex flex-wrap items-center gap-1.5'}>
                      {lyric.genre && (
                        <span className="inline-flex items-center rounded-full border border-muted-foreground px-[9px] py-[3px] text-xs leading-none font-medium text-foreground">{lyric.genre}</span>
                      )}
                      {lyric.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="inline-flex items-center rounded-full border border-lyric-tag px-[9px] py-[3px] text-xs leading-none font-medium text-lyric-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Vista lista (≥ sm): las tres acciones a la vista. Grilla y mobile: menú de opciones arriba a la derecha. */}
                {list && (
                  <div className="flex shrink-0 items-center gap-3 self-center max-sm:hidden">
                    {[
                      { key: 'view', label: 'Ver completa', Icon: EyeSolid, onClick: () => setViewing(lyric) },
                      { key: 'edit', label: 'Editar', Icon: PencilSolid, onClick: () => setEditing(lyric) },
                      { key: 'delete', label: 'Enviar a la Papelera', Icon: TrashSolid, onClick: () => setToDelete(lyric) },
                    ].map(({ key, label, Icon, onClick }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={onClick}
                        title={label}
                        aria-label={`${label}: ${lyric.title}`}
                        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] border-foreground text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                      >
                        <Icon className="h-[18px] w-[18px]" aria-hidden />
                      </button>
                    ))}
                  </div>
                )}
                <div className={cn('absolute top-3 right-3 flex h-8 items-center gap-1', list && 'sm:hidden')}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Opciones de ${lyric.title}`}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground"
                    >
                      <MoreVertical className="h-4 w-4" aria-hidden />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
                    <DropdownMenuItem onClick={() => setViewing(lyric)}>
                      <Eye className="h-4 w-4 text-amber-strong" aria-hidden /> Ver completa
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEditing(lyric)}>
                      <Pencil className="h-4 w-4" aria-hidden /> Editar
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setToDelete(lyric)} className="text-destructive focus:text-destructive">
                      <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}

      {/* Crear / editar */}
      <LyricFormDialog
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) { setCreating(false); setEditing(null); setPrefill(null); }
        }}
        title={editing ? 'Editar letra' : 'Nueva letra'}
        description={editing ? 'Ajustá lo que quieras: título, texto, género o etiquetas.' : 'Escribí tranquilo/a. Después podés usarla en tus generaciones.'}
        submitLabel={editing ? 'Guardar cambios' : 'Guardar letra'}
        initial={editing ?? undefined}
        prefill={prefill}
        pending={createMutation.isPending || updateMutation.isPending}
        onSubmit={(body) => {
          if (editing) updateMutation.mutate({ id: editing.id, body: { ...body, genre: body.genre || null } });
          else createMutation.mutate(body);
        }}
      />

      {/* Detalle: letra completa formateada */}
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-h-[85vh] overflow-hidden border-border/70 bg-surface sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-left">{viewing?.title}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2 text-left">
              {viewing && <SourceBadge source={viewing.source} />}
              {viewing?.genre && <Chip>{viewing.genre}</Chip>}
              {viewing && <span className="text-xs">{formatRelative(viewing.updatedAt)}</span>}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] pr-3">
            {viewing && <LyricBody lyrics={viewing.lyrics} />}
          </ScrollArea>
          <DialogFooter className="sm:flex-wrap">
            {viewing && (
              <>
                <Button
                  variant="outline"
                  className={cn('rounded-full hover:border-amber/50 hover:bg-amber/10', lyricsGate.locked && LOCKED_CONTROL)}
                  aria-disabled={lyricsGate.locked || undefined}
                  onClick={() => openStudio('view', viewing.genre ?? '', viewing)}
                >
                  <Wand2 className="h-4 w-4" aria-hidden /> Mejorar con Melodya
                  <RequiredPlanBadge capability="LYRICS_AI" />
                </Button>
                <Button
                  variant="outline"
                  className="rounded-full"
                  onClick={() => { setEditing(viewing); setViewing(null); }}
                >
                  <Pencil className="h-4 w-4" aria-hidden /> Editar
                </Button>
              </>
            )}
            <Button className="rounded-full" onClick={() => setViewing(null)}>
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`¿Enviar "${toDelete?.title ?? ''}" a la Papelera?`}
        actionLabel="Enviar a la Papelera"
        description="La letra deja de estar disponible, pero se conserva: la restaurás desde la Papelera. Las canciones que ya generaste no cambian."
        onConfirm={() => toDelete && removeMutation.mutate(toDelete.id)}
        pending={removeMutation.isPending}
      />

      {/* Asistente de letras: un solo dialog para toda la tab (crear / mejorar). */}
      <LyricsStudio
        key={studioSeed}
        open={studioOpen}
        onOpenChange={setStudioOpen}
        initialGenre={studioGenre || undefined}
        initialLyrics={studioTarget?.lyrics}
        initialLyricsTitle={studioTarget?.title}
        onApply={(outcome) => {
          setStudioOpen(false);
          if (studioOrigin === 'view' && studioTarget) {
            // Viniendo del dialog de una letra guardada: abrir el form de edición
            // con la versión nueva (título y letra del outcome, el resto de la letra original).
            setViewing(null);
            setEditing({ ...studioTarget, title: outcome.title, lyrics: outcome.lyrics });
            toast({ title: 'Letra cargada 📝', description: 'Revisá la versión nueva y guardá los cambios.' });
          } else {
            // Desde el CTA del header: precargar el form
            // (queda abierto para revisar tags/género antes de guardar).
            setCreating(true);
            setPrefill(outcome);
            toast({ title: 'Letra cargada 📝', description: 'Revisala, ajustá lo que quieras y guardala.' });
          }
        }}
      />
    </section>
  );
}

/* Cápsula como la de los ítems del sidebar (design-V2): fondo terracota suave, ícono en un círculo de acento y texto en negrita.
   Con `edge` sale del borde izquierdo de la card (lado plano), como las cápsulas pegadas al borde de la barra lateral. */
function SourceBadge({ source, edge = false }: { source: 'MANUAL' | 'AI_GENERATED'; edge?: boolean }) {
  const Icon = source === 'MANUAL' ? FileText : Sparkles;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--m-capsule-tint)] py-0.5 pr-3 pl-0.5 text-xs font-bold text-foreground', edge && 'rounded-l-none pl-3')}>
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      {source === 'MANUAL' ? 'Escrita por vos' : 'Con Melodya'}
    </span>
  );
}

/* ── Editor de letra (crear / editar) ── */
function LyricFormDialog({
  open, onOpenChange, title, description, submitLabel, initial, prefill, pending, onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  initial?: UserLyric;
  /** Outcome del estudio de letras: se inyecta en el form sin cerrarlo. */
  prefill?: StudioOutcome | null;
  pending?: boolean;
  onSubmit: (body: { title: string; lyrics: string; genre?: string; tags: string[] }) => void;
}) {
  const [form, setForm] = useState({ title: '', lyrics: '', genre: '', tags: '' });

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        title: initial?.title ?? '',
        lyrics: initial?.lyrics ?? '',
        genre: initial?.genre ?? '',
        tags: initial?.tags.join(', ') ?? '',
      });
    }
  }, [open, initial]);

  // Letra traída del estudio (onApply): rellena título y letra, mantiene género/tags.
  // Deps solo [prefill]: si el form se vuelve a abrir (open cambia) NO se reaplica
  // un prefill viejo — el reset de arriba manda y el estudio lo refresca al aplicarlo.
  useEffect(() => {
    if (prefill) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm((f) => ({ ...f, title: prefill.title, lyrics: prefill.lyrics }));
    }
  }, [prefill]);

  const valid = form.title.trim().length > 0 && form.lyrics.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border/70 bg-surface sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onSubmit({
              title: form.title.trim(),
              lyrics: form.lyrics,
              genre: form.genre.trim() || undefined,
              tags: parseTagList(form.tags),
            });
          }}
        >
          <Field label="Título" htmlFor="lyric-title">
            <Input
              id="lyric-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Ej.: Verano en la azotea"
              maxLength={120}
              required
              autoFocus
            />
          </Field>

          <div className="space-y-1.5">
            <label htmlFor="lyric-body" className="text-sm font-medium text-foreground">
              Letra
            </label>
            <Textarea
              id="lyric-body"
              value={form.lyrics}
              onChange={(e) => setForm((f) => ({ ...f, lyrics: e.target.value }))}
              placeholder={'[verso]\nEscribí acá tu primera línea…\n\n[coro]\nY el estribillo que se te quedó cantando…'}
              className="min-h-[300px] resize-y rounded-xl bg-surface-2/60 font-mono text-sm leading-7"
              required
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Podés marcar las secciones entre corchetes: [verso], [coro], [puente]…
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Género" htmlFor="lyric-genre" optional>
              <Input
                id="lyric-genre"
                value={form.genre}
                onChange={(e) => setForm((f) => ({ ...f, genre: e.target.value }))}
                placeholder="Ej.: cumbia, balada…"
                maxLength={60}
              />
            </Field>
            <Field label="Etiquetas" htmlFor="lyric-tags" optional hint="Separadas por comas.">
              <Input
                id="lyric-tags"
                value={form.tags}
                onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                placeholder="nostalgia, amor, verano"
              />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" disabled={!valid || pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
