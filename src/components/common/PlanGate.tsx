
/**
 * MELODYA WEB — Patrón común de funcionalidades fuera del plan: corona + etiqueta del plan mínimo, estilo «bloqueado» y UN solo aviso de upgrade.
 *
 *  • <RequiredPlanBadge capability=… /> — corona discreta y el plan mínimo («Creator» / «Pro»). No muestra nada si el usuario ya tiene la funcionalidad.
 *  • <UpgradeDialog /> — el aviso que se abre al pulsar algo bloqueado (montado una vez en AppShell). Explica qué se intentó usar, qué plan lo habilita y lleva a
 *    «Planes y fichas». No inicia ningún checkout.
 *  • LOCKED_CONTROL — clases comunes del estado bloqueado (visible, atenuado, con borde punteado): el control sigue siendo clicable para mostrar el aviso.
 * Un cupo agotado NO usa este patrón (es otra situación: ver lib/capabilities, limitExceeded / songsMeterText).
 */
import React from 'react';
import { Crown } from 'lucide-react';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import type { CapabilityKey } from '@/lib/capabilities';
import { usePlanCatalog, usePlanGate } from '@/hooks/use-plan-gate';
import { upgradeCopy } from '@/lib/plan-gate';
import { useUpgradePrompt } from '@/stores/upgrade-prompt';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Estilo común de un control bloqueado por el plan: se ve, se nota que no está incluido y sigue siendo clicable (abre el aviso). */
export const LOCKED_CONTROL = 'border-dashed border-amber/40 text-muted-foreground opacity-90 hover:border-amber/60 hover:bg-amber/5';

/** Corona + plan mínimo. Aparece cuando el plan efectivo NO incluye la capacidad (`excluded`), con cualquier `entitlements.mode`: la corona informa, no bloquea. */
export function RequiredPlanBadge({ capability, className, showCrownOnly = false }: { capability: CapabilityKey; className?: string; showCrownOnly?: boolean }) {
  const gate = usePlanGate(capability);
  if (!gate.excluded) return null;
  const label = gate.copy?.planLabel ?? null;
  return (
    <span
      data-testid={`plan-badge-${capability}`}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 text-[11px] font-semibold leading-none text-amber-strong', className)}
    >
      <Crown className="h-3 w-3" aria-hidden />
      {label && !showCrownOnly ? <span>{label}</span> : null}
      <span className="sr-only">{label ? ` — disponible en el plan ${label}` : ' — no incluido en tu plan'}</span>
    </span>
  );
}

/** Aviso de upgrade global. Se abre con useUpgradePrompt().show(capacidad) y lleva a «Planes y fichas». */
export function UpgradeDialog() {
  const capability = useUpgradePrompt((s) => s.capability);
  const close = useUpgradePrompt((s) => s.close);
  const plans = usePlanCatalog();
  const copy = capability ? upgradeCopy(capability, plans) : null;

  return (
    <Dialog open={capability !== null} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md border-border/70 bg-surface" data-testid="upgrade-dialog">
        {copy && (
          <>
            <DialogHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-amber/15 text-amber-strong" aria-hidden>
                <Crown className="h-5 w-5" />
              </div>
              <DialogTitle className="font-display">{copy.title}</DialogTitle>
              <DialogDescription className="text-left leading-relaxed">{copy.message}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="ghost" className="rounded-full" onClick={close}>Ahora no</Button>
              <Button
                className="rounded-full"
                onClick={() => { close(); navigate('/plans'); }}
              >
                Ver planes y fichas
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
