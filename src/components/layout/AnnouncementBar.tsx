
/**
 * MELODYA WEB — AnnouncementBar: aviso superior administrado desde el
 * backoffice. Efectos reales del backend: SCROLL | PULSE | STATIC | TYPE |
 * SHINE, con colores bgColor/textColor configurables y link opcional.
 *
 * SCROLL (marquesina): el texto scrollea y el botón de acción (linkLabel)
 * queda FIJO a la derecha, siempre clicable. SHINE se muestra como
 * "parpadeo" suave y legible (el barrido rápido original no se leía).
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, X } from 'lucide-react';
import { cmsApi } from '@/lib/api';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

const DISMISS_KEY = 'melodya.announcement.dismissed';

function readDismissed(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function AnnouncementBar() {
  // Sin datos del CMS (SSR / primer render) la barra no se pinta, así que leer
  // localStorage al inicializar no genera diferencias de hidratación.
  const [dismissed, setDismissed] = React.useState<string[]>(readDismissed);

  const { data } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => cmsApi.announcements(),
    staleTime: 60_000,
  });

  const items = (data?.items ?? []).filter((a) => !dismissed.includes(a.id));
  if (!items.length) return null;
  const announcement = items[0];

  const bg = announcement.bgColor ?? 'var(--surface-2)';
  const fg = announcement.textColor ?? 'var(--foreground)';
  const hasAction = Boolean(announcement.linkUrl && announcement.linkLabel);
  const external = announcement.linkUrl ? /^https?:\/\//.test(announcement.linkUrl) : false;

  const dismiss = () => {
    const next = [...dismissed, announcement.id];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
  };

  const message = (
    <span
      className={cn(
        'text-xs font-medium tracking-wide sm:text-sm',
        announcement.effect === 'PULSE' && 'announce-pulse',
        announcement.effect === 'TYPE' && 'announce-type',
        announcement.effect === 'SHINE' && 'announce-shine'
      )}
    >
      {announcement.message}
    </span>
  );

  /* Botón de acción (linkLabel): siempre visible y fijo, en todos los efectos. */
  const actionButton = hasAction ? (
    external ? (
      <a
        href={announcement.linkUrl!}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider opacity-90 transition-all hover:opacity-100"
        style={{ borderColor: fg, color: fg }}
      >
        {announcement.linkLabel}
        <ArrowRight className="h-3 w-3" aria-hidden />
      </a>
    ) : (
      <Link
        to={announcement.linkUrl!.replace(/^#/, '')}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider opacity-90 transition-all hover:opacity-100"
        style={{ borderColor: fg, color: fg }}
      >
        {announcement.linkLabel}
        <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    )
  ) : null;

  return (
    <div role="status" className="relative w-full overflow-hidden" style={{ backgroundColor: bg, color: fg }}>
      {announcement.effect === 'SCROLL' ? (
        <div className="flex items-stretch">
          {/* Marquesina: el texto corre, el botón queda fijo a la derecha */}
          <div className="announce-scroll-mask min-w-0 flex-1 overflow-hidden">
            <div className="announce-scroll flex w-max whitespace-nowrap py-2" aria-hidden={false}>
              <span className="px-6 text-xs font-medium tracking-wide sm:text-sm">{announcement.message}</span>
              <span className="px-6 text-xs font-medium tracking-wide sm:text-sm" aria-hidden>
                {announcement.message}
              </span>
            </div>
          </div>
          {actionButton && (
            <div
              className="flex shrink-0 items-center border-l py-2 pr-2 pl-3"
              style={{ borderColor: `${fg}33`, background: bg }}
            >
              {actionButton}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 px-10 py-2 text-center">
          {message}
          {actionButton}
        </div>
      )}
      <button
        onClick={dismiss}
        aria-label="Cerrar aviso"
        className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
