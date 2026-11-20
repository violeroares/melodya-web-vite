
/**
 * Barra de pestañas segmentada (mismo componente `seg fill` del mockup letra-input): una única píldora
 * deslizante marca la pestaña activa; scrollable en mobile y arrastrable con el mouse. La usan la
 * Biblioteca y el Perfil.
 */
import { useLayoutEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@/lib/utils';

export function SegmentedTabs<K extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  tabs: ReadonlyArray<{ key: K; label: string; icon: ComponentType<{ className?: string }> }>;
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  className?: string;
}) {
  /* Indicador deslizante: una sola "píldora" que se mueve (left/width) hasta la pestaña activa. */
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const el = tabRefs.current[value];
      if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const raf = requestAnimationFrame(() => setAnimate(true)); // la primera medición no se anima
    const list = listRef.current;
    const ro = typeof ResizeObserver !== 'undefined' && list ? new ResizeObserver(measure) : null;
    if (list) ro?.observe(list);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [value]);

  /* Arrastrar con el mouse para desplazar la barra cuando no entran todas las pestañas (en touch ya es nativo). */
  const dragged = useRef(false);
  const onListPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (e.pointerType !== 'mouse' || e.button !== 0 || !list || list.scrollWidth <= list.clientWidth) return;
    const startX = e.clientX;
    const startScroll = list.scrollLeft;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragged.current && Math.abs(dx) < 5) return;
      dragged.current = true;
      list.scrollLeft = startScroll - dx;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // el click del arrastre llega justo después del pointerup: se descarta en onClickCapture
      window.setTimeout(() => {
        dragged.current = false;
      }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  useLayoutEffect(() => {
    tabRefs.current[value]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [value]);

  return (
    <nav aria-label={ariaLabel} className={className}>
      <div
        ref={listRef}
        role="tablist"
        onPointerDown={onListPointerDown}
        onClickCapture={(e) => {
          if (dragged.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        className="relative flex gap-1 scrollbar-none select-none overflow-x-auto rounded-[28px] border-[1.5px] border-line p-1"
      >
        {thumb && (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-1 bottom-1 rounded-[22px] bg-selected motion-reduce:transition-none',
              animate && 'transition-[left,width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]'
            )}
            style={{ left: thumb.left, width: thumb.width }}
          />
        )}
        {tabs.map(({ key, label, icon: Icon }) => {
          const active = value === key;
          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(key)}
              className={cn(
                'relative z-[1] flex h-10 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-[22px] px-3 text-[12.5px] sm:h-11 sm:px-4 sm:text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                active ? 'font-bold text-on-selected' : 'font-medium text-foreground hover:bg-accent'
              )}
            >
              {active && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
