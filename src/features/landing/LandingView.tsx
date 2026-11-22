/**
 * MELODYA WEB — Landing pública (invitado, raíz «/»). Traslado del diseño de melodya.landing a la app: mismas secciones, animaciones,
 * video y recursos gráficos, con la navegación y los datos reales de Melodya Web:
 *  • precios  → LandingPricing (planes del backend), comunidad → LandingCommunity (feed del backend + reproductor global);
 *  • Ingresar / Crear cuenta / comunidad → rutas del router de la app (#/login, #/register, #/community);
 *  • tema → ThemeProvider de la app (clase dark en <html>);
 *  • sin sidebar, header de la app ni bottom bar: AppShell los oculta con isPublicLanding().
 * Todos los estilos viven bajo `.landing-root` (landing.css) y no afectan a otras pantallas.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTheme } from '@/lib/theme';
import { ArrowUpRight, Menu, Mic2, Moon, Music2, PencilLine, Sparkles, Sun, Volume2, VolumeX, X } from 'lucide-react';
import { Link } from '@/lib/router';
import { usePlayerStore } from '@/stores/player';
import { useCommunityPreview, usePublicPlans } from '@/features/home/public-data';
import { LandingPricing } from './LandingPricing';
import { LandingCommunity } from './LandingCommunity';
import { FlowArt, IsoMedia, OrbitRings, SolarSystem, ISO_CIRCLE_R, ISO_CX, ISO_CY, ISO_H, ISO_W, prefersReducedMotion } from './scenes';
import { loadGsap, type Revertible } from './motion';
import './landing.css';

const HERO_AUDIO = '/landing/media/audio-landing.mp3';
const ISO_DESKTOP_HEIGHT = .8; // fracción de la altura del hero que ocupa el isotipo en escritorio

type Tone = 'idea' | 'lyrics' | 'sound' | 'style';

function Feature({ icon, title, text, checked, onSelect }: { icon: React.ReactNode; title: string; text: string; tone?: Tone; checked: boolean; onSelect: () => void }) {
  return <article className="feature" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} onClick={onSelect} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect(); } }}>
    <div className="feature-half"><span className="feature-icon" aria-hidden="true">{icon}</span><h3>{title}</h3></div>
    <p>{text}</p>
  </article>;
}

/** Desplazamiento a una sección de la misma página. No usa `#ancla`: en la app el hash es el router (#planes sería la ruta /plans). */
function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

export function LandingView() {
  const root = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const ideaWord = useRef<HTMLSpanElement>(null);
  const hero = useRef<HTMLElement>(null);
  const isoSlot = useRef<HTMLDivElement>(null);
  const isoClip = useRef<SVGClipPathElement>(null);
  const isoInner = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme !== 'light';
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [feature, setFeature] = useState(0);
  const playerActive = usePlayerStore((s) => !!s.track);
  const playerPlaying = usePlayerStore((s) => s.isPlaying);
  const songsCount = useCommunityPreview().data?.items.length ?? 0;
  const plansCount = usePublicPlans().plans.length;

  /* Banda sonora: SIN reproducción automática. Sólo suena si la persona lo pide con el botón (así se respetan las restricciones del navegador
     y a quien no quiere sonido). Nunca convive con el reproductor global: si éste empieza a sonar, se pausa, y al activarla se pausa el otro. */
  const toggleSound = () => {
    const a = audio.current;
    if (!a) return;
    if (!a.paused) { a.pause(); return; }
    const st = usePlayerStore.getState();
    if (st.isPlaying) st.toggle();
    a.volume = .6;
    a.play().catch(() => undefined);
  };
  useEffect(() => {
    if (playerPlaying) audio.current?.pause();
  }, [playerPlaying]);

  const onFeatureKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const next = (feature + dir + 4) % 4;
    setFeature(next);
    (e.currentTarget.children[next] as HTMLElement).focus();
  };

  // Header: cambio sutil de superficie al desplazarse (sólo una clase, sin cambiar el layout).
  useEffect(() => {
    let frame = 0;
    const update = () => { frame = 0; setScrolled(window.scrollY > 8); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, []);

  // Menú móvil: Escape lo cierra (devolviendo el foco), igual que mover el foco o hacer clic fuera del header.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (restoreFocus: boolean) => { setMenuOpen(false); if (restoreFocus) menuButton.current?.focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    const onPointer = (e: PointerEvent) => { if (!headerRef.current?.contains(e.target as Node)) close(false); };
    const onFocusIn = (e: FocusEvent) => { if (!headerRef.current?.contains(e.target as Node)) close(false); };
    const onResize = () => { if (window.innerWidth >= 900) close(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  // Los sistemas solares y las escenas de las tarjetas sólo se animan mientras se ven.
  useEffect(() => {
    const rootEl = root.current;
    if (!rootEl || !('IntersectionObserver' in window)) return;
    const watch = (selector: string, rootMargin: string) => {
      const io = new IntersectionObserver((entries) => entries.forEach((e) => { (e.target as HTMLElement).dataset.live = String(e.isIntersecting); }), { rootMargin });
      rootEl.querySelectorAll<HTMLElement>(selector).forEach((el) => io.observe(el));
      return io;
    };
    const a = watch('.solar', '80px');
    const b = watch('.flow-card', '40px');
    return () => { a.disconnect(); b.disconnect(); };
  }, []);

  // Revelado del isotipo (estilo Spotify Premium): el hero queda fijo mientras el isotipo con video crece hasta cubrir la pantalla.
  useLayoutEffect(() => {
    const rootEl = root.current, stage = hero.current, slot = isoSlot.current, clip = isoClip.current, inner = isoInner.current;
    if (!rootEl || !stage || !slot || !clip || !inner) return;
    const m = { s0: 1, s1: 1, x0: 0, y0: 0, x1: 0, y1: 0, p: 0 };
    const render = () => {
      const k = m.s1 / m.s0, s = m.s0 * Math.pow(k, m.p);
      const x = m.x0 + (m.x1 - m.x0) * m.p, y = m.y0 + (m.y1 - m.y0) * m.p;
      clip.setAttribute('transform', `translate(${x} ${y}) scale(${s}) translate(${-ISO_CX} ${-ISO_CY})`);
      // El video se centra en el isotipo y crece con él, lo justo para cubrir siempre la parte visible de la máscara.
      const W = stage.clientWidth, H = stage.clientHeight, bw = ISO_W * s, bh = ISO_H * s;
      const needX = Math.max(Math.min(x, bw / 2), Math.min(W - x, bw / 2)), needY = Math.max(Math.min(y, bh / 2), Math.min(H - y, bh / 2));
      const v = Math.min(1.05, Math.max(.2, Math.max((2 * needX) / W, (2 * needY) / H) * 1.03));
      inner.style.transform = `translate(${x - W / 2}px, ${y - H / 2}px) scale(${v})`;
    };
    const measure = () => {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (!W || !H) return; // todavía sin layout (hoja de estilos en camino): el ResizeObserver vuelve a medir al tener tamaño
      if (window.matchMedia('(min-width: 900px)').matches) {
        // Escritorio: el isotipo ocupa toda la altura del hero, con el círculo a la derecha y las medialunas bajo el texto.
        m.s0 = (H * ISO_DESKTOP_HEIGHT) / ISO_H;
        m.x0 = W - (ISO_CIRCLE_R * m.s0) - 24;
        m.y0 = H / 2;
      } else {
        m.s0 = slot.clientWidth / ISO_W;
        m.x0 = slot.offsetLeft + slot.clientWidth / 2;
        m.y0 = slot.offsetTop + slot.clientHeight / 2;
      }
      m.x1 = W / 2; m.y1 = H / 2;
      rootEl.style.setProperty('--hero-h', `${H}px`);
      m.s1 = (Math.hypot(W, H) / 2 + 8) / ISO_CIRCLE_R;
      render();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    if (prefersReducedMotion()) return () => ro.disconnect();
    let cancelled = false;
    let ctx: Revertible | undefined;
    void loadGsap().then(({ gsap }) => {
      if (cancelled) return;
      const headerH = () => (headerRef.current?.offsetHeight ?? 0);
      // El hero queda fijo durante el crecimiento (1,5 pantallas) más una altura de hero, en la que «La solución» sube sobre el video a pantalla completa.
      const grow = Math.round(window.innerHeight * 1.5), cover = stage.clientHeight;
      ctx = gsap.context(() => {
        gsap.timeline({ scrollTrigger: { trigger: stage, start: () => `top top+=${headerH()}`, end: () => `+=${Math.round(window.innerHeight * 1.5 + stage.clientHeight)}`, pin: true, scrub: .6, invalidateOnRefresh: true, onRefresh: measure } })
          .to(m, { p: 1, ease: 'none', duration: grow, onUpdate: render }, 0)
          .to('.hero-copy', { opacity: 0, y: -48, ease: 'none', duration: grow * .22 }, 0)
          .to({}, { duration: cover }, grow);
      }, stage);
      rootEl.dataset.heroPin = 'on';
    });
    return () => { cancelled = true; delete rootEl.dataset.heroPin; ro.disconnect(); ctx?.revert(); };
  }, []);

  // Entradas, revelado al desplazarse, tarjetas de flujo que se recogen y palabra rotativa del título.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let alive = true;
    let timer = 0;
    let ctx: Revertible | undefined;
    void loadGsap().then(({ gsap }) => {
      if (!alive) return;
      ctx = gsap.context(() => {
        gsap.from('.hero-copy > *', { y: 24, opacity: 0, duration: .8, stagger: .08, ease: 'power3.out', clearProps: 'transform,opacity' });
        gsap.utils.toArray<HTMLElement>('.reveal').forEach((el) => gsap.from(el, { scrollTrigger: { trigger: el, start: 'top 86%', once: true }, y: 28, opacity: 0, duration: .75, ease: 'power2.out', clearProps: 'transform,opacity' }));
        gsap.utils.toArray<HTMLElement>('.feature').forEach((card, i) => gsap.from(card, { scrollTrigger: { trigger: card, start: 'top 90%', once: true }, y: 22, opacity: 0, duration: .6, delay: (i % 4) * .07, ease: 'power2.out', clearProps: 'transform,opacity' }));
        // Tarjetas de flujo: la anterior se recoge a medida que llega la siguiente.
        const flowCards = gsap.utils.toArray<HTMLElement>('.flow-card');
        flowCards.forEach((card, index) => {
          if (index === flowCards.length - 1) return;
          gsap.to(card, { scale: .94, ease: 'none', scrollTrigger: { trigger: flowCards[index + 1], start: 'top 68%', end: 'top 28%', scrub: true } });
        });
        const words = ['una idea', 'un tarareo', 'una letra', 'un ritmo'];
        let wordIndex = 0;
        const rotateWord = () => {
          if (!alive || !ideaWord.current) return;
          const next = words[(wordIndex + 1) % words.length];
          gsap.timeline({ onComplete: () => { wordIndex = (wordIndex + 1) % words.length; timer = window.setTimeout(rotateWord, 1800); } })
            .to(ideaWord.current, { y: -14, opacity: 0, duration: .28, ease: 'power2.in' })
            .call(() => { if (ideaWord.current) ideaWord.current.textContent = next; })
            .set(ideaWord.current, { y: 14 })
            .to(ideaWord.current, { y: 0, opacity: 1, duration: .4, ease: 'power2.out' });
        };
        timer = window.setTimeout(rotateWord, 1600);
      }, page);
    });
    return () => { alive = false; window.clearTimeout(timer); ctx?.revert(); };
  }, []);

  // Planes y canciones llegan del backend después del primer pintado: se revelan al desplazarse y se recalculan las posiciones de los disparadores.
  useEffect(() => {
    if (!plansCount && !songsCount) return;
    let cancelled = false;
    let ctx: Revertible | undefined;
    void loadGsap().then(({ gsap, ScrollTrigger }) => {
      if (cancelled) return;
      if (!prefersReducedMotion()) {
        ctx = gsap.context(() => {
          gsap.utils.toArray<HTMLElement>('.pricing-card, .song-card').forEach((card, i) => gsap.from(card, { scrollTrigger: { trigger: card, start: 'top 90%', once: true }, y: 22, opacity: 0, duration: .6, delay: (i % 4) * .07, ease: 'power2.out', clearProps: 'transform,opacity' }));
        }, page);
      }
      ScrollTrigger.refresh();
    });
    return () => { cancelled = true; ctx?.revert(); };
  }, [plansCount, songsCount]);

  const closeMenu = () => setMenuOpen(false);
  /* El menú móvil abierto empuja el contenido (el header es sticky pero está en el flujo): se cierra y se aplica el layout ANTES de calcular el destino, o el desplazamiento se pasaría de largo al plegarse. */
  const goTo = (id: string) => (e: React.MouseEvent) => { e.preventDefault(); flushSync(() => setMenuOpen(false)); scrollToSection(id); };
  const navLinks = [
    { id: 'solucion', label: 'La solución' },
    { id: 'features', label: 'Funciones' },
    ...(songsCount > 0 ? [{ id: 'comunidad', label: 'Comunidad' }] : []),
    { id: 'planes', label: 'Precios' },
  ];
  const logo = <>
    <img className="logo-dark" src="/landing/isologo-on-dark.png" alt="Melodya" width="2574" height="281" decoding="async" />
    <img className="logo-light" src="/landing/isologo-on-light.png" alt="Melodya" width="2574" height="281" decoding="async" />
  </>;
  const themeLabel = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
  const themeToggle = (className: string, text?: string) => <button type="button" className={className} onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label={themeLabel}>{dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}{text && <span>{text}</span>}</button>;

  return <div className="landing-root" ref={root} data-player={playerActive ? 'on' : 'off'}>
    <header className={`site-header ${scrolled ? 'is-scrolled' : ''}`} ref={headerRef}>
      <nav className="nav" aria-label="Principal">
        <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); closeMenu(); window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); }} aria-label="Melodya, ir al inicio">{logo}</a>
        <div className="nav-links">{navLinks.map((l) => <a key={l.id} href="#/" onClick={goTo(l.id)}>{l.label}</a>)}</div>
        <div className="nav-actions">
          {themeToggle('icon-button nav-theme')}
          <Link className="login" to="/login">Ingresar</Link>
          <Link className="login solid" to="/register">Empezar <ArrowUpRight size={15} aria-hidden="true" /></Link>
          <button type="button" ref={menuButton} className="icon-button menu-toggle" aria-expanded={menuOpen} aria-controls="mobile-menu" aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}</button>
        </div>
      </nav>
      <div className="mobile-menu" id="mobile-menu" hidden={!menuOpen}>
        {navLinks.map((l) => <a key={l.id} href="#/" onClick={goTo(l.id)}>{l.label}</a>)}
        <Link className="button primary" to="/register" onClick={closeMenu}>Empezar a crear <ArrowUpRight size={17} aria-hidden="true" /></Link>
        <Link className="button outline" to="/login" onClick={closeMenu}>Ingresar</Link>
        {themeToggle('mobile-theme', dark ? 'Tema claro' : 'Tema oscuro')}
      </div>
    </header>

    <audio ref={audio} src={HERO_AUDIO} loop preload="none" onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} />
    <button type="button" className="icon-button sound-toggle" onClick={toggleSound} aria-pressed={playing} aria-label={playing ? 'Silenciar música' : 'Activar música'} title={playing ? 'Silenciar música' : 'Activar música'}>
      {playing ? <Volume2 size={20} aria-hidden="true" /> : <VolumeX size={20} aria-hidden="true" />}
    </button>

    <div className="landing-main" ref={page}>
      <section className="hero" id="top" ref={hero}><div className="hero-copy"><p className="eyebrow">● TU PRÓXIMA CANCIÓN EMPIEZA ACÁ</p><h1><span className="headline-line">De <span className="rotating-word" ref={ideaWord}>una idea</span></span><br /><em>a una canción.</em></h1><p className="lead">Una melodía que te acompaña, una frase que querés convertir en estribillo o un ritmo que pide crecer. Traé la chispa y descubrí todo lo que puede convertirse en música.</p><div className="actions"><Link className="button primary" to="/register">Empezar a crear <ArrowUpRight size={17} aria-hidden="true" /></Link><a className="text-link" href="#/" onClick={goTo('features')}>Descubrí cómo funciona <ArrowUpRight size={16} aria-hidden="true" /></a></div><p className="hero-note">Probá ideas, escuchá posibilidades y quedate con las que más te entusiasmen.</p></div><div className="iso-slot" ref={isoSlot} aria-hidden="true" /><IsoMedia clipRef={isoClip} innerRef={isoInner} /></section>

      <section className="problem" id="solucion"><div className="problem-solar reveal"><SolarSystem /></div><div className="problem-copy reveal"><p className="eyebrow">● CUANDO APARECE LA CHISPA</p><h2>Una idea pide espacio.<br /><span>Melodya le da sonido.</span></h2><div><p>Una frase en el celular. Un audio que querés volver canción. Una melodía que aparece de golpe y merece quedarse.</p><p>Melodya te acompaña a explorarla, darle forma y escuchar cómo crece hasta encontrar una versión que te represente.</p><Link className="text-link" to="/register">Dale una vuelta a tu idea <ArrowUpRight size={16} aria-hidden="true" /></Link></div></div></section>

      <section className="features section" id="features"><header><p className="eyebrow">● TODO LO QUE PODÉS EXPLORAR</p><h2>De la primera nota<br /><span>a tu próxima canción.</span></h2><p className="section-intro">Un espacio para crear con libertad, seguir la curiosidad y descubrir una canción distinta en cada vuelta.</p></header><div className="feature-grid" role="radiogroup" aria-label="Funciones" onKeyDown={onFeatureKeys}><Feature tone="idea" icon={<PencilLine />} title="Empezá como quieras" text="Escribí una idea, tarareá o marcá un ritmo. Cada punto de partida abre un camino diferente." checked={feature === 0} onSelect={() => setFeature(0)} /><Feature tone="sound" icon={<Sparkles />} title="Encontrá tu sonido" text="Combiná climas, estilos y direcciones hasta encontrar una canción con identidad propia." checked={feature === 1} onSelect={() => setFeature(1)} /><Feature tone="style" icon={<Music2 />} title="Probá nuevas versiones" text="Escuchá alternativas, cambiá el rumbo y compará posibilidades mientras la canción toma forma." checked={feature === 2} onSelect={() => setFeature(2)} /><Feature tone="lyrics" icon={<Mic2 />} title="Guardá lo que te inspira" text="Tus ideas y versiones quedan juntas para volver, sumar detalles y seguir creando cuando tengas ganas." checked={feature === 3} onSelect={() => setFeature(3)} /></div></section>

      <section className="story"><div className="story-copy reveal"><p className="eyebrow">● FORMAS NUEVAS DE HACER MÚSICA</p><h2>Dejá que la canción<br /><em>te sorprenda.</em></h2><p>Crear también es descubrir. Una dirección te lleva a otra, una textura cambia el clima y una pequeña prueba puede abrir un mundo entero.</p><p>Deslizá para recorrer el proceso. Cada tarjeta suma una posibilidad, como una colección de discos que se arma mientras avanzás.</p></div><div className="flow-stack"><article className="flow-card flow-card-one"><b>01 / EMPEZÁ</b><h3>Dale lugar a la primera idea.</h3><p>Una frase, una nota de voz o un ritmo sobre la mesa. Todo puede ser la puerta de entrada a una canción.</p><FlowArt kind="one" /></article><article className="flow-card flow-card-two"><b>02 / EXPLORÁ</b><h3>Jugá con las posibilidades.</h3><p>Probá climas, estilos y direcciones. Escuchá cómo cambia una misma idea cuando encuentra un nuevo universo.</p><FlowArt kind="two" /></article><article className="flow-card flow-card-three"><b>03 / ELEGÍ</b><h3>Quedate con lo que te representa.</h3><p>Compará caminos, ajustá los detalles y guardá la versión que te da ganas de compartirla.</p><FlowArt kind="three" /></article></div></section>

      <section className="manifesto reveal"><OrbitRings /><span className="manifesto-word">Crear</span><p>Una canción puede empezar en cualquier lugar. Abrí una idea, seguí la curiosidad y escuchá hasta encontrar algo que quieras volver a poner.</p><span className="manifesto-word accent-word">Probá.</span></section>

      <LandingCommunity />

      <LandingPricing />
    </div>

    <footer className="landing-footer"><span className="footer-brand"><img src="/landing/isotipo.png" alt="Melodya" width="705" height="285" decoding="async" /><span>Hecho con el corazón</span></span><span>© {new Date().getFullYear()} Melodya</span></footer>
  </div>;
}
