
/**
 * MELODYA WEB — Diálogo para importar una letra existente al LyricsStudio.
 * Sirve tanto para "Pegar letra" como para "Subir archivo" (.txt/.md): el
 * archivo solo precarga el texto y el usuario lo revisa acá antes de importar.
 * No guarda nada: el padre manda el texto a POST /assistant/lyrics (existingLyrics).
 */

import React, { useState } from 'react';
import { AlignLeft, ClipboardPaste, Loader2, Wand2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExpandableLyrics } from '@/features/creator/PlanetEditors';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Límites del backend (generation.schema.js). */
export const IMPORT_MIN_CHARS = 20;
export const IMPORT_MAX_CHARS = 5000;
/** Por encima de esto el editor de Melodya puede recortar el final. */
const IMPORT_SOFT_CHARS = 2800;

/** 'as-is' no pasa por el asistente: la letra va al editor tal como viene (sin instrucción). */
export type ImportMode = 'format' | 'format-improve' | 'as-is';

export const IMPORT_INSTRUCTIONS: Record<Exclude<ImportMode, 'as-is'>, string> = {
  format:
    'FORMATEAR SOLAMENTE: conservá el contenido tal cual. Corregí saltos de línea y espacios, ' +
    'detectá las secciones y agregá etiquetas como [Intro], [Verso 1], [Pre-Coro], [Coro], [Puente] y [Outro]. ' +
    'No inventes contenido, no cambies palabras, la historia, los personajes ni la perspectiva, y no agregues información.',
  'format-improve':
    'FORMATEAR Y MEJORAR: detectá y ordenená las secciones con etiquetas como [Intro], [Verso 1], [Pre-Coro], [Coro], [Puente] y [Outro]. ' +
    'Mejorá solamente las frases claramente artificiales, confusas, forzadas o poco naturales. ' +
    'Mantené la historia, la información, los personajes, la perspectiva, el sentido y las repeticiones útiles. ' +
    'No agregues información nueva ni conviertas la letra en otra canción.',
};

export interface LyricsImportDraft {
  title: string;
  text: string;
}

export function LyricsImportDialog({
  open,
  onOpenChange,
  draft,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Texto/título precargados (p. ej. desde un archivo). El padre cambia `key` al abrir. */
  draft: LyricsImportDraft;
  pending: boolean;
  onSubmit: (input: { title: string; lyrics: string; mode: ImportMode }) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [text, setText] = useState(draft.text);
  const [mode, setMode] = useState<ImportMode>('format');

  const length = text.trim().length;
  const tooShort = length < IMPORT_MIN_CHARS;
  const tooLong = length > IMPORT_MAX_CHARS;

  const submit = () => {
    if (pending || tooShort || tooLong) return;
    onSubmit({ title: title.trim(), lyrics: text.trim(), mode });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!pending ? onOpenChange(o) : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-0 bg-surface sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">Importar letra</DialogTitle>
          <DialogDescription>
            Revisala acá: Melodya la prepara y la lleva al editor. Todavía no se guarda en tu biblioteca.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ly-import-title" className="text-sm font-medium">
              Título <span className="text-muted-foreground">(opcional)</span>
            </Label>
            <Input
              id="ly-import-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Ej.: Verano en la azotea"
              disabled={pending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ly-import-text" className="text-sm font-medium">
              Letra
            </Label>
            <ExpandableLyrics
              id="ly-import-text"
              value={text}
              onChange={setText}
              description={`${length.toLocaleString('es-AR')} / ${IMPORT_MAX_CHARS.toLocaleString('es-AR')} caracteres`}
              placeholder="Pegá tu letra acá…"
              heightClass="h-[260px]"
              disabled={pending}
            />
            <p className={cn('text-xs', tooLong ? 'text-destructive' : 'text-muted-foreground')}>
              {length.toLocaleString('es-AR')} / {IMPORT_MAX_CHARS.toLocaleString('es-AR')} caracteres
              {tooLong && ' — la letra es demasiado larga, acortala para importarla.'}
              {!tooLong && length > IMPORT_SOFT_CHARS &&
                ' — Melodya puede recortar el final de letras muy largas.'}
            </p>
          </div>

          <fieldset className="space-y-4" disabled={pending}>
            <legend className="mb-2 text-sm font-medium">¿Qué querés que haga Melodya?</legend>
            {(
              [
                { id: 'format', label: 'Solo formatear', hint: 'Ordena y marca las secciones sin tocar el texto.', Icon: AlignLeft },
                { id: 'format-improve', label: 'Formatear y mejorar', hint: 'Además suaviza frases forzadas o poco naturales.', Icon: Wand2 },
                { id: 'as-is', label: 'Pegar tal cual', hint: 'La lleva al editor sin cambios, sin usar el asistente.', Icon: ClipboardPaste },
              ] as const
            ).map((o) => (
              /* Cápsulas como las de Composición: pegadas al borde izquierdo, cada una con su color; la elegida a pleno color */
              <label
                key={o.id}
                className={cn(
                  'dialog-cap flex min-h-[72px] cursor-pointer items-center rounded-r-[36px] py-3 pr-6 pl-6 transition-opacity has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-foreground has-[input:focus-visible]:ring-offset-2 has-[input:focus-visible]:ring-offset-background',
                  /* Todas con el color de «Solo formatear»; la elegida toma el de «Formatear y mejorar» */
                  mode === o.id ? 'bg-primary text-[#131C33]' : 'bg-voice text-on-voice opacity-70 hover:opacity-100',
                  pending && 'cursor-not-allowed opacity-50'
                )}
              >
                <input
                  type="radio"
                  name="ly-import-mode"
                  value={o.id}
                  checked={mode === o.id}
                  onChange={() => setMode(o.id)}
                  className="sr-only"
                />
                <span aria-hidden className={cn('mr-4 flex size-[46px] shrink-0 items-center justify-center rounded-full', mode === o.id ? 'bg-[#131C33]/15' : 'bg-on-voice/15')}>
                  <o.Icon className="h-5 w-5" />
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="font-display text-lg font-bold">{o.label}</span>
                  <span className={cn('text-[13px]', mode === o.id ? 'font-medium text-[#131C33]/80' : 'opacity-80')}>{o.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="rounded-full max-sm:flex-1"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            className="rounded-full max-sm:flex-1 bg-primary font-bold text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95 disabled:bg-foreground/10 disabled:bg-none disabled:text-muted-foreground disabled:opacity-100"
            onClick={submit}
            disabled={pending || tooShort || tooLong}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {pending ? 'Procesando…' : 'Importar letra'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
