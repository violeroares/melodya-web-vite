
/**
 * MELODYA WEB — Biblioteca › Letristas (LyricPersonas).
 * Tus letristas personales inyectan estilo few-shot al asistente de letras.
 * Búsqueda server-side con debounce; referencias validadas por el backend.
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, MoreVertical, Music4, PenLine, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react';
import { songwritersApi, lyricsApi, songsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { toUserMessage } from '@/lib/errors';
import { useDebounce, formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { LOCK_REASON } from '@/lib/capabilities';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import type { LyricPersona, Song } from '@/types';
import { EmptyState, ErrorState, LoadingCards, SectionHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { ConfirmDialog, Field, LIST_MENU_COMFORTABLE_MOBILE, TabCtaButton, ViewToggle, useViewMode } from './library-utils';

export function SongwritersTab() {
  const personasGate = usePlanGate('LYRIC_PERSONAS'); // E5: sin letristas en el plan se muestra el aviso de upgrade
  const personasLocked = personasGate.locked;
  const [view, setView] = useViewMode('melodya:songwriters-view');
  const list = view === 'list';
  const qc = useQueryClient();
  const { toast } = useToast();
  const play = usePlayerStore((s) => s.play);
  const [playingPersona, setPlayingPersona] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 350);
  const [editing, setEditing] = useState<LyricPersona | null>(null);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<LyricPersona | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['songwriters', debouncedSearch],
    queryFn: () => songwritersApi.list({ search: debouncedSearch.trim() || undefined, pageSize: 50 }),
  });
  const songwriters = data?.items ?? [];

  const saveMutation = useMutation({
    mutationFn: (body: { name: string; description: string; lyricIds?: string[]; songIds?: string[] }) => songwritersApi.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['songwriters'] });
      toast({ title: 'Letrista creado', description: 'Ya podés elegirlo cuando generás letras.' });
      setCreating(false);
    },
    onError: (err) => toast({ title: 'No pudimos crear el letrista', description: toUserMessage(err), variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name: string; description: string; lyricIds: string[]; songIds: string[] } }) =>
      songwritersApi.update(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['songwriters'] });
      toast({ title: 'Letrista actualizado' });
      setEditing(null);
    },
    onError: (err) => toast({ title: 'No pudimos actualizar el letrista', description: toUserMessage(err), variant: 'destructive' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => songwritersApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['songwriters'] });
      toast({ title: 'Letrista enviado a la Papelera', description: 'Lo restaurás desde Biblioteca › Papelera.' });
      setToDelete(null);
    },
    onError: (err) => toast({ title: 'No pudimos eliminar el letrista', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* ── Reproducir la colección: trae cada canción referenciada (contrato real
     GET /songs/:id, máximo 20 referencias por colección) y arma la cola. ── */
  const playCollection = async (persona: LyricPersona) => {
    if (playingPersona) return;
    setPlayingPersona(persona.id);
    try {
      const artist = useAuthStore.getState().user?.name ?? 'Mi colección';
      const results = await Promise.allSettled(
        persona.songIds.slice(0, 20).map((id) => songsApi.get(id)),
      );
      const tracks: PlayerTrack[] = results
        .filter((r): r is PromiseFulfilledResult<Song> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((s) => apiFileUrl(s.currentVersion?.audioUrl ?? null))
        .map((s) => ({
          id: s.id,
          title: s.title,
          artist,
          coverUrl: apiFileUrl(s.coverUrl),
          audioUrl: apiFileUrl(s.currentVersion?.audioUrl ?? null) ?? '',
          durationSec: s.currentVersion?.durationSec ?? null,
          isPublic: s.visibility === 'PUBLIC',
          own: true,
        }));
      if (!tracks.length) {
        toast({
          title: 'Esta colección no se puede reproducir',
          description: 'Las canciones que la componen ya no tienen audio disponible.',
        });
        return;
      }
      const skipped = persona.songIds.length - tracks.length;
      play(tracks[0], tracks);
      toast({
        title: `Reproduciendo “${persona.name}”`,
        description: `${tracks.length} ${tracks.length === 1 ? 'canción en la cola' : 'canciones en la cola'}${skipped > 0 ? ` · ${skipped} ${skipped === 1 ? 'salteada' : 'salteadas'} sin audio` : ''}`,
      });
    } catch (err) {
      toast({ title: 'No pudimos armar la colección', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setPlayingPersona(null);
    }
  };

  return (
    <section aria-label="Tus letristas">
      <SectionHeader
        title="Letristas"
        subtitle="Estilos de escritura que Melodya imita cuando generás letras."
        hideSubtitleOnMobile
        action={
          <TabCtaButton icon={Plus} onClick={() => (personasLocked ? personasGate.prompt() : setCreating(true))} locked={personasLocked} badge={<RequiredPlanBadge capability="LYRIC_PERSONAS" />} title={personasLocked ? LOCK_REASON.LYRIC_PERSONAS : undefined}>
            Crear letrista
          </TabCtaButton>
        }
      />

      <div className="mb-5 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar letrista por nombre…"
            aria-label="Buscar letristas"
            className="h-11 rounded-full pl-9 text-sm font-normal"
          />
        </div>
        <ViewToggle view={view} onChange={setView} className="max-sm:hidden" />
      </div>

      {isLoading ? (
        <LoadingCards count={4} />
      ) : isError ? (
        <ErrorState message={toUserMessage(error)} onRetry={() => void refetch()} />
      ) : songwriters.length === 0 ? (
        search.trim() ? (
          <EmptyState
            icon={<Search className="h-7 w-7" />}
            title="No encontramos letristas."
            description="Probá con otro nombre."
            actionLabel="Ver todos"
            onAction={() => setSearch('')}
          />
        ) : (
          <EmptyState
            variant="studio"
            icon={<PenLine className="h-7 w-7" />}
            title="Todavía no tenés letristas."
            description="Creá estilos propios: cómo escribe, su tono y sus reglas. Melodya los usa como referencia."
            actionLabel="Crear mi primer letrista"
            onAction={() => setCreating(true)}
          />
        )
      ) : (
        <div className={cn(list ? 'flex flex-col gap-2' : 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3')}>
          {songwriters.map((persona) => (
            <article
              key={persona.id}
              className={cn(
                'group relative flex h-full flex-col rounded-cover border border-border/70 bg-surface p-4 transition-colors hover:border-amber/40',
                list && 'p-3 sm:flex-row sm:items-center sm:gap-4 sm:pr-14'
              )}
            >
              <div className={cn('flex items-start gap-3 pr-10', list && 'sm:w-64 sm:shrink-0 sm:items-center sm:pr-0')}>
                <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-element-lyrics text-[#131C33]" aria-hidden>
                  <PenLine className="h-[22px] w-[22px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-foreground">{persona.name}</h3>
                  <p className="text-xs text-muted-foreground">Creado {formatRelative(persona.createdAt)}</p>
                </div>
              </div>
              <p className={cn('mt-3 line-clamp-3 min-h-14 text-sm leading-snug text-muted-foreground', list && 'mt-2 min-h-0 line-clamp-2 sm:mt-0 sm:flex-1')}>
                {persona.description}
              </p>
              <div className={cn('mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3', list && 'sm:mt-0 sm:w-[22rem] sm:shrink-0 sm:flex-nowrap sm:border-t-0 sm:pt-0')}>
                {persona.songIds.length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => void playCollection(persona)}
                    disabled={playingPersona !== null}
                    className="persona-play h-8 gap-1.5 rounded-full gradient-warm px-3 text-xs font-bold text-primary-foreground hover:text-primary-foreground disabled:opacity-60"
                    aria-label={`Reproducir la colección ${persona.name} (${persona.songIds.length} ${persona.songIds.length === 1 ? 'canción' : 'canciones'})`}
                    title="Reproducir las canciones de esta colección"
                  >
                    {playingPersona === persona.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Play className="h-3.5 w-3.5 translate-x-px fill-current" aria-hidden />
                    )}
                    Colección
                  </Button>
                )}
                {persona.lyricIds.length > 0 && (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <FileText className="h-3 w-3" aria-hidden /> {persona.lyricIds.length} {persona.lyricIds.length === 1 ? 'letra ref.' : 'letras ref.'}
                  </span>
                )}
                {persona.songIds.length > 0 && (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <Music4 className="h-3 w-3" aria-hidden /> {persona.songIds.length} {persona.songIds.length === 1 ? 'canción ref.' : 'canciones ref.'}
                  </span>
                )}
                {persona.lyricIds.length === 0 && persona.songIds.length === 0 && (
                  <span className="text-xs text-muted-foreground">Sin referencias</span>
                )}
              </div>

              {/* Opciones (editar / eliminar): arriba a la derecha, como en Letras */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Opciones de ${persona.name}`}
                    className={cn(
                      'absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground',
                      list && 'sm:top-1/2 sm:-translate-y-1/2'
                    )}
                  >
                    <MoreVertical className="h-4 w-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
                  <DropdownMenuItem onClick={() => setEditing(persona)}>
                    <Pencil className="h-4 w-4" aria-hidden /> Editar
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setToDelete(persona)} className="text-destructive focus:text-destructive">
                    <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </article>
          ))}
        </div>
      )}

      <SongwriterFormDialog
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o) { setCreating(false); setEditing(null); }
        }}
        title={editing ? 'Editar letrista' : 'Crear letrista'}
        initial={editing ?? undefined}
        pending={saveMutation.isPending || updateMutation.isPending}
        onSubmit={(body) => {
          if (editing) updateMutation.mutate({ id: editing.id, body });
          else saveMutation.mutate(body);
        }}
      />

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`¿Enviar a "${toDelete?.name ?? ''}" a la Papelera?`}
        actionLabel="Enviar a la Papelera"
        description="Deja de estar disponible para generar letras, pero se conserva con sus referencias: lo restaurás desde la Papelera. Tus letras y canciones no cambian."
        onConfirm={() => toDelete && removeMutation.mutate(toDelete.id)}
        pending={removeMutation.isPending}
      />
    </section>
  );
}

/* ── Form letrista (crear / editar) con referencias few-shot ── */
function SongwriterFormDialog({
  open, onOpenChange, title, initial, pending, onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial?: LyricPersona;
  pending?: boolean;
  onSubmit: (body: { name: string; description: string; lyricIds: string[]; songIds: string[] }) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lyricIds, setLyricIds] = useState<string[]>([]);
  const [songIds, setSongIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
      setLyricIds(initial?.lyricIds ?? []);
      setSongIds(initial?.songIds ?? []);
    }
  }, [open, initial]);

  // Referencias disponibles (solo se cargan con el diálogo abierto)
  const lyricsQuery = useQuery({
    queryKey: ['lyrics', 'refs'],
    queryFn: () => lyricsApi.list({ pageSize: 50 }),
    enabled: open,
  });
  const songsQuery = useQuery({
    queryKey: ['songs'],
    queryFn: () => songsApi.list({ pageSize: 50 }),
    enabled: open,
  });

  const valid = name.trim().length >= 2 && description.trim().length > 0;

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Alto ajustado a la pantalla: el encabezado y los botones quedan fijos y solo el cuerpo con los campos se desplaza */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden border-border/70 bg-surface p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 pr-20">
          <DialogTitle className="font-display">{title}</DialogTitle>
          <DialogDescription>
            Un letrista define cómo escribe Melodya: su estilo, su tono y sus manías.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onSubmit({ name: name.trim(), description: description.trim(), lyricIds, songIds });
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
          <Field label="Nombre" htmlFor="persona-name">
            <Input
              id="persona-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej.: El poeta del conurbano"
              maxLength={80}
              required
              autoFocus
            />
          </Field>

          <Field
            label="Descripción"
            htmlFor="persona-desc"
            hint="Describí su estilo, tono y reglas (máx 500)."
          >
            <Textarea
              id="persona-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Escribe en primera persona, con imágenes cotidianas del barrio, rimas simples y un dejo de nostalgia…"
              maxLength={500}
              className="min-h-24 sm:min-h-28"
              required
            />
            <p className="text-right text-xs text-muted-foreground">{description.length}/500</p>
          </Field>

          <Field label="Letras de referencia" optional hint="Melodya toma estas letras como ejemplo de estilo.">
            <ScrollArea className="h-28 overflow-hidden rounded-xl sm:h-36 border border-border/70 bg-surface-2/50 p-2">
              {lyricsQuery.isLoading ? (
                <p className="p-2 text-sm text-muted-foreground">Cargando tus letras…</p>
              ) : (lyricsQuery.data?.items ?? []).length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">Todavía no tenés letras guardadas.</p>
              ) : (
                <ul className="space-y-1">
                  {lyricsQuery.data!.items.map((lyric) => (
                    <li key={lyric.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
                        <Checkbox
                          checked={lyricIds.includes(lyric.id)}
                          onCheckedChange={() => setLyricIds((l) => toggle(l, lyric.id))}
                          aria-label={`Referencia: ${lyric.title}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{lyric.title}</span>
                        <span className="text-xs text-muted-foreground">{lyric.genre ?? ''}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </Field>

          <Field label="Canciones de referencia" optional hint="El ritmo y la temática de estas canciones también inspiran al letrista.">
            <ScrollArea className="h-28 overflow-hidden rounded-xl sm:h-36 border border-border/70 bg-surface-2/50 p-2">
              {songsQuery.isLoading ? (
                <p className="p-2 text-sm text-muted-foreground">Cargando tus canciones…</p>
              ) : (songsQuery.data?.items ?? []).length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">Todavía no tenés canciones.</p>
              ) : (
                <ul className="space-y-1">
                  {songsQuery.data!.items.map((song) => (
                    <li key={song.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
                        <Checkbox
                          checked={songIds.includes(song.id)}
                          onCheckedChange={() => setSongIds((l) => toggle(l, song.id))}
                          aria-label={`Referencia: ${song.title}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{song.title}</span>
                        {song.currentVersion?.genre && (
                          <span className="text-xs text-muted-foreground">{song.currentVersion.genre}</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </Field>
          </div>

          <DialogFooter className="shrink-0 border-t border-[var(--m-separator)] px-6 pt-3 pb-3">
            <Button type="button" variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" disabled={!valid || pending}>
              {initial ? 'Guardar cambios' : 'Crear letrista'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
