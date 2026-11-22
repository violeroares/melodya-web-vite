import type { ReactNode } from 'react';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Estado vacío de las secciones, como el de la Papelera (design-V2 `.dropz`): borde punteado de 1,5 px, esquinas de 28 px y sin fondo;
 * anillo de 72 px con el círculo dorado suave de 52 px, título de 17 px y texto de 13 px. Con `actionLabel` + `actionTo` suma un botón de contorno.
 */
export function DashedEmpty({
  icon,
  title,
  description,
  actionLabel,
  actionTo,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  actionTo?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex w-full flex-col items-center gap-2.5 rounded-[28px] border-[1.5px] border-dashed border-line px-4 py-7 text-center text-foreground',
        className
      )}
    >
      <span aria-hidden className="flex size-[72px] shrink-0 items-center justify-center rounded-full border-[3px] border-line">
        <span className="flex size-[52px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--m-gold)_18%,var(--m-surface))] text-amber-strong [&_svg]:size-[26px]">
          {icon}
        </span>
      </span>
      <b className="text-[17px] leading-[1.3] font-bold">{title}</b>
      {description && <span className="text-[13px] leading-[1.35] text-muted-foreground">{description}</span>}
      {actionLabel && actionTo && (
        <Button asChild variant="outline" className="mt-1.5 rounded-full border-[1.5px] border-line bg-transparent text-foreground hover:bg-accent">
          <Link to={actionTo}>{actionLabel}</Link>
        </Button>
      )}
    </div>
  );
}
