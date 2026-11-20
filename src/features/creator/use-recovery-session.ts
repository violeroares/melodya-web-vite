
/**
 * Recuperación de una generación fallida dentro del creador (E4): estado local (`recovery-store`), generación a ofrecer al volver, y la
 * solicitud reconstruida por el servidor (`GET /generations/:id/recovery`) con sus muestras.
 *
 * Una sola recuperación activa y el mismo espacio de composición de siempre: este hook NO escribe los planetas; el creador los aplica cuando
 * `hydration` está lista y la sesión lo pide (`needsApply`). Nada se carga solo sobre una composición existente: lo decide el usuario.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { generationApi, samplesApi } from '@/lib/api';
import { ApiError } from '@/lib/api/client';
import { browserStorage } from '@/lib/draft-store';
import { endSession, markHandled, readRecovery, startSession, updateSession, type HandledState, type OtherOrigin, type RecoveryRecord, type RecoverySession, type DestinationChoice } from '@/lib/recovery-store';
import { isRetryAvailable, subscribeRetryAvailability } from '@/lib/retry-availability';
import type { CapabilityLocks } from '@/lib/capabilities';
import type { Generation, GenerationRecovery } from '@/types';
import { useVoiceAvailability } from '@/features/voice/VoiceAvailabilityNotice';
import { availabilityState } from '@/features/voice/voice-expiry';
import { resolveSample, sampleIdsOf, type Hydration, type SampleLookup, type SampleRecord, type VoiceCheck } from './version-source';
import { generationLikeOfRecovery, pickRecoveryCandidate, songFromRecovery } from './recovery-model';

const isClientError = (err: unknown): boolean => err instanceof ApiError && err.status >= 400 && err.status < 500;
const isGone = (err: unknown): boolean => err instanceof ApiError && (err.status === 404 || err.status === 403);
const retryTransient = (count: number, err: unknown): boolean => !isClientError(err) && count < 2;

function lookupOf(q: { data?: SampleRecord; isError: boolean; error: unknown }): SampleLookup {
  if (q.data) return { state: 'found', sample: q.data };
  if (q.isError) return isGone(q.error) ? { state: 'not-found' } : { state: 'error' };
  return { state: 'loading' };
}

export type RecoveryProblem =
  | { kind: 'not-retryable'; reason: string | null }
  | { kind: 'gone' } // no existe o no es del usuario
  | { kind: 'temporary' };

const EMPTY_RECORD: RecoveryRecord = { v: 1, userId: '', handled: {}, active: null };

export function useRecoverySession(args: { userId: string | null; offerEnabled: boolean; locks: CapabilityLocks }) {
  const { userId, offerEnabled, locks } = args;
  const storage = useMemo(() => browserStorage(), []);
  const [record, setRecord] = useState<RecoveryRecord>(EMPTY_RECORD);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!userId) { setRecord(EMPTY_RECORD); setLoadedFor(null); return; }
    setRecord(readRecovery(storage, userId));
    setLoadedFor(userId);
  }, [storage, userId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const ready = userId !== null && loadedFor === userId;
  const session = ready ? record.active : null;

  /* ── Qué ofrecer al volver al creador ── */
  const candidateQ = useQuery({
    queryKey: ['recovery-candidate', userId],
    queryFn: () => generationApi.list({ pageSize: 10 }),
    enabled: ready && offerEnabled && session === null,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false, // un fallo al consultar no molesta con un aviso: simplemente no se ofrece
  });
  const candidate = useMemo<Generation | null>(
    // eslint-disable-next-line react-hooks/purity -- la ventana de recuperación depende de la hora actual al evaluar el candidato
    () => (ready && offerEnabled && session === null && candidateQ.data ? pickRecoveryCandidate(candidateQ.data.items, record.handled, Date.now()) : null),
    [ready, offerEnabled, session, candidateQ.data, record.handled],
  );

  /* ── La solicitud reconstruida por el servidor ── */
  const generationId = session?.generationId ?? null;
  const regenerate = session?.regenerateLyrics === true;
  const recQ = useQuery({
    queryKey: ['generation-recovery', generationId, regenerate],
    queryFn: () => generationApi.recovery(generationId as string, { regenerateLyrics: regenerate }),
    enabled: Boolean(generationId),
    staleTime: 0, // el estado del destino se calcula al consultar: siempre fresco
    refetchOnWindowFocus: false,
    retry: retryTransient,
  });
  const recovery: GenerationRecovery | null = recQ.data ?? null;

  const problem = useMemo<RecoveryProblem | null>(() => {
    if (!recQ.isError) return null;
    const e = recQ.error;
    if (e instanceof ApiError && e.status === 409) {
      const d = e.details as { code?: unknown; reason?: unknown } | undefined;
      if (d?.code === 'GENERATION_NOT_RETRYABLE') return { kind: 'not-retryable', reason: typeof d.reason === 'string' ? d.reason : null };
    }
    return isGone(e) ? { kind: 'gone' } : { kind: 'temporary' };
  }, [recQ.isError, recQ.error]);

  // Si ya tiene reintento, se averigua cuál es (el contrato de recuperación no lo incluye; `GET /generations/:id` sí).
  const alreadyRetried = problem?.kind === 'not-retryable' && problem.reason === 'ALREADY_RETRIED';
  const retriedQ = useQuery({
    queryKey: ['generation', generationId, 'retried-by'],
    queryFn: () => generationApi.get(generationId as string),
    enabled: Boolean(generationId) && alreadyRetried,
    staleTime: 0,
    retry: false,
  });
  const retriedBy = retriedQ.data?.retriedBy ?? null;

  /* ── Muestras (voz y referencia) por id, como en «Otra versión» ── */
  const like = recovery ? generationLikeOfRecovery(recovery) : null;
  const ids = sampleIdsOf(like);
  const voiceQ = useQuery({ queryKey: ['sample', ids.voice], queryFn: () => samplesApi.get(ids.voice as string), enabled: Boolean(ids.voice), staleTime: 60_000, refetchOnWindowFocus: false, retry: retryTransient });
  const refQ = useQuery({ queryKey: ['sample', ids.reference], queryFn: () => samplesApi.get(ids.reference as string), enabled: Boolean(ids.reference), staleTime: 60_000, refetchOnWindowFocus: false, retry: retryTransient });
  const voice = voiceQ.data;
  // La disponibilidad de la voz la comprueba el CLIENTE con el endpoint existente; el servidor no consulta a Suno al recuperar.
  const checkVoice = Boolean(voice && voice.kind === 'VOICE' && voice.sunoPersonaId && voice.sunoPersonaModel === 'voice_persona');
  const availQ = useVoiceAvailability(checkVoice ? ids.voice : null);

  const hydration = useMemo<Hydration | null>(() => {
    if (!recovery) return null;
    const check: VoiceCheck = !checkVoice ? { state: 'idle' }
      : availQ.data ? { state: availabilityState(availQ.data) === 'expired' ? 'expired' : availabilityState(availQ.data) === 'available' ? 'available' : 'unknown' }
        : availQ.isError ? { state: 'unknown' }
          : { state: 'loading' };
    return songFromRecovery({
      recovery,
      voice: ids.hasVoice ? resolveSample({ role: 'voice', sampleId: ids.voice, lookup: lookupOf({ data: voiceQ.data, isError: voiceQ.isError, error: voiceQ.error }), check }) : null,
      reference: ids.hasReference ? resolveSample({ role: 'reference', sampleId: ids.reference, lookup: lookupOf({ data: refQ.data, isError: refQ.isError, error: refQ.error }) }) : null,
      locks,
      heldDecision: session?.heldDecision ?? null,
    });
  }, [recovery, ids.voice, ids.reference, ids.hasVoice, ids.hasReference, voiceQ.data, voiceQ.isError, voiceQ.error, refQ.data, refQ.isError, refQ.error, checkVoice, availQ.data, availQ.isError, locks, session?.heldDecision]);

  const resolvingSamples = Boolean(recovery) && (
    (Boolean(ids.voice) && voiceQ.isPending) || (Boolean(ids.reference) && refQ.isPending) || (checkVoice && availQ.isPending)
  );
  const status: 'idle' | 'loading' | 'ready' | 'error' = !generationId ? 'idle' : problem ? 'error' : recovery && !resolvingSamples ? 'ready' : 'loading';

  /* ── Acciones (todas escriben en el almacén local de ESTA cuenta) ── */
  const commit = useCallback((next: RecoveryRecord) => setRecord(next), []);
  const start = useCallback((id: string) => { if (userId) commit(startSession(storage, userId, id)); }, [commit, storage, userId]);
  const end = useCallback((outcome: HandledState) => { if (userId) commit(endSession(storage, userId, outcome)); }, [commit, storage, userId]);
  const dismissCandidate = useCallback((id: string) => { if (userId) commit(markHandled(storage, userId, id, 'DISMISSED')); }, [commit, storage, userId]);
  const patch = useCallback((p: Partial<Omit<RecoverySession, 'generationId' | 'startedAt'>>) => { if (userId) commit(updateSession(storage, userId, p)); }, [commit, storage, userId]);
  const markApplied = useCallback(() => patch({ needsApply: false }), [patch]);
  const requestApply = useCallback(() => patch({ needsApply: true }), [patch]);
  const chooseDestination = useCallback((destination: DestinationChoice | null, otherOrigin?: OtherOrigin | null) => patch({ destination, ...(otherOrigin !== undefined ? { otherOrigin } : {}) }), [patch]);
  const setHeldDecision = useCallback((heldDecision: 'KEEP' | 'DROP' | null) => patch({ heldDecision }), [patch]);
  const setDetached = useCallback((detached: boolean) => patch({ detached }), [patch]);
  const setRegenerateLyrics = useCallback((regenerateLyrics: boolean) => patch({ regenerateLyrics, needsApply: true }), [patch]);

  const retryAvailable = useSyncExternalStore(subscribeRetryAvailability, isRetryAvailable, () => true);

  return {
    ready, session, candidate, recovery, hydration, status, problem, retriedBy, retryAvailable,
    refetchRecovery: recQ.refetch,
    start, end, dismissCandidate, markApplied, requestApply, chooseDestination, setHeldDecision, setDetached, setRegenerateLyrics,
  };
}

export type RecoverySessionApi = ReturnType<typeof useRecoverySession>;
