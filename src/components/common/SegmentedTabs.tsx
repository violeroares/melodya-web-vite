'use client';

/**
 * Barra de pestañas segmentada (mismo componente `seg fill` del mockup letra-input): una única píldora
 * deslizante marca la pestaña activa; scrollable en mobile y arrastrable con el mouse; la opción elegida muestra
 * su ícono. Es el selector de grupo de todo el sistema (Biblioteca, Perfil, Notificaciones, Actividad, Comunidad…).
 */
import { useLayoutEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SegmentedTabs<K extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
  variant = 'default',
  trailing,
  trailingClassName,
  iconOnly = false,
}: {
  /** `icon` se muestra solo en la opción elegida; `hint` es una segunda línea chica bajo el nombre (ej. «~1 min»). */
  tabs: ReadonlyArray<{ key: K; label: string; icon?: ComponentType<{ className?: string }>; hint?: string; count?: number }>;
  /** `null` = ninguna elegida (el indicador no se muestra). */
  value: K | null;
  /** Se llama también al tocar la opción ya elegida (quien lo use puede interpretarlo como «quitar»). */
  onChange: (key: K) => void;
  ariaLabel: string;
  className?: string;
  /** `trash`: el selector de la Papelera de design-V2 (borde al 50 %, texto al 62 %, activo en dorado con texto navy). */
  variant?: 'default' | 'trash';
  /** Contenido dentro del mismo contenedor, a la derecha de las opciones (ej. un buscador). */
  trailing?: ReactNode;
  trailingClassName?: string;
  /** Muestra siempre el ícono de cada opción y deja el nombre solo para lectores de pantalla (y como tooltip). */
  iconOnly?: boolean;
}) {
  const trash = variant === 'trash';
  /* Indicador deslizante: una sola "píldora" que se mueve (left/width) hasta la pestaña activa. */
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const el = value == null ? null : tabRefs.current[value];
      setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
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
    /* Centra la opción elegida moviendo SOLO la barra (scrollIntoView también movería la página y dejaría el contenedor cortado). */
    const list = listRef.current;
    const el = value == null ? null : tabRefs.current[value];
    if (!list || !el) return;
    const left = Math.max(0, Math.min(el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2, list.scrollWidth - list.clientWidth));
    list.scrollTo({ left, behavior: animate ? 'smooth' : 'auto' });
  }, [value]);

  return (
    <nav aria-label={ariaLabel} className={cn('min-w-0 max-w-full', className)}>
      {/* Como siempre: el borde y el relleno son del propio carril que se desliza, así la opción elegida queda recortada por el contenedor y nunca sale de él */}
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
          className={cn(
            'relative flex items-center gap-1 scrollbar-none select-none overflow-x-auto rounded-[28px] border-[1.5px] p-1',
            trash ? 'border-line/50' : 'border-line'
          )}
        >
          {thumb && (
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute top-1 bottom-1 rounded-[22px] motion-reduce:transition-none', trash ? 'bg-gold' : 'bg-selected',
                animate && 'transition-[left,width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]'
              )}
              style={{ left: thumb.left, width: thumb.width }}
            />
          )}
          {tabs.map(({ key, label, icon: Icon, hint, count }) => {
            const active = value === key;
            return (
              <button
                key={key}
                ref={(el) => {
                  tabRefs.current[key] = el;
                }}
                type="button"
                role="tab"
                title={iconOnly ? label : undefined}
                aria-selected={active}
                onClick={() => onChange(key)}
                className={cn(
                  'relative z-[1] flex shrink-0 items-center justify-center gap-1.5 rounded-[22px] px-3 text-[12.5px] sm:px-4 sm:text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                  trailing ? 'flex-none' : 'flex-1',
                  hint ? 'min-h-11 flex-col gap-0 py-1 leading-[1.2]' : 'h-10 sm:h-11',
                  trash && 'h-10 px-3.5 text-sm sm:h-10 sm:px-3.5 sm:text-sm',
                  active ? (trash ? 'font-bold text-[#131C33]' : 'font-bold text-on-selected') : trash ? 'font-medium text-foreground/60 hover:bg-accent' : 'font-medium text-foreground hover:bg-accent'
                )}
              >
                {iconOnly && Icon ? (
                  <>
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="sr-only">{label}</span>
                  </>
                ) : hint ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      {active && Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {label}
                    </span>
                    <span className={cn('text-xs leading-[1.2] font-medium', active ? 'opacity-90' : 'opacity-75')}>{hint}</span>
                  </>
                ) : (
                  <>
                    {active && Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                    {label}
                    {count != null && (
                      <span className="h-5 min-w-5 rounded-full bg-current/15 px-1.5 text-center text-xs leading-5 font-bold tabular-nums">{count}</span>
                    )}
                  </>
                )}
              </button>
            );
          })}
          {trailing && <div className={cn('shrink-0', trailingClassName)}>{trailing}</div>}
        </div>
    </nav>
  );
}
