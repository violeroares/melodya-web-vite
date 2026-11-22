'use client';

/**
 * Atajo «Remix» del detalle de canción: botón redondo (estilo de «Me gusta» / «No me gusta»)
 * que abre las dos modalidades del menú de tres puntos. Quién lo ve lo decide `remixMenuState` (lo evalúa el llamador).
 * Sin SONG_REMIX en el plan se ve atenuado y al pulsarlo abre el aviso de mejora, igual que la entrada del menú.
 */

import { Copy, Disc3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RequiredPlanBadge } from '@/components/common/PlanGate';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { LOCK_REASON } from '@/lib/capabilities';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import type { RemixMode } from '@/types';
import { MODE_LABEL, remixUrl } from '@/features/creator/remix-source';
import { RemixIcon } from '@/features/song/RemixIcon';

/* Mismo estilo que «Me gusta» / «No me gusta»: contorno fino, sin relleno */
const ROUND = 'size-12 rounded-full border-[1.5px] border-foreground bg-transparent p-0 text-foreground hover:bg-foreground/10 hover:text-foreground';

export function RemixShortcutButton({ songId, versionId, title }: { songId: string; versionId?: string | null; title: string }) {
  const remixGate = usePlanGate('SONG_REMIX');
  const referenceGate = usePlanGate('AUDIO_REFERENCE');

  const go = (mode: RemixMode) => {
    if (remixGate.locked) { remixGate.prompt(); return; }
    if (mode === 'COVER' && referenceGate.locked) { referenceGate.prompt(); return; }
    navigate(remixUrl(songId, mode, versionId));
  };

  if (remixGate.locked) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        title={LOCK_REASON.SONG_REMIX}
        aria-label={`Remix de ${title} (no incluido en tu plan)`}
        onClick={() => remixGate.prompt()}
        data-testid="remix-shortcut-locked"
        className={cn(ROUND, 'opacity-70')}
      >
        <RemixIcon className="h-5 w-5" aria-hidden />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" title="Remix" aria-label={`Remix de ${title}`} data-testid="remix-shortcut" className={ROUND}>
          <RemixIcon className="h-5 w-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" variant="list">
        <DropdownMenuItem onClick={() => go('COVER')} title="Crea una canción nueva usando el audio de esta como referencia">
          <Disc3 className="h-4 w-4" aria-hidden /> {MODE_LABEL.COVER}
          <RequiredPlanBadge capability="AUDIO_REFERENCE" className="ml-auto" />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => go('PROMPT_REUSE')} title="Crea una canción nueva con la letra y el estilo de esta, sin su audio">
          <Copy className="h-4 w-4" aria-hidden /> {MODE_LABEL.PROMPT_REUSE}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
