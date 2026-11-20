
/**
 * Menú «Remix» de una canción (detalle, Comunidad y Biblioteca). Dos modalidades, ambas crean una canción NUEVA e independiente:
 *  • Versionar (Cover): usa el audio de esta canción como referencia (necesita AUDIO_REFERENCE además de SONG_REMIX).
 *  • Reutilizar configuración: copia letra y estilo, sin el audio.
 * «Otra versión» NO vive acá: agrega una versión a la misma canción y no cambia.
 * Quién ve la entrada lo decide `remixMenuState`; el servidor vuelve a validar al abrir la plantilla y al aceptar la generación.
 */

import { Copy, Disc3 } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { LOCK_REASON } from '@/lib/capabilities';
import { navigate } from '@/lib/router';
import type { RemixMode } from '@/types';
import { MODE_LABEL, remixUrl } from '@/features/creator/remix-source';
import { RemixIcon } from '@/features/song/RemixIcon';

export function RemixMenu({ songId, versionId }: { songId: string; versionId?: string | null }) {
  const remixGate = usePlanGate('SONG_REMIX');
  const referenceGate = usePlanGate('AUDIO_REFERENCE');

  const go = (mode: RemixMode) => {
    // Defensa extra (el menú bloqueado ya no llega acá): un plan sin la capacidad no abre el creador.
    if (remixGate.locked) { remixGate.prompt(); return; }
    if (mode === 'COVER' && referenceGate.locked) { referenceGate.prompt(); return; }
    navigate(remixUrl(songId, mode, versionId));
  };

  // Sin SONG_REMIX en el plan (capacidades efectivas): Remix se ve BLOQUEADO, con corona y plan mínimo, y al pulsarlo abre el aviso de mejora.
  // No se despliega ninguna modalidad.
  if (remixGate.locked) {
    return (
      <DropdownMenuItem onClick={() => remixGate.prompt()} title={LOCK_REASON.SONG_REMIX} data-testid="remix-locked">
        <RemixIcon className="h-4 w-4" aria-hidden /> Remix
        <RequiredPlanBadge capability="SONG_REMIX" className="ml-auto" />
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="remix-menu">
        <RemixIcon className="h-4 w-4" aria-hidden /> Remix
        <RequiredPlanBadge capability="SONG_REMIX" className="ml-auto" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent variant="list">
        <DropdownMenuItem onClick={() => go('COVER')} title="Crea una canción nueva usando el audio de esta como referencia" data-testid="remix-cover">
          <Disc3 className="h-4 w-4" aria-hidden /> {MODE_LABEL.COVER}
          <RequiredPlanBadge capability="AUDIO_REFERENCE" className="ml-auto" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => go('PROMPT_REUSE')} title="Crea una canción nueva con la letra y el estilo de esta, sin su audio" data-testid="remix-prompt">
          <Copy className="h-4 w-4" aria-hidden /> {MODE_LABEL.PROMPT_REUSE}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
