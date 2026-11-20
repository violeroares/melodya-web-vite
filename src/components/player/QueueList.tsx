
/**
 * MELODYA WEB — QueueList: lista de cola compartida por el Sheet del PlayerBar
 * y la pestaña "Cola" del reproductor expandido.
 *
 * Reordenar la cola:
 *  • Drag & drop (HTML5, desktop): agarrás la fila y la soltás arriba/abajo de
 *    otra; una línea ámbar indica dónde va a caer. El tema en curso no se
 *    arrastra (la fila queda fija) para no "perder" lo que suena.
 *  • Botones ↑/↓ (touch/teclado): la fila sube o baja una posición; están
 *    ocultos hasta hover/focus en desktop y siempre visibles en touch.
 * También: quitar de la cola, saltar a una pista y filtrar por título/artista
 * (útil con la radio, que va sumando páginas). Con filtro activo el
 * reordenado se deshabilita (los índices visibles no son los de la cola).
 */
import React, { useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Search, X } from 'lucide-react';
import { usePlayerStore, type PlayerTrack } from '@/stores/player';
import { cn } from '@/lib/utils';
import { CoverArt, EqualizerBars } from '@/components/common';
import { formatDuration } from '@/hooks';

/** Posición del indicador de drop dentro de una fila. */
type DropHint = { index: number; above: boolean } | null;

export function QueueList({ emptyLabel = 'La cola está vacía. Tocá cualquier canción para empezar.' }: { emptyLabel?: string }) {
  const { track, queue, play, removeFromQueue, moveInQueue } = usePlayerStore();
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  /* Filtro por título/artista (solo visible con colas de 5+ temas). */
  const [filter, setFilter] = useState('');
  /* Índice fuente en coordenadas de la lista original durante el drag. */
  const dragFrom = useRef<number | null>(null);

  const q = filter.trim().toLowerCase();
  const filtering = q.length > 0;
  const rows = useMemo(() => {
    if (!q) return queue.map((t, i) => ({ t, i }));
    return queue
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
  }, [queue, q]);

  if (queue.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const currentIdx = track ? queue.findIndex((t) => t.id === track.id && t.audioUrl === track.audioUrl) : -1;

  /* ── Drag & drop: traducir el índice destino a coordenadas de la lista ──
     El navegador solo da el elemento bajo el puntero; con from conocemos el
     desplazamiento para calcular dónde cae la pista movida. */
  const onDragStart = (e: React.DragEvent, i: number) => {
    dragFrom.current = i;
    setDragging(i);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(i)); // Firefox requiere datos
    } catch {
      /* noop */
    }
  };

  const onDragEnd = () => {
    dragFrom.current = null;
    setDragging(null);
    setDropHint(null);
  };

  /** Índice (en la lista SIN la pista movida) donde caería la pista movida. */
  const targetIndex = (over: number, above: boolean, from: number): number => {
    if (from < over) {
      // La pista viene de arriba: al sacarla, los índices se corren 1 menos.
      return above ? over - 1 : over;
    }
    return above ? over : over + 1;
  };

  const onDragOverRow = (e: React.DragEvent, i: number) => {
    if (dragFrom.current === null || dragFrom.current === i) {
      setDropHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropHint({ index: i, above: e.clientY < rect.top + rect.height / 2 });
  };

  const onDropRow = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (from === null || from === i) {
      onDragEnd();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    const to = targetIndex(i, above, from);
    moveInQueue(from, to);
    onDragEnd();
  };

  /* Botones ↑/↓: mover una posición; también sirven como fallback accesible
     del drag & drop (teclado y touch). */
  const move = (i: number, delta: 1 | -1) => {
    const to = i + delta;
    if (to < 0 || to >= queue.length) return;
    moveInQueue(i, to);
  };

  return (
    <div className="flex flex-col">
      {/* Filtro (colas de 5+): encontrar un tema sin scrollear la radio */}
      {queue.length >= 5 && (
        <div className="queue-filter mx-1 mb-2 flex items-center gap-2 rounded-full border border-border/70 bg-surface-2/60 px-3 py-1.5 transition-colors focus-within:border-amber/50">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrar en la cola…"
            aria-label="Filtrar canciones de la cola por título o artista"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
          />
          {filtering && (
            <>
              <span className="shrink-0 text-[10px] font-bold text-amber-strong tabular-nums" aria-live="polite">
                {rows.length} de {queue.length}
              </span>
              <button
                type="button"
                onClick={() => setFilter('')}
                aria-label="Limpiar el filtro de la cola"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </>
          )}
        </div>
      )}
      {filtering && rows.length > 0 && (
        <p className="px-3 pb-1 text-[10px] text-muted-foreground">Filtro activo: reordenar está pausado hasta que lo limpies.</p>
      )}
    <ol className="-ml-2 space-y-2" aria-label="Cola de reproducción">
      {rows.map(({ t, i: origIdx }) => {
        const isCurrent = track && t.id === track.id && t.audioUrl === track.audioUrl;
        /* Con filtro activo no se reordena: los índices visibles no son los de la cola. */
        const reorderable = !isCurrent && !filtering;
        const hint = dropHint && dropHint.index === origIdx ? dropHint : null;
        const showLineAbove = hint?.above && dragging !== origIdx;
        const showLineBelow = hint && !hint.above && dragging !== origIdx;
        return (
          <li key={`${t.id}-${t.audioUrl}`} className="relative">
            {showLineAbove && <span aria-hidden className="queue-drop-line absolute inset-x-2 -top-[5px] z-[2]" />}
            <div
              draggable={reorderable}
              onDragStart={reorderable ? (e) => onDragStart(e, origIdx) : undefined}
              onDragEnd={reorderable ? onDragEnd : undefined}
              onDragOver={reorderable ? (e) => onDragOverRow(e, origIdx) : undefined}
              onDrop={reorderable ? (e) => onDropRow(e, origIdx) : undefined}
              className={cn(
                'group/row flex items-center gap-1 rounded-l-none rounded-r-full transition-colors',
                /* La que suena es la tarjeta azul del reproductor inferior; el resto, cápsulas suaves */
                isCurrent ? 'bg-voice text-on-voice' : 'bg-surface-2/60 hover:bg-surface-2',
                reorderable && 'sm:cursor-grab',
                dragging === origIdx && 'queue-row-dragging'
              )}
            >
              {/* Agarradero (desktop): pista visual de que la fila se puede arrastrar */}
              {!isCurrent && (
                <span
                  aria-hidden
                  className="hidden h-6 w-4 shrink-0 items-center justify-center text-muted-foreground/50 opacity-0 transition-opacity group-hover/row:opacity-100 sm:flex"
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
              )}
              <button
                onClick={() => play(t, queue)}
                className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-l-none rounded-r-full py-2 pl-5 pr-4 text-left focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-gold"
                aria-label={`${isCurrent ? 'Sonando: ' : 'Reproducir '}${t.title}, de ${t.artist}`}
                aria-current={isCurrent ? 'true' : undefined}
              >
                <span className={cn('w-5 shrink-0 text-center text-xs tabular-nums', isCurrent ? 'text-gold' : 'text-muted-foreground')}>
                  {isCurrent ? <EqualizerBars className="h-3 mx-auto" /> : origIdx + 1}
                </span>
                <CoverArt id={t.id} src={t.coverUrl} alt="" className="size-11 shrink-0" rounded="rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-[15px] font-bold">{t.title}</span>
                  <span className={cn('block truncate text-xs', isCurrent ? 'opacity-80' : 'text-muted-foreground')}>{t.artist}</span>
                </span>
                {t.durationSec ? (
                  <span className={cn('shrink-0 text-[11px] tabular-nums', isCurrent ? 'opacity-80' : 'text-muted-foreground')}>{formatDuration(t.durationSec)}</span>
                ) : null}
              </button>
              {reorderable ? (
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => move(origIdx, -1)}
                    disabled={origIdx === 0}
                    aria-label={`Subir ${t.title} en la cola`}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-20 disabled:hover:bg-transparent max-sm:opacity-100"
                  >
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(origIdx, 1)}
                    disabled={origIdx === queue.length - 1}
                    aria-label={`Bajar ${t.title} en la cola`}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-20 disabled:hover:bg-transparent max-sm:opacity-100"
                  >
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeFromQueue(t)}
                    aria-label={`Quitar ${t.title} de la cola`}
                    className="mr-1.5 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all hover:bg-surface-2 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100 max-sm:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
              ) : !isCurrent ? (
                /* Filtrando: solo se puede quitar (sin reordenar). */
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => removeFromQueue(t)}
                    aria-label={`Quitar ${t.title} de la cola`}
                    className="mr-1.5 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-surface-2 hover:text-destructive max-sm:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
            {showLineBelow && <span aria-hidden className="queue-drop-line absolute inset-x-2 -bottom-[5px] z-[2]" />}
          </li>
        );
      })}
      {filtering && rows.length === 0 && (
        <li className="px-4 py-6 text-center text-xs text-muted-foreground">
          Nada en la cola coincide con “{filter.trim()}”.
        </li>
      )}
    </ol>
    </div>
  );
}
