'use client';

/**
 * MELODYA WEB — Biblioteca: helpers compartidos entre pestañas.
 * (rutas /library/* — cada pestaña maneja su propia data por react-query)
 */
import React, { useCallback, useState } from 'react';
import { Music4, ListMusic, FileText, PenLine, AudioLines, Mic2, Trash2, AlertCircle, Pause, Play, LayoutGrid, List } from 'lucide-react';
import { useRoute, navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { isTrackPlaying, playButtonView } from './sample-playback';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/** Antes devolvía las medidas de escritorio para mobile; ahora la variante «list» ya usa UNA sola medida en todos los anchos, así que no agrega nada (se conserva por compatibilidad). */
export const LIST_MENU_COMFORTABLE_MOBILE = '';

/* ── Tabs disponibles (orden del navbar; keys = rutas del backend) ── */
export type LibraryTabKey = 'songs' | 'projects' | 'lyrics' | 'lyric-personas' | 'samples' | 'voices' | 'trash';

export const LIBRARY_TABS: Array<{ key: LibraryTabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'songs', label: 'Canciones', icon: Music4 },
  { key: 'projects', label: 'Álbumes', icon: ListMusic },
  { key: 'lyrics', label: 'Letras', icon: FileText },
  { key: 'lyric-personas', label: 'Letristas', icon: PenLine },
  { key: 'samples', label: 'Audios', icon: AudioLines },
  { key: 'voices', label: 'Voces', icon: Mic2 },
  { key: 'trash', label: 'Papelera', icon: Trash2 },
];

/** Tab activa según el hash (/library → songs por defecto). */
export function useLibraryTab(): [LibraryTabKey, (tab: LibraryTabKey) => void] {
  const { path } = useRoute();
  const seg = path.replace(/^\/library\/?/, '').split('/')[0];
  const tab = (LIBRARY_TABS.some((t) => t.key === seg) ? seg : 'songs') as LibraryTabKey;
  const setTab = useCallback((t: LibraryTabKey) => navigate(`/library/${t}`), []);
  return [tab, setTab];
}

/* ── Confirmación destructiva reutilizable (accesible) ── */
export function ConfirmDialog({
  open, onOpenChange, title, description, actionLabel = 'Eliminar', onConfirm, pending = false, destructive = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel?: string;
  onConfirm: () => void;
  pending?: boolean;
  /** false = acción reversible (p. ej. restaurar): botón con el color primario en lugar del rojo. */
  destructive?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="rounded-full">Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            className="rounded-full"
          >
            {pending && <span className="mr-1 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── Letra formateada: secciones [verso]/[coro] → etiqueta ámbar en negrita ── */
export function LyricBody({ lyrics, className }: { lyrics: string; className?: string }) {
  const lines = lyrics.split(/\r?\n/);
  return (
    <div className={cn('space-y-1.5 text-sm leading-relaxed text-foreground/90', className)}>
      {lines.map((line, i) => {
        const section = line.trim().match(/^\[(.+)\]$/);
        if (section) {
          return (
            <p key={i} className="pt-2 font-semibold tracking-wide text-amber-strong uppercase">
              [{section[1]}]
            </p>
          );
        }
        return (
          <p key={i} className={cn('whitespace-pre-line', line.trim() === '' && 'h-1')}>
            {line || '\u00A0'}
          </p>
        );
      })}
    </div>
  );
}

/* ── Inputs de formulario: label + hint + control ── */
export function Field({
  label, hint, htmlFor, children, optional = false,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
        {optional && <span className="ml-1.5 font-normal text-muted-foreground">(opcional)</span>}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* ── Tags separados por coma → string[] (trim + dedupe) ── */
export function parseTagList(input: string): string[] {
  const seen = new Set<string>();
  return input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => {
      if (!t || seen.has(t.toLowerCase())) return false;
      seen.add(t.toLowerCase());
      return true;
    })
    .slice(0, 12);
}

/* ── Aviso inline de error (calido, no bloqueante) ── */
export function InlineError({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground/90">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/* ── Botón de acción primario de cada tab (CTA ámbar; ghost = secundario) ── */
export function TabCtaButton({
  onClick,
  icon: Icon,
  kind = 'primary',
  ariaLabel,
  disabled,
  title,
  badge,
  locked = false,
  iconOnlyOnMobile = true,
  children,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  kind?: 'primary' | 'ghost';
  ariaLabel?: string;
  disabled?: boolean;
  title?: string;
  /** Número chico junto al texto (p. ej. la cantidad en cola); solo se ve cuando hay texto. */
  badge?: React.ReactNode;
  /** Funcionalidad fuera del plan: se ve atenuada con borde punteado y sigue siendo clicable (el llamador muestra el aviso de upgrade). */
  locked?: boolean;
  /** false = el texto se mantiene visible también en celular (por defecto queda solo el ícono). */
  iconOnlyOnMobile?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      aria-disabled={locked || undefined}
      variant={kind === 'ghost' ? 'outline' : 'default'}
      className={cn(
        locked && 'border-dashed border-amber/50 !bg-transparent !text-muted-foreground opacity-90 hover:!bg-amber/5',
        /* En mobile queda solo el ícono (cuadrado); el texto sigue disponible para lectores de pantalla. */
        iconOnlyOnMobile && 'max-sm:size-11 max-sm:gap-0 max-sm:px-0',
        kind === 'ghost'
          ? 'rounded-full border-[1.5px] border-line bg-transparent text-[13.5px] font-medium text-foreground transition-colors hover:bg-accent'
          : 'rounded-full gradient-warm text-[13.5px] font-bold text-primary-foreground hover:text-primary-foreground'
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span className={cn(iconOnlyOnMobile && 'max-sm:sr-only')}>{children}</span>
      {badge != null && <span className={cn('text-xs font-semibold opacity-80', iconOnlyOnMobile && 'max-sm:sr-only')}>{badge}</span>}
    </Button>
  );
}

/**
 * Botón Play/Pausa de una muestra de la biblioteca. Usa el reproductor compartido (`playerStore`): el icono y la etiqueta salen
 * del estado real (`track` + `isPlaying`), y pulsarlo reproduce, pausa o reanuda esa misma pista (`play` alterna si es la actual).
 */
export function SamplePlayButton({
  id, name, track, className,
}: {
  id: string;
  name: string;
  track: () => PlayerTrack;
  className?: string;
}) {
  const playing = usePlayerStore((s) => isTrackPlaying(s, id));
  const view = playButtonView(playing, name);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={view.label}
      /* Igual al botón de reproducir de «De la comunidad» (Inicio): círculo de 44 px con borde fino; naranja sólido cuando suena */
      className={cn(
        'size-11 rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-foreground',
        playing ? 'border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground' : 'border-line text-foreground hover:bg-surface-2',
        className
      )}
      onClick={() => usePlayerStore.getState().play(track())}
    >
      {view.icon === 'pause' ? (
        <Pause className="h-4 w-4 fill-current" aria-hidden />
      ) : (
        <Play className="h-4 w-4 translate-x-px fill-current" aria-hidden />
      )}
    </Button>
  );
}


/* ── Vista grilla / lista (la elección se recuerda por pestaña en este navegador) ── */
export type ViewMode = 'grid' | 'list';

export function useViewMode(storageKey: string): [ViewMode, (v: ViewMode) => void] {
  const [view, setViewState] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'grid';
    try {
      return window.localStorage.getItem(storageKey) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const setView = useCallback(
    (v: ViewMode) => {
      setViewState(v);
      try {
        window.localStorage.setItem(storageKey, v);
      } catch {
        /* sin almacenamiento: la elección vale solo para esta visita */
      }
    },
    [storageKey]
  );
  return [view, setView];
}

/** Botones grilla/lista (mismo componente visual que el de Canciones). */
export function ViewToggle({ view, onChange, className, compact = true }: { view: ViewMode; onChange: (v: ViewMode) => void; className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2', className)} role="group" aria-label="Cambiar vista">
      {(
        [
          { key: 'grid', label: 'Vista de grilla', icon: LayoutGrid },
          { key: 'list', label: 'Vista de lista', icon: List },
        ] as const
      ).map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={view === key}
          aria-label={label}
          title={label}
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
            compact && 'max-sm:size-8',
            view === key ? 'border-selected bg-selected text-on-selected' : 'border-line text-foreground hover:bg-accent'
          )}
        >
          <Icon className={cn('h-4 w-4', compact && 'max-sm:h-3.5 max-sm:w-3.5')} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/* Íconos sólidos (sin trazo) para las acciones de la vista lista: ver, editar y enviar a la Papelera. */
export const solidIcon = (d: string) =>
  function SolidIcon({ className }: { className?: string }) {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
        <path d={d} />
      </svg>
    );
  };
export const EyeSolid = solidIcon("M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z");
export const PencilSolid = solidIcon("M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z");
export const TrashSolid = solidIcon("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z");
