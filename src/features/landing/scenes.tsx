/**
 * MELODYA WEB — Escenas gráficas de la landing pública (traslado fiel de melodya.landing):
 * sistema solar, isotipo con video (o ondas generativas), escenas de las tarjetas de flujo y órbitas del manifiesto.
 * Todo el movimiento es CSS/canvas; GSAP sólo se usa en LandingView (import dinámico).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

export const HERO_VIDEO = '/landing/media/melodya-hero.mp4';

// Geometría del isotipo, trazada a partir del isotipo.png de la marca.
export const ISO_W = 593, ISO_H = 285, ISO_CX = 352.5, ISO_CY = 142.5, ISO_CIRCLE_R = 142.5;

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- Sistema solar (adaptado de la pantalla Proyecto de estilo-visual-v2) ----
   El viewBox es de 400 unidades; anillos, planetas y núcleo se ubican en % del cuadrado, así que todo escala con su contenedor. Los planetas
   orbitan sólo con transformaciones CSS y se contra-rotan para quedar derechos. */
export const RING_RADII = [82, 114, 146, 178];
const PLANET_SIZE = 42;
const planets: { key: string; label: string; ring: number; angle: number; duration: number; reverse?: boolean; icon: React.ReactNode }[] = [
  { key: 'idea', label: 'Idea', ring: 0, angle: 20, duration: 150, icon: <><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></> },
  { key: 'lyrics', label: 'Letra', ring: 1, angle: 138, duration: 200, reverse: true, icon: <><path d="M4 6h16M4 11h10M4 16h6"/><path d="M14 20l1-3.6 4.6-4.6 2.6 2.6-4.6 4.6z"/></> },
  { key: 'sound', label: 'Sonido', ring: 2, angle: 236, duration: 260, icon: <><path d="M9 18V6l10-2v12"/><circle cx="6.6" cy="18" r="2.6"/><circle cx="16.6" cy="16" r="2.6"/></> },
  { key: 'style', label: 'Estilo', ring: 3, angle: 318, duration: 320, reverse: true, icon: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></> },
];
const ticks = Array.from({ length: 90 }, (_, i) => {
  const a = (i * 2 * Math.PI) / 90, amp = .25 + .75 * Math.abs(Math.sin(i * .41) * Math.cos(i * .17)), R = 189, L = 3 + 8 * amp;
  return { x1: 200 + R * Math.cos(a), y1: 200 + R * Math.sin(a), x2: 200 + (R + L) * Math.cos(a), y2: 200 + (R + L) * Math.sin(a), o: .3 + .4 * amp };
});
const spark = 'M0-1C.1-.28.28-.1 1 0 .28.1.1.28 0 1-.1.28-.28.1-1 0-.28-.1-.1-.28 0-1Z';
const sparkles = [[34, 52, 6, 0], [366, 66, 5, 1], [28, 338, 4.5, 2], [372, 348, 6, 3], [352, 206, 3, 1.5], [46, 196, 3, 2.5]];

export function SolarSystem() {
  return <div className="solar-wrap">
    <div className="solar" data-live="true" role="img" aria-label="Sistema solar de Melodya: tu canción en el centro y sus elementos (idea, letra, sonido y estilo) orbitando a su alrededor">
      <svg className="solar-deco" viewBox="0 0 400 400" aria-hidden="true">
        <g stroke="currentColor" strokeOpacity=".16"><line x1="4" y1="200" x2="396" y2="200"/><line x1="200" y1="4" x2="200" y2="396"/></g>
        <g className="solar-ticks" stroke="var(--m-gold)" strokeWidth="1.6" strokeLinecap="round">{ticks.map((t, i) => <line key={i} x1={t.x1.toFixed(1)} y1={t.y1.toFixed(1)} x2={t.x2.toFixed(1)} y2={t.y2.toFixed(1)} strokeOpacity={t.o.toFixed(2)}/>)}</g>
        <g fill="var(--m-gold)">{sparkles.map(([x, y, s, d], i) => <path key={i} className="twinkle" style={{ animationDelay: `${d}s` }} d={spark} transform={`translate(${x} ${y}) scale(${s})`}/>)}</g>
      </svg>
      <div className="solar-body">
        {RING_RADII.map((r, i) => <span key={r} className="ring" style={{ '--d': `${(r * 2) / 4}%`, '--rc': `var(--m-orbit-${i})`, '--rw': `${[2, 1.6, 1.3, 1.1][i]}px` } as React.CSSProperties}/>)}
        <span className="core"><span>Mi canción</span></span>
        {planets.map((p) => {
          const r = RING_RADII[p.ring];
          return <span key={p.key} className={`orbit-spin ${p.reverse ? 'rev' : ''}`} style={{ '--d': `${(r * 2) / 4}%`, '--dur': `${p.duration}s`, '--a': `${p.angle}deg`, '--pw': `${(PLANET_SIZE / (r * 2)) * 100}%`, '--c': `var(--m-element-${p.key})` } as React.CSSProperties}>
            <span className="arm"><span className="planet"><span className="upright"><span className="upright-fix"><span className="planet-face"><svg viewBox="0 0 24 24" fill="none" stroke="var(--m-brand-navy)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p.icon}</svg></span><span className="planet-label">{p.label}</span></span></span></span></span>
          </span>;
        })}
      </div>
    </div>
  </div>;
}

const clipShapes = ['M90 31A198.2 198.2 0 0 0 90 253Z', 'M194 0A88 142.5 0 0 0 194 285Z', 'M511 0A88 142.5 0 0 1 511 285Z', 'M615 31A198.2 198.2 0 0 1 615 253Z'];

/* Video (o, mientras carga o con movimiento reducido, ondas generativas estáticas) visto sólo a través del recorte con forma de isotipo. */
export function IsoMedia({ clipRef, innerRef }: { clipRef: React.Ref<SVGClipPathElement>; innerRef: React.Ref<HTMLDivElement> }) {
  const [withVideo, setWithVideo] = useState(false);
  useEffect(() => {
    // Con «reducir movimiento» no se reproduce el video automáticamente: queda la imagen estática de las ondas.
    // Sincroniza con un sistema externo (matchMedia) al montar.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWithVideo(!prefersReducedMotion());
  }, []);
  return <>
    <svg className="iso-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <clipPath id="iso-clip" clipPathUnits="userSpaceOnUse" ref={clipRef}>{clipShapes.map((d) => <path key={d} d={d}/>)}<circle cx={ISO_CX} cy={ISO_CY} r={ISO_CIRCLE_R}/></clipPath>
    </svg>
    <div className="iso-media" role="img" aria-label="Isotipo de Melodya con ondas de sonido en movimiento">
      <div className="iso-media-inner" ref={innerRef}>
        <WaveCanvas/>
        {withVideo && <video className="iso-video" src={HERO_VIDEO} autoPlay muted loop playsInline preload="metadata" aria-hidden="true"/>}
      </div>
    </div>
  </>;
}

function WaveCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!, c = canvas.getContext('2d');
    if (!c) return;
    const css = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const palette = [token('--m-accent', '#FF6B4D'), token('--m-gold', '#C98F22'), token('--m-element-sound', '#6C8CFF'), token('--m-element-lyrics', '#C07BFF'), token('--m-element-idea', '#FFD166')];
    const size = () => { const dpr = Math.min(window.devicePixelRatio || 1, 1.5); canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; };
    const draw = (t: number) => {
      const w = canvas.width, h = canvas.height;
      const bg = c.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, '#131C33'); bg.addColorStop(1, '#27345E');
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.fillStyle = bg; c.fillRect(0, 0, w, h);
      c.globalCompositeOperation = 'lighter'; c.lineCap = 'round'; c.lineJoin = 'round';
      palette.forEach((color, i) => {
        const path = new Path2D();
        for (let x = -20; x <= w + 20; x += 10) {
          const y = h * (.5 + (i - 2) * .05) + Math.sin(x * .0032 * (1 + i * .28) + t * .00055 * (1 + i * .22) + i * 1.9) * h * .17 + Math.sin(x * .0095 + t * .0011 + i) * h * .05;
          if (x === -20) path.moveTo(x, y); else path.lineTo(x, y);
        }
        c.strokeStyle = color; c.globalAlpha = .16; c.lineWidth = h * .07; c.stroke(path);
        c.globalAlpha = .75; c.lineWidth = h * .012; c.stroke(path);
      });
    };
    size();
    if (prefersReducedMotion()) { draw(4000); return; }
    let frame = 0, live = true;
    const loop = (t: number) => { draw(t); frame = live ? requestAnimationFrame(loop) : 0; };
    const io = new IntersectionObserver(([e]) => { live = e.isIntersecting; if (live && !frame) frame = requestAnimationFrame(loop); });
    io.observe(canvas);
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    frame = requestAnimationFrame(loop);
    return () => { live = false; cancelAnimationFrame(frame); io.disconnect(); ro.disconnect(); };
  }, []);
  return <canvas className="iso-canvas" ref={ref} aria-hidden="true"/>;
}

const bars = (count: number) => Array.from({ length: count }, (_, i) => <i key={i} style={{ '--i': i, '--h': `${28 + ((i * 37) % 62)}%` } as React.CSSProperties}/>);
const styleChips = ['Pop', 'Cumbia', 'Rock', 'Lo-fi', 'Folk', 'Jazz'];
const sliders = ['Clima', 'Energía', 'Ritmo'];
const versions = ['Versión 1', 'Versión 2', 'Versión 3'];

/* Pequeñas escenas en bucle que ilustran cada tarjeta del flujo; sólo CSS, en pausa mientras la tarjeta no se ve. */
export function FlowArt({ kind }: { kind: 'one' | 'two' | 'three' }) {
  if (kind === 'one') return <div className="flow-art art-start" aria-hidden="true">
    <div className="art-pill art-type"><span>Una frase que no me sale de la cabeza…</span></div>
    <div className="art-pill art-voice"><b className="rec-dot"/><span className="art-bars">{bars(18)}</span><em>0:08</em></div>
    <div className="art-pill art-beat">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ '--i': i } as React.CSSProperties}/>)}</div>
  </div>;
  if (kind === 'two') return <div className="flow-art art-explore" aria-hidden="true">
    <div className="art-chips">{styleChips.map((c, i) => <span key={c} style={{ '--i': i } as React.CSSProperties}>{c}</span>)}</div>
    <div className="art-sliders">{sliders.map((s, i) => <div key={s} style={{ '--i': i } as React.CSSProperties}><small>{s}</small><span className="track"><i/></span></div>)}</div>
  </div>;
  return <div className="flow-art art-choose" aria-hidden="true">
    {versions.map((v, i) => <div className="art-version" key={v} style={{ '--i': i } as React.CSSProperties}>
      <small>{v}</small><span className="art-bars">{bars(14)}</span><span className="art-check"><Check size={14}/></span>
    </div>)}
    <span className="art-saved">Guardada en tu colección</span>
  </div>;
}

export function OrbitRings() {
  return <svg className="manifesto-rings" viewBox="-40 -40 480 480" aria-hidden="true" preserveAspectRatio="xMidYMid meet">{RING_RADII.map((r, i) => <circle key={r} className="orbit-ring" style={{ '--i': i } as React.CSSProperties} cx="200" cy="200" r={r + 20} fill="none" stroke={`var(--m-orbit-${i})`} strokeWidth="1.2"/>)}</svg>;
}
