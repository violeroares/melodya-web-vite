
/**
 * Remix fuera del plan: pantalla del creador cuando la persona llega a /create?remix=… sin la capacidad (SONG_REMIX o, en Versionar, AUDIO_REFERENCE).
 * No carga la plantilla ni muestra el creador. La decisión sale de las capacidades EFECTIVAS (nunca del nombre del plan) y el servidor la repite
 * (403 CAPABILITY_NOT_IN_PLAN) en la plantilla y al generar. «Mejorar plan» abre el aviso habitual, que indica qué planes la incluyen.
 */

import { Crown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePlanGate } from '@/hooks/use-plan-gate';
import type { CapabilityKey } from '@/lib/capabilities';

export function RemixPlanBlocked({ capability, reason, canReusePrompt, onReusePrompt, onLibrary }: {
  capability: Extract<CapabilityKey, 'SONG_REMIX' | 'AUDIO_REFERENCE'>;
  reason: string;
  /** Si solo falta AUDIO_REFERENCE, «Reutilizar configuración» sigue disponible. */
  canReusePrompt: boolean;
  onReusePrompt: () => void;
  onLibrary: () => void;
}) {
  const gate = usePlanGate(capability);
  return (
    <div role="alert" className="view-in mx-auto flex w-full max-w-xl flex-col items-start gap-4 rounded-2xl border border-border/70 bg-surface p-6" data-testid="remix-plan-blocked">
      <Crown className="h-6 w-6 text-amber-strong" aria-hidden />
      <h1 className="font-display text-xl font-extrabold">{capability === 'SONG_REMIX' ? 'Remix no está incluido en tu plan' : 'Versionar no está incluido en tu plan'}</h1>
      <p className="text-sm text-muted-foreground">{reason}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="rounded-full gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={gate.prompt}>
          <Crown className="mr-2 h-4 w-4" aria-hidden /> Mejorar plan
        </Button>
        {canReusePrompt && <Button type="button" variant="outline" className="rounded-full" onClick={onReusePrompt}>Reutilizar configuración</Button>}
        <Button type="button" variant="ghost" className="rounded-full" onClick={onLibrary}>Ir a mi biblioteca</Button>
      </div>
    </div>
  );
}
