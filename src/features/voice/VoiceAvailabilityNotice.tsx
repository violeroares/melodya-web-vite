'use client';

/**
 * Aviso de disponibilidad de una voz clonada al ELEGIRLA (no al listar): consulta GET /samples/:id/voice-availability, que el backend
 * cachea 2 minutos. Solo una respuesta definitiva «caducada» muestra el aviso con la acción de recrearla; si no se pudo comprobar
 * (red, timeout) no se muestra nada ni se afirma que caducó: la generación sigue su camino y el backend decide.
 */
import { useQuery } from '@tanstack/react-query';
import { Mic } from 'lucide-react';
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

/** Voz caducada, con el estilo de «Mis voces caducadas» de design-V2 (Crear · Tus voces): tarjeta 28/28/14/14 y una fila con el avatar atenuado
 *  (micrófono del planeta Voz al 55 %), el título en Bricolage 16/700 a su lado, el texto en 13 px secundario a todo el ancho de la tarjeta y «Recrear» abajo como botón con borde, centrado. */
export function VoiceExpiredCard({ onRecreate, disabled = false }: { onRecreate: () => void; disabled?: boolean }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-[28px_28px_14px_14px] border-[1.5px] border-border bg-[var(--m-input)] px-3.5 py-3.5">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-voice text-[#F0A44B] opacity-55">
          <Mic className="h-[22px] w-[22px]" />
        </span>
        <p className="min-w-0 flex-1 font-display text-base font-bold leading-[1.2] text-foreground">{VOICE_EXPIRED_TITLE}</p>
      </div>
      <p className="text-[13px] leading-[1.35] text-muted-foreground">{VOICE_EXPIRED_TEXT}</p>
      <button
        type="button"
        onClick={onRecreate}
        disabled={disabled}
        aria-label="Recrear mi voz"
        className="inline-flex min-h-10 shrink-0 items-center justify-center self-center rounded-3xl border-[1.5px] border-line px-4 text-[15px] font-bold leading-[1.2] tracking-[0.02em] text-foreground transition-colors hover:bg-foreground/10 focus-visible:ring-[4px] focus-visible:ring-[var(--m-focus-ring)] focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 disabled:border-transparent"
      >
        Recrear
      </button>
    </div>
  );
}

export function VoiceAvailabilityNotice({ sampleId, onRecreate, disabled = false }: { sampleId: string | null | undefined; onRecreate: (sampleId: string) => void; disabled?: boolean }) {
  const { data } = useVoiceAvailability(sampleId);
  if (!sampleId || availabilityState(data) !== 'expired') return null;
  return <VoiceExpiredCard onRecreate={() => onRecreate(sampleId)} disabled={disabled} />;
}
