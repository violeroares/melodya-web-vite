
/**
 * MELODYA WEB — Diálogo "Crear voz" (clonación estilo Suno Voice).
 *
 * Flujo espejo del de Suno (capturas del usuario, Pasos 0-5):
 *  1. Autorización de uso de voz (si no estaba aceptada) — consentimiento
 *     biométrico antes de grabar/subir nada.
 *  2. Fuente de la voz: grabar desde el navegador (MediaRecorder, mono 48 kHz,
 *     cancelación de eco/ruido) o subir un archivo.
 *  3. Frase de verificación: Melodya/Suno devuelve una frase que el usuario
 *     debe cantar con su voz (doble verificación) — se graba o sube.
 *  4. Detalles mientras se prepara: nivel de canto + nombre + etiquetas de
 *     estilo + descripción (viajan a Suno en voice/generate).
 *  5. Avatar (opcional) y listo: la voz queda disponible para crear canciones.
 *
 * Se usa desde Biblioteca › Voces y desde el Creator Wizard (paso "Voz").
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines, Check, CheckCircle2, CircleAlert, Loader2, Mic2, Music4, Pencil, ShieldCheck,
  Sparkles, Upload, Volume2, Waves,
  Play,
  Pause,
  Sprout,
  Star,
  SkipForward,
  type LucideIcon,
} from 'lucide-react';
import { profileApi, samplesApi, voiceSessionsApi } from '@/lib/api';
import { toUserMessage } from '@/lib/errors';
import { navigate } from '@/lib/router';
import { readAudioDuration } from './audio-duration';
import {
  awaitPhrase, buildVerifyBody, closeNotice, creationOutcome, failedBeforeVoice, phraseOutcome, pollSession, resolveDurationSec, sessionErrorMessage,
  isRecordingPending, findActiveSession, PHRASE_HINT, PHRASE_INSTRUCTION, PHRASE_RETRY_TIP, resumePhase, SKILL_CHOICES, SKILL_SKIP_NOTE,
  uploadPhraseReading, type SkillChoice,
} from './voice-session-flow';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/hooks/use-toast';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import type { UserSample, VoiceSession } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CanvasTextarea } from '@/components/common/CanvasTextarea';
import { ConfirmDialog } from '@/features/library/library-utils';
import { Chip } from '@/components/common';

/* ───────────────────────────── Utilidades ───────────────────────────── */

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

/** Polling acotado de la sesión (frase / creación de la voz): devuelve el último estado visto, sea cual sea. */
function pollUntil(
  sessionId: string,
  predicate: (s: VoiceSession) => boolean,
  attempts = 40,
  intervalMs = 2500,
  isCancelled?: () => boolean,
): Promise<VoiceSession> {
  return pollSession(() => voiceSessionsApi.get(sessionId), predicate, attempts, intervalMs, { isCancelled });
}

/* ─────────────────────────── Diálogo ─────────────────────────── */

type Phase = 'consent' | 'source' | 'phrase' | 'details' | 'creating' | 'stillCreating' | 'avatar' | 'failed';

const PHASE_STEPS: Array<{ key: Phase; label: string }> = [
  { key: 'source', label: 'Tu voz' },
  { key: 'phrase', label: 'Frase' },
  { key: 'details', label: 'Detalles' },
  { key: 'avatar', label: 'Listo' },
];

function phaseIndex(p: Phase): number {
  if (p === 'consent' || p === 'source') return 0;
  if (p === 'phrase') return 1;
  if (p === 'details' || p === 'creating' || p === 'stillCreating' || p === 'failed') return 2;
  return 3;
}

export function VoiceCloneDialog({
  open, onOpenChange, onVoiceReady, resumeSession, recreateSampleId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Recrear una voz CADUCADA con su muestra original (la que Melodya conserva): se retoma la sesión en curso de esa muestra o se crea
   * una nueva (`recreate`), se pide una frase nueva y una grabación nueva; no se vuelve a pedir el audio original. La voz anterior se
   * reemplaza solo cuando la nueva queda lista.
   */
  recreateSampleId?: string | null;
  /** Sesión en curso que se retoma desde la fase que le corresponde (sin volver a grabar la muestra ni crear otra sesión). */
  resumeSession?: VoiceSession | null;
  /** Callback opcional al completar la voz (el wizard la selecciona). */
  onVoiceReady?: (sample: UserSample) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const consentAccepted = !!user?.voiceConsentAcceptedAt;

  const [phase, setPhase] = useState<Phase>('source');
  const [busy, setBusy] = useState(false);
  // Recreación de una voz caducada: arranca sola al abrir, y los reintentos también son «recrear» (la muestra ya tiene una voz).
  const recreateStartedRef = useRef<string | null>(null);
  const [recreateStarting, setRecreateStarting] = useState(false);
  const isRecreate = Boolean(recreateSampleId);
  const [error, setError] = useState<string | null>(null);

  // Datos del flujo
  const [sourceSample, setSourceSample] = useState<UserSample | null>(null);
  // Al retomar una sesión, la muestra original se lee del backend (GET /samples/:id); en un flujo nuevo es la recién subida.
  const resumeSampleId = resumeSession?.voiceSampleId ?? recreateSampleId ?? null;
  const resumedSample = useQuery({
    queryKey: ['samples', 'one', resumeSampleId],
    queryFn: () => samplesApi.get(resumeSampleId as string),
    enabled: open && !!resumeSampleId,
  }).data ?? null;
  const activeSource = sourceSample ?? resumedSample;
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [verifySampleId, setVerifySampleId] = useState<string | null>(null);
  const [voice, setVoice] = useState<UserSample | null>(null);
  // Toma válida grabada y aún sin enviar (la reporta el RecordPanel vigente): cerrar el diálogo la perdería.
  const pendingRecordingRef = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [simReview, setSimReview] = useState(false); // solo desarrollo: muestra la pre-escucha de una toma simulada

  // Detalles (paso estilo Suno: skill + nombre + tags + descripción)
  const [skill, setSkill] = useState<SkillChoice>('');
  // El nombre propuesto es el de la muestra original; solo se guarda lo que el usuario escribe (estado derivado, sin copiarlo).
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const name = nameEdit ?? activeSource?.name ?? '';
  const [tagsInput, setTagsInput] = useState('');
  const [description, setDescription] = useState('');

  const reset = useCallback(() => {
    recreateStartedRef.current = null;
    setRecreateStarting(false);
    setPhase('source');
    setBusy(false);
    setError(null);
    setSourceSample(null);
    setSession(null);
    setVerifySampleId(null);
    setVoice(null);
    setSkill('');
    setNameEdit(null);
    setTagsInput('');
    setDescription('');
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Una petición en curso (subida / verify) no se abandona a medias: Esc y clic fuera se ignoran hasta que termine.
      if (busy) return;
      if (pendingRecordingRef.current) {
        setConfirmClose(true);
        return;
      }
      // La sesión ya creada en el backend sigue ahí: se refresca la Biblioteca y se avisa dónde retomarla.
      if (activeSource || session) {
        void qc.invalidateQueries({ queryKey: ['samples'] });
        void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
      }
      const notice = closeNotice(phase, !!session);
      if (notice) toast({ title: 'Podés seguir después', description: notice });
      reset();
    }
    onOpenChange(next);
  };

  // Al abrir: si falta la autorización, arrancamos por ahí (como Suno Paso 1).
  // (ajuste de estado durante el render: corre una vez por cada apertura)
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      // Retomar una sesión en curso: se entra por la fase que le toca; el resto del asistente es el mismo.
      const resumed = resumeSession ? resumePhase(resumeSession.status) : null;
      if (resumeSession && resumed) {
        setSession(resumeSession);
        setPhase(resumed);
      } else {
        setPhase(consentAccepted ? 'source' : 'consent');
      }
      setError(null);
    }
  }

  const refreshVoiceSample = useCallback(async (id: string): Promise<UserSample | null> => {
    try {
      return await samplesApi.get(id);
    } catch {
      return null;
    }
  }, []);

  /** Paso fuente → sube la toma/archivo como sample VOICE y crea la sesión. */
  const submitSource = async (file: File, recordedSec?: number) => {
    setBusy(true);
    setError(null);
    try {
      const defaultName = `Mi voz · ${new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}`;
      // Duración real de la toma (POST /samples la admite): el backend la usa para acotar el tramo que analiza Suno.
      const durationSec = resolveDurationSec(await readAudioDuration(file), recordedSec);
      const sample = await samplesApi.create(file, {
        type: 'VOICE',
        name: defaultName,
        ...(durationSec ? { durationSec } : {}),
      });
      setSourceSample(sample);
      const res = await voiceSessionsApi.create(sample.id);
      if (res.alreadyRegistered) {
        toast({
          title: 'Esa voz ya está clonada',
          description: 'Grabá o subí otra toma para crear una voz nueva.',
        });
        setBusy(false);
        reset();
        onOpenChange(false);
        return;
      }
      setSession(res.session);
      setPhase('phrase');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Paso frase: sube la lectura como sample y pasa a los detalles. */
  const submitPhraseReading = async (file: File, recordedSec?: number) => {
    setBusy(true);
    setError(null);
    try {
      // Sin una frase válida no hay nada que verificar: no se sube la grabación (y se avisa, no se ignora el clic).
      const result = await uploadPhraseReading(
        session,
        file,
        recordedSec,
        `Frase de verificación · ${new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}`,
        { readDuration: readAudioDuration, createSample: samplesApi.create },
      );
      if (result.status === 'blocked') {
        setError('La frase todavía no está lista. Esperá unos segundos o empezá de nuevo.');
        return;
      }
      setVerifySampleId(result.sampleId);
      setPhase('details');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Paso detalles: verify con todo → creación de la voz en Suno. */
  const submitVerify = async () => {
    if (!session || !verifySampleId || phraseOutcome(session) !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await voiceSessionsApi.verify(session.id, buildVerifyBody({ sampleId: verifySampleId, name, description, tagsInput, skill }));
      void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
      setPhase('creating');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Polling de la creación: VOICE_PENDING → READY | FAILED. Agotar los intentos NO es éxito: la voz solo está lista con READY.
  useEffect(() => {
    if (phase !== 'creating' || !session) return;
    let cancelled = false;
    (async () => {
      try {
        const final = await pollUntil(session.id, (s) => creationOutcome(s) !== 'pending', 40, 2500, () => cancelled);
        if (cancelled) return;
        setSession(final);
        const outcome = creationOutcome(final);
        if (outcome === 'failed') {
          setPhase('failed');
          return;
        }
        if (outcome === 'pending') {
          // Sigue en proceso en Suno: ni éxito ni selección de la voz; se puede consultar en Biblioteca › Voces.
          setPhase('stillCreating');
          return;
        }
        // READY: refrescamos la muestra original (ya tiene sunoPersonaId + detalles) y comprobamos que de verdad la tiene.
        const sourceId = final.voiceSampleId ?? activeSource?.id ?? null;
        const fresh = sourceId ? await refreshVoiceSample(sourceId) : null;
        if (cancelled) return;
        if (!fresh?.sunoPersonaId) {
          setPhase('stillCreating');
          return;
        }
        setVoice(fresh);
        void qc.invalidateQueries({ queryKey: ['samples'] });
        // La voz nueva ya está confirmada (READY + sunoPersonaId): la disponibilidad cacheada de la voz anterior deja de valer, venga
        // la recreación de Biblioteca › Voces o del creador (ambos usan este diálogo).
        void qc.invalidateQueries({ queryKey: ['voice-availability'] });
        void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
        setPhase('avatar');
      } catch (err) {
        if (cancelled) return;
        setError(toUserMessage(err));
        setPhase('stillCreating');
      }
    })();
    return () => {
      cancelled = true;
    };

  }, [phase, session?.id]);

  // Recreación: al abrir con una muestra, se retoma su sesión en curso o se crea una nueva con `recreate` (nueva frase de Suno).
  // La guarda por ref evita duplicar la sesión (y la frase en Suno) si el efecto corre dos veces.
  useEffect(() => {
    if (!open || !recreateSampleId || !consentAccepted || recreateStartedRef.current === recreateSampleId) return;
    recreateStartedRef.current = recreateSampleId;
    setRecreateStarting(true);
    setError(null);
    (async () => {
      try {
        const existing = await voiceSessionsApi.list({ pageSize: 50 }).catch(() => null);
        const active = existing ? findActiveSession(existing.items, recreateSampleId) : undefined;
        const resumed = active ? resumePhase(active.status) : null;
        if (active && resumed) {
          setSession(active);
          setPhase(resumed);
          return;
        }
        const res = await voiceSessionsApi.create(recreateSampleId, { recreate: true });
        setSession(res.session);
        setVerifySampleId(null);
        setPhase('phrase');
      } catch (err) {
        // Muestra original eliminada (422 VOICE_SAMPLE_UNAVAILABLE) u otro fallo: se explica y se ofrece grabar/subir una muestra nueva.
        setError(toUserMessage(err));
        setPhase('source');
      } finally {
        setRecreateStarting(false);
      }
    })();
  }, [open, recreateSampleId, consentAccepted]);

  /** Reintento tras FAILED: nueva sesión con la misma muestra fuente. */
  const retrySession = async () => {
    const sourceId = session?.voiceSampleId ?? activeSource?.id ?? null;
    if (!sourceId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await voiceSessionsApi.create(sourceId, isRecreate ? { recreate: true } : undefined);
      if (res.alreadyRegistered) {
        // Alguien clonó mientras tanto: directo al final feliz.
        const fresh = await refreshVoiceSample(sourceId);
        if (!fresh?.sunoPersonaId) {
          setError('No pudimos confirmar que la voz esté disponible. Revisala en Biblioteca › Voces.');
          return;
        }
        setVoice(fresh);
        setPhase('avatar');
        return;
      }
      setSession(res.session);
      setVerifySampleId(null);
      setPhase('phrase');
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onPendingRecording = (pending: boolean) => {
    pendingRecordingRef.current = pending;
  };

  const finish = () => {
    if (voice && onVoiceReady) onVoiceReady(voice);
    reset();
    onOpenChange(false);
  };

  const idx = phaseIndex(phase);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Esc y clic fuera no cierran (el asistente tiene varios pasos): solo la X, que pasa por handleOpenChange y sus guardas. */}
      <DialogContent
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="flex max-h-[92vh] w-[min(94vw,880px)] flex-col gap-0 overflow-hidden rounded-[28px_28px_14px_14px] border-border bg-surface p-0 sm:max-w-[880px]">
        {/* Header: título + pasos del asistente (los pasos van en su propia fila para que
            siempre se vean, en mobile y con el modal angosto) */}
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3 pr-12">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full gradient-warm text-primary-foreground" aria-hidden>
              <Mic2 className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="font-display truncate text-xl font-bold">{isRecreate ? 'Recrear voz' : 'Crear voz'}</DialogTitle>
              <DialogDescription className="line-clamp-2 text-xs sm:truncate">
                Grabá o subí tu voz, verificá con una frase y quedá disponible para tus canciones.
              </DialogDescription>
            </div>
          </div>
          {/* Paso a paso: círculos numerados con línea de unión (nuestro estilo) y la tipografía de los pasos del prototipo (etiqueta chica en mayúsculas con separación entre letras) */}
          <ol className="mt-4 grid grid-cols-4 gap-2" aria-label="Progreso">
            {PHASE_STEPS.map((s, i) => {
              const done = i < idx;
              const current = i === idx;
              return (
                <li key={s.key} aria-current={current ? 'step' : undefined} className="flex min-w-0 flex-col items-center gap-1.5 sm:flex-row sm:gap-2">
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                      current ? 'bg-primary text-primary-foreground' : done ? 'bg-success text-background' : 'border-[1.5px] border-line text-muted-foreground'
                    )}
                    aria-hidden
                  >
                    {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={cn('truncate text-[11.5px] tracking-[0.08em] uppercase', current ? 'font-bold text-label' : done ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')}>
                    {s.label}
                    <span className="sr-only">{current ? ' (paso actual)' : done ? ' (completado)' : ''}</span>
                  </span>
                  {i < PHASE_STEPS.length - 1 && (
                    <span className={cn('ml-1 hidden h-px flex-1 rounded-full sm:block', done ? 'bg-success' : 'bg-faint')} aria-hidden />
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {/* SOLO DESARROLLO (no existe en producción): saltar entre los pasos con datos simulados, para verlos sin grabar ni subir audio */}
          {import.meta.env.DEV && (
            <VoiceStepSimulator
              onGo={(target) => {
                setError(null);
                setSimReview(target === 'review');
                if (target === 'review') { setPhase('source'); return; }
                if (target === 'phrase') setSession(SIM_SESSION);
                if (target === 'failed') setSession({ ...SIM_SESSION, status: 'FAILED', error: { code: 'SIM', message: 'La toma tenía demasiado ruido de fondo.' } });
                if (target === 'avatar') setVoice(SIM_VOICE);
                setPhase(target);
              }}
            />
          )}

          {recreateStarting && (
            <div className="flex items-center gap-3 py-10 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> Preparando la recreación de tu voz con tu grabación original…
            </div>
          )}

          {phase === 'consent' && <ConsentPanel onAccepted={() => setPhase('source')} />}

          {phase === 'source' && simReview && <SimulatedReview onAgain={() => setSimReview(false)} onUse={() => { setSimReview(false); setSession(SIM_SESSION); setPhase('phrase'); }} />}

          {phase === 'source' && !simReview && !recreateStarting && (
            <SourcePanel busy={busy} onFile={(f, sec) => void submitSource(f, sec)} onPendingChange={onPendingRecording} />
          )}

          {phase === 'phrase' && session && (
            <PhrasePanel
              key={session.id} // sesión nueva (p. ej. «Empezar de nuevo») = estado propio nuevo: no arrastra el aviso de demora
              session={session}
              busy={busy}
              onFile={(f, sec) => void submitPhraseReading(f, sec)}
              onRetrySession={() => void retrySession()}
              onSession={setSession}
              onPendingChange={onPendingRecording}
              onFailed={(failed) => {
                setSession(failed);
                setPhase('failed');
              }}
            />
          )}

          {phase === 'details' && (
            <div className="space-y-6">
              <SkillSurvey value={skill} onChange={setSkill} />
              <DetailsForm name={name} setName={setNameEdit} tagsInput={tagsInput} setTagsInput={setTagsInput} description={description} setDescription={setDescription} />
              <div className="flex justify-center">
                <Button
                  className="rounded-full bg-primary font-bold text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95 disabled:bg-foreground/10 disabled:bg-none disabled:text-muted-foreground disabled:opacity-100"
                  disabled={busy || !name.trim()}
                  onClick={() => void submitVerify()}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                  Crear mi voz
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Al crear la voz confirmás que el audio contiene únicamente tu propia voz y que subirlo no
                infringe derechos de terceros, de acuerdo con los Términos de Melodya.
              </p>
            </div>
          )}

          {phase === 'creating' && <CreatingPanel />}

          {phase === 'stillCreating' && (
            <div className="space-y-4 text-center">
              <div className="flex flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] px-6 py-8 text-center" role="status">
                <VoiceCore />
                <div>
                  <h3 className="font-display text-[19px] leading-tight font-semibold">Tu voz sigue creándose</h3>
                  <p className="mt-1 text-sm leading-snug text-muted-foreground">
                    Todavía no terminamos de crearla, así que aún no está disponible para tus canciones. Puede demorar varios
                    minutos: consultá el estado en tu Biblioteca de voces o seguí esperando acá.
                  </p>
                </div>
              </div>
              <div className="flex justify-center gap-2">
                <Button variant="outline" className="min-h-11 min-w-0 flex-1 whitespace-normal rounded-full px-3 py-1.5 text-xs leading-tight sm:flex-none sm:px-5 sm:text-sm" onClick={() => { setError(null); setPhase('creating'); }}>
                  Seguir esperando
                </Button>
                <Button
                  className="min-h-11 min-w-0 flex-1 whitespace-normal rounded-full bg-primary px-3 py-1.5 text-xs font-bold leading-tight text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95 sm:flex-none sm:px-5 sm:text-sm"
                  onClick={() => {
                    void qc.invalidateQueries({ queryKey: ['voice-sessions'] });
                    handleOpenChange(false);
                    navigate('/library/voices');
                  }}
                >
                  Ir a Biblioteca de voces
                </Button>
              </div>
            </div>
          )}

          {phase === 'failed' && (
            <div className="space-y-4 text-center">
              <div className="flex flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] px-6 py-8 text-center" role="alert">
                <VoiceCore icon={CircleAlert} spin={false} iconClassName="text-destructive" />
                <div>
                  <h3 className="font-display text-[19px] leading-tight font-semibold">
                    {failedBeforeVoice(session) ? 'No pudimos preparar la frase' : 'No pudimos crear tu voz'}
                  </h3>
                  {sessionErrorMessage(session?.error) && (
                    <p className="mt-1 text-sm leading-snug font-medium text-foreground">{sessionErrorMessage(session?.error)}</p>
                  )}
                  <p className="mt-1 text-sm leading-snug text-muted-foreground">
                    {failedBeforeVoice(session)
                      ? 'Probá de nuevo con una toma más limpia y sin ruido de fondo.'
                      : PHRASE_RETRY_TIP}
                  </p>
                </div>
              </div>
              <Button variant="outline" className="rounded-full" disabled={busy} onClick={() => void retrySession()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Volver a intentar
              </Button>
            </div>
          )}

          {phase === 'avatar' && voice && (
            <AvatarPanel
              voice={voice}
              onDone={finish}
              onUpdated={(s) => setVoice(s)}
              onError={(msg) => setError(msg)}
            />
          )}
        </div>
      </DialogContent>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="¿Descartar la grabación?"
        description="Grabaste una toma que todavía no enviaste. Si cerrás ahora, se pierde."
        actionLabel="Descartar y cerrar"
        onConfirm={() => {
          setConfirmClose(false);
          pendingRecordingRef.current = false;
          handleOpenChange(false);
        }}
      />
    </Dialog>
  );
}

/* ───────────────────── SOLO DESARROLLO: simulación de los pasos ───────────────────── */

const SIM_NOW = '2026-01-01T00:00:00.000Z';
const SIM_SESSION: VoiceSession = {
  id: 'sim-session', userId: 'sim', voiceSampleId: 'sim-source', phraseTaskId: null,
  phrase: 'Hoy vuelvo a casa cantando bajito, con el sol de la tarde en la ventana y toda la ciudad en silencio.',
  verifySampleId: null, verifyTaskId: null, voiceId: null, status: 'PHRASE_READY', createdAt: SIM_NOW, updatedAt: SIM_NOW,
};
const SIM_VOICE: UserSample = {
  id: 'sim-voice', userId: 'sim', fileId: 'sim', kind: 'VOICE', type: 'voice', name: 'Mi voz', description: null,
  durationSec: 14, sunoPersonaId: null, sunoPersonaModel: null, tags: ['simulada'], avatarFileId: null, avatarUrl: null, createdAt: SIM_NOW, fileUrl: '',
};

const SIM_TARGETS: Array<{ key: Phase | 'review'; label: string }> = [
  { key: 'consent', label: 'Autorización' },
  { key: 'source', label: 'Grabar' },
  { key: 'review', label: 'Toma lista' },
  { key: 'phrase', label: 'Frase' },
  { key: 'details', label: 'Detalles' },
  { key: 'creating', label: 'Creando' },
  { key: 'stillCreating', label: 'Demora' },
  { key: 'failed', label: 'Error' },
  { key: 'avatar', label: 'Listo' },
];

function VoiceStepSimulator({ onGo }: { onGo: (target: Phase | 'review') => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-amber/60 bg-amber/5 p-2">
      <span className="px-1 text-[11px] font-bold uppercase tracking-wide text-amber-strong">Simulación (solo local)</span>
      {SIM_TARGETS.map((t) => (
        <button key={t.key} type="button" onClick={() => onGo(t.key)} className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-foreground/10">
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** WAV de un tono suave de `sec` segundos, para poder reproducir una toma sin haber grabado nada. */
function makeToneUrl(sec: number): string {
  const rate = 8000;
  const n = rate * sec;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * (220 + 40 * Math.sin(i / 4000)) * i) / rate) * 3000), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function SimulatedReview({ onAgain, onUse }: { onAgain: () => void; onUse: () => void }) {
  const [url] = useState(() => makeToneUrl(14));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="space-y-3 py-2">
      <ReviewPlayer src={url} fallbackSec={14} />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="outline" size="sm" className="rounded-full" onClick={onAgain}>Grabar de nuevo</Button>
        <Button size="sm" className="rounded-full bg-primary font-bold text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95" onClick={onUse}>
          <CheckCircle2 className="h-4 w-4" aria-hidden /> Usar esta toma
        </Button>
      </div>
    </div>
  );
}

/* ───────────────────── Paso 1: consentimiento ───────────────────── */

function ConsentPanel({ onAccepted }: { onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const accept = async () => {
    setBusy(true);
    try {
      await profileApi.acceptVoiceConsent();
      await useAuthStore.getState().loadMe();
      toast({ title: 'Autorización aceptada', description: 'Ya podés grabar tu voz para clonarla.' });
      onAccepted();
    } catch (err) {
      toast({ title: 'No pudimos registrar la autorización', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Cápsula como «Antes de crear, falta resolver» de Materiales: pegada al borde izquierdo, tinte terracota, título en la fuente de títulos */}
      <div className="voice-cap rounded-r-[40px] bg-[var(--m-capsule-tint)] py-3.5 pr-5 pl-5 text-foreground sm:pl-6">
        <h3 className="flex items-center gap-2 font-display text-base font-bold">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
          Antes de empezar: autorización de uso de voz
        </h3>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
          Entendés que la creación de una voz implica el procesamiento de datos relacionados con tu voz
          que pueden considerarse información biométrica, y dás tu consentimiento para que Melodya los
          recopile y procese de acuerdo con los Términos de servicio y la Política de privacidad.
        </p>
      </div>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-background/40 p-3 text-sm leading-relaxed">
        <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} className="mt-0.5 rounded-full" aria-label="Aceptar autorización" />
        <span className="text-foreground/90">
          Acepto la autorización de uso de voz y confirmo que el audio que suba o grabe contiene
          exclusivamente mi propia voz.
        </span>
      </label>
      <Button
        className="w-full rounded-full bg-primary font-bold text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95 disabled:bg-foreground/10 disabled:bg-none disabled:text-muted-foreground disabled:opacity-100 sm:w-auto"
        disabled={!checked || busy}
        onClick={() => void accept()}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
        Aceptar y continuar
      </Button>
    </div>
  );
}

/* ───────────────────── Paso 2: fuente (grabar o subir) ───────────────────── */

function SourcePanel({
  busy, onFile, onPendingChange,
}: {
  busy: boolean;
  onFile: (f: File, recordedSec?: number) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Grabá o subí una muestra de tu voz: la usamos para que tus canciones suenen como vos.
        Necesitamos al menos <strong className="text-foreground">10 segundos</strong> de voz limpia.
      </p>
      <RecordPanel minSec={10} disabled={busy} onFile={onFile} onPendingChange={onPendingChange} />
      <UploadPanel disabled={busy} onFile={onFile} />
      <TipsRow />
      {busy && (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Subiendo tu voz…
        </p>
      )}
    </div>
  );
}

/* ───────────────────── Paso 3: frase de verificación ───────────────────── */

function PhrasePanel({
  session, busy, onFile, onRetrySession, onSession, onPendingChange, onFailed,
}: {
  session: VoiceSession;
  busy: boolean;
  onFile: (f: File, recordedSec?: number) => void;
  onRetrySession: () => void;
  /** Sesión actualizada por el sondeo: el diálogo debe conservarla (sus envíos validan contra ella). */
  onSession: (session: VoiceSession) => void;
  onPendingChange: (pending: boolean) => void;
  /** La sesión falló (o no entregó una frase válida): el diálogo pasa a su fase de error. */
  onFailed: (session: VoiceSession) => void;
}) {
  const [timedOut, setTimedOut] = useState(false);
  const [round, setRound] = useState(0);
  const outcome = phraseOutcome(session);
  const phrase = session.phrase ?? '';

  useEffect(() => {
    const first = phraseOutcome(session);
    if (first === 'failed' || first === 'unavailable') {
      onFailed(session);
      return;
    }
    if (first !== 'pending') return;
    let cancelled = false;
    (async () => {
      try {
        const step = await awaitPhrase(() => voiceSessionsApi.get(session.id), 12, 2500, { isCancelled: () => cancelled });
        if (cancelled) return;
        if (step.kind === 'timeout') setTimedOut(true); // sigue pendiente: no es un fallo
        else if (step.kind === 'ready') onSession(step.session); // la frase ya está: el diálogo la necesita para habilitar el envío
        else onFailed(step.session); // FAILED o sin frase válida: fallo definitivo
      } catch {
        if (!cancelled) setTimedOut(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id, session.status, round]);

  if (outcome === 'failed' || outcome === 'unavailable') return null; // el diálogo ya pasó a su fase de error

  if (outcome === 'pending') {
    return (
      <div className="space-y-4 py-6 text-center">
        <Loader2 className="mx-auto h-9 w-9 animate-spin text-amber-strong" aria-hidden />
        <div>
          <h3 className="font-display text-lg font-bold">Preparando tu frase de verificación…</h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
            {timedOut
              ? 'Está tardando más de lo esperado. Podés seguir esperando o empezar de nuevo (se pedirá una frase nueva).'
              : 'Unos segundos y te damos el texto para cantar con tu voz.'}
          </p>
        </div>
        {timedOut && (
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" className="rounded-full" onClick={() => { setTimedOut(false); setRound((n) => n + 1); }}>
              Seguir esperando
            </Button>
            <Button variant="ghost" className="rounded-full" onClick={onRetrySession}>
              Empezar de nuevo
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-amber/40 bg-amber/10 p-4 sm:p-5">
        <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-amber-strong uppercase">
          <Volume2 className="h-3.5 w-3.5" aria-hidden /> Necesitamos verificar que sos vos
        </p>
        <p className="mt-1 text-sm leading-relaxed text-foreground/90">
          {PHRASE_INSTRUCTION}
        </p>
        <p className="mt-2 font-display text-xl leading-snug text-foreground sm:text-2xl">“{phrase}”</p>
      </div>
      <RecordPanel minSec={3} disabled={busy} onFile={onFile} onPendingChange={onPendingChange} hint={PHRASE_HINT} />
      <UploadPanel disabled={busy} onFile={onFile} label="O subí la grabación de la frase" />
      {busy && (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Subiendo tu grabación…
        </p>
      )}
    </div>
  );
}

/* ───────────────────── Paso 4: detalles + skill ───────────────────── */

/* Icono y color de cada nivel (mismo estilo que los botones de «¿Ya tenés una letra?» del Estudio de letras: pastilla con círculo de color) */
const SKILL_LOOK: Record<string, { icon: LucideIcon; tone: string }> = {
  BEGINNER: { icon: Sprout, tone: 'bg-primary text-[#131C33]' },
  INTERMEDIATE: { icon: Music4, tone: 'bg-gold text-[#131C33]' },
  ADVANCED: { icon: Mic2, tone: 'bg-voice text-on-voice' },
  PROFESSIONAL: { icon: Star, tone: 'bg-primary text-[#131C33]' },
  '': { icon: SkipForward, tone: 'bg-foreground/15 text-foreground' },
};

function SkillSurvey({ value, onChange }: { value: SkillChoice; onChange: (v: SkillChoice) => void }) {
  return (
    <div>
      <h3 className="font-display text-xl font-bold leading-tight">Una pregunta rápida mientras preparamos todo</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">¿Cómo describirías tu forma de cantar?</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {SKILL_CHOICES.map((opt) => {
          const look = SKILL_LOOK[opt.value] ?? SKILL_LOOK[''];
          const on = value === opt.value;
          return (
            <button
              key={opt.value || 'skip'}
              type="button"
              onClick={() => onChange(opt.value)}
              aria-pressed={on}
              className={cn(
                'flex h-auto min-h-11 w-full min-w-0 items-center gap-2 rounded-full border p-1.5 pr-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
                on ? 'border-primary bg-primary text-[#131C33]' : 'border-border/70 bg-surface-2/40 hover:border-amber/40 hover:bg-surface-2',
              )}
            >
              <span aria-hidden className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', on ? 'bg-[#131C33] text-primary' : look.tone)}>
                <look.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-sm font-bold">{opt.title}</span>
                <span className={cn('block text-xs', on ? 'text-[#131C33]/80' : 'text-muted-foreground')}>{opt.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{SKILL_SKIP_NOTE}</p>
    </div>
  );
}

function DetailsForm({
  name, setName, tagsInput, setTagsInput, description, setDescription,
}: {
  name: string;
  setName: (v: string) => void;
  tagsInput: string;
  setTagsInput: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <h3 className="font-display text-xl font-bold leading-tight">Detalles de tu voz</h3>
      <div className="space-y-1.5">
        <Label htmlFor="voice-name" className="text-sm font-medium">Nombra esta voz</Label>
        <Input
          id="voice-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej: Mi voz principal"
          maxLength={100}
          className="rounded-xl"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="voice-tags" className="text-sm font-medium">
          Etiquetas de estilo <span className="font-normal text-muted-foreground">(opcional)</span>
        </Label>
        <Input
          id="voice-tags"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="Ej: pop, funk, balada (separadas por comas)"
          className="rounded-xl"
        />
        <p className="text-xs text-muted-foreground">Le dicen a Melodya cómo pensás usar la voz (máx. 8 etiquetas).</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="voice-desc" className="text-sm font-medium">
          Descripción <span className="font-normal text-muted-foreground">(opcional)</span>
        </Label>
        <CanvasTextarea
          id="voice-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ej: voz cálida de barítono, con aire en los agudos"
          maxLength={500}
          className="h-[96px]"
        />
      </div>
    </div>
  );
}

/* ───────────────────── Paso 5a: creando ───────────────────── */

/* Núcleo girando como el de «Melodya escribiendo» del prototipo (design-V2): aro tenue con un arco dorado que da vueltas y, al centro, el círculo de voz con el icono del micrófono. */
function VoiceCore({ icon: Icon = Mic2, spin = true, iconClassName = 'text-gold' }: { icon?: LucideIcon; spin?: boolean; iconClassName?: string }) {
  return (
    <span aria-hidden className="relative mx-auto block size-24 shrink-0">
      <svg className={cn('absolute inset-0 size-full', spin && 'animate-spin motion-reduce:animate-none')} style={spin ? { animationDuration: '2.4s' } : undefined} viewBox="0 0 96 96" fill="none">
        <circle cx="48" cy="48" r="44" stroke="var(--m-faint)" strokeWidth="3" />
        {spin && <circle cx="48" cy="48" r="44" stroke="var(--m-gold)" strokeWidth="3" strokeLinecap="round" strokeDasharray="77 200" />}
      </svg>
      <span className="absolute inset-[21%] flex items-center justify-center rounded-full bg-voice">
        <Icon className={cn('h-[26px] w-[26px]', iconClassName)} />
      </span>
    </span>
  );
}

function CreatingPanel() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[28px_28px_14px_14px] border-[1.5px] border-dashed border-line bg-[var(--m-input)] px-6 py-8 text-center" role="status">
      <VoiceCore />
      <div>
        <h3 className="font-display text-[19px] leading-tight font-semibold">Creando tu voz…</h3>
        <p className="mt-1 text-sm leading-snug text-muted-foreground">
          Estamos verificando tu grabación y generando la voz custom. Puede demorar unos segundos;
          esta pantalla avanza sola.
        </p>
      </div>
    </div>
  );
}

/* ───────────────────── Paso 5b: avatar + guardar ───────────────────── */

function AvatarPanel({
  voice, onDone, onUpdated, onError,
}: {
  voice: UserSample;
  onDone: () => void;
  onUpdated: (s: UserSample) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const updated = await samplesApi.setAvatar(voice.id, file);
      onUpdated(updated);
    } catch (err) {
      onError(toUserMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Cápsula como «Seguí creando» del inicio: pegada al borde izquierdo, tinte terracota, título en la fuente de títulos */}
      <div className="voice-cap flex items-center gap-3 rounded-r-[40px] bg-[var(--m-capsule-tint)] py-3.5 pr-5 pl-5 text-foreground sm:pl-6">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]">
          <CheckCircle2 className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <p className="font-display text-base font-bold">¡Tu voz está lista!</p>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
            “{voice.name}” ya está disponible para tus canciones. Si querés, poné una foto de perfil a la voz.
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        {/* Avatar como el de los creadores de la comunidad: foto circular con un aro dorado separado por un hueco del color del fondo */}
        <div className="shrink-0 p-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="group relative flex size-32 items-center justify-center overflow-hidden rounded-full bg-surface shadow-[0_0_0_4px_var(--background),0_0_0_6.5px_var(--m-gold)] transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-foreground motion-reduce:transition-none motion-reduce:hover:scale-100"
            aria-label="Elegir avatar para la voz"
          >
            {voice.avatarUrl ? (
              <img src={voice.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex flex-col items-center gap-1.5 text-foreground">
                <Pencil className="h-6 w-6" aria-hidden />
                <span className="text-xs font-medium">Foto de la voz</span>
              </span>
            )}
          </button>
        </div>
        <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
          {/* Nombre y etiquetas en la misma fila: las etiquetas van al lado, con su contorno */}
          <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <p className="text-sm font-semibold">{voice.name}</p>
            {voice.tags?.map((t) => (
              <Chip key={t} className="px-2.5 py-1 text-[11px]">{t}</Chip>
            ))}
          </div>
          {voice.description && <p className="text-xs leading-relaxed text-muted-foreground">{voice.description}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">
            JPG, PNG o WEBP de hasta 5 MB. Opcional: podés dejarla sin foto y cambiarla después.
          </p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />

      <div className="flex items-center justify-center gap-2">
        <Button variant="outline" className="min-w-0 flex-1 whitespace-normal rounded-full px-3 text-xs leading-tight disabled:text-muted-foreground disabled:opacity-100 sm:flex-none sm:px-6 sm:text-sm" onClick={onDone} disabled={busy}>
          {voice.avatarUrl ? 'Cambiar después' : 'Dejarla sin foto'}
        </Button>
        <Button
          className="min-w-0 flex-1 whitespace-normal rounded-full bg-primary px-3 text-xs font-bold leading-tight text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95 disabled:bg-foreground/10 disabled:bg-none disabled:text-muted-foreground disabled:opacity-100 sm:flex-none sm:px-6 sm:text-sm"
          disabled={busy}
          onClick={onDone}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
          {voice.avatarUrl ? 'Listo' : 'Guardar voz'}
        </Button>
      </div>
    </div>
  );
}

/* ───────────────────── Panel de grabación reutilizable ───────────────────── */

/* Reproductor de la toma (design-V2, «Tu sonido»): cápsula azul de voz con el botón de reproducir naranja, barras de onda que se van llenando en dorado y el tiempo.
   El audio es el mismo <audio> de siempre (oculto); esto solo cambia cómo se ve y se controla. */
function ReviewPlayer({ src, fallbackSec }: { src: string; fallbackSec: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const total = Number.isFinite(dur) && dur > 0 ? dur : fallbackSec;
  const ratio = total > 0 ? Math.min(1, time / total) : 0;
  const N = 88;

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLButtonElement>) => {
    const a = audioRef.current;
    if (!a || !(total > 0)) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
  };

  return (
    <div className="flex items-center gap-3 rounded-full bg-voice py-2 pr-4 pl-2 text-on-voice">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTime(0); }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pausar' : 'Reproducir'}
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-[#131C33] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-voice"
      >
        {playing ? <Pause className="h-5 w-5 fill-current" aria-hidden /> : <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden />}
      </button>
      <button type="button" onClick={seek} aria-label="Moverse en la toma" className="flex h-9 min-w-0 flex-1 items-center justify-between focus-visible:outline-2 focus-visible:outline-on-voice">
        {Array.from({ length: N }).map((_, i) => {
          const h = 6 + Math.round(24 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.31)));
          return <span key={i} aria-hidden className={cn('w-[2px] rounded-full', i / N < ratio ? 'bg-gold' : 'bg-on-voice/40')} style={{ height: h }} />;
        })}
      </button>
      <span className="text-[12.5px] whitespace-nowrap tabular-nums opacity-85">{fmt(time)} / {fmt(total)}</span>
    </div>
  );
}

export function RecordPanel({
  minSec, disabled, onFile, hint, onPendingChange,
}: {
  minSec: number;
  disabled: boolean;
  onFile: (f: File, recordedSec?: number) => void;
  hint?: string;
  /** Avisa si hay una toma válida sin enviar (al desmontarse avisa que ya no). */
  onPendingChange?: (pending: boolean) => void;
}) {
  const rec = useVoiceRecorder();
  const recording = rec.state === 'recording';
  const tooShort = rec.state === 'ready' && rec.elapsed < minSec;
  const pending = isRecordingPending(rec.state, !!rec.file, rec.elapsed, minSec);
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending]);

  /* Pantallas «Listo para grabar» y «Grabando» del prototipo (design-V2): botón circular grande de 150 px (micrófono → cuadrado de detener) con anillo punteado o pulsos,
     tiempo en grande y barras de onda. Solo cambia lo visual: la grabación, el medidor y la pre-escucha son los de siempre. */
  return (
    <div className="space-y-3 py-2">
      <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:flex-wrap sm:justify-between sm:gap-3 sm:text-left">
        <div className="min-w-0">
          <p className="font-display text-xl font-bold">{recording ? 'Grabando tu voz' : 'Grabá con tu micrófono'}</p>
          {hint && !recording && <p className="text-sm text-muted-foreground">{hint}</p>}
        </div>
        {/* Selector de micrófono (solo con más de uno y sin grabar) */}
        {rec.devices.length > 1 && !recording && rec.state !== 'ready' && (
          <Select value={rec.deviceId} onValueChange={rec.setDeviceId}>
            <SelectTrigger className="h-9 w-[260px] max-w-full rounded-full text-xs" aria-label="Micrófono">
              <SelectValue placeholder="Micrófono" />
            </SelectTrigger>
            <SelectContent>
              {rec.devices.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId} className="text-xs">
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {rec.error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive" role="alert">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{rec.error}</span>
        </div>
      )}

      {rec.state !== 'ready' ? (
        <div className="flex flex-col items-center gap-4">
          {/* Botón principal: círculo de 150 px, con pulsos al grabar y anillo punteado en reposo */}
          <div className="relative flex h-[220px] w-full items-center justify-center">
            {recording ? (
              <>
                <span aria-hidden className="absolute size-[200px] rounded-full border-2 border-primary/50 motion-safe:animate-ping motion-reduce:hidden" style={{ animationDuration: '2.7s' }} />
                <span aria-hidden className="absolute size-[200px] rounded-full border-2 border-primary/50 motion-safe:animate-ping motion-reduce:hidden" style={{ animationDuration: '2.7s', animationDelay: '0.9s' }} />
                <span aria-hidden className="absolute size-[200px] rounded-full border-2 border-primary/50 motion-safe:animate-ping motion-reduce:hidden" style={{ animationDuration: '2.7s', animationDelay: '1.8s' }} />
              </>
            ) : (
              <span aria-hidden className="absolute size-[200px] rounded-full border-[1.5px] border-dashed border-line" />
            )}
            {recording ? (
              <button
                type="button"
                onClick={rec.stop}
                disabled={disabled}
                aria-label="Detener grabación"
                className="relative flex size-[150px] items-center justify-center rounded-full bg-primary text-[#131C33] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
              >
                <span className="size-[46px] rounded-xl bg-[#131C33]" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void rec.start()}
                disabled={disabled || rec.state === 'requesting' || rec.state === 'stopping'}
                aria-label="Empezar a grabar"
                className="relative flex size-[150px] items-center justify-center rounded-full bg-primary text-[#131C33] transition-transform active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground disabled:opacity-60"
              >
                {rec.state === 'requesting' ? <Loader2 className="h-12 w-12 animate-spin" aria-hidden /> : <Mic2 className="h-[52px] w-[52px]" aria-hidden />}
              </button>
            )}
          </div>

          {/* Tiempo en grande + leyenda */}
          <div className="text-center">
            <div className="font-display text-[44px] leading-none font-bold tracking-[-0.02em] tabular-nums" aria-live="polite">
              {recording ? fmt(rec.elapsed) : '0:00'}
            </div>
            <span className="mt-1 block text-sm text-muted-foreground">{recording ? 'Tocá para terminar' : 'Tocá para grabar'}</span>
          </div>

          {/* Barras de onda: siguen el nivel del micrófono al grabar; en reposo quedan quietas y tenues */}
          <span className="flex h-12 w-full max-w-sm items-center justify-between" aria-hidden>
            {Array.from({ length: 30 }).map((_, i) => {
              const base = 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6));
              if (!recording) return <span key={i} className="w-[3px] rounded-full bg-foreground/25" style={{ height: 6 + base * 16 }} />;
              // Al grabar cada barra late sola (animación CSS) y el nivel del micrófono sube o baja su amplitud
              const m = Math.max(0.18, Math.min(1, rec.level * 1.4 + base * 0.2));
              return (
                <span
                  key={i}
                  className="rec-bar h-11 w-[3px] rounded-full bg-gold"
                  style={{ '--m': m.toFixed(2), '--d': `${(0.8 + (i % 5) * 0.12).toFixed(2)}s`, '--dl': `${(-(i * 0.13)).toFixed(2)}s` } as React.CSSProperties}
                />
              );
            })}
          </span>
        </div>
      ) : (
        /* Pre-escucha de la toma */
        <div className="space-y-3">
          {rec.previewUrl && <ReviewPlayer src={rec.previewUrl} fallbackSec={rec.elapsed} />}
          {tooShort && (
            <p className="flex items-center justify-center gap-1.5 text-xs text-amber-strong" role="status">
              <CircleAlert className="h-3.5 w-3.5" aria-hidden />
              Necesitamos al menos {minSec}s — tu toma duró {fmt(rec.elapsed)}.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" size="sm" className="rounded-full" onClick={rec.reset} disabled={disabled}>
              Grabar de nuevo
            </Button>
            <Button
              size="sm"
              className="rounded-full bg-primary font-bold text-[#131C33] hover:bg-primary hover:text-[#131C33] hover:brightness-95 disabled:bg-foreground/10 disabled:bg-none disabled:text-muted-foreground disabled:opacity-100"
              disabled={disabled || tooShort || !rec.file}
              onClick={() => rec.file && onFile(rec.file, rec.elapsed)}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden /> Usar esta toma
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────── Subida de archivo / drag & drop ───────────────────── */

export function UploadPanel({ disabled, onFile, label }: { disabled: boolean; onFile: (f: File) => void; label?: string }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={label ?? 'Subir un archivo de audio'}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const f = e.dataTransfer.files?.[0];
          if (f && f.type.startsWith('audio/')) onFile(f);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[20px_20px_6px_6px] border border-dashed bg-[var(--m-input)] px-4 py-5 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground',
          dragging ? 'border-primary bg-primary/10' : 'border-line hover:border-foreground',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]">
          <Upload className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium">{label ?? 'O subí un archivo de audio'}</p>
        <p className="text-xs text-muted-foreground">Arrastralo acá o tocá para elegirlo · MP3, WAV, M4A, WEBM · hasta 50 MB</p>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

/* ───────────────────── Consejos (como Suno Paso 1) ───────────────────── */

const TIPS = [
  { icon: Music4, title: 'Cantá en el estilo que quieras', text: 'Pop, rock, rap o lo que te guste.' },
  { icon: Mic2, title: 'Un buen micrófono ayuda', text: 'El de la notebook también sirve.' },
  { icon: AudioLines, title: 'Elegí un lugar tranquilo', text: 'Sin ruido de fondo' },
  { icon: Waves, title: 'Al menos 10 segundos', text: 'Para captar tu timbre y tu tono.' },
];

const TIP_TONES = ['bg-primary text-[#131C33]', 'bg-gold text-[#131C33]', 'bg-voice text-on-voice', 'bg-primary text-[#131C33]'];

/* Consejos con el mismo estilo que los botones de «Materiales»: pastilla con círculo de color, título en negrita y descripción debajo. */
function TipsRow() {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4">
      {TIPS.map((t, n) => (
        <li key={t.title} className="flex flex-col items-center gap-2 text-center">
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', TIP_TONES[n % TIP_TONES.length])} aria-hidden>
            <t.icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block text-sm font-bold">{t.title}</span>
            <span className="block text-xs text-muted-foreground">{t.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
