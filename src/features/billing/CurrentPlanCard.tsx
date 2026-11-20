/**
 * MELODYA WEB — «Tu plan Free» (plan base) y la lista de capacidades y límites de un plan.
 *
 * Free es el plan BASE: lo tiene todo usuario sin una suscripción paga vigente y NO es una suscripción (no hay renovación ni cancelación). El servidor
 * informa el plan efectivo (`effectivePlan`) y las capacidades de cada plan; esta tarjeta solo las presenta. Contratar Creator o Pro se hace desde las
 * tarjetas de plan de la misma pantalla.
 */
import React from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { planCapabilityLines, planTitle, type PlanEntitlementLike } from '@/lib/subscription';
import type { EffectivePlan } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { PlanUsage } from './PlanUsage';

type Entitlements = Record<string, PlanEntitlementLike | undefined> | null | undefined;

/** Capacidades y límites del plan (lo incluido y lo que no), con sus topes. */
export function PlanCapabilities({ entitlements, className }: { entitlements: Entitlements; className?: string }) {
  const lines = planCapabilityLines(entitlements);
  return (
    <ul className={cn('grid gap-x-6 gap-y-1.5 sm:grid-cols-2', className)} aria-label="Capacidades y límites de tu plan" data-testid="plan-capabilities">
      {lines.map((l) => (
        <li key={l.key} className="flex items-start gap-2 text-sm">
          <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center', l.included ? 'text-foreground' : 'text-muted-foreground')} aria-hidden>
            {l.included ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <X className="h-4 w-4" strokeWidth={2.5} />}
          </span>
          <span className={l.included ? 'text-foreground' : 'text-muted-foreground'}>
            {l.label}
            {l.detail ? <>: <span className="font-semibold">{l.detail}</span></> : null}
            <span className="sr-only">{l.included ? ' (incluido)' : ' (no incluido)'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CurrentPlanCard({ effectivePlan, entitlements }: { effectivePlan: EffectivePlan; entitlements: Entitlements }) {
  return (
    <Card className="mb-8 w-full rounded-cover border-amber/40 bg-surface" data-testid="current-plan-card">
      <CardContent className="grid gap-6 p-5 lg:grid-cols-2 lg:gap-8">
        <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-strong" aria-hidden />
          <h2 className="font-display text-lg font-extrabold text-foreground">{planTitle(effectivePlan)}</h2>
          <Badge variant="outline" className="border-amber/40 text-amber-strong">Plan base</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Es tu plan desde que te registraste: es gratuito y no vence. Elegí Creator o Pro cuando quieras más canciones y más herramientas.
        </p>
        <PlanCapabilities entitlements={entitlements} className="sm:grid-cols-1 xl:grid-cols-2" />
        </div>
        <PlanUsage className="border-t border-border/60 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" />
      </CardContent>
    </Card>
  );
}
