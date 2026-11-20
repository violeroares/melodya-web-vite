
/**
 * «Otra versión»: reúne por id todo lo necesario para reconstruir los planetas de la versión elegida.
 *
 *   canción (songsApi.get) → versiones (songsApi.versions, todas) → generación de la versión (generationApi.get)
 *   → muestras de voz y referencia (samplesApi.get) → disponibilidad de la voz clonada (samplesApi.voiceAvailability)
 *
 * Nada se busca dentro de una lista paginada. No guarda estado propio: todo sale de React Query (las mismas claves que el detalle de la
 * canción: ['song', id], ['song', id, 'versions'], ['generation', id], ['voice-availability', id]) y de una función pura. La mezcla con lo que
 * el usuario edita la hace el creador: lo editado siempre gana, así que una respuesta tardía no puede pisarlo.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { generationApi, samplesApi, songsApi } from '@/lib/api';
import { ApiError } from '@/lib/api/client';
import { useAuthStore } from '@/stores/auth';
import { useVoiceAvailability } from '@/features/voice/VoiceAvailabilityNotice';
import { availabilityState } from '@/features/voice/voice-expiry';
import type { CapabilityLocks } from '@/lib/capabilities';
import type { Song } from '@/types';
import {
  BLANK_ORIGIN, blankHydration, resolveOrigin, resolveSample, sampleIdsOf, songFromGeneration, songFromVersion, versionOptions,
  type Hydration, type SampleLookup, type SampleRecord, type VersionOption, type VoiceCheck,
} from './version-source';

const isClientError = (err: unknown): boolean => err instanceof ApiError && err.status >= 400 && err.status < 500;
const isGone = (err: unknown): boolean => err instanceof ApiError && (err.status === 404 || err.status === 403);
/** Un 4xx no mejora reintentando; red, timeout o 5xx sí (dos intentos más). */
const retryTransient = (count: number, err: unknown): boolean => !isClientError(err) && count < 2;

function lookupOf(q: { data?: SampleRecord; isError: boolean; error: unknown }): SampleLookup {
  if (q.data) return { state: 'found', sample: q.data };
  if (q.isError) return isGone(q.error) ? { state: 'not-found' } : { state: 'error' };
  return { state: 'loading' };
}

export type BlockedKind = 'not-found' | 'not-owner' | 'error';
export interface VersionSource {
  status: 'loading' | 'blocked' | 'ready';
  blocked: { kind: BlockedKind; message: string } | null;
  song: Song | null;
  options: VersionOption[];
  /** Versión elegida como origen, `blank` (sin configuración) o `null` (la canción no tiene versiones). */
  originId: string | null;
  /** Lo que el creador muestra mientras el usuario no haya editado nada. */
  hydration: Hydration;
  /** Se está leyendo la configuración original: hasta que termine no se edita ni se crea. */
  loading: boolean;
  retry: () => void;
}

export function useVersionSource(args: { songId: string | null; from: string | null; locks: CapabilityLocks }): VersionSource {
  const { songId, from, locks } = args;
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const on = Boolean(songId);

  const songQ = useQuery({ queryKey: ['song', songId], queryFn: () => songsApi.get(songId as string), enabled: on, staleTime: 0, refetchOnWindowFocus: false, retry: retryTransient });
  const song = songQ.data ?? null;
  const owned = Boolean(song && userId && song.userId === userId);
  const versionsQ = useQuery({ queryKey: ['song', songId, 'versions'], queryFn: () => songsApi.versions(songId as string), enabled: on && owned && !songQ.isError, refetchOnWindowFocus: false, retry: retryTransient });
  const versions = useMemo(() => versionsQ.data?.items ?? [], [versionsQ.data]);

  const options = useMemo(() => versionOptions(versions, song?.currentVersionId), [versions, song?.currentVersionId]);
  const originId = versionsQ.data && song ? resolveOrigin({ from, versions, currentVersionId: song.currentVersionId }) : null;
  const originVersion = originId && originId !== BLANK_ORIGIN ? versions.find((v) => v.id === originId) ?? null : null;
  const generationId = originVersion?.generationId ?? null;

  // Una consulta por generación: los dos clips de un mismo pedido comparten la entrada de caché.
  const genQ = useQuery({ queryKey: ['generation', generationId], queryFn: () => generationApi.get(generationId as string), enabled: Boolean(generationId), staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: retryTransient });

  const ids = sampleIdsOf(genQ.data);
  const voiceQ = useQuery({ queryKey: ['sample', ids.voice], queryFn: () => samplesApi.get(ids.voice as string), enabled: Boolean(ids.voice), staleTime: 60_000, refetchOnWindowFocus: false, retry: retryTransient });
  const refQ = useQuery({ queryKey: ['sample', ids.reference], queryFn: () => samplesApi.get(ids.reference as string), enabled: Boolean(ids.reference), staleTime: 60_000, refetchOnWindowFocus: false, retry: retryTransient });

  // Solo las voces clonadas de Suno Voice caducan; el resto de las muestras no tiene nada que comprobar.
  const voice = voiceQ.data;
  const checkVoice = Boolean(voice && voice.kind === 'VOICE' && voice.sunoPersonaId && voice.sunoPersonaModel === 'voice_persona');
  const availQ = useVoiceAvailability(checkVoice ? ids.voice : null);

  const hydration = useMemo<Hydration>(() => {
    if (!originId || originId === BLANK_ORIGIN) return blankHydration();
    if (!generationId) return songFromVersion(originVersion);
    if (genQ.data) {
      const check: VoiceCheck = !checkVoice ? { state: 'idle' }
        : availQ.data ? { state: availabilityState(availQ.data) === 'expired' ? 'expired' : availabilityState(availQ.data) === 'available' ? 'available' : 'unknown' }
        : availQ.isError ? { state: 'unknown' }
        : { state: 'loading' };
      return songFromGeneration({
        generation: genQ.data,
        voice: ids.hasVoice ? resolveSample({ role: 'voice', sampleId: ids.voice, lookup: lookupOf({ data: voiceQ.data, isError: voiceQ.isError, error: voiceQ.error }), check }) : null,
        reference: ids.hasReference ? resolveSample({ role: 'reference', sampleId: ids.reference, lookup: lookupOf({ data: refQ.data, isError: refQ.isError, error: refQ.error }) }) : null,
        locks,
      });
    }
    if (genQ.isError) {
      // La generación ya no se puede leer (404/403): se recupera lo que la propia versión guardó. Un fallo temporal no se disfraza de eso.
      if (isGone(genQ.error)) return songFromVersion(originVersion);
      return { ...blankHydration(), notes: [{ id: 'generation-error', tone: 'warning', action: 'retry', text: 'No pudimos leer la configuración de esa versión por un problema temporal. Reintentá o empezá con los planetas vacíos.' }] };
    }
    return blankHydration();
  }, [originId, originVersion, generationId, genQ.data, genQ.isError, genQ.error, ids.voice, ids.reference, ids.hasVoice, ids.hasReference, voiceQ.data, voiceQ.isError, voiceQ.error, refQ.data, refQ.isError, refQ.error, checkVoice, availQ.data, availQ.isError, locks]);

  const loading = on && !songQ.isError && (
    songQ.isPending || (owned && versionsQ.isPending)
    || (Boolean(generationId) && genQ.isPending)
    || (Boolean(generationId) && Boolean(genQ.data) && ((ids.voice ? voiceQ.isPending : false) || (ids.reference ? refQ.isPending : false) || (checkVoice && availQ.isPending)))
  );

  const blocked = ((): VersionSource['blocked'] => {
    if (songQ.isError) {
      if (songQ.error instanceof ApiError && songQ.error.status === 404) return { kind: 'not-found', message: 'Esta canción no existe o está en la Papelera. Restaurala desde la Papelera para crear otra versión.' };
      if (songQ.error instanceof ApiError && songQ.error.status === 403) return { kind: 'not-owner', message: 'Esta canción no es tuya, así que no podés crear otra versión.' };
      return { kind: 'error', message: 'No pudimos cargar la canción por un problema temporal. Reintentá en unos segundos.' };
    }
    if (song && userId && song.userId !== userId) return { kind: 'not-owner', message: 'Esta canción no es tuya, así que no podés crear otra versión.' };
    if (versionsQ.isError) {
      if (versionsQ.error instanceof ApiError && versionsQ.error.status === 404) return { kind: 'not-found', message: 'Esta canción no existe o está en la Papelera. Restaurala desde la Papelera para crear otra versión.' };
      return { kind: 'error', message: 'No pudimos cargar las versiones de la canción por un problema temporal. Reintentá en unos segundos.' };
    }
    return null;
  })();

  const retry = () => {
    if (songQ.isError) void songQ.refetch();
    if (versionsQ.isError) void versionsQ.refetch();
    if (genQ.isError) void genQ.refetch();
    if (voiceQ.isError) void voiceQ.refetch();
    if (refQ.isError) void refQ.refetch();
  };

  return { status: blocked ? 'blocked' : loading ? 'loading' : 'ready', blocked, song, options, originId, hydration, loading, retry };
}
