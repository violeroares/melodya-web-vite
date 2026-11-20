
/**
 * MELODYA WEB — Ítem «Descargar WAV» de los menús de descarga (detalle de canción y filas de versiones).
 *
 * El estado sale de `wavMenuState` (lib/capabilities, lógica pura y probada): bloqueado por el plan (corona + aviso de upgrade, igual que el
 * MP3), listo, preparando, fallido (reintentar), o aún sin conversión (preparar). El WAV se convierte bajo demanda, una sola vez, y queda guardado
 * para las descargas siguientes; el plan decide si se puede pedir y descargar.
 */
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import type { WavMenuState } from '@/lib/capabilities';

export function WavMenuItem({ state, onSelect }: { state: WavMenuState; onSelect: () => void }) {
  const spinning = state.busy;
  return (
    <DropdownMenuItem
      data-testid="download-wav"
      data-wav-state={state.kind}
      disabled={state.disabled}
      aria-busy={state.busy || undefined}
      onClick={onSelect}
      title={state.title}
      className={state.kind === 'locked' ? 'opacity-90' : undefined}
    >
      {spinning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : state.kind === 'failed' && !state.disabled ? <RefreshCw className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
      {state.label}
      <RequiredPlanBadge capability="DOWNLOAD_WAV" className="ml-auto" />
    </DropdownMenuItem>
  );
}
