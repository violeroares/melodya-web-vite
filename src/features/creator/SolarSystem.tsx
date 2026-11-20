
/**
 * Presentación del sistema solar: el centro es la canción y cada elemento es un planeta (un botón).
 *
 * Diseño pensado para la interacción, no para el efecto:
 *  • El orden del DOM es el orden lógico (centro → planetas → «+»). Todo es un <button> alcanzable con Tab.
 *  • En pantallas chicas los planetas son tarjetas en una grilla (sin posicionamiento absoluto); desde `md` se
 *    reparten sobre una órbita. Nada depende de hover, arrastre ni gestos.
 *  • El estado de cada planeta se dice con texto e icono, no solo con color. Las animaciones respetan reduced-motion.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { PenLine, Palette, Mic2, AudioLines, SlidersHorizontal, Sparkles, Plus, Minus, Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type PlanetId, type SongState, type Issue, type Capabilities, activePlanets, planetDef, summarize, songStatus, hasStyleInputs } from './song-model';
import { VinylDisc } from './VinylDisc';

const ICONS: Record<PlanetId, React.ElementType> = {
  composition: PenLine,
  style: Palette,
  voice: Mic2,
  reference: AudioLines,
  production: SlidersHorizontal,
  creativity: Sparkles,
};

/** Cada planeta lleva su color de elemento de design-V2 (sólido, con icono navy) además de icono y nombre. */
const TONES: Record<PlanetId, string> = {
  composition: 'bg-element-idea text-primary-foreground ring-[6px] ring-element-idea/20',
  style: 'bg-element-style text-primary-foreground ring-[6px] ring-element-style/20',
  voice: 'bg-element-lyrics text-primary-foreground ring-[6px] ring-element-lyrics/20',
  reference: 'bg-element-sound text-primary-foreground ring-[6px] ring-element-sound/20',
  production: 'bg-orbit-0 text-primary-foreground ring-[6px] ring-orbit-0/20',
  creativity: 'bg-accent-soft text-primary-foreground ring-[6px] ring-accent-soft/20',
};

/** Mismo color de cada planeta, sin el halo: para los iconos de la lista «Materiales». */
export const PLANET_DOT: Record<PlanetId, string> = {
  composition: 'bg-element-idea text-primary-foreground',
  style: 'bg-element-style text-primary-foreground',
  voice: 'bg-element-lyrics text-primary-foreground',
  reference: 'bg-element-sound text-primary-foreground',
  production: 'bg-orbit-0 text-primary-foreground',
  creativity: 'bg-accent-soft text-primary-foreground',
};

/* Decoración del sistema (misma que el hero de la landing): marcas doradas, destellos y lunas. Todo es aria-hidden. */
const TICKS = Array.from({ length: 90 }, (_, i) => {
  const a = (i * 2 * Math.PI) / 90, amp = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.41) * Math.cos(i * 0.17)), r1 = 46.5, len = 0.8 + 2.2 * amp;
  return { x1: 50 + r1 * Math.cos(a), y1: 50 + r1 * Math.sin(a), x2: 50 + (r1 + len) * Math.cos(a), y2: 50 + (r1 + len) * Math.sin(a), o: 0.3 + 0.4 * amp };
});
const SPARK = 'M0-1C.1-.28.28-.1 1 0 .28.1.1.28 0 1-.1.28-.28.1-1 0-.28-.1-.1-.28 0-1Z';
const SPARKS: Array<[number, number, number, string]> = [[6, 10, 1.6, '0s'], [93, 14, 1.3, '1.2s'], [5, 88, 1.2, '2.4s'], [94, 90, 1.6, '3.6s']];

export const planetIcon = (id: PlanetId) => ICONS[id];

function planetState(issues: Issue[], id: PlanetId, empty: boolean): 'error' | 'warning' | 'ok' | 'optional' {
  const mine = issues.filter((i) => i.planet === id);
  if (mine.some((i) => i.severity === 'error')) return 'error';
  if (mine.some((i) => i.severity === 'warning')) return 'warning';
  return empty ? 'optional' : 'ok';
}

const STATE_TEXT = { error: 'Falta algo', warning: 'Revisar', ok: 'Listo', optional: 'Opcional' } as const;

/** Posición de cada planeta en la órbita: 2 por órbita, repartidos como al azar pero fijos, con su etiqueta siempre debajo del
 *  círculo. Hay dos juegos de ángulos (pantallas chicas y desde `sm`) porque cambian los tamaños y hay que evitar que se pisen.
 *  El botón «+» no usa estos lugares: tiene el suyo, fijo. `orbit` indexa las órbitas; los ángulos van en grados (0 = derecha, 90 = abajo). */
type Slot = { orbit: 0 | 1 | 2; angle: number; orbitSm?: 0 | 1 | 2; angleSm: number };
/* Posiciones calculadas para que, con hasta 6 elementos más el «+» fijo, ningún círculo ni cartel se pise entre sí ni con el centro
   (escritorio 480–640 px de lado; celular desde 360 px). Los primeros lugares son los que se usan con menos elementos. */
const SLOTS: Slot[] = [
  { orbit: 0, angle: 30, orbitSm: 0, angleSm: 50 },
  { orbit: 1, angle: 160, orbitSm: 2, angleSm: 310 },
  { orbit: 2, angle: 300, orbitSm: 2, angleSm: 270 },
  { orbit: 1, angle: 200, orbitSm: 0, angleSm: 160 },
  { orbit: 1, angle: 250, orbitSm: 2, angleSm: 230 },
  { orbit: 1, angle: 340, orbitSm: 2, angleSm: 130 },
];

/** Etiqueta del planeta (design-V2 · project-home `.lab`): tarjeta chica translúcida con el nombre en dorado y mayúsculas arriba
 *  y el detalle abajo. Va siempre centrada debajo del círculo. */
function PlanetLabel({ icon: Icon, label, detail, className }: { icon: React.ElementType; label: string; detail: string; className?: string }) {
  return (
    <span
      className={cn(
        'flex w-max max-w-[7rem] flex-col rounded-[10px] border px-2.5 pt-1 pb-1.5 leading-[1.2] backdrop-blur-[8px] sm:max-w-[10.5rem] sm:rounded-[14px] sm:px-3.5 sm:pt-[7px] sm:pb-2',
        'border-[rgba(11,18,34,.10)] bg-[rgba(255,253,247,.8)] shadow-[0_8px_18px_-10px_rgba(60,45,20,.32)]',
        'dark:border-[rgba(232,211,162,.15)] dark:bg-[rgba(7,11,24,.66)] dark:shadow-none',
        'absolute top-full left-1/2 z-10 mt-1.5 -translate-x-1/2 items-center text-center',
        className
      )}
      data-launch="label"
    >
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-lyric-tag sm:text-[11px]">
        <Icon className="h-[11px] w-[11px] shrink-0 sm:h-3 sm:w-3" aria-hidden />
        {label}
      </span>
      <span className="mt-0.5 line-clamp-2 font-display text-[14.5px] font-medium tracking-[-0.01em] text-foreground @max-[36rem]:hidden">{detail}</span>
    </span>
  );
}

export function SolarSystem({ song, caps, issues, onOpenPlanet, onOpenCatalog, registerRef, launching, onLaunchEnd }: {
  /** Animación de lanzamiento (al tocar «Crear mi canción»): el sistema se recoge y se forma el disco; al terminar avisa con `onLaunchEnd`. */
  launching?: boolean;
  onLaunchEnd?: () => void;
  song: SongState;
  caps: Capabilities;
  issues: Issue[];
  onOpenPlanet: (id: PlanetId) => void;
  onOpenCatalog: () => void;
  /** Para devolver el foco al planeta (o al «+») al cerrar un panel. */
  registerRef: (key: PlanetId | 'add', el: HTMLButtonElement | null) => void;
}) {
  const ids = activePlanets(song);
  const summary = summarize(song, caps);
  const status = songStatus(song, caps);
  const R = 36; // radio de la órbita media, en % del contenedor
  const ORBIT_RADII = [R * 0.72, R, R * 1.22]; // coinciden con los tres anillos exteriores

  /* ── Animación de lanzamiento: «Generar canción · animación» del prototipo (design-V2), línea de tiempo de 4,8 s ──
     Los planetas empiezan a girar y se van hacia el borde del círculo de afuera mientras los anillos se recogen en surcos y aparece el disco;
     el centro se vuelve la etiqueta naranja, el disco acelera, se acerca y se desvanece. El resto (ejes, adornos, etiquetas) se apaga al principio. */
  const boxRef = React.useRef<HTMLDivElement>(null);
  const discRef = React.useRef<HTMLDivElement>(null);
  const sheenRef = React.useRef<HTMLDivElement>(null);
  const holeRef = React.useRef<HTMLSpanElement>(null);
  const labelRef = React.useRef<HTMLSpanElement>(null);
  const endRef = React.useRef(onLaunchEnd);
  React.useEffect(() => { endRef.current = onLaunchEnd; }, [onLaunchEnd]);
  React.useEffect(() => {
    if (!launching) return;
    const box = boxRef.current;
    const disc = discRef.current;
    const sheen = sheenRef.current;
    const hole = holeRef.current;
    const label = labelRef.current;
    if (!box || !disc || !hole || !label) return;

    const DUR = 4.8;
    const S = box.clientWidth;
    const c = S / 2;
    // El prototipo está dibujado con el anillo exterior en 154 px: se escala todo a esa proporción
    const k = (S * ((R * 1.22) / 100)) / 154;
    const Rd = 158 * k;
    const Lr = 50 * k;
    const RIM = 150 * k;
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const eOut = (x: number) => 1 - Math.pow(1 - x, 3);
    const eIn = (x: number) => x * x * x;
    const eIO = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

    const q = <T extends Element>(sel: string) => Array.from(box.querySelectorAll<T>(sel));
    const fades = q<HTMLElement | SVGElement>('[data-launch="deco"]');
    const labs = q<HTMLElement>('[data-launch="label"]');
    const axes = box.querySelector<SVGElement>('[data-launch="axes"]');
    const rings = q<SVGCircleElement>('[data-launch="ring"]').map((el) => ({ el, i: Number(el.dataset.i), r: (Number(el.dataset.r) / 100) * S }));
    const core = box.querySelector<HTMLElement>('[data-launch="core"]');
    const coreBox = box.querySelector<HTMLElement>('[data-launch="core-box"]');
    const coreSize = core ? core.offsetWidth : 100;
    const bRect = box.getBoundingClientRect();
    const orbs = q<HTMLElement>('ul > li').map((el) => {
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - bRect.left - c;
      const dy = r.top + r.height / 2 - bRect.top - c;
      return { el, a: Math.atan2(dy, dx), r: Math.hypot(dx, dy) };
    });

    // El disco vive en una capa fija: su centro es el del sistema solar en pantalla; crece hasta cubrir la esquina más lejana
    const cx = bRect.left + c;
    const cy = bRect.top + c;
    const farthest = Math.max(Math.hypot(cx, cy), Math.hypot(window.innerWidth - cx, cy), Math.hypot(cx, window.innerHeight - cy), Math.hypot(window.innerWidth - cx, window.innerHeight - cy));
    const Zmax = Math.max(5.4, (farthest / Rd) * 1.08);
    disc.style.left = `${cx - Rd}px`;
    disc.style.top = `${cy - Rd}px`;
    disc.style.width = disc.style.height = `${2 * Rd}px`;
    label.style.left = `${cx - Lr}px`;
    label.style.top = `${cy - Lr}px`;
    label.style.width = label.style.height = `${2 * Lr}px`;
    hole.style.left = `${cx - 5}px`;
    hole.style.top = `${cy - 5}px`;
    // Mientras dura, la página no se desplaza (la capa del disco está anclada a la pantalla) ni muestra barras por lo que crece
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    if (coreBox) coreBox.style.zIndex = '5';
    box.querySelector<SVGElement>('svg')?.style.setProperty('z-index', '4');

    const set = (t: number) => {
      const Z = lerp(1, Zmax, eIn(seg(t, 3.9, 4.7)));
      const endf = 1 - seg(t, 4.3, 4.75);
      const away = seg(t, 0.1, 0.5);
      fades.forEach((e) => { e.style.opacity = (1 - away).toFixed(3); });
      labs.forEach((e) => { e.style.opacity = (1 - seg(t, 0, 0.3)).toFixed(3); });
      const conv = eIO(seg(t, 0.3, 1.7));
      const dis = seg(t, 1.6, 2.05);
      const rot = 0.7 * eOut(seg(t, 0, 1.4));
      orbs.forEach((o) => {
        const a = o.a + rot;
        const rad = lerp(o.r, RIM, conv);
        o.el.style.left = `${(c + rad * Math.cos(a)).toFixed(1)}px`;
        o.el.style.top = `${(c + rad * Math.sin(a)).toFixed(1)}px`;
        o.el.style.scale = (1 - 0.75 * dis * dis).toFixed(3);
        o.el.style.opacity = (1 - dis).toFixed(3);
      });
      const rp = eIO(seg(t, 0.5, 1.8));
      rings.forEach((o) => {
        const target = Lr * 1.3 + (o.i * (Rd * 0.9 - Lr * 1.3)) / Math.max(1, rings.length - 1);
        o.el.style.transformOrigin = '50px 50px';
        o.el.style.transform = `scale(${(lerp(1, target / o.r, rp) * Z).toFixed(4)})`;
        o.el.style.opacity = ((1 - 0.5 * seg(t, 1.8, 2.2)) * endf).toFixed(3);
      });
      if (axes) axes.style.opacity = (1 - seg(t, 0.2, 0.9)).toFixed(3);
      const W = 160;
      const R_ = 0.8;
      const tau = Math.max(0, t - 1.9);
      const spin = tau < R_ ? (W * tau * tau) / (2 * R_) : W * (tau - R_ / 2);
      disc.style.opacity = (seg(t, 0.8, 1.5) * (1 - seg(t, 4.45, 4.8))).toFixed(3);
      disc.style.transform = `scale(${(lerp(0.5, 1, eOut(seg(t, 0.8, 1.9))) * Z).toFixed(4)}) rotate(${spin.toFixed(1)}deg)`;
      if (sheen) sheen.style.transform = `rotate(${(spin * 0.4).toFixed(1)}deg)`;
      const cp = eIO(seg(t, 0.6, 1.8));
      if (core) {
        // El centro pasa a ser la etiqueta naranja; cuando termina de transformarse, la etiqueta de la capa fija toma la posta (así puede crecer sin recortes)
        core.style.transform = `scale(${lerp(1, (Lr * 2) / coreSize, cp).toFixed(4)}) rotate(${spin.toFixed(1)}deg)`;
        core.style.background = cp > 0.5 ? '#FF6B4D' : '';
        core.style.opacity = t < 1.8 ? '1' : '0';
        Array.from(core.children).forEach((ch) => { (ch as HTMLElement).style.opacity = (1 - seg(t, 0.6, 1.1)).toFixed(3); });
      }
      label.style.opacity = t < 1.8 ? '0' : endf.toFixed(3);
      label.style.transform = `scale(${Z.toFixed(4)}) rotate(${spin.toFixed(1)}deg)`;
      hole.style.opacity = (seg(t, 1.6, 2.0) * endf).toFixed(3);
      hole.style.transform = `scale(${Z.toFixed(3)})`;
    };

    set(0);
    let raf = 0;
    let t0: number | null = null;
    const loop = (now: number) => {
      if (t0 === null) t0 = now;
      const t = (now - t0) / 1000;
      set(Math.min(t, DUR));
      if (t >= DUR) {
        endRef.current?.();
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.documentElement.style.overflow = prevOverflow;
      // Si el lanzamiento se corta (p. ej. falló el pedido), el sistema solar vuelve a su estado normal
      fades.forEach((e) => { e.style.opacity = ''; });
      labs.forEach((e) => { e.style.opacity = ''; });
      orbs.forEach((o) => { o.el.style.left = ''; o.el.style.top = ''; o.el.style.scale = ''; o.el.style.opacity = ''; });
      rings.forEach((o) => { o.el.style.transform = ''; o.el.style.transformOrigin = ''; o.el.style.opacity = ''; });
      if (axes) axes.style.opacity = '';
      if (core) {
        core.style.transform = ''; core.style.background = ''; core.style.opacity = '';
        Array.from(core.children).forEach((ch) => { (ch as HTMLElement).style.opacity = ''; });
      }
      if (coreBox) coreBox.style.zIndex = '';
      box.querySelector<SVGElement>('svg')?.style.removeProperty('z-index');
    };
  }, [launching, R]);

  /* El «+» no depende de cuántos elementos hay: queda fijo abajo y centrado, sobre la última órbita */
  const ADD_SLOT: Slot = { orbit: 2, angle: 90, angleSm: 90 };
  const pos = (i: number, fixed?: Slot) => {
    const slot = fixed ?? SLOTS[Math.min(i, SLOTS.length - 1)];
    const at = (orbit: number, deg: number) => {
      const r = ORBIT_RADII[orbit];
      const a = deg * (Math.PI / 180);
      return [(50 + r * Math.cos(a)).toFixed(2), (50 + r * Math.sin(a)).toFixed(2)];
    };
    const [x, y] = at(slot.orbit, slot.angle);
    const [xs, ys] = at(slot.orbitSm ?? slot.orbit, slot.angleSm);
    return { '--x': `${x}%`, '--y': `${y}%`, '--xs': `${xs}%`, '--ys': `${ys}%` } as React.CSSProperties;
  };

  return (
    <section aria-labelledby="solar-title" className="relative pb-16 sm:pb-[4.5rem]">
      <h2 id="solar-title" className="sr-only">Elementos de tu canción</h2>
      <div ref={boxRef} className="@container relative mx-auto aspect-square w-full max-w-[min(640px,max(480px,calc(100dvh-17rem)))]">
        {/* Órbitas y decoración: puramente decorativas */}
        <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" fill="none">
          <g data-launch="axes" stroke="currentColor" strokeOpacity=".14" strokeWidth=".14"><line x1="0" y1="50" x2="100" y2="50" /><line x1="50" y1="0" x2="50" y2="100" /></g>
          {/* Anillos grises que se desvanecen hacia afuera (--m-orbit-0…3) */}
          <circle data-launch="ring" data-i="0" data-r={R * 0.5} cx="50" cy="50" r={R * 0.5} stroke="var(--m-orbit-0)" strokeWidth="0.28" />
          <circle data-launch="ring" data-i="1" data-r={R * 0.72} cx="50" cy="50" r={R * 0.72} stroke="var(--m-orbit-1)" strokeWidth="0.24" />
          <circle data-launch="ring" data-i="2" data-r={R} cx="50" cy="50" r={R} stroke="var(--m-orbit-2)" strokeWidth="0.2" />
          <circle data-launch="ring" data-i="3" data-r={R * 1.22} cx="50" cy="50" r={R * 1.22} stroke="var(--m-orbit-3)" strokeWidth="0.16" />
          <g data-launch="deco" stroke="var(--m-gold)" strokeWidth=".4" strokeLinecap="round">
            {TICKS.map((t, i) => <line key={i} x1={t.x1.toFixed(2)} y1={t.y1.toFixed(2)} x2={t.x2.toFixed(2)} y2={t.y2.toFixed(2)} strokeOpacity={t.o.toFixed(2)} />)}
          </g>
          <g data-launch="deco" fill="var(--m-gold)">
            {SPARKS.map(([x, y, sc, d], i) => <path key={i} d={SPARK} transform={`translate(${x} ${y}) scale(${sc})`} className="motion-safe:animate-pulse" style={{ animationDelay: d, animationDuration: '5s' }} />)}
          </g>
        </svg>
        {/* Lunas: dos puntos que orbitan despacio sobre los anillos interiores (no son interactivos) */}
        <div aria-hidden data-launch="deco" className="pointer-events-none absolute left-1/2 top-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 motion-safe:animate-[spin_120s_linear_infinite]" style={{ width: `${R}%` }}>
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-element-sound" />
        </div>
        <div aria-hidden data-launch="deco" className="pointer-events-none absolute left-1/2 top-1/2 aspect-square -translate-x-1/2 -translate-y-1/2 motion-safe:animate-[spin_200s_linear_infinite_reverse]" style={{ width: `${R * 1.44}%` }}>
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-element-lyrics" />
        </div>

        {/* Centro: la canción */}
        <div data-launch="core-box" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div
            data-launch="core"
            className={cn(
              'relative flex h-[6.5rem] w-[6.5rem] flex-col items-center justify-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--background)_55%,var(--surface))] p-2 dark:bg-surface text-center text-foreground sm:h-[9.5rem] sm:w-[9.5rem] sm:gap-1 sm:p-4',
              status.ready ? 'shadow-[0_0_0_2.5px_var(--success)]' : 'shadow-[0_0_0_2.5px_var(--m-gold)]'
            )}
            role="group"
            aria-label={`Mi canción. ${status.ready ? 'Lista para crear.' : `Falta: ${status.missing[0]}`}`}
          >
            {/* Halo naranja que respira detrás del centro */}
            <span aria-hidden className="pointer-events-none absolute -inset-[60%] -z-10 rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--m-accent)_24%,transparent)_0,transparent_62%)] motion-safe:animate-pulse [animation-duration:6s]" />
            <p className="line-clamp-2 font-display text-sm font-bold leading-tight sm:text-base">{status.ready ? 'Mi canción' : song.composition.title.trim() || 'Mi canción'}</p>
            <p className={cn('mt-0.5 inline-flex flex-col items-center gap-1 text-center text-[10px] leading-tight font-semibold sm:flex-row sm:gap-1.5 sm:text-[11px]', status.ready ? 'text-success' : 'text-label dark:text-gold')}>
              {status.ready ? (
                <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success text-background sm:h-5 sm:w-5">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              ) : <CircleAlert className="h-3 w-3" aria-hidden />}
              {status.ready ? 'Lista para crear' : 'Falta completar'}
            </p>
          </div>
        </div>

        {/* Planetas + «+» */}
        <ul className="absolute inset-0">
          {ids.map((id, i) => {
            const Icon = ICONS[id];
            const def = planetDef(id);
            const st = planetState(issues, id, id === 'style' && !hasStyleInputs(song));
            return (
              <li key={id} style={pos(i)} className="absolute left-[var(--xs)] top-[var(--ys)] -translate-x-1/2 -translate-y-1/2 sm:left-[var(--x)] sm:top-[var(--y)]">
                <button
                  type="button"
                  ref={(el) => registerRef(id, el)}
                  onClick={() => onOpenPlanet(id)}
                  aria-haspopup="dialog"
                  aria-label={`${def.label}. ${summary[id]}. ${STATE_TEXT[st]}. Tocá para editar.`}
                  className="group relative flex w-11 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)] focus-visible:outline-2 focus-visible:outline-foreground sm:w-16"
                >
                  <span className={cn('relative flex h-11 w-11 items-center justify-center rounded-full sm:h-16 sm:w-16 transition-[transform,box-shadow] duration-200 group-hover:scale-110 group-hover:ring-[10px] group-active:scale-100 motion-reduce:transition-none motion-reduce:group-hover:scale-100', TONES[id])}>
                    <Icon className="h-5 w-5 sm:h-7 sm:w-7" aria-hidden />
                    <span
                      className={cn(
                        'absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background sm:h-5 sm:w-5',
                        st === 'error' ? 'bg-destructive text-background' : st === 'warning' ? 'bg-gold text-on-gold' : st === 'optional' ? 'bg-surface-2 text-muted-foreground' : 'bg-success text-background'
                      )}
                      aria-hidden
                    >
                      {st === 'error' ? <CircleAlert className="h-3 w-3" /> : st === 'warning' ? <TriangleAlert className="h-3 w-3" /> : st === 'optional' ? <Minus className="h-3 w-3" /> : <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                  </span>
                  <PlanetLabel icon={Icon} label={def.label} detail={summary[id]} />
                </button>
              </li>
            );
          })}
          <li style={pos(ids.length, ADD_SLOT)} className="absolute left-[var(--xs)] top-[var(--ys)] -translate-x-1/2 -translate-y-1/2 sm:left-[var(--x)] sm:top-[var(--y)]">
            <button
              type="button"
              ref={(el) => registerRef('add', el)}
              onClick={onOpenCatalog}
              aria-haspopup="dialog"
              aria-label="Agregar un elemento a tu canción: voz, referencia de audio, producción o creatividad"
              className="group relative flex w-11 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)] focus-visible:outline-2 focus-visible:outline-foreground sm:w-16"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-dashed border-gold sm:h-16 sm:w-16 bg-surface text-lyric-tag transition-[transform,background-color] duration-200 group-hover:scale-110 group-hover:bg-accent motion-reduce:group-hover:scale-100">
                <Plus className="h-5 w-5 sm:h-7 sm:w-7" aria-hidden />
              </span>
              <PlanetLabel icon={Plus} label="Agregar" detail="Más elementos" />
            </button>
          </li>
        </ul>
      </div>
      {/* Lanzamiento: el disco, la etiqueta y el agujero van en una capa fija sobre toda la pantalla (portal), para que al crecer no los recorte ningún contenedor */}
      {launching && typeof document !== 'undefined' && createPortal(
        <div aria-hidden className="pointer-events-none fixed inset-0 z-[80] overflow-hidden">
          <div ref={discRef} className="absolute opacity-0" style={{ zIndex: 1 }}>
            <VinylDisc plain sheenRef={sheenRef} className="absolute inset-0" />
          </div>
          <span ref={labelRef} className="absolute rounded-full opacity-0" style={{ zIndex: 2, background: '#FF6B4D' }} />
          <span ref={holeRef} className="absolute size-[10px] rounded-full bg-[#03050B] opacity-0" style={{ zIndex: 3 }} />
        </div>,
        document.body
      )}
    </section>
  );
}
