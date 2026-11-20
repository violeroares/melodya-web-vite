/**
 * MELODYA WEB — «Tu consumo en este período»: cuánto usó el usuario de cada capacidad de su plan con un límite numérico.
 *
 * Los datos son los de GET /users/me/usage (`meters`): el servidor arma la lista a partir del registro de capacidades y de la misma tabla de cupos que usa el
 * enforcement, así que lo que se ve acá es exactamente lo que se cuenta y se exige. La lista es dinámica (no hay capacidades fijas en la interfaz) y el saldo de
 * fichas NO forma parte de esta sección. Si el consumo no se puede cargar la sección no se muestra (no se inventa ningún valor).
 */
import React from 'react';
import { BarChart3 } from 'lucide-react';
import { useUsage } from '@/hooks/use-capabilities';
import { usageMeterLines, usagePeriodText } from '@/lib/capabilities';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function PlanUsage({ className }: { className?: string }) {
  const { data: usage, isLoading } = useUsage();

  if (isLoading) {
    return (
      <div role="status" className={cn('space-y-2', className)} aria-label="Cargando tu consumo">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }
  const lines = usageMeterLines(usage);
  if (lines.length === 0) return null;
  const period = usagePeriodText(usage);

  return (
    <section className={cn('space-y-3', className)} aria-labelledby="plan-usage-title" data-testid="plan-usage">
      <div>
        <h3 id="plan-usage-title" className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <BarChart3 className="h-4 w-4 text-amber-strong" aria-hidden /> Tu consumo en este período
        </h3>
        {period && <p className="mt-0.5 text-xs text-muted-foreground">{period}</p>}
      </div>
      <ul className="space-y-3.5">
        {lines.map((l) => (
          <li key={l.key} data-testid={`usage-${l.key}`} data-state={l.state}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-sm text-foreground">{l.name}</span>
              <span className={cn('shrink-0 text-sm font-semibold tabular-nums', l.state === 'reached' ? 'text-coral' : l.state === 'bar' ? 'text-foreground' : 'text-muted-foreground')}>
                {l.value}
              </span>
            </div>
            {l.state !== 'not-included' && l.state !== 'unlimited' && (
              <Progress
                value={l.percent}
                aria-label={`${l.name}: ${l.value}`}
                className={cn('mt-1.5 h-2', l.state === 'reached' ? 'bg-coral/20 [&_[data-slot=progress-indicator]]:bg-coral' : 'bg-amber/20 [&_[data-slot=progress-indicator]]:bg-amber')}
              />
            )}
            {l.detail && <p className={cn('mt-1 text-xs', l.state === 'reached' ? 'font-medium text-coral' : 'text-muted-foreground')}>{l.detail}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
