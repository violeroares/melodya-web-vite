
/**
 * MELODYA WEB — Componentes comunes: portadas, chips, estados (loading/empty/error).
 */
import React from 'react';
import { Music, Plus, Sparkles, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiFileUrl } from '@/lib/api/client';
import { useAuthImage } from '@/lib/auth-image';
import { Link } from '@/lib/router';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/* ── CoverArt: portada con fallback plano determinístico por id (colores de elemento de design-V2) ── */
const FALLBACKS = ['bg-element-idea', 'bg-element-lyrics', 'bg-element-sound', 'bg-element-style'];
function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function CoverArt({
  id,
  src,
  alt,
  className,
  rounded = 'rounded-xl',
  showVinyl = false,
  requireAuth = false,
}: {
  id: string;
  src?: string | null;
  alt: string;
  className?: string;
  rounded?: string;
  showVinyl?: boolean;
  /** La portada se sabe PRIVADA (p. ej. canción PRIVATE propia): se descarga directo con sesión, sin el intento anónimo que daría 401/403. */
  requireAuth?: boolean;
}) {
  const url = apiFileUrl(src);
  const { src: imgSrc, failed, onError } = useAuthImage(url, { requireAuth });
  const fallback = FALLBACKS[hashStr(id) % FALLBACKS.length];
  const [loadedSrc, setLoadedSrc] = React.useState<string | null>(null);
  return (
    <div
      className={cn(
        'relative overflow-hidden bg-surface-2',
        rounded,
        showVinyl && '',
        className
      )}
    >
      {imgSrc && !failed ? (
        <>
          {/* Skeleton mientras la imagen carga (evita la card vacía); una portada ya en caché lo salta */}
          {loadedSrc !== imgSrc && <div aria-hidden className="absolute inset-0 animate-pulse bg-accent" />}
          <img
            ref={(el) => {
              if (el?.complete && el.naturalWidth > 0) setLoadedSrc(imgSrc);
            }}
            src={imgSrc}
            alt={alt}
            onLoad={() => setLoadedSrc(imgSrc)}
            onError={onError}
            className={cn('h-full w-full object-cover transition-[transform,opacity] duration-300', loadedSrc !== imgSrc && 'opacity-0')}
          />
        </>
      ) : (
        <div
          className={cn('flex h-full w-full items-center justify-center', fallback)}
        >
          <Music className="h-1/3 w-1/3 text-primary-foreground/80" aria-hidden />
        </div>
      )}
    </div>
  );
}

/* ── Chip / tag ── */
export function Chip({ children, className, onClick, active, title }: { children: React.ReactNode; className?: string; onClick?: () => void; active?: boolean; title?: string }) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      onClick={onClick}
      title={title}
      aria-pressed={onClick && active !== undefined ? active : undefined}
      className={cn(
        /* design-V2 · `.chip`: 40 px de alto, 20 px de radio, borde de 1,5 px, 16 px de relleno, Figtree 500 14/1.2. Elegido: relleno `--m-selected`
           (azul en claro, crema en oscuro), texto `--m-on-selected` en 700. El texto nunca se corta: si no entra, el chip pasa a la fila de abajo. */
        'inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] px-4 text-sm font-medium leading-[1.2] transition-colors',
        active
          ? 'border-selected bg-selected font-bold text-on-selected'
          : 'border-line bg-transparent text-foreground',
        onClick && 'cursor-pointer',
        onClick && !active && 'hover:bg-foreground/10',
        className
      )}
    >
      {children}
    </Comp>
  );
}

/* ── Estados ── */
/** `cover`: esqueleto de portada V2 (radio asimétrico, 8px hasta el texto). */
export function LoadingCards({ count = 6, className, cover = false }: { count?: number; className?: string; cover?: boolean }) {
  return (
    <div className={cn('grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5', className)} aria-busy="true" aria-label="Cargando contenido">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={cover ? 'space-y-2' : 'space-y-3'}>
          <div className={cn('aspect-square animate-pulse bg-surface-2', cover ? 'rounded-cover' : 'rounded-xl')} />
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

export function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-14 w-14 shrink-0 animate-pulse rounded-lg bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionTo,
  onAction,
  className,
  variant = 'default',
  actionIcon,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  actionTo?: string;
  onAction?: () => void;
  className?: string;
  /** «studio»: estado vacío del Estudio de letras (tarjeta punteada, aro con círculo de voz y título en tipografía de títulos). */
  variant?: 'default' | 'studio';
  /** Ícono del botón en la variante studio: «+» por defecto; `null` para no mostrar ninguno (acciones que no crean nada). */
  actionIcon?: React.ReactNode;
}) {
  if (variant === 'studio') {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] p-6 py-10 text-center', className)}>
        <span aria-hidden className="relative block size-24 shrink-0">
          <svg className="absolute inset-0 size-full" viewBox="0 0 96 96" fill="none">
            <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
          </svg>
          <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice [&_svg]:size-[26px] [&_svg]:text-gold">{icon ?? <Sparkles />}</span>
        </span>
        <h3 className="font-display text-[19px] leading-tight font-semibold text-foreground">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {actionLabel &&
          (actionTo ? (
            <Button asChild className="rounded-full">
              <Link to={actionTo}>
                {actionIcon === undefined ? <Plus className="h-4 w-4" aria-hidden /> : actionIcon}
                {actionLabel}
              </Link>
            </Button>
          ) : (
            <Button onClick={onAction} className="rounded-full">
              {actionIcon === undefined ? <Plus className="h-4 w-4" aria-hidden /> : actionIcon}
              {actionLabel}
            </Button>
          ))}
      </div>
    );
  }
  return (
    <div className={cn('relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border/70 bg-surface/40 px-6 py-14 text-center', className)}>
      {/* Retícula sutil de fondo: "papel de partitura" */}
      <span aria-hidden className="grid-music pointer-events-none absolute inset-0" />
      <div className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-amber-strong shadow-inner">{icon ?? <Sparkles className="h-7 w-7" />}</div>
      <h3 className="relative text-base font-semibold text-foreground">{title}</h3>
      {description && <p className="relative mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {actionLabel &&
        (actionTo ? (
          <Button asChild className="relative mt-5 rounded-full">
            <Link to={actionTo}>{actionLabel}</Link>
          </Button>
        ) : (
          <Button onClick={onAction} className="relative mt-5 rounded-full">
            {actionLabel}
          </Button>
        ))}
    </div>
  );
}

export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center', className)}>
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <Music className="h-6 w-6" aria-hidden />
      </div>
      <p className="max-w-sm text-sm text-foreground/90">{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-4 rounded-full">
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Reintentar
        </Button>
      )}
    </div>
  );
}

export function SectionHeader({
  title,
  subtitle,
  action,
  className,
  hideSubtitleOnMobile = false,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** En pantallas angostas oculta la descripción para ganar espacio. */
  hideSubtitleOnMobile?: boolean;
}) {
  return (
    <div className={cn('mb-4 flex flex-wrap items-center justify-between gap-3', className)}>
      <div>
        <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
          <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
          {title}
        </h2>
        {subtitle && <p className={cn('mt-1 text-sm text-muted-foreground', hideSubtitleOnMobile && 'max-sm:hidden')}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Logo Melodya */
export function MelodyaLogo({ className, compact = false, vertical = false }: { className?: string; compact?: boolean; vertical?: boolean }) {
  return (
    <span className={cn('inline-flex select-none items-center', className)}>
      {vertical ? (
        /* Isologo vertical (pantallas de cuenta): light sobre oscuro, dark sobre claro */
        <>
          <img src="/brand/isologo-vertical-on-dark.png" alt="Melodya" className="hidden h-[59px] w-[140px] dark:block" />
          <img src="/brand/isologo-vertical-on-light.png" alt="Melodya" className="block h-[59px] w-[140px] dark:hidden" />
        </>
      ) : compact ? (
        /* Isotipo: círculo flanqueado por semicírculos (naranja de marca, sirve en ambos temas) */
        <img src="/brand/isotipo.png" alt="Melodya" className="h-5 w-auto" />
      ) : (
        <>
          <img src="/brand/isologo-horizontal-on-dark.png" alt="Melodya" className="hidden h-6 w-auto dark:block" />
          <img src="/brand/isologo-horizontal-on-light.png" alt="Melodya" className="block h-6 w-auto dark:hidden" />
        </>
      )}
    </span>
  );
}

/* ── AuthAvatar: avatar con reintento autenticado ──
   Los archivos de avatar del backend son PRIVADOS (el <img> no puede mandar
   Authorization). Primero probás la carga directa; si falla (403) se baja
   con fetch autenticado → object URL. Fallback: iniciales. */
export function AuthAvatar({
  src,
  name,
  className,
  fallbackClassName,
}: {
  src?: string | null;
  name: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const url = apiFileUrl(src);
  const { src: imgSrc, onError } = useAuthImage(url);
  const initials = (name || 'M')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <Avatar className={cn('border border-border/70', className)}>
      {imgSrc ? (
        <AvatarImage
          src={imgSrc}
          alt={name}
          /* Radix NO monta el <img> cuando la carga directa falla (archivos
             privados → 403 sin header), así que onError del img nunca dispara:
             el reintento autenticado se engancha al cambio de estado interno. */
          onLoadingStatusChange={(status) => {
            if (status === 'error') onError();
          }}
        />
      ) : null}
      <AvatarFallback className={cn('bg-amber/15 text-xs font-bold text-amber-strong', fallbackClassName)}>
        {initials || 'M'}
      </AvatarFallback>
    </Avatar>
  );
}

/** Barras de ecualizador (canción sonando) */
export function EqualizerBars({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="eq-bar w-[3px] rounded-sm bg-amber" style={{ height: '100%', animationDelay: `${i * 0.22}s` }} />
      ))}
    </span>
  );
}

/* ── AuthImage: imagen autenticada con reintento (portadas de perfil, v0.19) ──
   Mismo truco del AuthAvatar: primero carga directa; si el archivo es privado
   (403 sin Authorization) se baja con fetch autenticado → object URL. */
export function AuthImage({
  src,
  alt,
  className,
  children,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  /** Fallback (gradiente decorativo, placeholder…) cuando no hay imagen. */
  children?: React.ReactNode;
}) {
  const url = apiFileUrl(src);
  const { src: imgSrc, failed, onError } = useAuthImage(url);
  return (
    <div className={cn('relative overflow-hidden', className)}>
      {imgSrc && !failed ? (
        <img src={imgSrc} alt={alt} onError={onError} className="h-full w-full object-cover" />
      ) : (
        children ?? null
      )}
    </div>
  );
}
