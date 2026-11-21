
/**
 * MELODYA WEB — Biblioteca › Papelera general.
 * Una sola sección para los cinco tipos (canciones, letras, proyectos, letristas, samples y voces). Todo es borrado LÓGICO: lo
 * enviado a la Papelera se conserva tal cual y «Restaurar» solo lo vuelve a mostrar (no reconstruye ni regenera nada).
 * Cada tipo conserva su propio endpoint en el backend (GET /<recurso>/trash y POST /<recurso>/:id/restore); acá solo se unifica la
 * experiencia. La ruta es /library/trash/<tipo>.
 */
import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, FileText, ListMusic, Mic2, Music4, PenLine, RotateCcw, Trash2 } from 'lucide-react';
import { lyricsApi, projectsApi, samplesApi, songsApi, songwritersApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { apiFileUrl } from '@/lib/api/client';
import { Link, navigate, useRoute } from '@/lib/router';
import { usePlayerStore } from '@/stores/player';
import { formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { CoverArt, EmptyState, ErrorState, LoadingCards } from '@/components/common';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './library-utils';
import {
  TRASH_EMPTY, TRASH_RESTORED_TITLE, TRASH_TYPE_KEYS, TRASH_TYPE_LABELS, isAlreadyGone, keysToInvalidate, restoreWarning,
  songDetailPath, trashPathFor, trashTypeFromPath, type TrashType,
} from './trash-utils';

/** Lo mínimo que la Papelera necesita de cualquier elemento, ya normalizado por tipo. */
interface TrashRow {
  id: string;
  title: string;
  detail: string;
  deletedAt: string | null;
  coverUrl: string | null;
  badge?: string;
  warning: string | null;
}

const TYPE_ICON: Record<TrashType, React.ComponentType<{ className?: string }>> = {
  songs: Music4,
  lyrics: FileText,
  projects: ListMusic,
  songwriters: PenLine,
  samples: AudioLines,
};

const TYPE_TABS = TRASH_TYPE_KEYS.map((key) => ({ key, label: TRASH_TYPE_LABELS[key], icon: TYPE_ICON[key] }));

/** Carga y normaliza la Papelera de un tipo. */
async function loadRows(type: TrashType): Promise<TrashRow[]> {
  const params = { pageSize: 50 };
  switch (type) {
    case 'songs': {
      const { items } = await songsApi.trash(params);
      return items.map((s) => ({
        id: s.id,
        title: s.title,
        detail: s.visibility === 'PUBLIC' ? 'Era pública' : 'Privada',
        deletedAt: s.deletedAt ?? null,
        coverUrl: apiFileUrl(s.coverUrl ?? null),
        warning: restoreWarning('songs', s),
      }));
    }
    case 'lyrics': {
      const { items } = await lyricsApi.trash(params);
      return items.map((l) => ({
        id: l.id,
        title: l.title,
        detail: l.genre ? l.genre : l.source === 'AI_GENERATED' ? 'Escrita con Melodya' : 'Escrita por vos',
        deletedAt: l.deletedAt ?? null,
        coverUrl: null,
        warning: null,
      }));
    }
    case 'projects': {
      const { items } = await projectsApi.trash(params);
      return items.map((p) => ({
        id: p.id,
        title: p.name,
        detail: `${p.songsCount ?? 0} ${p.songsCount === 1 ? 'canción' : 'canciones'} (siguen en tu biblioteca)`,
        deletedAt: p.deletedAt ?? null,
        coverUrl: apiFileUrl(p.coverUrl ?? null),
        warning: null,
      }));
    }
    case 'songwriters': {
      const { items } = await songwritersApi.trash(params);
      return items.map((w) => ({
        id: w.id,
        title: w.name,
        detail: `${w.lyricIds.length} letras y ${w.songIds.length} canciones de ejemplo`,
        deletedAt: w.deletedAt ?? null,
        coverUrl: null,
        warning: null,
      }));
    }
    case 'samples': {
      const { items } = await samplesApi.trash(params);
      return items.map((s) => ({
        id: s.id,
        title: s.name,
        detail: s.sunoPersonaId ? 'Voz clonada' : s.kind === 'VOICE' ? 'Grabación de voz' : 'Audio',
        deletedAt: s.deletedAt ?? null,
        coverUrl: apiFileUrl(s.avatarUrl ?? null),
        badge: s.kind === 'VOICE' ? 'Voz' : undefined,
        warning: restoreWarning('samples', s),
      }));
    }
  }
}

const restoreCall: Record<TrashType, (id: string) => Promise<unknown>> = {
  songs: (id) => songsApi.restore(id),
  lyrics: (id) => lyricsApi.restore(id),
  projects: (id) => projectsApi.restore(id),
  songwriters: (id) => songwritersApi.restore(id),
  samples: (id) => samplesApi.restore(id),
};

export function TrashTab() {
  const { path } = useRoute();
  const type = trashTypeFromPath(path);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [toRestore, setToRestore] = useState<TrashRow | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['trash', type],
    queryFn: () => loadRows(type),
  });
  const rows = useMemo(() => data ?? [], [data]);

  const refresh = () => {
    for (const key of keysToInvalidate(type)) void qc.invalidateQueries({ queryKey: [...key] });
  };

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreCall[type](id),
    onSuccess: (_res, id) => {
      if (type === 'songs') usePlayerStore.getState().setTrackTrashed(id, false);
      refresh();
      toast({ title: TRASH_RESTORED_TITLE[type] });
      setToRestore(null);
    },
    onError: (err) => {
      setToRestore(null);
      if (isAlreadyGone(err)) {
        // Otra sesión ya lo restauró (o ya no existe): no es un error para el usuario, solo se actualiza la lista.
        refresh();
        toast({ title: 'Ya no estaba en la Papelera', description: 'Actualizamos la lista.' });
        return;
      }
      toast({ title: 'No pudimos restaurarlo', description: toUserMessage(err), variant: 'destructive' });
    },
  });

  const ask = (row: TrashRow) => (row.warning ? setToRestore(row) : restoreMutation.mutate(row.id));

  return (
    <section aria-labelledby="trash-title">
      <div className="mb-4">
        <h2 id="trash-title" className="font-display text-lg leading-[1.2] font-bold text-foreground sm:text-xl">Papelera</h2>
        <p className="mt-1 text-[13px] leading-[1.4] text-muted-foreground sm:text-sm">
          Lo que enviaste a la Papelera se conserva completo. Restauralo cuando quieras: vuelve tal como estaba. Por ahora no se borra nada definitivamente.
        </p>
      </div>

      <SegmentedTabs tabs={TYPE_TABS} value={type} onChange={(t) => navigate(trashPathFor(t))} ariaLabel="Tipo de contenido en la Papelera" className="mb-3" variant="trash" />

      {isLoading ? (
        <LoadingCards count={4} />
      ) : isError ? (
        <ErrorState message={toUserMessage(error)} onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        /* Como la zona de «Crear · Tu audio (subir) · Subir un archivo» de design-V2 (`.dropz`): borde punteado de 1,5 px, esquinas de 28 px, 28/16 de
           relleno y sin fondo; anillo de 72 px con el círculo dorado suave de 52 px, título de 17 px y texto de 13 px. */
        <div role="status" className="flex w-full flex-col items-center gap-2.5 rounded-[28px] border-[1.5px] border-dashed border-line px-4 py-7 text-center text-foreground">
          <span aria-hidden className="flex size-[72px] shrink-0 items-center justify-center rounded-full border-[3px] border-line">
            <span className="flex size-[52px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--m-gold)_18%,var(--m-surface))] text-amber-strong">
              <Trash2 className="h-[26px] w-[26px]" />
            </span>
          </span>
          <b className="text-[17px] leading-[1.3] font-bold">{TRASH_EMPTY[type].title}</b>
          <span className="text-[13px] leading-[1.35] text-muted-foreground">{TRASH_EMPTY[type].description}</span>
        </div>
      ) : (
        <ul className="rounded-cover border border-[var(--m-border)] bg-[var(--m-input)] px-3.5 py-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex min-h-[76px] items-center gap-3.5 border-t border-[var(--m-separator)] py-3 first:border-t-0 sm:gap-4"
            >
              {row.coverUrl || type === 'songs' || type === 'projects' ? (
                type === 'songs' ? (
                  /* Canciones: la portada abre el mismo detalle que Biblioteca (#/songs/:id), en solo lectura mientras estén en la Papelera. */
                  <Link to={songDetailPath(row.id)} tabIndex={-1} aria-hidden className="shrink-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
                    <CoverArt id={row.id} src={row.coverUrl} alt="" className="size-12" rounded="rounded-xl" />
                  </Link>
                ) : (
                  <CoverArt id={row.id} src={row.coverUrl} alt="" className="size-12 shrink-0" rounded="rounded-xl" />
                )
              ) : (
                <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-full text-[#131C33]', type === 'samples' ? (row.badge ? 'bg-[#F0A44B]' : 'bg-element-sound') : type === 'songwriters' ? 'bg-[var(--m-orbit-0)]' : 'bg-element-lyrics')} aria-hidden>
                  {type === 'samples' && row.badge ? <Mic2 className="h-[22px] w-[22px]" /> : React.createElement(TYPE_ICON[type], { className: 'h-[22px] w-[22px]' })}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 font-display text-base leading-[1.2] font-bold break-words text-foreground sm:text-lg">
                  {type === 'songs' ? (
                    <Link to={songDetailPath(row.id)} className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground" aria-label={`Abrir ${row.title}`}>
                      {row.title}
                    </Link>
                  ) : (
                    row.title
                  )}
                  {row.badge && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{row.badge}</span>}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-[1.35] text-muted-foreground sm:text-[13px]">
                  {row.detail}
                  {row.deletedAt && <> · enviada {formatRelative(row.deletedAt)}</>}
                </p>
                {row.warning && <p className="mt-1 text-xs leading-[1.35] text-amber-600 sm:text-[13px] dark:text-amber-400">{row.warning}</p>}
              </div>
              <Button
                variant="outline"
                className="h-10 shrink-0 rounded-full border-[1.5px] border-line bg-transparent px-4 text-[15px] font-bold tracking-[.02em] text-foreground hover:bg-foreground/10 max-sm:size-10 max-sm:px-0"
                disabled={restoreMutation.isPending}
                onClick={() => ask(row)}
                aria-label={`Restaurar ${row.title}`}
              >
                <RotateCcw className="mr-2 h-4 w-4 max-sm:mr-0 max-sm:h-5 max-sm:w-5" aria-hidden /> <span className="max-sm:sr-only">Restaurar</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!toRestore}
        onOpenChange={(o) => !o && setToRestore(null)}
        title={`¿Restaurar "${toRestore?.title ?? ''}"?`}
        description={toRestore?.warning ?? ''}
        actionLabel="Restaurar"
        destructive={false}
        onConfirm={() => toRestore && restoreMutation.mutate(toRestore.id)}
        pending={restoreMutation.isPending}
      />
    </section>
  );
}

export default TrashTab;
