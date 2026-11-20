
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ── Carrusel horizontal (el padding con margen negativo equivalente deja lugar para los aros y sombras de las tarjetas, que si no se recortan por el overflow) : gesto táctil nativo (scroll-snap) + flechas sólo en pantallas con puntero ── */
export function Rail({ labelId, arrowClassName, children }: { labelId: string; arrowClassName?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ active: false, moved: false, startX: 0, startLeft: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  const scrollBy = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: reduce ? 'auto' : 'smooth' });
  };

  /* Con mouse (p. ej. el modo responsivo del navegador) no hay gesto táctil: se arrastra el carrusel con el puntero. */
  const onPointerDown = (e: React.PointerEvent<HTMLUListElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !ref.current) return;
    drag.current = { active: true, moved: false, startX: e.clientX, startLeft: ref.current.scrollLeft };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLUListElement>) => {
    const d = drag.current;
    if (!d.active || !ref.current) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) > 5) {
      d.moved = true;
      setDragging(true);
      ref.current.setPointerCapture(e.pointerId);
    }
    if (d.moved) ref.current.scrollLeft = d.startLeft - dx;
  };
  const endDrag = () => {
    if (!drag.current.active) return;
    drag.current.active = false;
    if (drag.current.moved) setDragging(false);
  };

  return (
    <div className="group/rail relative">
      <ul
        ref={ref}
        onScroll={measure}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={(e) => {
          if (drag.current.moved) {
            e.preventDefault();
            e.stopPropagation();
            drag.current.moved = false;
          }
        }}
        aria-labelledby={labelId}
        className={cn(dragging && 'cursor-grabbing snap-none select-none', 'scrollbar-none -mx-4 -mt-1.5 -mb-1.5 flex snap-x snap-proximity gap-3 overflow-x-auto scroll-px-4 px-4 pt-1.5 pb-2.5 sm:-mx-6 sm:gap-4 sm:scroll-px-6 sm:px-6 md:-mx-1.5 md:scroll-px-1.5 md:px-1.5')}
      >
        {children}
      </ul>
      {(['start', 'end'] as const).map((side) => {
        const hidden = side === 'start' ? edge.start : edge.end;
        return (
          <button
            key={side}
            type="button"
            tabIndex={hidden ? -1 : 0}
            aria-hidden={hidden}
            aria-label={side === 'start' ? 'Ver anteriores' : 'Ver más'}
            onClick={() => scrollBy(side === 'start' ? -1 : 1)}
            className={cn(
              'absolute z-10 hidden size-11 items-center justify-center rounded-full border-[1.5px] border-line bg-background text-foreground transition-colors hover:bg-accent focus-visible:border-foreground focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)] focus-visible:outline-none md:flex',
              arrowClassName ?? 'top-[calc(50%-1.5rem)]',
              side === 'start' ? '-left-3' : '-right-3',
              hidden && 'pointer-events-none opacity-0'
            )}
          >
            {side === 'start' ? <ChevronLeft className="h-5 w-5" aria-hidden /> : <ChevronRight className="h-5 w-5" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
