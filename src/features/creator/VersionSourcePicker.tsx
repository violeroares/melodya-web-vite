
/**
 * «Otra versión» dentro del encabezado del creador (sin tarjetas propias):
 *  • `VersionOriginSelect`: selector compacto «Partir de: Versión 2 · Vigente» junto al contador de elementos.
 *  • `VersionNotes`: líneas discretas SOLO cuando hay algo relevante (configuración parcial, voz caducada, referencia no disponible,
 *    datos que no se pudieron recuperar, error de carga). La carga correcta no se anuncia con texto visible.
 *  • `VersionLiveRegion`: el anuncio correspondiente para lectores de pantalla (`aria-live`), invisible.
 *  • `VersionUnavailable`: pantalla de error cuando la canción no se puede usar.
 */

import React from 'react';
import { CircleAlert, Info, Loader2, Mic2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatRelative } from '@/hooks';
import { BLANK_ORIGIN, type HydrationNote, type VersionOption } from './version-source';

/** Texto completo de una opción de la lista desplegable. */
export function optionText(o: VersionOption): string {
  const parts = [o.label];
  if (o.isCurrent) parts.push('Vigente');
  if (!o.hasConfig) parts.push('configuración parcial');
  if (o.sameRequestAs !== null) parts.push(`mismo pedido que la v${o.sameRequestAs}`);
  const when = formatRelative(o.createdAt);
  if (when) parts.push(when);
  return parts.join(' · ');
}

/** Texto corto de la opción elegida, el que se ve en el encabezado. */
export function shortOptionText(o: VersionOption | null, originId: string | null): string {
  if (originId === BLANK_ORIGIN) return 'En blanco';
  if (!o) return 'Elegí una versión';
  return [o.label, o.isCurrent ? 'Vigente' : '', !o.hasConfig ? 'parcial' : ''].filter(Boolean).join(' · ');
}

export function VersionOriginSelect({ options, originId, loading, onSelect }: {
  options: VersionOption[];
  originId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  if (options.length === 0) return null;
  const selected = options.find((o) => o.id === originId) ?? null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <Select value={originId ?? undefined} onValueChange={onSelect} disabled={loading}>
        <SelectTrigger
          aria-label="Versión de la que partir"
          className="data-[size=default]:h-7 w-auto min-w-0 max-w-full gap-1.5 border-[1px] border-border/70 bg-transparent px-2.5 py-0 text-xs font-medium text-foreground"
        >
          <span className="shrink-0 text-muted-foreground">Partir de:</span>
          <SelectValue placeholder="Elegí una versión">{shortOptionText(selected, originId)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.id} value={o.id}>{optionText(o)}</SelectItem>)}
          <SelectItem value={BLANK_ORIGIN}>Empezar en blanco</SelectItem>
        </SelectContent>
      </Select>
      {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
    </span>
  );
}

/** Solo si hay algo que decir: sin notas no se dibuja nada. */
export function VersionNotes({ notes, loading, onRetry, onRecreateVoice }: {
  notes: HydrationNote[];
  loading: boolean;
  onRetry: () => void;
  onRecreateVoice: (sampleId: string) => void;
}) {
  if (loading || notes.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5" aria-label="Qué se pudo recuperar">
      {notes.map((n) => (
        <li key={n.id} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs leading-relaxed text-muted-foreground">
          {n.tone === 'warning'
            ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-strong" aria-hidden />
            : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1">{n.text}</span>
          {n.action === 'retry' && (
            <Button type="button" size="sm" variant="outline" className="h-6 rounded-full px-2.5 text-xs" onClick={onRetry}><RotateCw className="mr-1 h-3 w-3" aria-hidden /> Reintentar</Button>
          )}
          {n.action === 'recreate-voice' && n.sampleId && (
            <Button type="button" size="sm" variant="outline" className="h-6 rounded-full px-2.5 text-xs" onClick={() => onRecreateVoice(n.sampleId as string)}><Mic2 className="mr-1 h-3 w-3" aria-hidden /> Recrear voz</Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Anuncio para lectores de pantalla: invisible, pero avisa cuando se lee y cuando termina la carga. */
export function VersionLiveRegion({ loading, originId, selected }: { loading: boolean; originId: string | null; selected: VersionOption | null }) {
  const text = loading ? 'Leyendo la configuración de la versión elegida.'
    : originId === BLANK_ORIGIN ? 'Planetas vacíos. Seguís creando otra versión de esta canción.'
    : selected ? `Configuración de la ${selected.label.toLowerCase()} cargada. Podés cambiar, agregar o quitar cualquier planeta.` : '';
  return <p className="sr-only" role="status" aria-live="polite">{text}</p>;
}

/** La canción de «Otra versión» no se puede usar: se explica por qué y se ofrece una salida (no se muestra un creador a medias). */
export function VersionUnavailable({ message, retryable, onRetry, onLibrary, onNewSong, title = 'No podemos crear otra versión' }: { message: string; retryable: boolean; onRetry: () => void; onLibrary: () => void; onNewSong: () => void; title?: string }) {
  return (
    <div role="alert" className="view-in mx-auto flex w-full max-w-xl flex-col items-start gap-4 rounded-2xl border border-border/70 bg-surface p-6">
      <CircleAlert className="h-6 w-6 text-amber-strong" aria-hidden />
      <h1 className="font-display text-xl font-extrabold">{title}</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap gap-2">
        {retryable && <Button type="button" className="rounded-full" onClick={onRetry}><RotateCw className="mr-2 h-4 w-4" aria-hidden /> Reintentar</Button>}
        <Button type="button" variant="outline" className="rounded-full" onClick={onLibrary}>Ir a mi biblioteca</Button>
        <Button type="button" variant="ghost" className="rounded-full" onClick={onNewSong}>Crear una canción nueva</Button>
      </div>
    </div>
  );
}
