
/**
 * MELODYA WEB — Banners dinámicos del CMS (posiciones reales del backend:
 * HERO | SLIDER | PROMO | COMMUNITY | FOOTER). Renderiza según configuración:
 * tema, imagen desktop/mobile, link, botón y ventana de vigencia (resuelta
 * por el backend en GET /banners?position=...).
 */
import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { cmsApi } from '@/lib/api';
import { apiFileUrl } from '@/lib/api/client';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { promotionEndsText } from '@/lib/pricing';
import type { Banner } from '@/types';

/**
 * Etiqueta de la campaña vinculada al banner (ofertas de fin de semana, Black Friday, Halloween…). Solo dice qué es y hasta cuándo: el
 * descuento y el precio salen siempre del catálogo (GET /plans), nunca del banner. El backend ya oculta el banner si la promoción no está vigente.
 */
function BannerPromoChip({ banner, dark }: { banner: Banner; dark: boolean }) {
  if (!banner.promotion) return null;
  const ends = promotionEndsText(banner.promotion.endsAt);
  return (
    <span data-testid="banner-promo" className={cn('inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold', dark ? 'bg-coral/20 text-coral' : 'bg-coral/15 text-coral')}>
      <Sparkles className="h-3 w-3" aria-hidden />
      {banner.promotion.name}{ends ? ` · ${ends}` : ''}
    </span>
  );
}

export function useBanners(position: Banner['position']) {
  return useQuery({
    queryKey: ['banners', position],
    queryFn: () => cmsApi.banners(position),
    staleTime: 60_000,
  });
}

function useMobile(banner?: Banner): string {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  if (!banner) return '';
  return apiFileUrl((isMobile && banner.mobileImageUrl) || banner.imageUrl) ?? banner.imageUrl;
}

function BannerCta({ banner, size }: { banner: Banner; size: 'hero' | 'slider' | 'promo' | 'band' }) {
  if (!banner.linkUrl) return null;
  const external = /^https?:\/\//.test(banner.linkUrl);
  const cls = cn(
    'inline-flex shrink-0 items-center justify-center rounded-full font-semibold transition-transform active:scale-[0.98]',
    size === 'hero'
      ? 'px-5 py-2.5 text-[13px] sm:px-6 sm:py-3 sm:text-sm'
      : size === 'band'
        ? /* Botón de la banda de comunidad: escala con el ancho del banner (el alto del banner es fijo por proporción). */
          'h-[clamp(24px,6.5cqw,40px)] px-[clamp(12px,3cqw,20px)] py-0 text-[clamp(10px,2.4cqw,13px)]'
        : 'px-4 py-2 text-xs',
    size === 'hero' && ' gradient-warm text-primary-foreground'
  );
  const label = banner.buttonLabel ?? 'Ver más';
  if (external) {
    return (
      <a href={banner.linkUrl} target="_blank" rel="noopener noreferrer" className={cn(cls, size !== 'hero' && 'bg-primary text-primary-foreground')}>
        {label}
      </a>
    );
  }
  return (
    <Button asChild size={size === 'hero' ? 'lg' : 'sm'} className={cls}>
      <Link to={banner.linkUrl.replace(/^#/, '')}>{label}</Link>
    </Button>
  );
}

/** HERO: portada grande con texto superpuesto. */
export function BannerHero({ banners }: { banners: Banner[] }) {
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (banners.length > 1) {
      timer.current = setInterval(() => setIndex((i) => (i + 1) % banners.length), 7000);
      return () => {
        if (timer.current) clearInterval(timer.current);
      };
    }
  }, [banners.length]);

  const banner = banners.length ? banners[index % banners.length] : undefined;
  const img = useMobile(banner);
  if (!banner) return null;
  const dark = banner.theme !== 'light';

  return (
    <section className="relative isolate overflow-hidden rounded-[28px_28px_14px_14px] border border-border/60" aria-roledescription="banner principal">
      {/* Imagen con overlay según tema (en móvil el velo cubre todo el ancho para que el texto siempre se lea) */}
      <img src={img} alt={banner.title} className="absolute inset-0 -z-10 h-full w-full object-cover" />
      <div
        className={cn(
          'absolute inset-0 -z-10 bg-gradient-to-r',
          dark
            ? 'from-[#131C33]/90 via-[#131C33]/75 to-[#131C33]/40 sm:via-[#131C33]/55 sm:to-transparent'
            : 'from-white/95 via-white/80 to-white/45 sm:via-white/70 sm:to-transparent'
        )}
      />

      {/* Contenido: define el alto (crece con el texto, nunca se desborda) */}
      <div className={cn('flex min-h-[220px] flex-col justify-center gap-3 px-5 py-6 sm:min-h-[280px] sm:px-10 sm:py-10 lg:min-h-[320px] lg:px-12', banners.length > 1 && 'pb-12 sm:pb-12')}>
        <div className="max-w-xl">
          <p className={cn('mb-2 hidden items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold sm:inline-flex', dark ? 'bg-amber/15 text-amber-strong' : 'bg-primary/10 text-primary')}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Melodya
          </p>
          <BannerPromoChip banner={banner} dark={dark} />
          <h1 className={cn('font-display text-[22px] font-extrabold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-3xl lg:text-4xl', dark ? 'text-[#F3E5E2]' : 'text-primary-foreground')}>
            {banner.title}
          </h1>
          {banner.subtitle && (
            <p className={cn('mt-2 line-clamp-3 max-w-md text-[13px] leading-relaxed sm:line-clamp-none sm:text-base', dark ? 'text-[#F3E5E2]/80' : 'text-primary-foreground/75')}>{banner.subtitle}</p>
          )}
          <div className="mt-4 sm:mt-5">
            <BannerCta banner={banner} size="hero" />
          </div>
        </div>
      </div>

      {banners.length > 1 && (
        <div className="absolute bottom-4 right-5 flex gap-1.5 sm:right-10">
          {banners.map((_, i) => (
            <button
              key={i}
              aria-label={`Banner ${i + 1}`}
              onClick={() => setIndex(i)}
              className={cn('h-1.5 rounded-full transition-all', i === index % banners.length ? 'w-6 bg-amber' : 'w-1.5 bg-amber/40')}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Slide individual (componente para respetar reglas de hooks). */
function BannerSlide({ banner }: { banner: Banner }) {
  const img = useMobile(banner);
  const dark = banner.theme !== 'light';
  return (
    <article className="relative isolate flex min-h-[190px] w-[85%] shrink-0 snap-center flex-col justify-end overflow-hidden rounded-[28px_28px_14px_14px] border border-border/60 sm:min-h-[210px] sm:w-[46%] lg:w-[31.5%]">
      <img src={img} alt={banner.title} className="absolute inset-0 -z-10 h-full w-full object-cover" />
      <div
        className={cn(
          'absolute inset-0 -z-10 bg-gradient-to-t',
          dark ? 'from-[#131C33]/95 via-[#131C33]/55 to-transparent' : 'from-white/90 via-white/55 to-transparent'
        )}
      />
      <div className="flex min-w-0 flex-col gap-1.5 p-4 pt-16 sm:gap-2 sm:p-5 sm:pt-16">
        <BannerPromoChip banner={banner} dark={dark} />
        <h3 className={cn('line-clamp-2 font-display text-base font-bold leading-snug [overflow-wrap:anywhere] sm:text-lg', dark ? 'text-[#F3E5E2]' : 'text-primary-foreground')}>{banner.title}</h3>
        {banner.subtitle && <p className={cn('line-clamp-2 text-xs sm:text-[13px]', dark ? 'text-[#F3E5E2]/75' : 'text-primary-foreground/70')}>{banner.subtitle}</p>}
        <div className="mt-1">
          <BannerCta banner={banner} size="slider" />
        </div>
      </div>
    </article>
  );
}

/** SLIDER: carrusel horizontal de tarjetas con flechas a los laterales. */
export function BannerCarousel({ banners }: { banners: Banner[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  if (!banners.length) return null;

  const scrollBy = (dir: 1 | -1) => {
    scroller.current?.scrollBy({ left: dir * (scroller.current.clientWidth * 0.85), behavior: 'smooth' });
  };

  return (
    <section className="group/banner relative" aria-label="Novedades">
      <div ref={scroller} className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {banners.map((banner) => (
          <BannerSlide key={banner.id} banner={banner} />
        ))}
      </div>
      {banners.length > 1 && (
        <>
          <button
            aria-label="Banner anterior"
            onClick={() => scrollBy(-1)}
            className="banner-arrow left-1 sm:-left-3"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            aria-label="Banner siguiente"
            onClick={() => scrollBy(1)}
            className="banner-arrow right-1 sm:-right-3"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </>
      )}
    </section>
  );
}

/** PROMO: tarjeta compacta horizontal (entre listas). */
export function PromoBanner({ banners }: { banners: Banner[] }) {
  const banner = banners[0];
  const img = useMobile(banner);
  if (!banner) return null;
  const dark = banner.theme !== 'light';
  return (
    <section className="relative overflow-hidden rounded-[28px_28px_14px_14px] border border-border/60" aria-label="Promoción">
      <div className="flex flex-col sm:flex-row">
        <div className="relative h-36 w-full shrink-0 sm:h-auto sm:min-h-[170px] sm:w-2/5">
          { }
          <img src={img} alt={banner.title} className="absolute inset-0 h-full w-full object-cover" />
        </div>
        <div className={cn('flex min-w-0 flex-1 flex-col justify-center gap-2 p-5 sm:p-6 lg:p-8', dark ? 'bg-surface text-foreground' : 'bg-[#F3E5E2] text-[#131C33]')}>
          <BannerPromoChip banner={banner} dark={dark} />
          <h3 className="font-display text-base font-bold leading-snug [overflow-wrap:anywhere] sm:text-lg lg:text-xl">{banner.title}</h3>
          {banner.subtitle && <p className={cn('text-[13px] leading-relaxed sm:text-sm', dark ? 'text-muted-foreground' : 'text-[#131C33]/70')}>{banner.subtitle}</p>}
          <div className="mt-2">
            <BannerCta banner={banner} size="promo" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** COMMUNITY: banda ancha para la sección comunidad. */
export function CommunityBanner({ banners }: { banners: Banner[] }) {
  const banner = banners[0];
  const img = useMobile(banner);
  if (!banner) return null;
  const dark = banner.theme !== 'light';
  return (
    <section className="@container relative overflow-hidden rounded-2xl" aria-label="Comunidad">
      <div className="relative aspect-[21/6]">
        { }
        <img src={img} alt={banner.title} className="absolute inset-0 h-full w-full object-cover" />
        <div className={cn('absolute inset-0', dark ? 'bg-gradient-to-r from-[#131C33]/90 to-transparent' : 'bg-gradient-to-r from-white/90 to-transparent')} />
        {/* Mismo alto en todos los tamaños: textos, botón y espacios escalan con el ancho del banner para que siempre entren. */}
        <div className="absolute inset-0 flex min-w-0 flex-col items-start justify-center gap-[clamp(2px,1.2cqw,8px)] px-[clamp(12px,3.5cqw,32px)] py-[clamp(6px,2cqw,20px)]">
          <h2
            className={cn(
              'line-clamp-1 max-w-[75%] font-display text-[clamp(13px,3.6cqw,26px)] leading-tight font-extrabold @[680px]:line-clamp-2',
              dark ? 'text-[#F3E5E2]' : 'text-primary-foreground'
            )}
          >
            {banner.title}
          </h2>
          {banner.subtitle && (
            <p
              className={cn(
                'line-clamp-1 max-w-[70%] text-[clamp(10px,2.3cqw,14px)] leading-snug @[680px]:line-clamp-2',
                dark ? 'text-[#F3E5E2]/80' : 'text-primary-foreground/70'
              )}
            >
              {banner.subtitle}
            </p>
          )}
          <div className="mt-[clamp(2px,0.8cqw,8px)]">
            <BannerCta banner={banner} size="band" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** FOOTER: banners de posición FOOTER. Tarjeta con miniatura, título, subtítulo y botón (siempre que haya link). */
export function BannerFooter({ banners }: { banners: Banner[] }) {
  if (!banners.length) return null;
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {banners.map((b) => {
        const external = b.linkUrl ? /^https?:\/\//.test(b.linkUrl) : false;
        const label = b.buttonLabel ?? 'Ver más';
        const ctaCls =
          'inline-flex h-10 shrink-0 items-center justify-center rounded-full gradient-warm px-5 text-[13px] font-bold text-primary-foreground transition-transform active:scale-[0.98] max-sm:w-full';
        return (
          <article
            key={b.id}
            className="flex w-full flex-col gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:p-5"
          >
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <FooterThumb banner={b} />
              <div className="min-w-0 flex-1">
                <h3 className="line-clamp-2 font-display text-base font-bold leading-tight text-foreground [overflow-wrap:anywhere] sm:text-lg">{b.title}</h3>
                {b.subtitle && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{b.subtitle}</p>}
              </div>
            </div>
            {b.linkUrl &&
              (external ? (
                <a href={b.linkUrl} target="_blank" rel="noopener noreferrer" className={ctaCls}>
                  {label}
                </a>
              ) : (
                <Link to={b.linkUrl.replace(/^#/, '')} className={ctaCls}>
                  {label}
                </Link>
              ))}
          </article>
        );
      })}
    </div>
  );
}

function FooterThumb({ banner }: { banner: Banner }) {
  const img = useMobile(banner);
  if (!img) {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full gradient-warm sm:size-14" aria-hidden>
        <Sparkles className="h-5 w-5 text-primary-foreground" />
      </span>
    );
  }
  return (
    <img
      src={img}
      alt=""
      className="size-12 shrink-0 rounded-2xl object-cover ring-1 ring-black/10 sm:size-14"
    />
  );
}

/** Slot genérico por posición: la pieza que consume el resto de la app. */
export function BannerSlot({ position, className }: { position: Banner['position']; className?: string }) {
  const { data } = useBanners(position);
  const banners = data?.items ?? [];
  if (!banners.length) return null;

  const inner =
    position === 'HERO' ? (
      <BannerHero banners={banners} />
    ) : position === 'SLIDER' ? (
      <BannerCarousel banners={banners} />
    ) : position === 'PROMO' ? (
      <PromoBanner banners={banners} />
    ) : position === 'COMMUNITY' ? (
      <CommunityBanner banners={banners} />
    ) : (
      <BannerFooter banners={banners} />
    );

  return <div className={className}>{inner}</div>;
}
