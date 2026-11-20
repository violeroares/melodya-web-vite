
/**
 * MELODYA WEB — Biblioteca › Proyectos.
 * BACKEND GAP: GET /projects no expone búsqueda (solo paginación) → sin filtro aquí.
 * Borrar un proyecto NO borra sus canciones (contrato del backend).
 * Portada: POST /projects/:id/cover (multipart, imágenes, máx 5 MB — contrato real).
 * Miembros: PATCH /songs/:id { projectId } — soportado por el backend (v0.14):
 * valida que la canción sea del usuario y que el proyecto exista.
 * Portada en cards: el backend devuelve coverFile {id} → la capa api (mapProject)
 * arma coverUrl = /api/files/:id/stream.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FolderOpen, ImagePlus, ListMusic, MoreVertical, Pause, Pencil, Play, PlayCircle, Plus, Search, Trash2, X,
} from 'lucide-react';
import { projectsApi, songsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { toUserMessage } from '@/lib/errors';
import { usePlayerStore } from '@/stores/player';
import { formatDuration, formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import type { Project, Song } from '@/types';
import { cn } from '@/lib/utils';
import { CoverArt, EmptyState, ErrorState, LoadingCards, SectionHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConfirmDialog, Field, InlineError, LIST_MENU_COMFORTABLE_MOBILE, TabCtaButton } from './library-utils';

const MAX_COVER_BYTES = 5 * 1024 * 1024; // mismo límite que el backend real
/** Canciones del usuario para los selectores (compartido entre form y picker). */
const USER_SONGS_KEY = ['songs', 'project-form'] as const;

/** Lo que el formulario entrega al guardar (incluye el diff de canciones). */
interface ProjectFormSubmit {
  body: { name: string; description?: string };
  cover: File | null;
  songIds: string[];
  /** selected − actuales (en create == songIds). */
  added: string[];
  /** actuales − selected (en create == []). */
  removed: string[];
}

/** Fallos "blandos" de un flujo multi-paso: no frenan el paso principal. */
interface FlowOutcome {
  coverError: unknown | null;
  songFailErrors: unknown[];
}

type ToastFn = ReturnType<typeof useToast>['toast'];

/** Un solo toast por concepto (portada / canciones), con mensaje del primer error. */
function announceFlowIssues(outcome: FlowOutcome, kind: 'add' | 'edit', toast: ToastFn) {
  if (outcome.coverError) {
    toast({ title: 'No pudimos guardar la portada', description: toUserMessage(outcome.coverError), variant: 'destructive' });
  }
  if (outcome.songFailErrors.length > 0) {
    const f = outcome.songFailErrors.length;
    const detail =
      kind === 'add'
        ? `${f} ${f === 1 ? 'canción no se agregó' : 'canciones no se agregaron'}`
        : `${f} ${f === 1 ? 'cambio no se aplicó' : 'cambios no se aplicaron'}`;
    toast({
      title: 'No pudimos actualizar algunas canciones',
      description: `${detail} · ${toUserMessage(outcome.songFailErrors[0])}`,
      variant: 'destructive',
    });
  }
}

export function ProjectsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [toDelete, setToDelete] = useState<Project | null>(null);
  const [openProject, setOpenProject] = useState<Project | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsApi.list({ pageSize: 50 }),
  });
  const projects = data?.items ?? [];

  /* Crear: proyecto → portada → canciones. Cada paso blando falla solo con toast. */
  const createMutation = useMutation({
    mutationFn: async ({ body, cover, songIds }: { body: { name: string; description?: string }; cover: File | null; songIds: string[] }) => {
      const project = await projectsApi.create(body);
      const outcome: FlowOutcome = { coverError: null, songFailErrors: [] };
      if (cover) {
        try {
          await projectsApi.uploadCover(project.id, cover);
        } catch (err) {
          outcome.coverError = err;
        }
      }
      if (songIds.length > 0) {
        const results = await Promise.allSettled(songIds.map((id) => songsApi.update(id, { projectId: project.id })));
        outcome.songFailErrors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason);
      }
      return { outcome, songsAdded: songIds.length - outcome.songFailErrors.length };
    },
    onSuccess: ({ outcome, songsAdded }) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      if (songsAdded > 0) void qc.invalidateQueries({ queryKey: ['songs'] });
      setCreateOpen(false);
      toast({
        title:
          songsAdded > 0
            ? `Proyecto creado y ${songsAdded} ${songsAdded === 1 ? 'canción agregada' : 'canciones agregadas'}`
            : 'Proyecto creado',
        description: songsAdded > 0 ? undefined : 'Ya podés guardar tus canciones ahí.',
      });
      announceFlowIssues(outcome, 'add', toast);
    },
    onError: (err) => toast({ title: 'No pudimos crear el proyecto', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* Editar (nombre/descripción/portada + diff de canciones). */
  const updateMutation = useMutation({
    mutationFn: async ({ id, body, cover, added, removed }: {
      id: string;
      body: { name: string; description?: string };
      cover: File | null;
      added: string[];
      removed: string[];
    }) => {
      await projectsApi.update(id, body);
      const outcome: FlowOutcome & { addOk: number; removeOk: number } = { coverError: null, songFailErrors: [], addOk: 0, removeOk: 0 };
      if (cover) {
        try {
          await projectsApi.uploadCover(id, cover);
        } catch (err) {
          outcome.coverError = err;
        }
      }
      if (added.length + removed.length > 0) {
        const [addRes, removeRes] = await Promise.all([
          Promise.allSettled(added.map((sid) => songsApi.update(sid, { projectId: id }))),
          Promise.allSettled(removed.map((sid) => songsApi.update(sid, { projectId: null }))),
        ]);
        outcome.addOk = addRes.filter((r) => r.status === 'fulfilled').length;
        outcome.removeOk = removeRes.filter((r) => r.status === 'fulfilled').length;
        outcome.songFailErrors = [...addRes, ...removeRes]
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason);
      }
      return outcome;
    },
    onSuccess: (outcome, vars) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      if (vars.added.length + vars.removed.length > 0) {
        void qc.invalidateQueries({ queryKey: ['songs'] });
        void qc.invalidateQueries({ queryKey: ['project-songs', vars.id] });
      }
      setEditing(null);
      const summary: string[] = [];
      if (vars.cover && !outcome.coverError) summary.push('Portada actualizada');
      if (outcome.addOk > 0) summary.push(`${outcome.addOk} ${outcome.addOk === 1 ? 'agregada' : 'agregadas'}`);
      if (outcome.removeOk > 0) summary.push(`${outcome.removeOk} ${outcome.removeOk === 1 ? 'quitada' : 'quitadas'}`);
      toast({ title: 'Proyecto actualizado', description: summary.length > 0 ? summary.join(' · ') : undefined });
      announceFlowIssues(outcome, 'edit', toast);
    },
    onError: (err) => toast({ title: 'No pudimos actualizar el proyecto', description: toUserMessage(err), variant: 'destructive' }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => projectsApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      toast({ title: 'Proyecto enviado a la Papelera', description: 'Tus canciones siguen intactas en Canciones.' });
      setToDelete(null);
    },
    onError: (err) => toast({ title: 'No pudimos eliminar el proyecto', description: toUserMessage(err), variant: 'destructive' }),
  });

  return (
    <section aria-label="Tus proyectos">
      <SectionHeader
        title="Proyectos"
        subtitle="Espacios para agrupar canciones por idea, disco o momento."
        hideSubtitleOnMobile
        action={
          <TabCtaButton icon={Plus} onClick={() => setCreateOpen(true)}>
            Nuevo proyecto
          </TabCtaButton>
        }
      />

      {isLoading ? (
        <LoadingCards count={6} cover className="gap-x-3 gap-y-[18px]" />
      ) : isError ? (
        <ErrorState message={toUserMessage(error)} onRetry={() => void refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState
          variant="studio"
          icon={<ListMusic className="h-7 w-7" />}
          title="Todavía no tenés proyectos."
          description="Organizá tus canciones en espacios: un EP, una playlist conceptual, lo que se te ocurra."
          actionLabel="Crear mi primer proyecto"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-[18px] sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {projects.map((project) => (
            /* Mismo estilo que las tarjetas de Canciones: portada con esquinas 28/28/14/14, título en una línea, metadatos chicos
               debajo y el menú de opciones a la derecha del texto. */
            <article key={project.id} className="lift group flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setOpenProject(project)}
                aria-label={`Abrir proyecto ${project.name}`}
                className="block w-full cursor-pointer rounded-[28px_28px_14px_14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CoverArt id={project.id} src={project.coverUrl ?? null} alt="" className="aspect-square w-full transition-transform duration-300" rounded="rounded-[28px_28px_14px_14px]" />
              </button>

              <div className="flex min-w-0 items-start gap-1">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setOpenProject(project)}
                    className="block w-full min-w-0 cursor-pointer rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label={`Abrir proyecto ${project.name}`}
                  >
                    <h3 className="truncate text-[15px] leading-tight font-semibold text-foreground">{project.name}</h3>
                  </button>
                  <p className="line-clamp-2 text-[12.5px] leading-[1.3] text-muted-foreground">{project.description || 'Sin descripción'}</p>
                  <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 text-xs tabular-nums text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <ListMusic className="h-3.5 w-3.5" aria-hidden />
                      {project.songsCount ?? 0} {project.songsCount === 1 ? 'canción' : 'canciones'}
                    </span>
                    <span>{formatRelative(project.updatedAt)}</span>
                  </p>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Opciones de ${project.name}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MoreVertical className="h-4 w-4" aria-hidden />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" variant="list" className={LIST_MENU_COMFORTABLE_MOBILE}>
                    <DropdownMenuItem onClick={() => setOpenProject(project)}>
                      <FolderOpen className="h-4 w-4 text-amber-strong" aria-hidden /> Abrir
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEditing(project)}>
                      <Pencil className="h-4 w-4" aria-hidden /> Editar
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setToDelete(project)} className="text-destructive focus:text-destructive">
                      <Trash2 className="h-4 w-4" aria-hidden /> Enviar a la Papelera
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </article>
          ))}
        </div>
      )}

      <ProjectFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Nuevo proyecto"
        description="Un espacio para agrupar canciones: un EP, un concepto, una época."
        submitLabel="Crear proyecto"
        pending={createMutation.isPending}
        onSubmit={({ body, cover, songIds }) => createMutation.mutate({ body, cover, songIds })}
      />
      <ProjectFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Editar proyecto"
        description="Cambiá el nombre, la portada o las canciones cuando quieras."
        submitLabel="Guardar cambios"
        initial={editing ?? undefined}
        pending={updateMutation.isPending}
        onSubmit={({ body, cover, added, removed }) => editing && updateMutation.mutate({ id: editing.id, body, cover, added, removed })}
      />

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`¿Enviar "${toDelete?.name ?? ''}" a la Papelera?`}
        actionLabel="Enviar a la Papelera"
        description="El proyecto sale de tu biblioteca, pero tus canciones no se mueven: las seguís viendo en Canciones. Lo restaurás desde la Papelera."
        onConfirm={() => toDelete && removeMutation.mutate(toDelete.id)}
        pending={removeMutation.isPending}
      />

      <ProjectSongsSheet project={openProject} onClose={() => setOpenProject(null)} />
    </section>
  );
}

/* ── Formulario crear/editar (portada + canciones) ── */

interface ProjectFormState {
  name: string;
  desc: string;
  cover: File | null;
  previewUrl: string | null;
  /** El usuario tocó la selección: congelamos su lista; si no, espeja las actuales. */
  touched: boolean;
  selected: ReadonlySet<string>;
}

function ProjectFormDialog({
  open, onOpenChange, title, description, submitLabel, initial, pending, onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  initial?: Project;
  pending?: boolean;
  onSubmit: (payload: ProjectFormSubmit) => void;
}) {
  const { toast } = useToast();
  const isEdit = !!initial;
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<ProjectFormState>({ name: '', desc: '', cover: null, previewUrl: null, touched: false, selected: new Set() });

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        name: initial?.name ?? '',
        desc: initial?.description ?? '',
        cover: null,
        previewUrl: null,
        touched: false,
        selected: new Set(),
      });
    }
  }, [open, initial]);

  /* Liberar el objectURL anterior al cambiar la preview (y al desmontar). */
  const previewUrl = form.previewUrl;
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  /* Canciones del usuario (compartido con el picker del sheet vía queryKey). */
  const userSongsQuery = useQuery({
    queryKey: USER_SONGS_KEY,
    queryFn: () => songsApi.list({ pageSize: 50 }),
    enabled: open,
  });
  /* En edición: actuales del proyecto para preseleccionar y calcular el diff. */
  const projectSongsQuery = useQuery({
    queryKey: ['project-songs', initial?.id],
    queryFn: () => projectsApi.songs(initial!.id, { pageSize: 50 }),
    enabled: open && isEdit,
  });

  const userSongs = userSongsQuery.data?.items ?? [];
  const baseIds = useMemo(
    () => new Set((projectSongsQuery.data?.items ?? []).map((s) => s.id)),
    [projectSongsQuery.data]
  );
  const effectiveSelected = form.touched ? form.selected : baseIds;

  const valid = form.name.trim().length >= 2;
  /* Al editar, guardar solo se habilita si cambió algo: nombre, descripción, portada o canciones elegidas */
  const sameSongs = effectiveSelected.size === baseIds.size && [...effectiveSelected].every((id) => baseIds.has(id));
  const dirty = !isEdit
    || form.name.trim() !== (initial?.name ?? '')
    || form.desc.trim() !== (initial?.description ?? '').trim()
    || form.cover !== null
    || !sameSongs;
  const canSubmit = valid && dirty && !pending;
  /* Mientras cargan las actuales no se listan filas → no hay diff falso al guardar. */
  const songsLoading = userSongsQuery.isLoading || (isEdit && projectSongsQuery.isLoading);

  const pickCover = (file: File | null) => {
    if (file && file.size > MAX_COVER_BYTES) {
      toast({ title: 'La portada es demasiado grande', description: 'Elegí una imagen de hasta 5 MB.', variant: 'destructive' });
      return;
    }
    setForm((f) => ({ ...f, cover: file, previewUrl: file ? URL.createObjectURL(file) : null }));
  };

  const toggleSong = (id: string) => {
    const next = new Set(form.touched ? form.selected : baseIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setForm((f) => ({ ...f, touched: true, selected: next }));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const eff = form.touched ? form.selected : baseIds;
    onSubmit({
      body: { name: form.name.trim(), description: form.desc.trim() || undefined },
      cover: form.cover,
      songIds: [...eff],
      added: [...eff].filter((id) => !baseIds.has(id)),
      removed: [...baseIds].filter((id) => !eff.has(id)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto overflow-x-hidden border-border/70 bg-surface max-sm:max-h-[96dvh] max-sm:p-4 sm:max-w-lg sm:gap-4">
        <DialogHeader className="max-sm:min-h-11 max-sm:justify-center">
          <DialogTitle className="font-display">{title}</DialogTitle>
          <DialogDescription className="max-sm:sr-only">{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 max-sm:space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          {/* Portada (opcional, 16:9 — mismo lenguaje que el picker de samples) */}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              pickCover(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          <div className="relative">
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              aria-label={form.cover ? 'Cambiar la portada elegida' : 'Elegir portada del proyecto'}
              className={cn(
                'flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-4 overflow-hidden rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed p-6 text-center transition-colors max-sm:aspect-auto max-sm:h-20 max-sm:flex-row max-sm:gap-3 max-sm:p-3 max-sm:text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
                form.cover || initial?.coverUrl ? 'border-amber/50 bg-amber/5 p-0' : 'border-line bg-[var(--m-input)] hover:border-amber/40'
              )}
            >
              {form.cover && form.previewUrl ? (
                <img src={form.previewUrl} alt="Vista previa de la portada" className="h-full w-full object-cover" />
              ) : !form.cover && initial?.coverUrl ? (
                <CoverArt id={initial.id} src={initial.coverUrl} alt="Portada actual del proyecto" className="h-full w-full" rounded="rounded-none" />
              ) : (
                <>
                  {/* Núcleo de voz (igual que el estado vacío del Estudio de letras): aro tenue y círculo de voz con el ícono dorado */}
                  <span aria-hidden className="relative block size-24 shrink-0 max-sm:size-12">
                    <svg className="absolute inset-0 size-full" viewBox="0 0 96 96" fill="none">
                      <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
                    </svg>
                    <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
                      <ImagePlus className="h-[26px] w-[26px] text-gold max-sm:h-4 max-sm:w-4" />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col items-center gap-4 max-sm:items-start max-sm:gap-0.5">
                    <span className="max-w-[250px] font-display text-[19px] leading-tight font-semibold text-foreground max-sm:text-base">Portada del proyecto (opcional)</span>
                    <span className="max-w-xs text-sm text-muted-foreground max-sm:text-xs">Tocá para elegir una imagen · hasta 5 MB</span>
                  </span>
                </>
              )}
            </button>
            {form.cover && (
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, cover: null, previewUrl: null }))}
                aria-label="Quitar la portada elegida"
                className="absolute top-2 right-2 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground transition-colors hover:bg-background"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>

          <Field label="Nombre" htmlFor="project-name">
            <Input
              id="project-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Ej.: Cumbias del verano"
              maxLength={80}
              required
              autoFocus
              className="max-sm:h-11"
            />
          </Field>
          <Field label="Descripción" htmlFor="project-desc" optional>
            <Textarea
              id="project-desc"
              value={form.desc}
              onChange={(e) => setForm((f) => ({ ...f, desc: e.target.value }))}
              placeholder="¿Qué une a estas canciones?"
              maxLength={500}
              className="min-h-24 max-sm:min-h-14"
            />
          </Field>

          <Field label="Canciones del proyecto" hint="Elegís cuáles de tus canciones viven en este espacio.">
            {songsLoading ? (
              <SongRowsSkeleton />
            ) : userSongsQuery.isError ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                No pudimos cargar tus canciones ({toUserMessage(userSongsQuery.error)}). El proyecto se guarda igual.
              </p>
            ) : isEdit && projectSongsQuery.isError ? (
              <div className="space-y-2">
                <InlineError message="No pudimos cargar las canciones actuales del proyecto; al guardar no se quita ninguna." />
                <SongCheckList songs={userSongs} selected={effectiveSelected} onToggle={toggleSong} idPrefix="project-form" />
              </div>
            ) : userSongs.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Todavía no tenés canciones. Generá la primera y después la sumás al proyecto.
              </p>
            ) : (
              <SongCheckList songs={userSongs} selected={effectiveSelected} onToggle={toggleSong} idPrefix="project-form" />
            )}
          </Field>

          {/* Mismos botones que el modal de agregar canciones: una fila, centrados, contorno fino */}
          <DialogFooter className="flex-row justify-center gap-2 sm:justify-center">
            <Button type="button" variant="outline" className="rounded-full border-[1.5px] border-line bg-transparent text-[13.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:border-solid max-sm:flex-1 max-sm:px-3 max-sm:text-[13px]" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant={canSubmit ? 'default' : 'outline'}
              className={cn(
                canSubmit
                  ? 'rounded-full gradient-warm text-[13.5px] font-bold text-primary-foreground hover:text-primary-foreground max-sm:flex-1 max-sm:px-3 max-sm:text-[13px]'
                  : 'rounded-full border-[1.5px] border-line bg-transparent text-[13.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:border-transparent max-sm:flex-1 max-sm:px-3 max-sm:text-[13px]'
              )}
              disabled={!canSubmit}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Picker de canciones (Dialog reutilizado por el sheet del proyecto) ── */

function SongPickerDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [state, setState] = useState<{ touched: boolean; selected: ReadonlySet<string> }>({ touched: false, selected: new Set() });

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ touched: false, selected: new Set() });
    }
  }, [open]);

  const userSongsQuery = useQuery({
    queryKey: USER_SONGS_KEY,
    queryFn: () => songsApi.list({ pageSize: 50 }),
    enabled: open,
  });
  /* Misma key que el sheet → preselección desde caché sin request extra. */
  const projectSongsQuery = useQuery({
    queryKey: ['project-songs', project.id],
    queryFn: () => projectsApi.songs(project.id, { pageSize: 50 }),
    enabled: open,
  });

  const userSongs = userSongsQuery.data?.items ?? [];
  const currentIds = useMemo(
    () => new Set((projectSongsQuery.data?.items ?? []).map((s) => s.id)),
    [projectSongsQuery.data]
  );
  const effective = state.touched ? state.selected : currentIds;

  const toggleSong = (id: string) => {
    const next = new Set(state.touched ? state.selected : currentIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setState({ touched: true, selected: next });
  };

  const hasChanges =
    [...effective].some((id) => !currentIds.has(id)) || [...currentIds].some((id) => !effective.has(id));

  /* Aplica el diff (agregadas + quitadas) con allSettled: un toast por concepto. */
  const saveMutation = useMutation({
    mutationFn: async (): Promise<FlowOutcome & { addOk: number; removeOk: number }> => {
      const added = [...effective].filter((id) => !currentIds.has(id));
      const removed = [...currentIds].filter((id) => !effective.has(id));
      const [addRes, removeRes] = await Promise.all([
        Promise.allSettled(added.map((id) => songsApi.update(id, { projectId: project.id }))),
        Promise.allSettled(removed.map((id) => songsApi.update(id, { projectId: null }))),
      ]);
      return {
        coverError: null,
        addOk: addRes.filter((r) => r.status === 'fulfilled').length,
        removeOk: removeRes.filter((r) => r.status === 'fulfilled').length,
        songFailErrors: [...addRes, ...removeRes]
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason),
      };
    },
    onSuccess: (outcome) => {
      void qc.invalidateQueries({ queryKey: ['project-songs', project.id] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['songs'] });
      onOpenChange(false);
      const summary: string[] = [];
      if (outcome.addOk > 0) summary.push(`${outcome.addOk} ${outcome.addOk === 1 ? 'agregada' : 'agregadas'}`);
      if (outcome.removeOk > 0) summary.push(`${outcome.removeOk} ${outcome.removeOk === 1 ? 'quitada' : 'quitadas'}`);
      if (summary.length > 0) toast({ title: 'Canciones actualizadas', description: summary.join(' · ') });
      announceFlowIssues(outcome, 'edit', toast);
    },
    onError: (err) => toast({ title: 'No pudimos actualizar las canciones', description: toUserMessage(err), variant: 'destructive' }),
  });

  const loading = userSongsQuery.isLoading || projectSongsQuery.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto overflow-x-hidden grid-cols-[minmax(0,1fr)] border-border/70 bg-surface sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Canciones de “{project.name}”</DialogTitle>
          <DialogDescription>Elegís cuáles de tus canciones viven en este espacio.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!hasChanges || saveMutation.isPending) return;
            saveMutation.mutate();
          }}
        >
          {loading ? (
            <SongRowsSkeleton />
          ) : userSongsQuery.isError || projectSongsQuery.isError ? (
            <div>
              <InlineError message={toUserMessage(userSongsQuery.error ?? projectSongsQuery.error)} />
              <Button
                variant="outline"
                size="sm"
                className="mt-3 rounded-full"
                onClick={() => {
                  void userSongsQuery.refetch();
                  void projectSongsQuery.refetch();
                }}
              >
                Reintentar
              </Button>
            </div>
          ) : userSongs.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Todavía no tenés canciones para agregar. Generá la primera desde Crear y volvé acá.
            </p>
          ) : (
            <SongCheckList songs={userSongs} selected={effective} onToggle={toggleSong} idPrefix={`picker-${project.id}`} />
          )}

          {/* Botones en una sola fila y centrados, con el estilo de «Reproducir todo» (contorno fino); el deshabilitado se ve igual, atenuado */}
          <DialogFooter className="flex-row justify-center gap-2 sm:justify-center">
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-[1.5px] border-line bg-transparent text-[13.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:border-solid max-sm:flex-1 max-sm:px-3 max-sm:text-[13px]"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant={hasChanges && !saveMutation.isPending ? 'default' : 'outline'}
              className={cn(
                hasChanges && !saveMutation.isPending
                  ? 'rounded-full gradient-warm text-[13.5px] font-bold text-primary-foreground hover:text-primary-foreground max-sm:flex-1 max-sm:px-3 max-sm:text-[13px]'
                  : 'rounded-full border-[1.5px] border-line bg-transparent text-[13.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:border-transparent max-sm:flex-1 max-sm:px-3 max-sm:text-[13px]'
              )}
              disabled={!hasChanges || saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <span className="mr-1 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" aria-hidden />
              )}
              Guardar cambios
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Lista con checkboxes: portada + título + duración (buscable) ── */

function SongCheckList({ songs, selected, onToggle, idPrefix }: {
  songs: Song[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  idPrefix: string;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? songs.filter((s) => s.title.toLowerCase().includes(q)) : songs;
  }, [songs, search]);

  return (
    <div className="space-y-2">
      {songs.length > 6 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por título…"
            aria-label="Buscar entre tus canciones"
            className="h-11 pl-9 text-sm font-normal"
          />
        </div>
      )}
      {/* Lista como la de Biblioteca (design-V2 `lcard`/`lrow`): tarjeta con esquinas 28/28/14/14, filas con portada circular,
          título + duración y, a la derecha, el checkbox de selección. La elegida lleva el aro de acento en la portada. */}
      <div className="overflow-hidden rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] py-1.5">
      <ScrollArea type="always" className="max-h-72 max-sm:max-h-28 [&_[data-slot=scroll-area-viewport]]:max-h-72 max-sm:[&_[data-slot=scroll-area-viewport]]:max-h-28 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden! [&_[data-slot=scroll-area-viewport]>div]:block!">
      <ul aria-label="Tus canciones">
        {filtered.map((song) => {
          const on = selected.has(song.id);
          const cbId = `${idPrefix}-${song.id}`;
          return (
            <li key={song.id} className="border-b border-border/60 last:border-b-0">
              <label
                htmlFor={cbId}
                className={cn(
                  'flex h-[68px] cursor-pointer items-center gap-3.5 pr-3 pl-4 transition-colors hover:bg-surface-2/50 max-sm:h-14 max-sm:gap-3 max-sm:pl-3',
                  on && 'bg-amber/5'
                )}
              >
                <CoverArt
                  id={song.id}
                  src={song.coverUrl}
                  alt=""
                  className={cn('size-[52px] shrink-0 max-sm:size-10', on && 'ring-2 ring-primary ring-offset-2 ring-offset-[var(--m-input)]')}
                  rounded="rounded-full"
                />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-display text-base font-bold text-foreground">{song.title}</span>
                  <span className="text-[13px] text-muted-foreground">{formatDuration(song.currentVersion?.durationSec)}</span>
                </span>
                {/* Casillero como el «Automático» de Creatividad: círculo con borde dorado que se rellena con el visto al elegir */}
                <Checkbox
                  id={cbId}
                  checked={on}
                  onCheckedChange={() => onToggle(song.id)}
                  className="size-8 shrink-0 rounded-full border-gold bg-transparent data-[state=checked]:border-gold data-[state=checked]:bg-gold data-[state=checked]:text-[#131C33] [&_svg]:size-4 [&_svg]:stroke-[3]"
                />
              </label>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            {songs.length === 0 ? 'Todavía no tenés canciones.' : 'Ninguna canción coincide con la búsqueda.'}
          </li>
        )}
      </ul>
      </ScrollArea>
      </div>
      <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
        {selected.size} {selected.size === 1 ? 'seleccionada' : 'seleccionadas'}
      </p>
    </div>
  );
}

/* ── Skeleton de filas mientras cargan las canciones ── */
function SongRowsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-busy="true" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl p-2">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-surface-2" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Canciones del proyecto (Sheet con reproductor) ── */
function ProjectSongsSheet({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const play = usePlayerStore((s) => s.play);
  const currentId = usePlayerStore((s) => s.track?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['project-songs', project?.id],
    queryFn: () => projectsApi.songs(project!.id, { pageSize: 50 }),
    enabled: !!project,
  });
  const songs: Song[] = data?.items ?? [];

  /* Quitar del proyecto ≠ borrar: solo desasigna la canción (PATCH projectId null). */
  const removeSongMutation = useMutation({
    mutationFn: (songId: string) => songsApi.update(songId, { projectId: null }),
    onSuccess: () => {
      const pid = project?.id;
      if (pid) {
        void qc.invalidateQueries({ queryKey: ['project-songs', pid] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
        void qc.invalidateQueries({ queryKey: ['songs'] });
      }
      toast({ title: 'Quitada del proyecto', description: 'La canción sigue en tu biblioteca.' });
    },
    onError: (err) => toast({ title: 'No pudimos quitar la canción', description: toUserMessage(err), variant: 'destructive' }),
  });

  /* Cola del proyecto: canciones con audio listo (para "Reproducir todo" y salto automático) */
  const queue = useMemo(
    () =>
      songs
        .filter((s) => s.currentVersion?.audioUrl)
        .map((s) => ({
          id: s.id,
          title: s.title,
          artist: 'Vos',
          coverUrl: apiFileUrl(s.coverUrl),
          audioUrl: apiFileUrl(s.currentVersion?.audioUrl) ?? '',
          durationSec: s.currentVersion?.durationSec ?? null,
        })),
    [songs]
  );

  /* Duración total de lo reproducible (solo versiones con audio listo). */
  const totalSec = useMemo(() => queue.reduce((acc, q) => acc + (q.durationSec ?? 0), 0), [queue]);
  const playableCount = queue.length;

  return (
    <Sheet open={!!project} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto border-border/70 bg-background p-0 sm:max-w-md">
        {/* Portada del proyecto (el scrim superior asegura contraste con la X del sheet) */}
        {project && (
          <div className="relative">
            <CoverArt
              id={project.id}
              src={project.coverUrl ?? null}
              alt={project.name ? `Portada de ${project.name}` : 'Portada del proyecto'}
              className="h-44 w-full"
              rounded="rounded-none"
            />
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/45 to-transparent" />
          </div>
        )}

        <SheetHeader className="px-4 pb-0 pt-4">
          <SheetTitle className="font-display text-xl leading-tight">{project?.name}</SheetTitle>
          {project?.description ? (
            <SheetDescription className="line-clamp-2">{project.description}</SheetDescription>
          ) : (
            /* Sin descripción: el texto de relleno va como el título «Materiales» de Crear (punto dorado + mayúsculas) */
            <SheetDescription className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
              <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
              Canciones de este proyecto
            </SheetDescription>
          )}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {songs.length > 0 && (
              <>
                {songs.length} {songs.length === 1 ? 'canción' : 'canciones'}
                {totalSec > 0 ? ` · ${formatDuration(totalSec)} en total` : ''}
                {playableCount > 0 && playableCount < songs.length
                  ? ` · ${playableCount} ${playableCount === 1 ? 'lista para reproducir' : 'listas para reproducir'}`
                  : ''}
              </>
            )}
          </p>
        </SheetHeader>

        {/* Acciones: Reproducir todo (con la cola del proyecto) + Agregar canciones */}
        <div className="flex flex-wrap items-center gap-2 px-4">
          {songs.length > 0 && (
            <TabCtaButton
              icon={PlayCircle}
              kind="ghost"
              iconOnlyOnMobile={false}
              onClick={() => play(queue[0], queue)}
              disabled={playableCount === 0}
              badge={playableCount}
              title={
                playableCount === 0
                  ? 'Todavía no hay audio listo — esperá a que terminen las generaciones'
                  : `Reproducir ${playableCount} ${playableCount === 1 ? 'canción' : 'canciones'} en cola`
              }
            >
              Reproducir todo
            </TabCtaButton>
          )}
          <TabCtaButton icon={Plus} iconOnlyOnMobile={false} onClick={() => setPickerOpen(true)}>
            Agregar canciones
          </TabCtaButton>
        </div>

        {isLoading ? (
          <div className="space-y-3 px-4 pb-8" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-12 w-12 animate-pulse rounded-lg bg-surface-2" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-2" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-surface-2" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="px-4 pb-8">
            <InlineError message={toUserMessage(error)} />
            <Button variant="outline" size="sm" className="mt-3 rounded-full" onClick={() => void refetch()}>
              Reintentar
            </Button>
          </div>
        ) : songs.length === 0 ? (
          /* Mismo texto que la nota de «Creatividad» en el modal de Crear: 13 px, semibold, color de texto normal */
          <div className="space-y-3 px-4 pb-8 pt-6 text-[13px] leading-snug font-semibold text-foreground">
            {/* Cápsula terracota como las de “Influencia del estilo” en Creatividad: pegada al borde izquierdo del panel */}
            <div className="-ml-4 w-[calc(100%+1rem)] rounded-r-[40px] bg-voice py-4 pr-5 pl-5 text-on-voice">
              <p>Este proyecto todavía no tiene canciones.</p>
            </div>
            <p>
              Al generar una canción nueva, elegí este proyecto como destino — o agregá las que ya tenés con el botón de arriba.
            </p>
          </div>
        ) : (
          /* Mismas filas que «De la comunidad» (Inicio): tarjeta con esquinas 28/28/14/14, portada redonda, título + detalle y play con borde */
          <div className="px-4 pb-8">
          <ul className="overflow-hidden rounded-t-[28px] rounded-b-[14px] border-[1.5px] border-[var(--m-border)] bg-[var(--m-input)]">
            {songs.map((song, idx) => {
              const audioUrl = apiFileUrl(song.currentVersion?.audioUrl ?? null);
              const current = currentId === song.id && isPlaying;
              return (
                <li key={song.id} className="group flex h-[76px] items-center gap-3 border-b border-[var(--m-separator)] pr-3 pl-3 transition-colors first:h-[82px] first:pt-1.5 last:h-[82px] last:border-b-0 last:pb-1.5 only:h-[88px] hover:bg-surface-2/50">
                  <span className="w-4 shrink-0 text-center text-xs text-muted-foreground" aria-hidden>{idx + 1}</span>
                  <CoverArt
                    id={song.id}
                    src={song.coverUrl}
                    alt=""
                    className={cn('size-[52px] shrink-0', current && 'ring-2 ring-primary ring-offset-2 ring-offset-[var(--m-input)]')}
                    rounded="rounded-full"
                  />
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate font-display text-base font-bold text-foreground transition-colors group-hover:text-amber-strong">{song.title}</p>
                    <p className="truncate text-[13px] text-muted-foreground">
                      {song.currentVersion?.genre ? `${song.currentVersion.genre} · ` : ''}
                      {formatDuration(song.currentVersion?.durationSec)}
                    </p>
                  </div>
                  {audioUrl && (
                    <button
                      type="button"
                      onClick={() =>
                        play(
                          {
                            id: song.id,
                            title: song.title,
                            artist: 'Vos',
                            coverUrl: apiFileUrl(song.coverUrl),
                            audioUrl,
                            durationSec: song.currentVersion?.durationSec ?? null,
                          },
                          queue.length ? queue : undefined
                        )
                      }
                      aria-label={`${current ? 'Pausar' : 'Reproducir'} ${song.title}`}
                      className={cn(
                        'flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-foreground',
                        current ? 'border-primary bg-primary text-primary-foreground' : 'border-line text-foreground hover:bg-surface-2'
                      )}
                    >
                      {current ? <Pause className="h-4 w-4 fill-current" aria-hidden /> : <Play className="h-4 w-4 translate-x-px fill-current" aria-hidden />}
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Quitar ${song.title} del proyecto`}
                    title="Quitar del proyecto"
                    className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={removeSongMutation.isPending}
                    onClick={() => removeSongMutation.mutate(song.id)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
          </div>
        )}

        {project && <SongPickerDialog project={project} open={pickerOpen} onOpenChange={setPickerOpen} />}
      </SheetContent>
    </Sheet>
  );
}
