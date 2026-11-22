'use client';

/**
 * Editores de cada planeta de la canción. Cada editor trabaja sobre su parte del SongState (song-model) y muestra,
 * junto al control, sus requisitos y limitaciones. Nada acá arma payloads: eso es de buildGenerationRequest y del backend.
 */

import React, { useRef, useState } from 'react';
import { ConfirmDialog } from '@/features/library/library-utils';
import { Wand2, Loader2, Mic2, Sparkles, ChevronRight, Info, CircleAlert, Plus, X, Maximize2, Trash2, Upload, Check, Minus, AudioLines, TrendingUp, Flame, Guitar, Zap, Mountain, Disc3, Heart, Mic, Music4, Drama, Lightbulb, PenLine, Music2, BookOpen, type LucideIcon } from 'lucide-react';
import { Link } from '@/lib/router';
import { assistantApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import type { CapabilityLocks } from '@/lib/capabilities';
import { LOCKED_CONTROL, RequiredPlanBadge } from '@/components/common/PlanGate';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatDateDMY } from '@/lib/subscription';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CanvasTextarea } from '@/components/common/CanvasTextarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Chip } from '@/components/common';
import { Slider } from '@/components/ui/slider';
import { SavedLyricsPickerDialog } from './SavedLyricsPickerDialog';
import { VoiceAvailabilityNotice } from '@/features/voice/VoiceAvailabilityNotice';
import {
  LIMITS, MOODS, applyLyricsFromStudio, addGenresFromText, removeGenre, genreKey, styleUsage, ideaJoinsStyle, suggestIdeaRequest, pickSuggestedIdea,
  type SongState, type Capabilities, type Issue, type CompositionMode, type PlanetId,
} from './song-model';

export const GENRES = ['Cumbia', 'Rock', 'Pop', 'Electrónica', 'Folklore', 'Trap', 'Balada', 'Rap', 'Jazz', 'Tango'];

/** Ícono de cada género: aparece dentro del chip cuando está elegido (design-V2, configuracion-estilo). */
const GENRE_ICONS: Record<string, LucideIcon> = {
  cumbia: Music2, rock: Guitar, pop: Mic2, electrónica: Zap, electronica: Zap, folklore: Mountain,
  trap: Disc3, balada: Heart, rap: Mic, jazz: Music4, tango: Drama,
};
const genreIcon = (g: string): LucideIcon => GENRE_ICONS[g.trim().toLowerCase()] ?? Music2;

type Patch<K extends 'composition' | 'style' | 'voice' | 'reference' | 'production' | 'creativity'> = (patch: Partial<SongState[K]>) => void;

/** Mensajes del planeta (requisitos faltantes, limitaciones). El color nunca es el único indicador. */
export function PlanetNotices({ issues, planet }: { issues: Issue[]; planet: PlanetId }) {
  const mine = issues.filter((i) => i.planet === planet);
  if (!mine.length) return null;
  return (
    <ul className="space-y-2.5" aria-label="Avisos de este elemento">
      {/* Cápsulas como la de «Antes de crear, falta resolver» (design-V2, «Seguí creando»): pegadas al borde izquierdo, tinte terracota, título en la fuente de títulos */}
      {mine.map((i, n) => (
        <li
          key={n}
          className="-ml-4 w-[calc(100%+1rem)] rounded-r-[40px] bg-[var(--m-capsule-tint)] py-3.5 pr-5 pl-5 text-foreground"
        >
          <p className="flex items-center gap-2 font-display text-base font-bold">
            {i.severity === 'info' ? <Info className="h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className={cn('h-4 w-4 shrink-0', i.severity === 'error' && 'text-destructive')} aria-hidden />}
            {i.severity === 'error' ? 'Falta resolver:' : i.severity === 'warning' ? 'Atención:' : 'Nota:'}
          </p>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{i.message}</p>
        </li>
      ))}
    </ul>
  );
}

/** Opción de una elección única, con área de toque amplia y estado anunciado (radio). */
function Choice({ checked, onSelect, title, description, name, disabled, capsule, icon: Icon }: { checked: boolean; onSelect: () => void; title: string; description?: string; name: string; disabled?: boolean; capsule?: 'voice' | 'accent' | 'gold'; icon?: LucideIcon }) {
  /* Variante «cápsula» (design-V2, botones de Crear): pegada al borde izquierdo, redondeada a la derecha, cada una con su color (azul · naranja · dorado). La elegida se ve a pleno color; las otras se atenúan un poco. */
  if (capsule) {
    const tone = capsule === 'voice' ? 'bg-voice text-on-voice' : capsule === 'accent' ? 'bg-primary text-[#131C33]' : 'bg-gold text-[#131C33]';
    return (
      <label
        className={cn(
          '-ml-4 flex min-h-[72px] w-[calc(100%+1rem)] cursor-pointer items-center rounded-r-[36px] py-3 pr-6 pl-6 transition-opacity has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-foreground has-[input:focus-visible]:ring-offset-2 has-[input:focus-visible]:ring-offset-background',
          tone,
          !checked && 'opacity-70 hover:opacity-100',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className="sr-only" />
        {Icon && (
          <span aria-hidden className={cn('mr-4 flex size-[46px] shrink-0 items-center justify-center rounded-full', capsule === 'voice' ? 'bg-on-voice/15' : 'bg-[#131C33]/15')}>
            <Icon className="h-5 w-5" />
          </span>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="font-display text-lg font-bold">{title}</span>
          {description && <span className={cn('text-[13px]', capsule === 'voice' ? 'opacity-80' : 'font-medium text-[#131C33]/80')}>{description}</span>}
        </span>
      </label>
    );
  }
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-amber/60',
        checked ? 'border-amber/60 bg-amber/10' : 'border-border/70 bg-surface-2/30 hover:border-amber/40',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className="mt-1 h-4 w-4 shrink-0 accent-amber" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        {description && <span className="block text-xs leading-relaxed text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

/** Las voces creadas desde la web se llaman «Mi voz · 12 nov»: la fecha ya se muestra abajo («Creada el…»), así que no se repite en el título. */
const withoutAutoDate = (name: string) => name.replace(/\s*·\s*\d{1,2}\s+[a-záéíóúñ]{3,4}\.?\s*$/i, '').trim() || name;

/** Fila de una voz propia (design-V2 · «Tus voces» `.vitem.pick`): avatar de 48 px con el micrófono en el color del planeta Voz, nombre en Bricolage 16/700,
 *  descripción en 13 px y a la derecha un selector circular de 28 px: aro dorado, relleno dorado con tilde cuando está elegida. */
function VoiceRow({ checked, onSelect, title, description, name, disabled }: { checked: boolean; onSelect: () => void; title: string; description?: string; name: string; disabled?: boolean }) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 border-t border-[var(--m-separator)] py-3.5 first:border-t-0 has-[input:focus-visible]:rounded-xl has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-foreground',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className="sr-only" />
      <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#F0A44B] text-[#131C33]">
        <Mic className="h-[22px] w-[22px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-display text-base font-bold leading-[1.2]">{title}</span>
        {description && <span className="text-[13px] leading-[1.35] text-muted-foreground">{description}</span>}
      </span>
      <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-gold transition-colors', checked && 'bg-gold text-on-gold')}>
        {checked && <Check className="h-4 w-4" strokeWidth={3} />}
      </span>
    </label>
  );
}

/** Fila de un audio de la biblioteca (design-V2 · «Elegir de tu biblioteca», `.lib-row.two.pickrow`): círculo de 44 px (naranja de Voz para voz y beatbox, azul de Audio para
 *  el resto), el nombre en Bricolage 16/700 y debajo la descripción de siempre («tipo · N s») en 13 px. Se elige tocando la fila; la elegida lleva un velo de acento y un tilde dorado. */
function SampleRow({ checked, onSelect, title, type, description, name }: { checked: boolean; onSelect: () => void; title: string; type?: string; description?: string; name: string }) {
  // Voz y beatbox → naranja de Voz con micrófono; todo lo demás (instrumentos) → azul de Audio, con el ícono de su tipo
  const isVoice = /^(voice|vocal|beatbox)/i.test(type ?? '');
  const Icon = isVoice ? Mic : /^guitar/i.test(type ?? '') || /^bass/i.test(type ?? '') ? Guitar : /^drum/i.test(type ?? '') ? Disc3 : /^melod/i.test(type ?? '') ? Music4 : AudioLines;
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3.5 border-t border-[var(--m-separator)] px-3.5 py-3 first:border-t-0 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-inset has-[input:focus-visible]:ring-foreground',
        checked && 'bg-[color-mix(in_srgb,var(--m-accent)_14%,transparent)]'
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full text-[#131C33]" style={{ background: isVoice ? '#F0A44B' : '#7B93E8' }}>
        <Icon className="h-[22px] w-[22px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-display text-base leading-[1.25] font-bold">{title}</span>
        {description && <span className="text-[13px] leading-[1.35] text-muted-foreground">{description}</span>}
      </span>
      <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-gold transition-colors', checked && 'bg-gold text-on-gold')}>
        {checked && <Check className="h-4 w-4" strokeWidth={3} />}
      </span>
    </label>
  );
}

/* Lienzo de la letra (design-V2, «Letra»): marco con esquinas 20/20/6/6 y los títulos de sección ([Verse], [Chorus]…) en dorado.
   El textarea tiene el texto transparente y una capa espejo detrás dibuja el mismo texto coloreado. `fill` lo estira a todo el alto disponible. */
export function LyricsCanvas({ id, value, onChange, fill, children, placeholder, disabled, heightClass = 'h-[220px]', textareaRef, ariaLabel, plain, maxLength }: { plain?: boolean; maxLength?: number; id: string; value: string; onChange: (v: string) => void; fill?: boolean; children?: React.ReactNode; placeholder?: string; disabled?: boolean; heightClass?: string; textareaRef?: React.Ref<HTMLTextAreaElement>; ariaLabel?: string }) {
  const mirror = useRef<HTMLDivElement>(null);
  return (
    <div className={cn('relative rounded-[20px_20px_6px_6px] border-[1.5px] border-line bg-[var(--m-input)] px-4 pt-4 pb-2 transition-shadow focus-within:border-foreground focus-within:ring-4 focus-within:ring-[var(--m-focus-ring)]', fill && 'flex min-h-[240px] flex-1 flex-col')}>
      <div className={cn('relative', fill && 'min-h-0 flex-1')}>
        {!plain && (
          <div
            ref={mirror}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words pr-16 pb-1 text-[15px] leading-[1.6] text-foreground"
          >
            {value.split(/(\[[^\]\n]+\])/g).map((part, k) => (k % 2 === 1 ? <span key={k} className="text-lyric-tag">{part}</span> : part))}
            {'\n '}
          </div>
        )}
        <textarea
          id={id}
          ref={textareaRef}
          aria-label={ariaLabel}
          data-canvas-field
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
          placeholder={placeholder ?? '[Verse 1]\nEscribí tu letra…\n\n[Chorus]\nPodés usar etiquetas como [Verse], [Chorus] y [Bridge]'}
          disabled={disabled}
          maxLength={maxLength}
          className={cn('scrollbar-none relative block w-full border-0 bg-transparent p-0 pr-16 pb-1 outline-none placeholder:text-muted-foreground', plain ? 'text-base leading-[1.45] text-foreground' : 'text-[15px] leading-[1.6] text-transparent caret-foreground', fill ? 'h-full resize-none' : cn(heightClass, 'min-h-[72px] resize-y'))}
        />
      </div>
      {children}
    </div>
  );
}

/* Letra con botón para ampliarla: un modal con la letra completa y una cruz para cerrarlo. Se usa en «Tu letra» y en «Importar letra». */
export function ExpandableLyrics({ id, value, onChange, description, placeholder, disabled, heightClass, grow, textareaRef, ariaLabel, plain, maxLength, modalTitle }: { plain?: boolean; maxLength?: number; modalTitle?: string; id: string; value: string; onChange: (v: string) => void; description?: string; placeholder?: string; disabled?: boolean; heightClass?: string; grow?: boolean; textareaRef?: React.Ref<HTMLTextAreaElement>; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const clearButton = value.length > 0 && !disabled && (
    <button
      type="button"
      onClick={() => setConfirmClear(true)}
      aria-label={plain ? 'Borrar el texto' : 'Borrar la letra'}
      title={plain ? 'Borrar el texto' : 'Borrar la letra'}
      className="absolute top-2 right-10 z-10 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
    >
      <Trash2 className="h-4 w-4" aria-hidden />
    </button>
  );
  return (
    <>
      <LyricsCanvas id={id} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} heightClass={heightClass} fill={grow} textareaRef={textareaRef} ariaLabel={ariaLabel} plain={plain} maxLength={maxLength}>
        {clearButton}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={plain ? 'Ampliar el texto' : 'Ampliar la letra'}
          title={plain ? 'Ampliar el texto' : 'Ampliar la letra'}
          className="absolute top-2 right-2 z-10 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
        >
          <Maximize2 className="h-4 w-4" aria-hidden />
        </button>
      </LyricsCanvas>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[92dvh] max-h-[92dvh] flex-col gap-3 border-0 p-5 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">{modalTitle ?? 'Tu letra'}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <LyricsCanvas id={`${id}-full`} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} fill plain={plain} maxLength={maxLength}>
            {clearButton && React.cloneElement(clearButton, { className: clearButton.props.className.replace('right-10', 'right-2') })}
          </LyricsCanvas>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="¿Borrar el texto?"
        description={plain ? 'Se borra todo el texto de esta caja. No se puede deshacer.' : 'Se borra toda la letra de esta caja. No se puede deshacer.'}
        actionLabel="Borrar"
        onConfirm={() => {
          setConfirmClear(false);
          onChange('');
        }}
      />
    </>
  );
}

/* ───────────────────────────── Composición ───────────────────────────── */

export function CompositionEditor({ song, patch, onOpenStudio, issues, onApplySuggestion, locks, lockedTitle }: {
  song: SongState; patch: Patch<'composition'>; onOpenStudio: () => void; issues: Issue[];
  /** «Sugerime una idea»: recibe sólo la idea; Estilo no se toca. */
  onApplySuggestion: (idea: string) => void;
  /** «Otra versión»: el título de la canción original, que se conserva y no se edita (el backend no acepta `title` junto con `songId`). */
  lockedTitle?: string;
  /** Capacidades que el plan no incluye (E5): sin asistente de letras no hay sugerencias, pero el modo «idea» sigue disponible. */
  locks?: CapabilityLocks;
}) {
  const c = song.composition;
  const { toast } = useToast();
  const [suggesting, setSuggesting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const modes: Array<{ id: CompositionMode; title: string; description: string; tone: 'voice' | 'accent' | 'gold'; icon: LucideIcon }> = [
    { id: 'idea', title: 'Contanos una idea', description: 'Melodya escribe la letra y la canta.', tone: 'voice', icon: Lightbulb },
    { id: 'lyrics', title: 'Tengo mi letra', description: 'Tu letra se canta tal como la escribís.', tone: 'accent', icon: PenLine },
    { id: 'instrumental', title: 'Solo música', description: 'Instrumental, sin voz.', tone: 'gold', icon: Music2 },
  ];

  const suggest = async () => {
    // Las sugerencias son parte del asistente de letras: sin LYRICS_AI se muestra el aviso de upgrade (onOpenStudio lo hace al estar bloqueado).
    if (locks?.lyricsAi) {
      onOpenStudio();
      return;
    }
    setSuggesting(true);
    try {
      const res = await assistantApi.suggestions(suggestIdeaRequest());
      onApplySuggestion(pickSuggestedIdea(res.suggestions));
      toast({ title: '✨ Idea sugerida', description: 'Editála o probá otra semilla.' });
    } catch (err) {
      toast({ title: 'No pudimos sugerir', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">¿Cómo querés arrancar?</legend>
        {modes.map((m) => (
          <Choice capsule={m.tone} icon={m.icon} key={m.id} name="composition-mode" checked={c.mode === m.id} onSelect={() => patch({ mode: m.id })} title={m.title} description={m.description} />
        ))}
      </fieldset>

      {c.mode !== 'lyrics' && (
        <div className="space-y-2">
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor="song-idea" className="text-sm font-semibold">
            {c.mode === 'idea' ? 'Tu idea' : 'Ambiente o escena'} {c.mode === 'instrumental' && <span className="font-normal text-muted-foreground">(opcional)</span>}
          </Label>
            {c.mode === 'idea' && (
              <Button type="button" variant="outline" size="sm" className={cn('rounded-full text-sm font-medium', locks?.lyricsAi && LOCKED_CONTROL)} onClick={() => void suggest()} disabled={suggesting} aria-disabled={locks?.lyricsAi ? true : undefined}>
                    {suggesting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Wand2 className="mr-2 h-3.5 w-3.5" aria-hidden />}
                    Sugerime una idea
                    <RequiredPlanBadge capability="LYRICS_AI" className="ml-2" />
                  </Button>
            )}
          </div>
          {/* Lienzo de texto (design-V2, «Letra»): borde fino con esquinas 20/20/6/6, textarea sin marco (se puede agrandar hacia abajo) y scroll fino */}
          <ExpandableLyrics
            id="song-idea"
            plain
            value={c.idea}
            onChange={(v) => patch({ idea: v })}
            placeholder={c.mode === 'idea' ? 'Ej: una cumbia para el último día de las vacaciones en la costa…' : 'Ej: música para estudiar de noche, con lluvia afuera…'}
            maxLength={LIMITS.idea}
            heightClass="h-[110px]"
            modalTitle={c.mode === 'idea' ? 'Tu idea' : 'Ambiente o escena'}
          />
          <p role="status" aria-live="polite" className={cn('text-xs tabular-nums', c.idea.length >= LIMITS.idea ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
            {c.idea.length}/{LIMITS.idea} caracteres
          </p>
        </div>
      )}

      {c.mode === 'idea' && (
        <fieldset className="space-y-2">
          <legend className="mb-3 text-sm font-semibold">Temática <span className="font-normal text-muted-foreground">(opcional: ayuda a Melodya a escribir la letra)</span></legend>
          {/* Los chips se reparten el ancho y, si no entran en una fila, bajan a la siguiente (sin desplazarse hacia el costado) */}
          <div className="flex flex-wrap gap-1.5">
            {MOODS.map((m) => (
              <Chip key={m.id} active={c.mood === m.id} onClick={() => patch({ mood: c.mood === m.id ? '' : m.id })} className="h-9 flex-auto justify-center px-3 text-xs">
                {m.label}
              </Chip>
            ))}
          </div>
          {c.mood === 'libre' && (
            <Input value={c.moodCustom} onChange={(e) => patch({ moodCustom: e.target.value })} placeholder="Contanos de qué va…" className="max-w-xs rounded-xl" aria-label="Temática personalizada" maxLength={LIMITS.theme} />
          )}
        </fieldset>
      )}

      {c.mode === 'lyrics' && (
        <div className="space-y-2">
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="song-lyrics" className="text-sm font-semibold">Tu letra</Label>
            <Button type="button" size="sm" variant="outline" className={cn('rounded-full text-sm font-medium', locks?.lyricsAi && LOCKED_CONTROL)} onClick={onOpenStudio} aria-disabled={locks?.lyricsAi ? true : undefined}>
              <Wand2 className="mr-2 h-3.5 w-3.5" aria-hidden /> Crear o mejorar con Melodya
              <RequiredPlanBadge capability="LYRICS_AI" className="ml-2" />
            </Button>
          </div>
          <ExpandableLyrics id="song-lyrics" value={c.lyrics} onChange={(v) => patch({ lyrics: v })} description={c.lyrics.trim() ? `${c.lyrics.trim().split(/\s+/).length} palabras · ${c.lyrics.length}/${LIMITS.lyrics} caracteres` : 'Las etiquetas [Verse], [Chorus], [Bridge] se conservan.'} />
          {/* «Mis letras» a la izquierda (elige una guardada sin usar el asistente) y el contador a la derecha */}
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex min-h-11 items-center gap-1.5 text-[13px] leading-[1.2] font-bold tracking-[0.02em] text-label focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden /> Mis letras
            </button>
            <p className="text-right text-xs text-muted-foreground">
              {c.lyrics.trim() ? `${c.lyrics.trim().split(/\s+/).length} palabras · ${c.lyrics.length}/${LIMITS.lyrics} caracteres` : 'Las etiquetas [Verse], [Chorus], [Bridge] se conservan.'}
            </p>
          </div>
          <SavedLyricsPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={(l) => {
              const next = applyLyricsFromStudio(song, { lyrics: l.lyrics, title: l.title }).composition;
              patch({ lyrics: next.lyrics, title: next.title, titleFromLyrics: next.titleFromLyrics });
              setPickerOpen(false);
            }}
          />
        </div>
      )}

      {c.mode === 'idea' && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted-foreground">
          <span>¿Preferís ver y editar la letra antes de generar?</span>
          {/* Botón de texto como «Sugerir una idea» de design-V2 (`.btn-t`): ícono de destellos de 14 px, 13/700 con 0,02 em de espaciado, color de etiqueta, 44 px de alto */}
          <button type="button" onClick={onOpenStudio} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] leading-[1.2] font-bold tracking-[0.02em] text-label focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />Escribila ahora con Melodya
          </button>
          <RequiredPlanBadge capability="LYRICS_AI" />
        </p>
      )}

      {lockedTitle !== undefined ? (
        <div className="space-y-2">
          <Label htmlFor="song-title" className="text-sm font-semibold">Título de la canción</Label>
          <Input id="song-title" value={lockedTitle} readOnly disabled className="w-full rounded-xl text-base font-normal" aria-describedby="song-title-help" />
          <p id="song-title-help" className="text-xs leading-relaxed text-muted-foreground">El título se mantiene: estás creando otra versión de esta canción.</p>
        </div>
      ) : (
      <div className="space-y-2">
        <Label htmlFor="song-title" className="text-sm font-semibold">Título <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <Input id="song-title" value={c.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Si lo dejás vacío, Melodya elige uno" className="w-full rounded-xl text-base font-normal" aria-describedby="song-title-help" />
        <p id="song-title-help" className="text-xs leading-relaxed text-muted-foreground">
          {c.titleFromLyrics && 'Propuesto por Melodya a partir de tu letra: podés cambiarlo. '}
          <span className={cn('tabular-nums', c.title.trim().length > LIMITS.title && 'font-semibold text-destructive')}>{c.title.trim().length}/{LIMITS.title}</span>
        </p>
      </div>
      )}

      <PlanetNotices issues={issues} planet="composition" />
    </div>
  );
}

/* ───────────────────────────── Estilo ───────────────────────────── */

export function StyleEditor({ song, patch, issues }: { song: SongState; patch: Patch<'style'>; issues: Issue[] }) {
  const user = useAuthStore((s) => s.user);
  const genres = song.style.genres;
  const has = (g: string) => genres.some((x) => genreKey(x) === genreKey(g));
  const toggle = (g: string) => patch({ genres: has(g) ? removeGenre(genres, g) : [...genres, g] });
  const profile = (user?.genres ?? []).filter((g, i, arr) => arr.findIndex((x) => genreKey(x) === genreKey(g)) === i);
  const preset = GENRES.filter((g) => !profile.some((p) => genreKey(p) === genreKey(g)));
  const custom = genres.filter((g) => ![...GENRES, ...profile].some((p) => genreKey(p) === genreKey(g)));
  const d = song.style.description;
  const usage = styleUsage(song.style);

  // Género propio: se guarda en la misma lista que los chips (va a GENRE), nunca solo dentro de la descripción.
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const addDraft = () => {
    const { genres: next, status: last } = addGenresFromText(genres, draft);
    if (next !== genres) patch({ genres: next });
    if (last === 'added') { setDraft(''); setFeedback(''); return; }
    setFeedback(
      last === 'empty' ? 'Escribí un género para agregarlo.'
        : last === 'duplicate' ? 'Ese género ya está en tu lista.'
          : last === 'too-long' ? `Cada género admite hasta ${LIMITS.genreLength} caracteres.`
            : `Podés combinar hasta ${LIMITS.genres} géneros. Quitá alguno para agregar otro.`
    );
  };

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Géneros <span className="font-normal text-muted-foreground">(podés combinar hasta {LIMITS.genres})</span></legend>
        <div className="space-y-1.5">
          <Label htmlFor="custom-genre" className="text-xs text-muted-foreground">¿No está en la lista? Escribí el tuyo</Label>
          <div className="flex gap-2">
            <Input
              id="custom-genre"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); if (feedback) setFeedback(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDraft(); } }}
              placeholder="Ej: cumbia villera, indie folk, synthwave…"
              autoComplete="off"
              aria-describedby="custom-genre-feedback"
              className="rounded-xl"
            />
            <Button type="button" variant="outline" onClick={addDraft} disabled={!draft.trim()} className="shrink-0 h-14 rounded-full border-[1.5px] border-primary bg-primary px-[18px] text-sm font-bold text-[#131C33] hover:border-primary hover:bg-primary hover:text-[#131C33] hover:brightness-95" aria-label="Agregar género">
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Agregar</span>
            </Button>
          </div>
          <p id="custom-genre-feedback" role="status" aria-live="polite" className={cn('min-h-4 text-xs', feedback ? 'text-destructive' : 'text-muted-foreground')}>{feedback}</p>
        </div>
        {profile.length > 0 && (
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Sparkles className="h-3 w-3 text-amber-strong" aria-hidden /> Tus géneros</p>
            <div className="flex flex-wrap gap-2">
              {profile.map((g) => { const Icon = genreIcon(g); return <Chip key={g} active={has(g)} onClick={() => toggle(g)}>{has(g) && <Icon className="h-4 w-4 shrink-0" aria-hidden />}<span aria-hidden={false}>{g}</span></Chip>; })}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {preset.map((g) => { const Icon = genreIcon(g); return <Chip key={g} active={has(g)} onClick={() => toggle(g)}>{has(g) && <Icon className="h-4 w-4 shrink-0" aria-hidden />}{g}</Chip>; })}
        </div>
        {custom.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Agregados por vos</p>
            <ul className="flex flex-wrap gap-2" aria-label="Géneros agregados">
              {custom.map((g) => (
                <li key={g}>
                  <Chip active onClick={() => toggle(g)}>
                    <span>{g}</span>
                    <X className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">Quitar {g}</span>
                  </Chip>
                </li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="style-description" className="text-sm font-semibold">¿Cómo debería sonar? <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <CanvasTextarea
          id="style-description"
          value={d}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="Ej: cumbia argentina moderna, voz masculina con coros grupales, bajo marcado, teclado cumbiero, güiro y timbal, energía de fiesta, estribillo pegadizo"
          className="h-[130px]"
          aria-describedby="style-description-help style-budget"
        />
        <p id="style-description-help" className="text-xs leading-relaxed text-muted-foreground">
          Instrumentos, ritmo, ambiente, coros, energía… con tus palabras.
        </p>
        <p
          id="style-budget"
          role="status"
          aria-live="polite"
          className={cn('text-xs tabular-nums', usage.over > 0 || d.length > LIMITS.description ? 'font-semibold text-destructive' : 'text-muted-foreground')}
        >
          Géneros + descripción: {usage.used}/{usage.limit} caracteres
          {usage.over > 0 ? ` · sobran ${usage.over}: acortá la descripción o quitá géneros` : ` · quedan ${usage.remaining}`}
          {ideaJoinsStyle(song) && <span className="block font-normal text-muted-foreground">Tu idea se suma al final del estilo solo si queda lugar: no le quita espacio a lo que escribís acá.</span>}
          {usage.omitted.length > 0 && <span className="block font-normal text-muted-foreground">No se repite en el texto lo que ya nombrás en la descripción: {usage.omitted.join(', ')}. Igual se guarda como género.</span>}
        </p>
      </div>
      <PlanetNotices issues={issues} planet="style" />
    </div>
  );
}

/* ───────────────────────────── Voz ───────────────────────────── */

export function VoiceEditor({ song, caps, patch, issues, onRecordVoice, onRecreateVoice, locks }: {
  song: SongState; caps: Capabilities; patch: Patch<'voice'>; issues: Issue[]; onRecordVoice: () => void;
  /** Recrear una voz caducada con su muestra original (abre el asistente de clonación con esa muestra). */
  onRecreateVoice: (sampleId: string) => void;
  /** Capacidades que el plan no incluye (E5): usar una voz clonada (VOICE_COVER) y grabar una nueva (VOICE_CLONING). */
  locks?: CapabilityLocks;
}) {
  const v = song.voice;
  const own = Boolean(v.voiceSampleId);
  return (
    <div className="space-y-6">
      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">Voz de Melodya</legend>
        <Choice capsule="voice" icon={Sparkles} name="voice-pref" checked={!own && v.preference === ''} onSelect={() => patch({ preference: '', voiceSampleId: null })} title="Sin preferencia" description="Melodya elige la voz." />
        <Choice capsule="accent" icon={Mic2} name="voice-pref" checked={!own && v.preference === 'female'} onSelect={() => patch({ preference: 'female', voiceSampleId: null })} title="Femenina" />
        <Choice capsule="gold" icon={Mic} name="voice-pref" checked={!own && v.preference === 'male'} onSelect={() => patch({ preference: 'male', voiceSampleId: null })} title="Masculina" />
        <p className="text-xs leading-relaxed text-muted-foreground">Es una preferencia: se tiene en cuenta, pero no puede garantizarse el resultado.</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">Tu propia voz</legend>
        {caps.voices.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">Todavía no tenés una voz lista. Grabala una vez y la podés usar en todas tus canciones.</p>
        ) : (
          /* Como «Tus voces» de design-V2: una tarjeta (28/28/14/14) con una fila por voz, separadas por una línea */
          <div className="rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] px-3.5 py-1">
            {caps.voices.map((s) => (
              <VoiceRow key={s.id} name="voice-pref" checked={v.voiceSampleId === s.id} onSelect={() => patch({ voiceSampleId: s.id, preference: '' })} title={withoutAutoDate(s.name)} disabled={Boolean(locks?.customVoice)} description={s.createdAt ? `Creada el ${formatDateDMY(s.createdAt)}` : undefined} />
            ))}
          </div>
        )}
        {/* Disponibilidad de la voz elegida (se consulta al elegirla, no al listar): solo se avisa si el backend confirma que caducó. */}
        <VoiceAvailabilityNotice sampleId={v.voiceSampleId} onRecreate={onRecreateVoice} disabled={Boolean(locks?.voiceCloning)} />
        {/* Los dos botones siempre en la misma fila (en cualquier ancho), del mismo alto y con la misma tipografía */}
        <div className="flex items-stretch gap-2 pt-1">
          <button
            type="button"
            className={cn('flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[20px] border-[1.5px] px-3 py-1.5 text-center text-sm font-bold leading-tight border-line bg-transparent text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground', locks?.voiceCloning && LOCKED_CONTROL)}
            onClick={onRecordVoice}
            aria-disabled={locks?.voiceCloning ? true : undefined}
          >
            Grabar ahora
            <RequiredPlanBadge capability="VOICE_CLONING" showCrownOnly />
          </button>
          <Link to="/library/voices" className="flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[20px] border-[1.5px] px-3 py-1.5 text-center text-sm font-bold leading-tight border-primary bg-primary text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
            Administrar mis voces
          </Link>
        </div>
        {(locks?.customVoice || locks?.voiceCloning) && (
          <p role="note" className="text-xs leading-relaxed text-amber-strong">{[locks.customVoice, locks.voiceCloning].filter(Boolean).join(' ')}</p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">Requiere haber aceptado el uso de voz en tu perfil y completar la verificación. Solo se pueden elegir voces que ya están listas.</p>
      </fieldset>
      <PlanetNotices issues={issues} planet="voice" />
    </div>
  );
}

/* ───────────────────────────── Referencia de audio ───────────────────────────── */

export function ReferenceEditor({ song, caps, patch, issues }: { song: SongState; caps: Capabilities; patch: Patch<'reference'>; issues: Issue[] }) {
  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">Elegí un audio de tu biblioteca</legend>
        {caps.references.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Todavía no tenés audios de referencia. Subí uno en tu biblioteca de audios y volvé.</p>
            <Link to="/library/samples" className="inline-flex h-10 items-center gap-1.5 rounded-[20px] border-[1.5px] border-primary bg-primary px-[18px] text-sm font-bold text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
              Biblioteca de audios <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        ) : (
          /* Como «Elegir de tu biblioteca» de design-V2: una tarjeta (28/28/14/14) con una fila por audio, separadas por una línea; la elegida lleva un velo del color de acento */
          <div className="overflow-hidden rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)]">
            {caps.references.map((s) => (
              <SampleRow
                key={s.id}
                name="reference"
                checked={song.reference.sampleId === s.id}
                onSelect={() => patch({ sampleId: s.id })}
                title={s.name}
                type={s.type}
                description={[s.type?.toLowerCase(), s.durationSec ? `${Math.round(s.durationSec)} s` : ''].filter(Boolean).join(' · ') || undefined}
              />
            ))}
          </div>
        )}
        {caps.references.length > 0 && (
          <Link to="/library/samples" className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-[20px] border-[1.5px] border-primary bg-primary px-[18px] text-sm font-bold text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
            Subir otro audio en mi biblioteca <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        )}
      </fieldset>
      {/* Tarjeta como la de «Creá tu voz · autorización» de design-V2 (`.lcard.consent` + `.ckeys`) con la forma de la lista de audios (28/28/14/14), 16/18 de relleno (un poco más clara en oscuro) y los puntos con un círculo de 32 px
          en el azul del planeta Audio (#7B93E8) al 22 %, sin líneas entre ellos */}
      <section className="space-y-3">
        <h3 className="font-display text-lg font-bold">Qué podés esperar</h3>
        <ul className="flex flex-col gap-3 rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] px-[18px] py-4 dark:bg-[color-mix(in_srgb,var(--m-foreground)_6%,var(--m-input))]">
          {[
            { icon: Wand2, text: 'Con letra (tuya o escrita por Melodya), Melodya transforma el audio conservando su melodía (hasta 8 minutos). En ese caso no se puede elegir la duración ni las exclusiones.' },
            { icon: Music2, text: 'En un instrumental, el audio se usa solo como guía (entre 6 segundos y 30 minutos). En ese caso tampoco se pueden elegir duración, exclusiones, preferencia vocal ni creatividad.' },
            { icon: Upload, text: 'Subir audios se hace desde tu biblioteca. La grabación directa en la web solo existe para tu voz.' },
            { icon: Info, text: 'El parecido con la referencia depende de Melodya y no está garantizado.' },
          ].map((it) => (
            <li key={it.text} className="flex items-start gap-3">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,#7B93E8_22%,transparent)] text-[#7B93E8]">
                <it.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 pt-1 text-[13px] leading-[1.35] text-foreground/75">{it.text}</span>
            </li>
          ))}
        </ul>
      </section>
      <PlanetNotices issues={issues} planet="reference" />
    </div>
  );
}

/* ───────────────────────────── Producción ───────────────────────────── */

export function ProductionEditor({ song, patch, issues }: { song: SongState; patch: Patch<'production'>; issues: Issue[] }) {
  const p = song.production;
  return (
    <div className="space-y-6">
      {/* Cápsula como «Influencia del estilo» (Creatividad): pegada al borde izquierdo, fondo terracota */}
      <div className="-ml-4 w-[calc(100%+1rem)] space-y-2 rounded-r-[40px] bg-voice py-4 pr-5 pl-5 text-on-voice">
        <Label htmlFor="prod-duration" className="font-display text-base font-bold">Duración en segundos <span className="font-sans text-sm font-normal text-on-voice/70">(opcional)</span></Label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Input id="prod-duration" type="number" inputMode="numeric" min={LIMITS.durationMin} max={LIMITS.durationMax} value={p.durationSec} onChange={(e) => patch({ durationSec: e.target.value })} placeholder="10 a 360" className="max-w-[10rem] rounded-xl" aria-describedby="prod-duration-help prod-duration-help-2" />
          <p id="prod-duration-help" className="min-w-0 flex-1 basis-56 text-sm leading-snug font-semibold text-on-voice">Un número entero entre 10 y 360.</p>
        </div>
        {/* Control deslizante como el de «Influencia del estilo» (Creatividad): al moverlo se refleja el número en el campo de arriba */}
        <Slider
          value={[Math.min(LIMITS.durationMax, Math.max(LIMITS.durationMin, Math.round(Number(p.durationSec)) || LIMITS.durationMin))]}
          min={LIMITS.durationMin}
          max={LIMITS.durationMax}
          step={1}
          onValueChange={(v) => patch({ durationSec: String(Math.round(v[0])) })}
          className="slider-warm cursor-pointer py-1 [&_[data-slot=slider-track]]:bg-on-voice/25!"
          aria-label="Duración en segundos"
        />
        <p id="prod-duration-help-2" className="text-xs leading-relaxed text-on-voice/80">
          <span className="block text-sm leading-snug font-semibold text-on-voice">Se puede elegir en canciones con letra o instrumentales, sin audio de referencia.</span>
          <span className="mt-0.5 block">Es un objetivo: el resultado puede no ajustarse exactamente.</span>
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="prod-avoid" className="text-sm font-semibold">Qué querés evitar <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <Input id="prod-avoid" value={p.avoid} onChange={(e) => patch({ avoid: e.target.value })} placeholder="Ej: autotune, reggaetón, voces agudas" className="rounded-xl" aria-describedby="prod-avoid-help" />
        <p id="prod-avoid-help" className="text-xs leading-relaxed text-muted-foreground">Estilos o características a excluir, separados por comas. Funciona en canciones con letra (tuya o de Melodya) e instrumentales sin audio de referencia.</p>
      </div>
      <PlanetNotices issues={issues} planet="production" />
    </div>
  );
}

/* ───────────────────────────── Creatividad ───────────────────────────── */

const VARIETY_LEVELS: Array<{ v: number; label: string; hint: string; icon: LucideIcon; tone: string }> = [
  { v: 0, label: 'Apagada', hint: 'Mismo estilo, sin variación', icon: Minus, tone: 'bg-voice text-on-voice' },
  { v: 1, label: 'Normal', hint: 'Equilibrio entre estabilidad y variedad', icon: AudioLines, tone: 'bg-primary text-[#131C33]' },
  { v: 2, label: 'Alta', hint: 'Resultados con estilos claramente distintos', icon: TrendingUp, tone: 'bg-gold text-[#131C33]' },
  { v: 3, label: 'Extra', hint: 'Exploración más audaz', icon: Zap, tone: 'bg-voice text-on-voice' },
  { v: 4, label: 'Máxima', hint: 'Variación máxima; puede diferir mucho', icon: Flame, tone: 'bg-primary text-[#131C33]' },
];

/* Casillero «Automático» con el círculo dorado de la flecha de «continuar» (lo usa Variedad) */
function AutoToggle({ auto, onToggle }: { auto: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={auto}
      onClick={onToggle}
      className="flex shrink-0 items-center gap-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
    >
      Automático
      <span aria-hidden className={cn('flex size-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-gold transition-colors', auto ? 'bg-gold text-[#131C33]' : 'bg-transparent text-transparent')}>
        <Check className="h-4 w-4" strokeWidth={3} />
      </span>
    </button>
  );
}

/* «Automático» como en «Creatividad · Avanzado» de design-V2 (`.autoc`): etiqueta de 13 px semibold y un círculo de 28 px con borde del color de texto; al activarlo se llena de dorado con el tilde
   (lo usan Influencia del estilo, Rareza e Influencia del audio) */
function AutoCheck({ auto, onToggle }: { auto: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={auto}
      onClick={onToggle}
      className="flex shrink-0 items-center gap-2.5 text-[13px] leading-none font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
    >
      Automático
      <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors', auto ? 'border-gold bg-gold text-on-gold' : 'border-on-voice bg-transparent text-transparent')}>
        <Check className="h-4 w-4" strokeWidth={3} />
      </span>
    </button>
  );
}

/** `step` en puntos porcentuales (5 por defecto); la Influencia del audio usa 1 = pasos de 0,01. */
function UnitControl({ id, label, hint, value, onChange, step = 5 }: { id: string; label: string; hint: string; value: number | null; onChange: (v: number | null) => void; step?: number }) {
  const auto = value === null;
  return (
    /* Tarjeta como la de «Creatividad · Avanzado» de design-V2 (`.qcard.crea`): fondo azul, 18/20 de relleno y 12 px entre bloques; título de 19 px negrita, ayuda de 14 px al 70 %,
       «Automático» con su círculo, y el deslizador en dorado con el valor en una píldora de 68 × 28 px */
    <div className="-ml-4 flex w-[calc(100%+1rem)] flex-col gap-2 rounded-r-[32px] bg-voice py-3 pr-5 pl-5 text-on-voice">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={id} className="text-[17px] leading-[1.3] font-bold">{label}</Label>
          <AutoCheck auto={auto} onToggle={() => onChange(auto ? 0.5 : null)} />
        </div>
        {/* La descripción ocupa todo el ancho de la tarjeta (va debajo del título y de «Automático», no al lado) */}
        <p className="text-sm leading-[1.4] text-on-voice/70">{hint}</p>
      </div>
      <div className="flex items-center gap-2.5">
        <Slider
          id={id}
          value={[auto ? 65 : Math.round((value as number) * 100)]}
          max={100}
          step={step}
          disabled={auto}
          onValueChange={(v) => onChange(Math.round(v[0]) / 100)}
          className={cn('slider-warm min-w-0 flex-1 cursor-pointer disabled:cursor-not-allowed [&_[data-slot=slider-track]]:bg-on-voice/25!', auto && 'opacity-45 grayscale')}
          aria-label={label}
        />
        <span className="grid h-7 min-w-[68px] shrink-0 place-items-center rounded-[14px] bg-on-voice/[0.14] px-2.5 text-[13px] leading-none font-medium whitespace-nowrap tabular-nums">{auto ? 'Auto' : `${Math.round((value as number) * 100)}%`}</span>
      </div>
    </div>
  );
}

/** `audioApplies`: hay un audio de referencia válido que Melodya transforma con letra; solo entonces existe la Influencia del audio. */
export function CreativityEditor({ song, patch, issues, audioApplies = false }: { song: SongState; patch: Patch<'creativity'>; issues: Issue[]; audioApplies?: boolean }) {
  const k = song.creativity;
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-snug font-semibold text-foreground">
        Son ajustes avanzados que se aplican tal cual en Melodya. Dejalos en automático si no sabés qué buscás: usamos los valores predeterminados de Melodya. Cómo cambian el sonido depende de Melodya y no está garantizado.
      </p>
      <UnitControl id="cr-style" label="Influencia del estilo" hint="Qué tanto se ajusta al estilo que pediste." value={k.styleWeight} onChange={(v) => patch({ styleWeight: v })} />
      <UnitControl id="cr-weird" label="Rareza" hint="Cuánto se permite desviarse hacia lo experimental." value={k.weirdness} onChange={(v) => patch({ weirdness: v })} />
      {audioApplies && (
        <UnitControl id="cr-audio" label="Influencia del audio" hint="Qué tanto se parece el resultado al audio de referencia que elegiste." value={k.audioWeight} onChange={(v) => patch({ audioWeight: v })} step={1} />
      )}
      {/* Variedad con el estilo del modal «Agregar a tu canción»: filas en pastilla con círculo de color, y el elegido marcado con un visto */}
      <fieldset className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <legend className="font-display text-base font-bold">Variedad</legend>
            <p className="text-[13px] leading-snug text-muted-foreground">Qué tan distintos son los resultados entre sí.</p>
          </div>
          <AutoToggle auto={k.variety === null} onToggle={() => patch({ variety: k.variety === null ? 1 : null })} />
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          {VARIETY_LEVELS.map((l) => {
            const disabled = k.variety === null;
            const checked = k.variety === l.v;
            return (
              /* El botón elegido se marca con el borde dorado y el tilde dorado a la derecha, sin relleno; la descripción va adentro, debajo del título */
              <label
                key={l.v}
                className={cn(
                  'flex min-h-12 w-full min-w-0 items-center gap-3 rounded-3xl border-[1.5px] px-2 py-1.5 pr-4 text-left transition-colors has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-foreground',
                  checked ? 'border-gold text-foreground' : 'border-line text-foreground',
                  disabled ? 'cursor-not-allowed opacity-60' : cn('cursor-pointer', !checked && 'hover:bg-foreground/10')
                )}
              >
                <input type="radio" name="variety" disabled={disabled} checked={checked} onChange={() => patch({ variety: l.v })} className="sr-only" />
                <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#E9876F] text-[#131C33]">
                  <l.icon className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block text-sm font-bold">{l.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{l.hint}</span>
                </span>
                {checked && (
                  <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gold text-on-gold">
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>
      <PlanetNotices issues={issues} planet="creativity" />
    </div>
  );
}
