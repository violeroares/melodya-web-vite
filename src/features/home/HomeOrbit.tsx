
/**
 * Home orbital (design-V2): las portadas del usuario giran en una elipse con
 * profundidad (más grandes, nítidas y opacas al frente; chicas y borrosas atrás)
 * alrededor del núcleo naranja, que es el CTA "Crear una canción".
 * Referencia: docs/design-V2/mockups/mobile-app/prototypes/estilo-visual-v2 (SCREENS.home).
 */
import React from 'react';
import { ArrowRight } from 'lucide-react';
import { navigate } from '@/lib/router';

/** Fotos de la órbita (public/home-orbit): una por posición. */
const PHOTOS = Array.from({ length: 12 }, (_, i) => `/home-orbit/${String(i + 1).padStart(2, '0')}.jpg`);

const COUNT = PHOTOS.length;
const SECONDS_PER_TURN = 30;
const ROT = [-14, 12, -6, 20, -18, 8, -22, 15, -9, 24, -4, 18];
const SPIN = [9, -12, 15, -8, 11, -14, 7, -10, 13, -9, 10, -13];

export function HomeOrbit() {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const coverRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const planetRef = React.useRef<HTMLSpanElement>(null);
  const coreRef = React.useRef<HTMLButtonElement>(null);
  const coreTextRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let t = 0.35 * SECONDS_PER_TURN; // arranque desfasado, como en el prototipo
    let last: number | null = null;
    let raf = 0;

    const draw = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      // Todo escala con el ancho disponible (así las portadas no se pisan entre sí ni con el núcleo cuando el escenario se achica):
      // portadas de ~17 % del ancho (entre 48 y 96 px) y núcleo de ~46 % (entre 128 y 192 px).
      const size = Math.max(48, Math.min(96, w * 0.17));
      const core = Math.max(128, Math.min(192, w * 0.46));
      const coreEl = coreRef.current;
      if (coreEl) coreEl.style.width = coreEl.style.height = `${core.toFixed(0)}px`;
      const coreText = coreTextRef.current;
      if (coreText) {
        coreText.style.fontSize = `${(core / 7.4).toFixed(1)}px`;
        coreText.style.lineHeight = `${(core / 6.8).toFixed(1)}px`;
      }
      const cx = w / 2;
      const cy = h / 2;
      // margen = media diagonal de la portada escalada (x1.1) y girada, para que no se corte en los bordes
      const margin = size * 0.8;
      const rx = w / 2 - margin;
      const ry = h / 2 - margin;
      const turn = (t / SECONDS_PER_TURN) * 2 * Math.PI;

      for (let i = 0; i < COUNT; i++) {
        const el = coverRefs.current[i];
        if (!el) continue;
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / COUNT + turn;
        const s = Math.sin(a);
        const near = (1 - s) / 2;
        const sc = 0.55 + 0.55 * near;
        const bl = Math.pow(1 - near, 1.6) * 3;
        el.style.width = el.style.height = `${size}px`;
        el.style.left = `${(cx + rx * Math.cos(a) - size / 2).toFixed(1)}px`;
        el.style.top = `${(cy + ry * s - size / 2).toFixed(1)}px`;
        el.style.transform = `scale(${sc.toFixed(3)}) rotate(${(ROT[i] + t * SPIN[i]).toFixed(1)}deg)`;
        el.style.filter = `blur(${bl.toFixed(2)}px)`;
        el.style.opacity = (0.28 + 0.72 * near).toFixed(3);
        el.style.zIndex = String(Math.round(near * 100));
      }

      const planet = planetRef.current;
      if (planet) {
        const pa = 0.9 + turn * 1.6;
        const ps = Math.sin(pa);
        const pn = (1 - ps) / 2;
        planet.style.left = `${(cx + rx * Math.cos(pa) - 6).toFixed(1)}px`;
        planet.style.top = `${(cy + ry * ps - 6).toFixed(1)}px`;
        planet.style.transform = `scale(${(0.6 + 0.6 * pn).toFixed(3)})`;
        planet.style.zIndex = String(Math.round(pn * 100));
      }
    };

    draw();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    ro?.observe(stage);

    if (!reduce) {
      const step = (now: number) => {
        if (last !== null) {
          t += Math.min(0.05, (now - last) / 1000);
          draw();
        }
        last = now;
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, []);

  return (
    <div ref={stageRef} className="relative isolate mx-auto mt-2 h-[420px] w-full max-w-3xl overflow-hidden sm:mt-4 sm:h-[540px]">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {PHOTOS.map((src, i) => (
          <div
            key={src}
            ref={(el) => {
              coverRefs.current[i] = el;
            }}
            className="absolute overflow-hidden rounded-lg shadow-lg will-change-transform"
          >
            <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
          </div>
        ))}
        <span ref={planetRef} className="absolute size-3 rounded-full bg-gold" />
      </div>

      <button
        ref={coreRef}
        type="button"
        onClick={() => navigate('/create')}
        aria-label="Crear una canción"
        className="group absolute left-1/2 top-1/2 z-[200] flex size-44 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-2 rounded-full bg-primary px-5 text-center text-primary-foreground transition-transform duration-200 hover:scale-[1.03] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground sm:size-48"
      >
        <span ref={coreTextRef} className="font-display text-2xl font-bold leading-[28px] tracking-tight sm:text-[26px]">Creá tu canción</span>
        <span className="flex size-9 items-center justify-center rounded-full bg-primary-foreground text-[#F3E5E2] transition-transform group-hover:translate-x-1">
          <ArrowRight className="h-4 w-4" aria-hidden />
        </span>
      </button>
    </div>
  );
}
