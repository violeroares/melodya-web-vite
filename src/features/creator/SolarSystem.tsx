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
import { PenLine, Palette, Mic, AudioLines, SlidersHorizontal, Sparkles, Plus, Minus, Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type PlanetId, type SongState, type Issue, type Capabilities, activePlanets, planetDef, summarize, songStatus, hasStyleInputs } from './song-model';
import { VinylDisc } from './VinylDisc';

const ICONS: Record<PlanetId, React.ElementType> = {
  composition: PenLine,
  style: Palette,
  voice: Mic,
  reference: AudioLines,
  production: SlidersHorizontal,
  creativity: Sparkles,
};

/** Cada planeta lleva el color y el icono de design-V2 (Crear · «Sistema solar · capa sobre la barra», `EL`): fijos en claro y oscuro, con el icono
 *  en azul de marca, además del nombre. Composición #FF6B4D, Voz #F0A44B, Audio #7B93E8, Producción #C4C9D3, Estilo #E0BCAE, Creatividad #E9876F. */
const TONES: Record<PlanetId, { fill: string; ink: string }> = {
  composition: { fill: 'bg-[#FF6B4D]', ink: 'text-[#FF6B4D]' },
  style: { fill: 'bg-[#D2A692] dark:bg-[#E0B8A9]', ink: 'text-[#D2A692] dark:text-[#E0B8A9]' },
  voice: { fill: 'bg-[#F0A44B]', ink: 'text-[#F0A44B]' },
  reference: { fill: 'bg-[#7B93E8]', ink: 'text-[#7B93E8]' },
  production: { fill: 'bg-[#C4C9D3]', ink: 'text-[#C4C9D3]' },
  creativity: { fill: 'bg-[#E9876F]', ink: 'text-[#E9876F]' },
};

/** Mismo color de cada planeta, sin el halo: para los iconos de la lista «Materiales». */
export const PLANET_DOT: Record<PlanetId, string> = {
  composition: 'bg-[#FF6B4D] text-[#131C33]',
  style: 'bg-[#D2A692] dark:bg-[#E0B8A9] text-[#131C33]',
  voice: 'bg-[#F0A44B] text-[#131C33]',
  reference: 'bg-[#7B93E8] text-[#131C33]',
  production: 'bg-[#C4C9D3] text-[#131C33]',
  creativity: 'bg-[#E9876F] text-[#131C33]',
};

/* Decoración del sistema (design-V2 · Crear, «Sistema solar · capa sobre la barra», SolarSystem.kt / SystemGeometry.kt): marcas doradas
   alrededor de la órbita de afuera (sin el arco de abajo, donde vive el «+»), y chispas y notas doradas en los bordes. Todo es aria-hidden. */
const OUTER = 36 * 1.22; // radio de la órbita de afuera, en % del contenedor (el mismo que ORBIT_RADII[2])
const TICKS = Array.from({ length: 90 }, (_, i) => {
  const deg = i * 4;
  if (Math.abs(deg - 90) <= 24) return null;
  const a = (deg * Math.PI) / 180;
  const r1 = OUTER * (166 / 154); // en el mockup las marcas nacen a 166 sobre 154 de la órbita de afuera
  const len = ((i % 5 === 0 ? 12 : i % 2 === 1 ? 5 : 8) * OUTER) / 154;
  return { x1: 50 + r1 * Math.cos(a), y1: 50 + r1 * Math.sin(a), x2: 50 + (r1 + len) * Math.cos(a), y2: 50 + (r1 + len) * Math.sin(a) };
}).filter((t): t is { x1: number; y1: number; x2: number; y2: number } => t !== null);
const SPARK = 'M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z';
const NOTE = 'M9 17V5l10-2v12M9 17a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 15a3 3 0 1 1-3-3 3 3 0 0 1 3 3z';
/** [x %, y %, trazo, tamaño px] de SolarBackdrop. */
const BACKDROP: Array<[number, number, string, number]> = [
  [9, 4, SPARK, 18], [90, 3, SPARK, 18], [16, 10, NOTE, 16], [84, 9, NOTE, 18],
  [8, 90, NOTE, 16], [92, 91, NOTE, 18], [95, 97, SPARK, 10], [7, 98, SPARK, 6],
];

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

/** Etiqueta del planeta (design-V2 · `.pcard`): tarjeta chica translúcida con desenfoque; el nombre en dorado, mayúsculas y 800 de peso arriba
 *  y el detalle abajo. Va centrada debajo del círculo. */
function PlanetLabel({ label, detail, pending, className }: { label: string; detail: string; pending?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'flex w-max max-w-[clamp(7rem,26cqw,12.5rem)] flex-col items-center justify-center gap-px rounded-[11px] border border-faint px-[clamp(8px,2.4cqw,14px)] py-[clamp(4px,1.3cqw,8px)] text-center backdrop-blur-[8px]',
        'bg-[rgba(255,253,247,.8)] dark:bg-[rgba(7,11,24,.66)]',
        'absolute top-full left-1/2 z-10 mt-1.5 -translate-x-1/2',
        className
      )}
      data-launch="label"
    >
      <span className="text-[length:clamp(10px,2.4cqw,14px)] font-extrabold uppercase leading-[1.25] tracking-[0.12em] text-lyric-tag dark:text-gold">{label}</span>
      <span className={cn('max-w-full truncate text-[length:clamp(11px,2.4cqw,14px)] leading-[1.25] @max-[36rem]:hidden', pending ? 'text-muted-foreground' : 'text-foreground')}>{detail}</span>
    </span>
  );
}

/** Vuelo de llegada de un elemento nuevo (design-V2 · Crear V2.1 con animación): nace en el «+», va en espiral a su lugar (ángulo y radio
 *  interpolados por el camino más corto, 0,55 s + 0,30 s × ángulo/180°, ease-in-out cúbico, crece de 0,45 a 1 en el primer 45 %), deja una
 *  estela de 6 puntos (últimos 0,3 s) y al llegar un aro del color crece a 2,4× y se apaga en 0,6 s mientras la etiqueta aparece en 0,25 s.
 *  Nunca bloquea: el planeta ya está en su lugar para toques y lector de pantalla; tocar algo durante el vuelo lo termina.
 *  Con reduced-motion: sin vuelo, estela ni aro, solo un fundido de 0,2 s. */
function ArrivalFlight({ boxRef, id, orbit, angle, radii, onDone }: { boxRef: React.RefObject<HTMLDivElement | null>; id: PlanetId; orbit: number; angle: number; radii: number[]; onDone: () => void }) {
  const layerRef = React.useRef<HTMLDivElement>(null);
  const doneRef = React.useRef(onDone);
  React.useEffect(() => { doneRef.current = onDone; }, [onDone]);
  React.useEffect(() => {
    const box = boxRef.current;
    const layer = layerRef.current;
    const li = box?.querySelector<HTMLElement>(`[data-planet="${id}"]`);
    if (!box || !layer || !li) { doneRef.current(); return; }
    const circle = li.querySelector<HTMLElement>('button > span');
    const label = li.querySelector<HTMLElement>('[data-launch="label"]');
    const iconSvg = circle?.querySelector('svg')?.outerHTML ?? '';
    const cs = circle ? getComputedStyle(circle) : null;
    // El planeta nace punteado: fondo de la página, borde e icono del color del elemento
    const color = cs?.color ?? '#FF6B4D';
    const bg = cs?.backgroundColor ?? 'transparent';
    const PD = circle?.offsetWidth ?? 44;
    const S = box.clientWidth;
    const c = S / 2;
    const startR = (radii[2] / 100) * S;
    const endR = (radii[orbit] / 100) * S;
    const startA = 90;
    const sw = (() => { let d = (((angle - 90) % 360) + 360) % 360; if (d > 180) d -= 360; return d; })();
    const flightT = 0.55 + (0.3 * Math.abs(sw)) / 180;
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const pos = (t: number) => {
      const k = ease(Math.min(Math.max(t / flightT, 0), 1));
      const a = ((startA + sw * k) * Math.PI) / 180;
      const r = startR + (endR - startR) * k;
      return { x: c + r * Math.cos(a), y: c + r * Math.sin(a) };
    };
    const target = pos(flightT);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', finish, true);
      li.style.opacity = '';
      if (label) label.style.opacity = '';
      layer.innerHTML = '';
      doneRef.current();
    };
    // Tocar el «+» o un planeta durante el vuelo lo termina
    window.addEventListener('pointerdown', finish, true);
    const t0 = performance.now();
    li.style.opacity = '0';
    if (reduce) {
      const fade = (now: number) => {
        const o = Math.min((now - t0) / 1000 / 0.2, 1);
        li.style.opacity = String(o);
        if (o < 1) raf = requestAnimationFrame(fade); else finish();
      };
      raf = requestAnimationFrame(fade);
      return finish;
    }
    if (label) label.style.opacity = '0';
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      let html = '';
      if (t < flightT) {
        const p = pos(t);
        const sc = 0.45 + 0.55 * Math.min(t / (flightT / 2.2), 1);
        const d = PD * 0.45;
        for (let i = 1; i <= 6; i++) {
          const tt = t - (0.3 * i) / 6;
          if (tt < 0) break;
          const q = pos(tt);
          html += `<span style="position:absolute;border-radius:9999px;left:${q.x - d / 2}px;top:${q.y - d / 2}px;width:${d}px;height:${d}px;background:${color};opacity:${0.45 * (1 - i / 7)}"></span>`;
        }
        html += `<span style="position:absolute;display:flex;align-items:center;justify-content:center;border-radius:9999px;left:${p.x - PD / 2}px;top:${p.y - PD / 2}px;width:${PD}px;height:${PD}px;box-sizing:border-box;background:${bg};border:2px dashed ${color};color:${color};transform:scale(${sc})">${iconSvg}</span>`;
        li.style.opacity = '0';
      } else {
        const lt = t - flightT;
        li.style.opacity = '1';
        if (label) label.style.opacity = String(Math.min(lt / 0.25, 1));
        if (lt >= 0.6) { finish(); return; }
        const rk = 1 - Math.pow(1 - lt / 0.6, 2);
        html += `<span style="position:absolute;border-radius:9999px;border:2px solid ${color};left:${target.x - PD / 2}px;top:${target.y - PD / 2}px;width:${PD}px;height:${PD}px;transform:scale(${1 + 1.4 * rk});opacity:${0.8 * (1 - rk)}"></span>`;
      }
      layer.innerHTML = html;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return finish;
  }, [boxRef, id, orbit, angle, radii]);
  return <div ref={layerRef} aria-hidden className="pointer-events-none absolute inset-0 z-20" />;
}

export function SolarSystem({ song, caps, issues, onOpenPlanet, onOpenCatalog, registerRef, launching, onLaunchEnd, arrival, pending, onArrivalEnd, registerCollapse }: {
  /** Entrega la función que anima «Empezar de nuevo» (el sistema de antes se traga como por un agujero negro). Se llama justo ANTES de vaciar la canción. */
  registerCollapse?: (collapse: (() => boolean) | null) => void;
  /** Elementos agregados que todavía no se completaron con «Listo»: se dibujan punteados. */
  pending?: PlanetId[];
  /** Elemento recién agregado cuyo editor ya se cerró: vuela desde el «+» hasta su lugar. */
  arrival?: PlanetId | null;
  onArrivalEnd?: () => void;
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
  const ORBIT_RADII = React.useMemo(() => [R * 0.72, R, R * 1.22], [R]); // coinciden con los tres anillos exteriores
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const missingOptional = (['voice', 'reference', 'production', 'creativity'] as PlanetId[]).filter((id) => !ids.includes(id)).map((id, i) => { const l = planetDef(id).label; return i === 0 ? l : l.toLowerCase(); });
  const arrivalIdx = arrival ? ids.indexOf(arrival) : -1;
  const arrivalSlot = arrivalIdx >= 0 ? SLOTS[Math.min(arrivalIdx, SLOTS.length - 1)] : null;
  // Si el elemento ya no está (se quitó) o empieza el lanzamiento, se descarta la llegada
  React.useEffect(() => { if (arrival && (!arrivalSlot || launching)) onArrivalEnd?.(); }, [arrival, arrivalSlot, launching, onArrivalEnd]);

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

  /* ── «Empezar de nuevo»: «Crear · Sistema solar · capa sobre la barra» del prototipo (design-V2), 1,2 s ──
     El sistema de antes (una copia) gira 252° y se encoge hacia el centro como tragado por un agujero negro; un punto negro crece y se cierra,
     sale una onda dorada y el sistema vacío renace desde el centro. Con reduced-motion no hay animación. */
  React.useEffect(() => {
    if (!registerCollapse) return;
    registerCollapse(() => {
      const box = boxRef.current;
      const host = box?.parentElement;
      if (!box || !host || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      const S = box.clientWidth;
      const c = S / 2;
      const k = (S * ((R * 1.22) / 100)) / 154;
      const clamp = (x: number) => Math.max(0, Math.min(1, x));
      const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
      const eOut = (x: number) => 1 - Math.pow(1 - x, 3);
      const eIn = (x: number) => x * x * x;
      const place = (el: HTMLElement | SVGElement) => {
        el.style.position = 'absolute';
        el.style.left = `${box.offsetLeft}px`;
        el.style.top = `${box.offsetTop}px`;
        el.style.width = el.style.height = `${S}px`;
        el.style.margin = '0';
        el.style.pointerEvents = 'none';
      };
      const old = box.cloneNode(true) as HTMLElement;
      old.setAttribute('aria-hidden', 'true');
      old.setAttribute('inert', '');
      old.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      place(old);
      old.style.zIndex = '30';
      old.style.maxWidth = 'none';
      const fx = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      fx.setAttribute('aria-hidden', 'true');
      fx.setAttribute('viewBox', `0 0 ${S} ${S}`);
      place(fx);
      fx.style.zIndex = '31';
      fx.style.overflow = 'visible';
      fx.innerHTML = `<circle cx="${c}" cy="${c}" r="0" fill="#05070d" data-h/><circle cx="${c}" cy="${c}" r="0" fill="none" stroke="var(--m-gold)" stroke-width="3" data-w/>`;
      host.appendChild(old);
      host.appendChild(fx);
      const hole = fx.querySelector('[data-h]') as SVGCircleElement;
      const wave = fx.querySelector('[data-w]') as SVGCircleElement;
      const cards = Array.from(old.querySelectorAll<HTMLElement>('[data-launch="label"], [data-planet] span[class*="absolute"]'));
      const core = old.querySelector<HTMLElement>('[data-launch="core"]');
      box.style.opacity = '0';
      let raf = 0;
      let t0: number | null = null;
      const DUR = 1.2;
      const loop = (now: number) => {
        if (t0 === null) t0 = now;
        const t = Math.min((now - t0) / 1000, DUR);
        const kk = eIn(seg(t, 0.1, 0.85));
        const scale = 1 - kk;
        old.style.opacity = scale > 0.01 ? '1' : '0';
        old.style.transform = `rotate(${252 * kk}deg) scale(${scale})`;
        cards.forEach((el) => { el.style.opacity = String(1 - seg(t, 0, 0.12)); });
        if (core) Array.from(core.children).forEach((ch) => { (ch as HTMLElement).style.opacity = String(1 - seg(t, 0, 0.3)); });
        hole.setAttribute('r', String(22 * k * eOut(seg(t, 0.6, 0.8)) * (1 - seg(t, 0.8, 0.9))));
        const u = seg(t, 0.85, 1.1);
        wave.setAttribute('r', String((8 + 200 * eOut(u)) * k));
        wave.setAttribute('opacity', u > 0 && u < 1 ? String(0.7 * (1 - u)) : '0');
        const re = seg(t, 0.95, 1.2);
        box.style.opacity = String(re);
        box.style.transform = `scale(${0.85 + 0.15 * eOut(re)})`;
        if (t < DUR) {
          raf = requestAnimationFrame(loop);
        } else {
          old.remove();
          fx.remove();
          box.style.opacity = '';
          box.style.transform = '';
        }
      };
      raf = requestAnimationFrame(loop);
      void raf;
      return true;
    });
    return () => registerCollapse(null);
  }, [registerCollapse, R]);

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
        {/* Chispas y notas doradas en los bordes (SolarBackdrop) */}
        <div aria-hidden data-launch="deco" className="pointer-events-none absolute inset-0 text-gold opacity-70">
          {BACKDROP.map(([x, y, d, sz], i) => (
            <svg key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${x}%`, top: `${y}%`, width: `clamp(${Math.round(sz * 0.6)}px, ${(sz / 5.6).toFixed(2)}cqw, ${sz}px)`, height: `clamp(${Math.round(sz * 0.6)}px, ${(sz / 5.6).toFixed(2)}cqw, ${sz}px)` }} viewBox="0 0 24 24" fill="currentColor"><path d={d} /></svg>
          ))}
        </div>
        {/* Órbitas y marcas: puramente decorativas */}
        <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" fill="none">
          {/* Tres órbitas, una por cada anillo donde van los planetas: foreground al 40 %, de más gruesa (adentro) a más fina (afuera) */}
          {ORBIT_RADII.map((r, i) => (
            <circle key={i} data-launch="ring" data-i={i} data-r={r} cx="50" cy="50" r={r} stroke="var(--m-foreground)" strokeOpacity=".4" strokeWidth={[0.39, 0.29, 0.18][i]} />
          ))}
          <g data-launch="deco" stroke="var(--m-gold)" strokeOpacity=".75" strokeWidth="0.27" strokeLinecap="round">
            {TICKS.map((t, i) => <line key={i} x1={t.x1.toFixed(2)} y1={t.y1.toFixed(2)} x2={t.x2.toFixed(2)} y2={t.y2.toFixed(2)} />)}
          </g>
        </svg>

        {/* Centro: la canción */}
        <div data-launch="core-box" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div
            data-launch="core"
            style={{ width: `${(ORBIT_RADII[0] * 2 * 0.73).toFixed(2)}cqw` }}
            className="relative flex aspect-square flex-col items-center justify-center gap-1.5 rounded-full border-[2.5px] border-gold bg-surface px-[clamp(8px,2.4cqw,16px)] text-center text-foreground shadow-[0_0_0_clamp(8px,2cqw,12px)_color-mix(in_srgb,var(--m-gold)_9%,transparent)]"
            role="group"
            aria-label={`Mi canción. ${status.ready ? 'Lista para crear.' : `Falta: ${status.missing[0]}`}`}
          >
            <p className="line-clamp-2 font-display text-[length:clamp(14px,3.4cqw,20px)] font-bold leading-[1.15] tracking-[-0.01em]">{status.ready ? 'Mi canción' : song.composition.title.trim() || 'Mi canción'}</p>
            <p className="inline-flex items-center gap-1 text-center text-[length:clamp(11px,2.4cqw,14px)] font-medium leading-[1.2] text-label dark:text-gold">
              {status.ready ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden /> : <CircleAlert className="h-3 w-3" aria-hidden />}
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
            const isPending = pending?.includes(id) ?? false;
            return (
              <li key={id} data-planet={id} style={pos(i)} className="absolute left-[var(--xs)] top-[var(--ys)] -translate-x-1/2 -translate-y-1/2 sm:left-[var(--x)] sm:top-[var(--y)]">
                <button
                  type="button"
                  ref={(el) => registerRef(id, el)}
                  onClick={() => onOpenPlanet(id)}
                  aria-haspopup="dialog"
                  aria-label={`${def.label}. ${summary[id]}. ${STATE_TEXT[st]}. Tocá para editar.`}
                  className="group relative flex w-[clamp(2.5rem,11cqw,4rem)] cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)] focus-visible:outline-2 focus-visible:outline-foreground"
                >
                  {/* Sin completar: círculo punteado del color del elemento (design-V2 · `.planet.pending`). Con «Listo» se rellena. */}
                  <span
                    style={{ transitionDuration: '200ms,500ms,500ms,500ms' }}
                    className={cn(
                      'relative flex h-[clamp(2.5rem,11cqw,4rem)] w-[clamp(2.5rem,11cqw,4rem)] items-center justify-center rounded-full border-2 transition-[transform,color,border-color,background-color] group-hover:scale-110 group-active:scale-100 motion-reduce:transition-none motion-reduce:group-hover:scale-100',
                      isPending ? cn('border-dashed border-current bg-background', TONES[id].ink) : 'border-transparent bg-transparent text-[#131C33]'
                    )}
                  >
                    <span aria-hidden className={cn('absolute -inset-0.5 rounded-full transition-transform duration-500 ease-out motion-reduce:transition-none', TONES[id].fill, isPending ? 'scale-0' : 'scale-100')} />
                    <Icon className="relative h-[clamp(1.25rem,5.3cqw,1.75rem)] w-[clamp(1.25rem,5.3cqw,1.75rem)]" aria-hidden />
                    {/* Con un problema: aro punteado alrededor (design-V2 · `.planet.alert`) */}
                    {!isPending && (st === 'error' || st === 'warning') && <span aria-hidden className="pointer-events-none absolute -inset-[clamp(5px,1.4cqw,8px)] rounded-full border-2 border-dashed border-label dark:border-gold" />}
                    {/* Indicador de estado arriba a la derecha (el mismo de antes del rediseño): falta algo, revisar, opcional o listo. Va después del icono del planeta. */}
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
                  <PlanetLabel label={def.label} detail={isPending ? 'Falta completar' : summary[id]} pending={isPending} />
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
              aria-label="Agregar un elemento a tu canción: voz, audio, producción o creatividad"
              className="group relative flex w-[clamp(3.25rem,13cqw,5rem)] cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-[var(--m-focus-ring)] focus-visible:outline-2 focus-visible:outline-foreground"
            >
              <span className="flex h-[clamp(3.25rem,13cqw,5rem)] w-[clamp(3.25rem,13cqw,5rem)] items-center justify-center rounded-full bg-gold text-[#131C33] shadow-[0_0_0_clamp(4px,1.1cqw,6px)_var(--background)] transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
                <Plus className="h-[clamp(1.75rem,6.5cqw,2.25rem)] w-[clamp(1.75rem,6.5cqw,2.25rem)]" strokeWidth={2} aria-hidden />
              </span>
              <span data-launch="label" className="absolute left-1/2 top-full z-10 mt-2 w-[clamp(130px,30cqw,170px)] -translate-x-1/2 text-center text-[length:clamp(13px,2.8cqw,16px)] font-bold leading-[1.5]">
                {missingOptional.length ? 'Agregar' : 'Completo'}
                {missingOptional.length > 0 && <span className="font-normal"> (opcional)</span>}
                {missingOptional.length > 0 && <span className="block text-[length:clamp(11px,2.2cqw,12.5px)] font-normal leading-[1.3] text-muted-foreground @max-[36rem]:hidden">{missingOptional.join(', ')}</span>}
              </span>
            </button>
          </li>
        </ul>
        {arrival && arrivalSlot && !launching && (
          <ArrivalFlight
            key={arrival}
            boxRef={boxRef}
            id={arrival}
            orbit={wide ? arrivalSlot.orbit : arrivalSlot.orbitSm ?? arrivalSlot.orbit}
            angle={wide ? arrivalSlot.angle : arrivalSlot.angleSm}
            radii={ORBIT_RADII}
            onDone={() => onArrivalEnd?.()}
          />
        )}
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
