
/**
 * Aviso de disponibilidad de una voz clonada al ELEGIRLA (no al listar): consulta GET /samples/:id/voice-availability, que el backend
 * cachea 2 minutos. Solo una respuesta definitiva «caducada» muestra el aviso con la acción de recrearla; si no se pudo comprobar
 * (red, timeout) no se muestra nada ni se afirma que caducó: la generación sigue su camino y el backend decide.
 */
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Mic2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { samplesApi } from '@/lib/api';
import { VOICE_AVAILABILITY_MAX_CONCURRENT, VOICE_AVAILABILITY_STALE_MS, VOICE_EXPIRED_TEXT, VOICE_EXPIRED_TITLE, availabilityState, createConcurrencyLimiter } from './voice-expiry';

// Compartido por todas las tarjetas: aunque se monten varias a la vez, a Suno van como mucho 5 consultas simultáneas.
const limitAvailabilityChecks = createConcurrencyLimiter(VOICE_AVAILABILITY_MAX_CONCURRENT);

/** Una entrada de caché por voz (`['voice-availability', sampleId]`): tarjetas, cambio de vista y el selector del creador la comparten. */
export function useVoiceAvailability(sampleId: string | null | undefined) {
  return useQuery({
    queryKey: ['voice-availability', sampleId],
    queryFn: () => limitAvailabilityChecks(() => samplesApi.voiceAvailability(sampleId as string)),
    enabled: Boolean(sampleId),
    staleTime: VOICE_AVAILABILITY_STALE_MS,
    retry: false, // un fallo es «desconocido», no se insiste
    refetchOnWindowFocus: false,
  });
}

export function VoiceExpiredCard({ onRecreate, disabled = false }: { onRecreate: () => void; disabled?: boolean }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-cover border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center">
      <CircleAlert className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{VOICE_EXPIRED_TITLE}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{VOICE_EXPIRED_TEXT}</p>
      </div>
      <Button type="button" size="sm" className="rounded-full" onClick={onRecreate} disabled={disabled}>
        <Mic2 className="mr-2 h-3.5 w-3.5" aria-hidden /> Recrear mi voz
      </Button>
    </div>
  );
}

export function VoiceAvailabilityNotice({ sampleId, onRecreate, disabled = false }: { sampleId: string | null | undefined; onRecreate: (sampleId: string) => void; disabled?: boolean }) {
  const { data } = useVoiceAvailability(sampleId);
  if (!sampleId || availabilityState(data) !== 'expired') return null;
  return <VoiceExpiredCard onRecreate={() => onRecreate(sampleId)} disabled={disabled} />;
}
