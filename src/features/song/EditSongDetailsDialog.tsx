
/**
 * «Editar detalles de la canción» (solo dueño): un único formulario para el nombre, la portada, el resumen de estilos y la descripción.
 *
 *  • Nombre, resumen y descripción viajan juntos en UN PATCH /songs/:id con solo lo que cambió (features/song/song-details.ts).
 *  • La portada reutiliza el diálogo «Cambiar portada» de siempre (subir imagen o generar con Melodya): se abre encima de este
 *    formulario, así lo que escribiste no se pierde, y la vista previa se actualiza sola al terminar.
 *  • Son datos de la CANCIÓN: no crean versiones, no cambian la versión vigente y no tocan audios, letras ni parámetros de generación.
 */

import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, Loader2, Palette } from 'lucide-react';
import { songsApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { usePlayerStore } from '@/stores/player';
import { CoverArt } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Song } from '@/types';
import { DETAIL_LIMITS, buildDetailsPatch, charCount, draftFrom, hasChanges, normalizeDetail, validateDetails, type DetailsDraft, type DetailsPatch } from './song-details';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  song: Song;
  /** Estilos que se muestran mientras no haya un resumen propio (género + etiquetas de la versión vigente). */
  derivedStyles: string;
  /** Abre el diálogo «Cambiar portada» existente. */
  onChangeCover: () => void;
}

function Counter({ id, value, max, multiline }: { id: string; value: string; max: number; multiline?: boolean }) {
  const n = charCount(normalizeDetail(value, multiline));
  const over = n > max;
  return (
    <p id={id} className={cn('text-right text-xs tabular-nums', over ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
      {n}/{max}
      <span className="sr-only">{over ? ' caracteres: te pasaste del límite' : ' caracteres'}</span>
    </p>
  );
}

/** Formulario con el borrador. Vive dentro del contenido del diálogo: se monta al abrir y parte siempre de lo guardado. */
function DetailsForm({ song, derivedStyles, pending, serverError, onSubmit, onCancel, onChangeCover }: {
  song: Song;
  derivedStyles: string;
  pending: boolean;
  serverError: string | null;
  onSubmit: (patch: DetailsPatch) => void;
  onCancel: () => void;
  onChangeCover: () => void;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<DetailsDraft>(() => draftFrom(song));
  const [touched, setTouched] = useState(false);

  const saved = draftFrom(song);
  const errors = validateDetails(draft);
  const patch = buildDetailsPatch(song, draft);
  const invalid = Object.keys(errors).length > 0;
  const dirty = hasChanges(patch);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || !dirty || pending) return;
    onSubmit(patch);
  };

  // El error de un campo aparece cuando ya se tocó (o se intentó guardar), no mientras todavía no escribiste nada.
  const show = (field: keyof DetailsDraft) => (touched || draft[field] !== saved[field] ? errors[field] : undefined);
  const set = (field: keyof DetailsDraft) => (value: string) => setDraft((d) => ({ ...d, [field]: value }));
  const id = (name: string) => `${uid}-${name}`;

  return (
    <form onSubmit={submit} className="space-y-5" noValidate aria-busy={pending || undefined}>
      {/* Nombre */}
      <div className="space-y-1.5">
        <label htmlFor={id('title')} className="text-sm font-semibold">Nombre</label>
        <Input
          id={id('title')}
          value={draft.title}
          onChange={(e) => set('title')(e.target.value)}
          maxLength={DETAIL_LIMITS.title}
          autoComplete="off"
          aria-invalid={show('title') ? true : undefined}
          aria-describedby={show('title') ? id('title-err') : undefined}
          disabled={pending}
          className="rounded-full bg-background"
        />
        {show('title') && <p id={id('title-err')} role="alert" className="text-xs font-medium text-destructive">{show('title')}</p>}
      </div>

      {/* Portada: misma herramienta de siempre; la vista previa se actualiza al terminar */}
      <div className="space-y-1.5">
        <p className="text-sm font-semibold" id={id('cover-label')}>Portada</p>
        <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface-2/40 p-3">
          <CoverArt id={song.id} src={song.coverUrl} alt={`Portada actual de ${song.title}`} className="size-16 shrink-0" rounded="rounded-xl" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs text-muted-foreground">Subí una imagen tuya o generá una nueva. Cada versión conserva su propia portada.</p>
            <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-9" onClick={onChangeCover} disabled={pending} aria-describedby={id('cover-label')}>
              {song.coverUrl ? <Palette className="h-4 w-4" aria-hidden /> : <ImageIcon className="h-4 w-4" aria-hidden />}
              Cambiar portada
            </Button>
          </div>
        </div>
      </div>

      {/* Resumen de estilos */}
      <div className="space-y-1.5">
        <label htmlFor={id('style')} className="text-sm font-semibold">Resumen de estilos</label>
        <Input
          id={id('style')}
          value={draft.styleSummary}
          onChange={(e) => set('styleSummary')(e.target.value)}
          placeholder={derivedStyles ? `Ej.: ${derivedStyles}` : 'Ej.: Folk suave con guitarra y coros'}
          maxLength={DETAIL_LIMITS.styleSummary * 2}
          autoComplete="off"
          aria-invalid={show('styleSummary') ? true : undefined}
          aria-describedby={`${id('style-help')} ${id('style-count')}${show('styleSummary') ? ` ${id('style-err')}` : ''}`}
          disabled={pending}
          className="rounded-full bg-background"
        />
        <p id={id('style-help')} className="text-xs text-muted-foreground">
          {derivedStyles
            ? `Si lo dejás vacío se muestran los estilos de la versión actual: ${derivedStyles}.`
            : 'Si lo dejás vacío se muestran los estilos de la versión actual.'}
        </p>
        <Counter id={id('style-count')} value={draft.styleSummary} max={DETAIL_LIMITS.styleSummary} />
        {show('styleSummary') && <p id={id('style-err')} role="alert" className="text-xs font-medium text-destructive">{show('styleSummary')}</p>}
      </div>

      {/* Descripción */}
      <div className="space-y-1.5">
        <label htmlFor={id('desc')} className="text-sm font-semibold">Descripción <span className="font-normal text-muted-foreground">(opcional)</span></label>
        <Textarea
          id={id('desc')}
          value={draft.description}
          onChange={(e) => set('description')(e.target.value)}
          placeholder="Contá la historia o la idea detrás de esta canción."
          rows={4}
          maxLength={DETAIL_LIMITS.description * 2}
          aria-invalid={show('description') ? true : undefined}
          aria-describedby={`${id('desc-count')}${show('description') ? ` ${id('desc-err')}` : ''}`}
          disabled={pending}
          className="min-h-28 max-h-[40dvh] resize-y"
        />
        <Counter id={id('desc-count')} value={draft.description} max={DETAIL_LIMITS.description} multiline />
        {show('description') && <p id={id('desc-err')} role="alert" className="text-xs font-medium text-destructive">{show('description')}</p>}
      </div>

      {serverError && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{serverError}</p>}

      <DialogFooter className="gap-2 sm:gap-2">
        <Button type="button" variant="outline" className="min-h-11 rounded-full sm:min-h-9" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button
          type="submit"
          className="min-h-11 rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground sm:min-h-9"
          disabled={!dirty || invalid || pending}
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditSongDetailsDialog({ open, onOpenChange, song, derivedStyles, onChangeCover }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: DetailsPatch) => songsApi.update(song.id, patch),
    onSuccess: async (_res, patch) => {
      await qc.invalidateQueries({ queryKey: ['song', song.id] });
      void qc.invalidateQueries({ queryKey: ['songs'] });
      void qc.invalidateQueries({ queryKey: ['community', 'song', song.id] });
      // Las generaciones embeben song.title y el player conoce la canción (en curso, cola, recientes): se sincronizan como al renombrar.
      if (patch.title) {
        void qc.invalidateQueries({ queryKey: ['generations'] });
        usePlayerStore.getState().renameTrack(song.id, patch.title);
      }
      toast({ title: 'Detalles actualizados' });
      onOpenChange(false);
    },
    onError: (err) => {
      const message = toUserMessage(err, 'No pudimos guardar los cambios.');
      setServerError(message);
      toast({ title: 'No pudimos guardar los detalles', description: message, variant: 'destructive' });
    },
  });

  const change = (next: boolean) => {
    if (mutation.isPending) return; // no se cierra a mitad de un guardado
    setServerError(null);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="max-w-lg border-border/70 bg-surface">
        <DialogHeader>
          <DialogTitle className="font-display">Editar detalles de la canción</DialogTitle>
          <DialogDescription>
            Cambia cómo se ve tu canción. No crea una versión nueva ni toca el audio ni la letra.
          </DialogDescription>
        </DialogHeader>
        <DetailsForm
          song={song}
          derivedStyles={derivedStyles}
          pending={mutation.isPending}
          serverError={serverError}
          onSubmit={(patch) => { setServerError(null); mutation.mutate(patch); }}
          onCancel={() => change(false)}
          onChangeCover={onChangeCover}
        />
      </DialogContent>
    </Dialog>
  );
}
