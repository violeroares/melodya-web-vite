'use client';

/**
 * MELODYA WEB — Creador de canciones: la canción como sistema solar.
 *
 * El centro es la canción y cada elemento que se incorpora es un planeta (Composición y Estilo siempre; Voz, Audio,
 * Producción y Creatividad con el botón «+»). Cada planeta se abre en un panel para configurarlo o quitarlo, y
 * antes de generar hay una revisión con lo que se aplica y lo que no.
 *
 * El modelo vive en `song-model.ts` (puro y testeado); la presentación en `SolarSystem.tsx` y `PlanetEditors.tsx`.
 * Contratos: POST /generations (inputs estructurados + clientRequestId) y seguimiento por GET /generations/:id.
 * El nombre `CreatorWizard` se conserva porque es lo que importa la ruta /create.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Check, Plus, Minus, Info, CircleAlert, Trash2, ArrowRight, ChevronRight } from 'lucide-react';
import { navigate, useRoute } from '@/lib/router';
import { generationApi, samplesApi, projectsApi, songsApi } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { browserStorage, clearDraft, readDraft, writeDraft, type DraftContext } from '@/lib/draft-store';
import { createPendingStore, fingerprint, intentKey, retryTargetOf, type PendingRecord } from '@/lib/pending-request';
import { markRetryDisabled } from '@/lib/retry-availability';
import { ApiError } from '@/lib/api/client';
import { toUserMessage } from '@/lib/errors';
import { useCredits, formatRelative } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { useEntitlements, useUsage } from '@/hooks/use-capabilities';
import { creatorLocks, isLocked, isPlanExcluded, songsMeterText, type CapabilityKey } from '@/lib/capabilities';
import { usePlanGate } from '@/hooks/use-plan-gate';
import { LOCKED_CONTROL, RequiredPlanBadge } from '@/components/common/PlanGate';
import { useUpgradePrompt } from '@/stores/upgrade-prompt';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { LyricsStudio, type StudioOutcome } from './LyricsStudio';
import { useVersionSource } from './use-version-source';
import { useRemixSource } from './use-remix-source';
import { BLOCKED_TEXT, MODE_LABEL, classifyTemplateError, modeFromParam, remixAccess, remixUrl } from './remix-source';
import { RemixPlanBlocked } from './RemixPlanBlocked';
import { VersionLiveRegion, VersionNotes, VersionOriginSelect, VersionUnavailable } from './VersionSourcePicker';
import { BLANK_ORIGIN, lockTitle, mergeCapabilities } from './version-source';
import { VoiceCloneDialog } from '@/features/voice/VoiceCloneDialog';
import { GenerationStatusView, type LiveGen } from './GenerationStatus';
import { PendingRequestNotice } from './PendingRequestNotice';
import { OriginPickerDialog, RecoveryBanner, RecoveryBlocked, RecoveryPanel } from './RecoveryUI';
import { useRecoverySession } from './use-recovery-session';
import { discardBlockedRecovery } from './recovery-block';
import {
  REMIX_BLOCKED_REASON, RETRY_ALREADY_TEXT, RETRY_DISABLED_TEXT, TARGET_CHANGED_TEXT, buildRecoverySubmit, interpretRetryError, recoveryActionLabels, notRetryableText, recoveryBlockedReason, withHeldLyrics, withoutHeldLyrics,
} from './recovery-model';
import { DISCARD_DESCRIPTION, DISCARD_TITLE, UNCERTAIN_SUBMIT_TEXT } from './pending-copy';
import { VOICE_EXPIRED_TEXT, VOICE_EXPIRED_TITLE, voiceExpiredSample } from '@/features/voice/voice-expiry';
import { SolarSystem, planetIcon, PLANET_DOT } from './SolarSystem';
import { CompositionEditor, StyleEditor, VoiceEditor, ReferenceEditor, ProductionEditor, CreativityEditor } from './PlanetEditors';
import {
  emptySong, isEmptySong, parseSong, audioWeightApplies, availability, addPlanet, removePlanet, updatePlanet, validateSong,
  hasErrors, summarize, describeTreatment, applyLyricsFromStudio, buildGenerationRequest, planetDef, activePlanets, hasStyleInputs,
  type SongState, type PlanetId, type Capabilities,
} from './song-model';

type FocusKey = PlanetId | 'add';

function submitErrorMessage(err: unknown): string {
  // 422: el backend explica qué falta o qué preferencia no es compatible (VALIDATION_ERROR o INCOMPATIBLE_PREFERENCE).
  if (err instanceof ApiError) {
    const issues = (err.details as { issues?: Array<{ message?: string }> } | undefined)?.issues;
    const messages = Array.isArray(issues) ? issues.map((i) => i.message).filter((m): m is string => Boolean(m)) : [];
    if (messages.length) return messages.join(' ');
  }
  return toUserMessage(err, 'No pudimos iniciar la generación. Revisá tus fichas e intentá nuevamente.');
}

/** Acción secundaria del encabezado (misma presentación para «Empezar de cero» y «Crear canción nueva»). */
const HEADER_ACTION = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-foreground';

const NOT_AVAILABLE_ON_SUBMIT = 'La canción ya no está disponible (puede estar en la Papelera o haberse eliminado), así que no se creó la versión. No se descontaron fichas.';

const NEW_DRAFT: DraftContext = { kind: 'NEW' };

/** Planeta opcional → capacidad que lo habilita. Solo asocia el planeta con su capacidad; el plan que la incluye lo informa el catálogo. */
const PLANET_CAPABILITY: Partial<Record<PlanetId, CapabilityKey>> = {
  reference: 'AUDIO_REFERENCE',
  production: 'PRODUCTION_CONTROLS',
  creativity: 'CREATIVITY_SETTINGS',
};

export function CreatorWizard() {
  const { query } = useRoute();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userId = useAuthStore((st) => st.user?.id ?? null);
  const versionOfId = query.get('song');
  const fromParam = query.get('from');
  // Remix: canción NUEVA a partir de otra (/create?remix=<id>&mode=cover|prompt). No es «Otra versión»: son excluyentes.
  const remixSongId = versionOfId ? null : query.get('remix');
  const remixMode = modeFromParam(query.get('mode'));
  const isRemix = Boolean(remixSongId);
  // Hay una canción de origen (otra versión o remix): la configuración sale de ella y no se usa el borrador.
  const hasSource = Boolean(versionOfId) || isRemix;

  // Capacidades del plan (E5): lo que el servidor rechazaría se ve acá, con el motivo, antes de intentar crear.
  const entitlements = useEntitlements();
  const locks = useMemo(() => creatorLocks(entitlements), [entitlements]);

  /* ── «Otra versión» ──
   * Creación normal: `normalSong` (con su borrador). Otra versión: lo que el usuario editó (`versionEdits`) o, mientras no haya editado
   * nada, la configuración reconstruida de la versión de origen. Lo editado siempre gana: una respuesta tardía no lo puede pisar.
   * El creador se monta con `key` por canción, así que ningún estado de una creación normal se arrastra al modo versión. */
  const versionSource = useVersionSource({ songId: versionOfId, from: fromParam, locks });
  // Remix y plan: sin SONG_REMIX (y, en Versionar, sin AUDIO_REFERENCE) ni se pide la plantilla ni se muestra el creador (acceso por URL directa incluido).
  const access = isRemix ? remixAccess(locks, remixMode) : null;
  const remixSource = useRemixSource({ songId: remixSongId, mode: remixMode, from: fromParam, locks, enabled: !access || access.allowed });
  const source = isRemix ? remixSource : versionSource;
  const [normalSong, setNormalSong] = useState<SongState>(emptySong);
  const [versionEdits, setVersionEdits] = useState<SongState | null>(null);
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const versionBase = source.hydration.song;
  const song = hasSource ? (versionEdits ?? versionBase) : normalSong;
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- el compilador infiere `setVersionEdits` (estable); la lista manual es la intencional
  const setSong = useCallback((update: SongState | ((s: SongState) => SongState)) => {
    if (!hasSource) { setNormalSong(update); return; }
    // «Otra versión»: el título de la canción original se conserva (no se edita ni se envía). Un remix tiene título propio y editable.
    setVersionEdits((prev) => {
      const next = typeof update === 'function' ? update(prev ?? versionBase) : update;
      return isRemix ? next : lockTitle(next);
    });
  }, [hasSource, isRemix, versionBase]);
  const versionDirty = versionEdits !== null;
  const versionPending = hasSource && source.status !== 'ready';
  /* Cuenta a la que pertenece el borrador cargado en `normalSong`: nada se lee ni se escribe hasta saber de quién es, y al cambiar de
   * cuenta se descarta de memoria el borrador de la anterior (el guardado de cada cuenta queda intacto en su propia clave). */
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const hydrated = userId !== null && draftOwner === userId;
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [live, setLive] = useState<LiveGen>({ phase: 'idle' });
  /* Animación de lanzamiento sobre el sistema solar (se forma el disco) antes de pasar a la pantalla de generación */
  const [launching, setLaunching] = useState(false);
  /* Llegada de un elemento nuevo: el planeta sale del «+» y vuela a su lugar cuando el editor que lo guardó terminó de cerrarse. */
  const [arrival, setArrival] = useState<PlanetId | null>(null);
  /* Elementos agregados desde el «+» que todavía no se completaron con «Listo»: se dibujan punteados en el sistema. */
  const [pendingPlanets, setPendingPlanets] = useState<PlanetId[]>([]);
  const [openPlanet, setOpenPlanet] = useState<PlanetId | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [voiceCloneOpen, setVoiceCloneOpen] = useState(false);
  // Voz caducada que se recrea con su muestra original (null = clonación nueva).
  const [recreateVoiceId, setRecreateVoiceId] = useState<string | null>(null);
  const openRecreateVoice = (sampleId: string) => {
    if (cloneGate.locked) { cloneGate.prompt(); return; }
    setRecreateVoiceId(sampleId);
    setVoiceCloneOpen(true);
  };
  const refs = useRef<Partial<Record<FocusKey, HTMLButtonElement | null>>>({});
  const returnFocusTo = useRef<FocusKey>('add');

  /* ── Recuperar una generación fallida (E4) ──
   * Un solo espacio de composición: la composición recuperada ES el borrador de «canción nueva». Este estado solo recuerda de qué generación
   * viene, qué destino se eligió y qué se decidió sobre la letra retenida. Nada pisa una composición existente sin confirmación. */
  const recoverParam = query.get('recover');
  const rec = useRecoverySession({ userId, offerEnabled: !hasSource && live.phase === 'idle', locks });
  const recoveryActive = !hasSource && rec.session !== null;
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const [dismissConfirm, setDismissConfirm] = useState<string | null>(null);
  const [discardRecoveryOpen, setDiscardRecoveryOpen] = useState(false);
  const [originOpen, setOriginOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** Remix de otra persona cuyo origen ya no está autorizado: pantalla de bloqueo (no se carga nada de esa generación). */
  const [remixBlocked, setRemixBlocked] = useState<{ discardedDraft: boolean } | null>(null);

  // Borrador local (solo este dispositivo), aislado por cuenta: se carga al montar y cada vez que cambia la cuenta. No aplica a «otra versión» ni a remix.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!userId) { setDraftOwner(null); return; }
    if (!hasSource) {
      const saved = readDraft(browserStorage(), userId, NEW_DRAFT);
      const parsed = saved ? parseSong(saved.state) : null;
      if (parsed && !isEmptySong(parsed)) {
        setNormalSong(parsed);
        setRestoredAt(saved?.updatedAt ?? null);
      } else {
        setNormalSong(emptySong);
        setRestoredAt(null);
      }
    }
    setDraftOwner(userId);
  }, [hasSource, userId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!hydrated || hasSource || live.phase !== 'idle') return;
    if (isEmptySong(song)) clearDraft(browserStorage(), userId, NEW_DRAFT);
    else writeDraft(browserStorage(), userId, NEW_DRAFT, song);
  }, [song, hydrated, hasSource, live.phase, userId]);

  /* ── Solicitud pendiente (resultado incierto de un envío anterior) ──
   * Un solo `clientRequestId` por intención, con el cuerpo exacto guardado. Mientras haya una sin resolver no se envía otra. */
  const pendingStore = useMemo(() => createPendingStore({ storage: browserStorage() }), []);
  // Recuperación: lo que se envía (reintento enlazado o creación normal) y su intención salen del contrato del servidor y de lo que el usuario eligió.
  const recoveryPlan = useMemo(
    () => (recoveryActive && rec.session && rec.recovery && rec.status === 'ready'
      ? buildRecoverySubmit({ song, recovery: rec.recovery, session: rec.session, retryAvailable: rec.retryAvailable })
      : null),
    [recoveryActive, rec.session, rec.recovery, rec.status, rec.retryAvailable, song],
  );
  const usablePlan = recoveryPlan && recoveryPlan.kind !== 'BLOCKED' ? recoveryPlan : null;
  const intent = recoveryActive && rec.session
    ? (usablePlan?.intent ?? intentKey({ retryOfId: rec.session.generationId }))
    : intentKey({ versionOfId, remixSongId, remixMode });
  const [pending, setPending] = useState<PendingRecord | null>(null);
  const [resolving, setResolving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const sendingRef = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setPending(pendingStore.load(userId, intent)); }, [pendingStore, userId, intent]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { data: voiceSamples } = useQuery({ queryKey: ['samples', 'voice'], queryFn: () => samplesApi.list({ kind: 'VOICE', pageSize: 50 }), staleTime: 60_000 });
  const { data: refSamples } = useQuery({ queryKey: ['samples', 'instrument'], queryFn: () => samplesApi.list({ kind: 'INSTRUMENT', pageSize: 50 }), staleTime: 60_000 });
  const { data: projects } = useQuery({ queryKey: ['projects', 'creator'], queryFn: () => projectsApi.list({ pageSize: 50 }), staleTime: 60_000 });
  const { data: credits } = useCredits();
  // Funcionalidades fuera del plan: se ven con corona y plan mínimo, y al pulsarlas se muestra el aviso de upgrade (no se abre el editor ni la herramienta).
  const lyricsGate = usePlanGate('LYRICS_AI');
  const cloneGate = usePlanGate('VOICE_CLONING');
  const showUpgrade = useUpgradePrompt((st) => st.show);
  // Cupo mensual de canciones (E6): el medidor es informativo; el servidor decide con LIMIT_EXCEEDED.
  const { data: usage } = useUsage();
  const songMeter = useMemo(() => songsMeterText(usage), [usage]);

  // Solo se ofrecen voces con Persona lista: sin ella Suno no puede usarlas.
  // Las listas son paginadas (50): las muestras que «Otra versión» recupera por id se suman sin duplicarlas, para no tratar como ausente
  // una voz o un audio válidos solo por no estar en la primera página.
  const recovered = source.hydration.samples;
  const caps: Capabilities = useMemo(() => mergeCapabilities({
    voices: (voiceSamples?.items ?? []).filter((s) => s.sunoPersonaId).map((s) => ({ id: s.id, name: s.name, type: s.type, sunoPersonaId: s.sunoPersonaId, durationSec: s.durationSec, createdAt: s.createdAt })),
    references: (refSamples?.items ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type, durationSec: s.durationSec })),
  }, recovered), [voiceSamples, refSamples, recovered]);

  const issues = useMemo(() => validateSong(song, caps, locks), [song, caps, locks]);
  const quotaFull = Boolean(songMeter?.exhausted);
  const recoveryBlock = recoveryActive && rec.session
    ? recoveryBlockedReason({ session: rec.session, recovery: rec.recovery, loading: rec.status === 'loading' || rec.status === 'idle', failed: rec.status === 'error' })
    : null;
  const blocked = hasErrors(issues) || quotaFull || versionPending || pending !== null || resolving || recoveryBlock !== null;
  const summary = useMemo(() => summarize(song, caps), [song, caps]);
  const treatment = useMemo(() => describeTreatment(song), [song]);

  /* ── Foco: al cerrar un panel vuelve al elemento que lo abrió ── */
  const registerRef = useCallback((key: FocusKey, el: HTMLButtonElement | null) => { refs.current[key] = el; }, []);
  const restoreFocus = () => { window.setTimeout(() => (refs.current[returnFocusTo.current] ?? refs.current.add)?.focus(), 0); };
  /* En escritorio el panel de edición mide lo mismo que «Materiales» (se mide al abrir: el panel se dibuja en un portal, fuera del contenedor de ese ancho). */
  const reviewRef = useRef<HTMLElement>(null);
  const [sheetWidth, setSheetWidth] = useState<number | null>(null);
  const measureSheet = () => {
    setSheetWidth(reviewRef.current && window.innerWidth >= 1366 ? Math.round(reviewRef.current.getBoundingClientRect().width) : null);
  };
  /* Con el panel abierto, el ancho se vuelve a medir al cambiar el tamaño de la ventana (y se suelta por debajo de 1366 px). */
  useEffect(() => {
    if (openPlanet === null) return;
    const onResize = () => measureSheet();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [openPlanet]);
  /* Composición y Estilo están siempre en el sistema: se dibujan punteados mientras no tienen nada (o se están completando) y se rellenan con «Listo». */
  const [baseConfirmed, setBaseConfirmed] = useState<PlanetId[]>([]);
  const [baseEditing, setBaseEditing] = useState<PlanetId | null>(null);
  const baseEmpty = (id: PlanetId) => id === 'composition'
    ? !song.composition.idea.trim() && !song.composition.lyrics.trim() && !song.composition.title.trim()
    : !hasStyleInputs(song);
  const basePending = (['composition', 'style'] as PlanetId[]).filter((id) => !baseConfirmed.includes(id) && (baseEmpty(id) || (baseEditing === id && openPlanet === id)));
  // Mientras se lee la configuración de la versión de origen no se edita: así nada de lo que escriba el usuario compite con esa respuesta.
  const openEditor =(id: PlanetId) => {
    if (versionPending) return;
    returnFocusTo.current = id;
    measureSheet();
    // Composición/Estilo vacíos: quedan punteados mientras se edita y hasta apretar «Listo»
    setBaseEditing(id === 'composition' || id === 'style' ? (baseEmpty(id) ? id : null) : null);
    setOpenPlanet(id);
  };
  const openCatalog =() => { if (versionPending) return; returnFocusTo.current = 'add'; setCatalogOpen(true); };

  /* ── Operaciones sobre la canción ── */
  const patch = {
    composition: (p: Partial<SongState['composition']>) => setSong((s) => updatePlanet(s, 'composition', p)),
    style: (p: Partial<SongState['style']>) => setSong((s) => updatePlanet(s, 'style', p)),
    voice: (p: Partial<SongState['voice']>) => setSong((s) => updatePlanet(s, 'voice', p)),
    reference: (p: Partial<SongState['reference']>) => setSong((s) => updatePlanet(s, 'reference', p)),
    production: (p: Partial<SongState['production']>) => setSong((s) => updatePlanet(s, 'production', p)),
    creativity: (p: Partial<SongState['creativity']>) => setSong((s) => updatePlanet(s, 'creativity', p)),
  };

  /** Un planeta que el plan no incluye no se agrega: se muestra el aviso de upgrade de su capacidad. */
  const promptPlanetUpgrade = (cap: CapabilityKey) => {
    setCatalogOpen(false);
    showUpgrade(cap);
  };

  const addFromCatalog = (id: PlanetId) => {
    setSong((s) => addPlanet(s, id));
    // El elemento nuevo vuela desde el «+» al instante y queda punteado hasta que se completa con «Listo» (ahí se rellena)
    setPendingPlanets((p) => (p.includes(id) ? p : [...p, id]));
    setArrival(id);
    setCatalogOpen(false);
    returnFocusTo.current = id;
    measureSheet();
    setOpenPlanet(id);
  };

  const confirmPlanet = () => {
    if (openPlanet) {
      setPendingPlanets((p) => p.filter((x) => x !== openPlanet));
      if (openPlanet === 'composition' || openPlanet === 'style') setBaseConfirmed((c) => (c.includes(openPlanet) ? c : [...c, openPlanet]));
    }
    setOpenPlanet(null);
  };

  const removeCurrent = (id: PlanetId) => {
    setPendingPlanets((p) => p.filter((x) => x !== id));
    setSong((s) => removePlanet(s, id));
    setOpenPlanet(null);
    returnFocusTo.current = 'add';
    toast({ title: `Quitaste «${planetDef(id).label}»`, description: 'Podés volver a agregarlo con «+».' });
  };

  // Creación normal: vacía el creador y su borrador. En «otra versión» no existe: ahí se usa «Limpiar planetas» (no toca el borrador de otra canción).
  const restart = () => {
    if (recoveryActive) rec.end('DISMISSED'); // descartar la recuperación NO borra la generación fallida: sigue en el historial
    setNormalSong(emptySong);
    setBaseConfirmed([]);
    setPendingPlanets([]);
    setRestoredAt(null);
    clearDraft(browserStorage(), userId, NEW_DRAFT);
  };

  /**
   * El servidor bloqueó la recuperación (Remix ajeno sin origen autorizado). Se cierra la recuperación y, SOLO si ya se había cargado la
   * composición (es decir, el usuario la estaba editando), se descarta ese borrador —el espacio de composición de la recuperación— sin tocar
   * nada más. Si se bloquea al entrar, el borrador que había antes se conserva. Nada se borra del servidor.
   */
  const blockRecovery = () => {
    // Qué se limpia lo decide `discardBlockedRecovery` (probado): borrador de la recuperación y su pedido pendiente, solo si ya estaba cargada.
    const { discardedDraft } = discardBlockedRecovery({ storage: browserStorage(), userId, draft: NEW_DRAFT, pending: pendingStore, session: rec.session });
    if (rec.session) rec.end('DISMISSED');
    if (discardedDraft) {
      setNormalSong(emptySong);
      setRestoredAt(null);
      setPending(null);
    }
    setLive({ phase: 'idle' });
    setRemixBlocked({ discardedDraft });
  };
  /** ¿El Remix de la recuperación dejó de estar autorizado? Se pregunta al servidor (misma regla que GET /recovery); si sí, se bloquea. */
  const checkRemixBlocked = async () => {
    if (!rec.session || rec.recovery?.target.kind !== 'REMIX') return;
    const res = await rec.refetchRecovery();
    const f = res.error ? interpretRetryError(res.error) : null;
    if (f?.kind === 'NOT_RETRYABLE' && f.reason === REMIX_BLOCKED_REASON) blockRecovery();
  };
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (recoveryActive && rec.problem?.kind === 'not-retryable' && rec.problem.reason === REMIX_BLOCKED_REASON) blockRecovery();
  }, [recoveryActive, rec.problem]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ── Aplicar la composición recuperada (solo cuando el usuario la pidió) ── */
  const startRecovery = (generationId: string) => { setReplaceTarget(null); rec.start(generationId); };
  /** Recuperar sobre una composición en curso la reemplaza: primero se confirma. */
  const requestRecovery = (generationId: string) => {
    if (!isEmptySong(normalSong) && rec.session?.generationId !== generationId) { setReplaceTarget(generationId); return; }
    startRecovery(generationId);
  };
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!recoveryActive || !rec.session?.needsApply || rec.status !== 'ready' || !rec.hydration) return;
    setNormalSong(rec.hydration.song);
    setRestoredAt(null);
    rec.markApplied();
    // Confirmación discreta y transitoria: no ocupa lugar en el creador.
    toast({ title: '¡Composición recuperada!', description: 'Podés seguir editándola y volver a intentarlo.' });
  }, [recoveryActive, rec.session?.needsApply, rec.status, rec.hydration, rec]);
  // Si la recuperación sigue activa pero la composición se perdió del dispositivo, se vuelve a leer del servidor (no hay que volver al resumen).
  useEffect(() => {
    if (hydrated && recoveryActive && rec.session && !rec.session.needsApply && isEmptySong(normalSong)) rec.requestApply();
  }, [hydrated, recoveryActive, rec, normalSong]);
  // `/create?recover=<id>`: desde el resumen, el historial o un enlace. Se consume el parámetro y, si hay algo armado, se pide confirmación.
  useEffect(() => {
    if (!recoverParam || !rec.ready || !hydrated || hasSource) return;
    navigate('/create', { replace: true });
    requestRecovery(recoverParam);
  }, [recoverParam, rec.ready, hydrated, hasSource]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ── Origen de «Otra versión» (la elección vive en la URL: sobrevive a una recarga) ── */
  const goOrigin = (id: string) => navigate(
    isRemix ? remixUrl(remixSongId ?? '', remixMode, id) : `/create?song=${encodeURIComponent(versionOfId ?? '')}&from=${encodeURIComponent(id)}`,
    { replace: true },
  );
  /** Cambiar de origen o limpiar reemplaza lo que el usuario modificó: primero se confirma. */
  const requestOrigin = (id: string) => {
    if (versionDirty) { setPendingOrigin(id); return; }
    if (id !== source.originId) goOrigin(id);
  };
  const confirmOrigin = () => {
    if (pendingOrigin) { setVersionEdits(null); goOrigin(pendingOrigin); }
    setPendingOrigin(null);
  };
  const newSongInstead = () => navigate('/create');

  /** Generación aceptada por el servidor (202 o replay 200 de la misma clave): seguimiento y limpieza del borrador. */
  const onAccepted = (generationId: string, { clearTheDraft = true }: { clearTheDraft?: boolean } = {}) => {
    setPending(null);
    setLive({ phase: 'running', generationId });
    if (rec.session) rec.end(rec.session.detached ? 'RECOVERED' : 'SENT'); // enviada; si fue independiente, el reintento de la fallida sigue sin usar
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
    // El borrador es el de una canción nueva: generar otra versión de una canción existente no lo toca.
    if (!hasSource && clearTheDraft) clearDraft(browserStorage(), userId, NEW_DRAFT);
  };

  /** Rechazo definitivo del servidor (no se creó ni cobró nada): se explica según el caso. */
  const onRejected = (err: unknown) => {
    setPending(null);
    setLaunching(false); // si falla, no se espera a que termine la animación para mostrar el error
    if (recoveryActive && handleRetryRejection(err)) return;
    // Remix recuperado por la vía de creación normal (sin reintento enlazado): el servidor rechaza el origen con sus códigos de siempre. Se vuelve
    // a consultar la recuperación: si quedó bloqueada, se bloquea (y se descarta el borrador) en lugar de mostrar un error suelto.
    if (recoveryActive) void checkRemixBlocked();
    // Voz caducada detectada ANTES de cobrar: se explica y se ofrece recrearla (no se habla de contenido ni de la letra).
    const expiredSample = voiceExpiredSample(err);
    if (expiredSample !== undefined) {
      void queryClient.invalidateQueries({ queryKey: ['voice-availability'] });
      setLive({ phase: 'error', message: `${VOICE_EXPIRED_TITLE}. ${VOICE_EXPIRED_TEXT} No se descontaron fichas.`, canRetry: false, recreateVoiceId: expiredSample ?? song.voice.voiceSampleId ?? undefined });
      return;
    }
    // Remix: el servidor vuelve a validar el permiso al aceptar. Si cambió mientras se armaba (se revocó el permiso, pasó a privada,
    // a la Papelera o cambió la versión vigente), se explica sin revelar nada del original y sin cobro.
    if (isRemix && err instanceof ApiError && [403, 404, 422].includes(err.status)) {
      const d = (err.details as { code?: unknown } | undefined)?.code;
      const kind = classifyTemplateError(err.status, err.code, typeof d === 'string' ? d : undefined);
      // 'not-in-plan' sigue por el mensaje general (indica qué planes incluyen Remix).
      if (kind !== 'error' && kind !== 'not-in-plan') {
        setLive({ phase: 'error', message: `${BLOCKED_TEXT[kind]} No se descontaron fichas.`, canRetry: false });
        return;
      }
    }
    // La canción se movió a la Papelera o se eliminó mientras se armaba la versión (el servidor la responde como inexistente).
    if (versionOfId && err instanceof ApiError && err.status === 404) {
      setLive({ phase: 'error', message: NOT_AVAILABLE_ON_SUBMIT, canRetry: false });
      return;
    }
    setLive({ phase: 'error', message: submitErrorMessage(err), canRetry: true });
  };

  /** Rechazos propios del reintento (E3). Devuelve `true` si ya los explicó. Ninguno cobró nada. */
  const handleRetryRejection = (err: unknown): boolean => {
    const f = interpretRetryError(err);
    switch (f.kind) {
      case 'DISABLED':
        markRetryDisabled(); // se recuerda: no se vuelve a ofrecer una acción que ya sabemos que no está disponible
        setLive({ phase: 'error', message: RETRY_DISABLED_TEXT, canRetry: true });
        void checkRemixBlocked(); // sin reintento enlazado, el siguiente envío sería una creación normal: antes se comprueba que el Remix siga autorizado
        return true;
      case 'ALREADY_RETRIED':
        if (rec.session) rec.end('SENT');
        if (f.retriedBy) { toast({ title: 'Ya se había vuelto a intentar', description: RETRY_ALREADY_TEXT }); setLive({ phase: 'running', generationId: f.retriedBy }); }
        else setLive({ phase: 'error', message: RETRY_ALREADY_TEXT, canRetry: false });
        return true;
      case 'NOT_RETRYABLE':
        if (f.reason === REMIX_BLOCKED_REASON) { blockRecovery(); return true; } // el autor revocó mientras se editaba: se bloquea y se descarta ese borrador
        if (rec.session) rec.end('RECOVERED'); // la composición queda como una normal; ya no hay nada que reintentar
        setLive({ phase: 'error', message: notRetryableText(f.reason), canRetry: false });
        return true;
      case 'TARGET_CHANGED':
        rec.chooseDestination(null); // el destino cambió: se vuelve a decidir (nunca se cambia sola)
        void rec.refetchRecovery();
        setLive({ phase: 'error', message: TARGET_CHANGED_TEXT, canRetry: true });
        return true;
      default:
        return false;
    }
  };

  /** Sin respuesta confiable: la solicitud queda guardada (misma clave, mismo cuerpo) y se debe confirmar antes de enviar otra. */
  const onUncertain = (record: PendingRecord) => {
    setPending(record);
    setLaunching(false);
    setLive({ phase: 'error', message: UNCERTAIN_SUBMIT_TEXT, canRetry: true, uncertain: true });
  };

  /** Cuerpo que se enviaría ahora con lo que hay en el editor (el mismo para enviar y para compararlo con un pedido pendiente). */
  const currentBody = (): Record<string, unknown> => {
    if (usablePlan) return usablePlan.body as Record<string, unknown>;
    const request = buildGenerationRequest(song, {
      versionOfId,
      remix: isRemix && remixSongId ? { songId: remixSongId, versionId: remixSource.template?.source.versionId } : null,
    });
    return { ...request, ...(versionOfId ? { songId: versionOfId } : {}) };
  };

  const sendBody = (body: Record<string, unknown>) => generationApi.create(body as unknown as Parameters<typeof generationApi.create>[0]);
  /** El envío según la intención: `retry.<id>` va al reintento enlazado; el resto, a la creación normal. */
  const sendFor = (forIntent: string) => {
    const retryId = retryTargetOf(forIntent);
    return retryId ? (body: Record<string, unknown>) => generationApi.retry(retryId, body as unknown as Parameters<typeof generationApi.retry>[1]) : sendBody;
  };

  /* ── Generar ── */
  const submit = async () => {
    if (blocked || launching || live.phase !== 'idle' || sendingRef.current) return; // sendingRef: un segundo clic antes del re-render no envía nada
    sendingRef.current = true;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setLaunching(true);
    setLive({ phase: 'creating' });
    try {
      const res = await pendingStore.submit({ userId, intent, body: currentBody(), send: sendFor(intent), endpoint: usablePlan?.endpoint });
      if (res.kind === 'ACCEPTED') onAccepted(res.value.id);
      else if (res.kind === 'REJECTED') onRejected(res.error);
      else if (res.kind === 'UNCERTAIN') onUncertain(res.record);
      else {
        // BLOCKED: hay un pedido anterior sin confirmar y este cuerpo es distinto. IN_FLIGHT: ya hay un envío en curso.
        setLaunching(false);
        setLive({ phase: 'idle' });
        if (res.kind === 'BLOCKED') setPending(res.record);
      }
    } catch (err) {
      onRejected(err); // fallo local antes de enviar (p. ej. no hay cuenta): nada salió hacia el servidor
    } finally {
      sendingRef.current = false;
    }
  };

  /** Confirma el pedido anterior reenviando EXACTAMENTE lo guardado (misma clave, mismo cuerpo). */
  const resolvePending = async () => {
    if (sendingRef.current || !pending) return;
    sendingRef.current = true;
    setResolving(true);
    try {
      // Si el usuario siguió editando mientras tanto, su borrador actual NO es el del pedido confirmado y no se borra.
      let sameAsEditor = false;
      try { sameAsEditor = (await fingerprint(currentBody())) === pending.bodyHash; } catch { /* editor no armable: se conserva el borrador */ }
      const res = await pendingStore.resolve({ userId, intent, send: sendFor(intent) });
      if (res.kind === 'ACCEPTED') {
        onAccepted(res.value.id, { clearTheDraft: sameAsEditor });
      } else if (res.kind === 'REJECTED' && recoveryActive && handleRetryRejection(res.error)) {
        setPending(null);
      } else if (res.kind === 'REJECTED') {
        setPending(null);
        toast({ title: 'El pedido anterior no se había creado', description: `${submitErrorMessage(res.error)} No se descontaron fichas.`, variant: 'destructive' });
      } else if (res.kind === 'UNCERTAIN') {
        setPending(res.record);
        toast({ title: 'Todavía no pudimos confirmarlo', description: 'Revisá tu conexión e intentá de nuevo en unos segundos. No se cobra dos veces.', variant: 'destructive' });
      } else if (res.kind === 'NONE') {
        setPending(null);
      }
    } finally {
      sendingRef.current = false;
      setResolving(false);
    }
  };

  /** «Otra versión» con la canción en la Papelera: se restaura (acción explícita del usuario) y se vuelve a comprobar el destino. */
  const restoreTargetSong = async () => {
    const songId = rec.recovery?.target.songId;
    if (!songId || restoring) return;
    setRestoring(true);
    try {
      await songsApi.restore(songId);
      void queryClient.invalidateQueries({ queryKey: ['songs'] });
      await rec.refetchRecovery();
      toast({ title: 'Canción restaurada', description: 'Volvió desde la Papelera. Ya podés agregar la versión.' });
    } catch (err) {
      toast({ title: 'No pudimos restaurar la canción', description: toUserMessage(err), variant: 'destructive' });
    } finally {
      setRestoring(false);
    }
  };

  /** Descarte MANUAL y consciente: el pedido pudo haberse creado. Nunca se descarta por tiempo. */
  const discardPending = () => {
    if (userId) pendingStore.discard(userId, intent);
    setPending(null);
    setDiscardOpen(false);
  };

  if (live.phase !== 'idle' && !launching) {
    return (
      <div className="view-in">
        <GenerationStatusView
          state={live}
          elements={activePlanets(song).map((id) => ({ id, label: planetDef(id).label, detail: summary[id] }))}
          onRetry={() => setLive({ phase: 'idle' })}
          onRecover={hasSource ? undefined : (generationId) => { setLive({ phase: 'idle' }); startRecovery(generationId); }}
          onRecreateVoice={(sampleId) => { setLive({ phase: 'idle' }); openRecreateVoice(sampleId); }}
          onClose={() => navigate('/library/songs')}
          onCompleted={(songId) => { if (live.phase === 'running') setLive({ phase: 'done', generationId: live.generationId, songId }); }}
        />
      </div>
    );
  }

  // Remix fuera del plan (por las capacidades efectivas, o porque el servidor respondió 403 CAPABILITY_NOT_IN_PLAN a la plantilla).
  if (isRemix && ((access && !access.allowed) || remixSource.blockedKind === 'not-in-plan')) {
    const blockedAccess = access && !access.allowed ? access : null;
    return (
      <RemixPlanBlocked
        capability={blockedAccess?.capability ?? 'SONG_REMIX'}
        reason={blockedAccess?.reason ?? BLOCKED_TEXT['not-in-plan']}
        canReusePrompt={Boolean(blockedAccess?.canReusePrompt) && Boolean(remixSongId)}
        onReusePrompt={() => navigate(remixUrl(remixSongId ?? '', 'PROMPT_REUSE'))}
        onLibrary={() => navigate('/library/songs')}
      />
    );
  }

  // Remix de otra persona sin origen autorizado: pantalla compacta, sin planetas. El usuario siempre puede empezar una canción desde cero.
  if (remixBlocked) {
    return <RecoveryBlocked discardedDraft={remixBlocked.discardedDraft} onActivity={() => { setRemixBlocked(null); navigate('/profile/activity'); }} onFresh={() => setRemixBlocked(null)} />;
  }

  // Otra versión de una canción que no existe, está en la Papelera o no es del usuario: se explica y se ofrecen salidas, sin mostrar un creador a medias.
  if (hasSource && source.status === 'blocked' && source.blocked) {
    return (
      <VersionUnavailable
        title={isRemix ? 'No podemos hacer este remix' : undefined}
        message={source.blocked.message}
        retryable={source.blocked.kind === 'error'}
        onRetry={source.retry}
        onLibrary={() => navigate('/library/songs')}
        onNewSong={newSongInstead}
      />
    );
  }

  const current = openPlanet ? planetDef(openPlanet) : null;
  const catalog = availability(song, locks);
  const empty = isEmptySong(song);
  const actionLabels = recoveryActive && rec.session && usablePlan ? recoveryActionLabels({ session: rec.session, retryAvailable: rec.retryAvailable }) : null;
  const genresText = song.style.genres.join(', ');

  /* Botón «Crear mi canción»: barra anclada al borde izquierdo, abajo (como en el mockup) */
  const createAction = () => (
    <div className="mt-6 flex flex-col gap-2 min-[1366px]:col-start-1 min-[1366px]:row-start-2 wiz-create-bar min-[1366px]:-ml-6 min-[1366px]:mt-4">
      <Button
        size="lg"
        className="h-14 w-full justify-between rounded-full bg-voice py-0 pl-6 pr-0 font-display text-base font-bold text-on-voice hover:bg-voice/90 hover:text-on-voice disabled:opacity-60 rounded-l-none"
        disabled={blocked}
        aria-describedby={blocked ? 'create-blocked' : undefined}
        onClick={() => void submit()}
      >
        <span className="flex min-w-0 items-center gap-2"><Sparkles className="h-5 w-5 shrink-0 text-gold" aria-hidden /> <span className="truncate">{actionLabels?.label ?? 'Crear mi canción'}</span></span>
        <span aria-hidden className="-mr-px flex size-[58px] shrink-0 items-center justify-center rounded-full bg-gold text-on-gold">
          <ArrowRight className="h-5 w-5" />
        </span>
      </Button>
      {blocked && <p id="create-blocked" className="px-2 text-sm text-muted-foreground">{versionPending ? 'Estamos leyendo la configuración de la versión elegida…' : quotaFull && !hasErrors(issues) ? songMeter?.text : pending !== null ? 'Primero confirmá tu pedido anterior (arriba).' : recoveryBlock ?? 'Resolvé los puntos marcados para poder crearla.'}</p>}
    </div>
  );

  return (
    <div className="view-in mx-auto w-full max-w-7xl pb-16 min-[1366px]:grid min-[1366px]:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] min-[1366px]:grid-rows-[1fr_auto] min-[1366px]:gap-x-8">
      <div className="min-w-0 min-[1366px]:col-start-1 min-[1366px]:row-start-1">
      <div className="lg:flex lg:items-start lg:justify-between lg:gap-4">
      <header className="min-w-0 pb-4 pt-1 lg:pb-5">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-label">
          <span aria-hidden className="size-1.5 rounded-full bg-gold" />
          En armado
        </p>
        <h1 className="mt-1 font-display text-2xl font-extrabold tracking-tight sm:text-3xl">Armá tu canción</h1>
        {versionOfId && source.song && (
          <p className="mt-0.5 truncate text-sm text-muted-foreground" title={source.song.title}>
            Otra versión de <span className="font-medium text-label">«{source.song.title}»</span>
          </p>
        )}
        {isRemix && remixSource.template && (
          <p className="mt-0.5 truncate text-sm text-muted-foreground" title={remixSource.template.source.title} data-testid="remix-header">
            {MODE_LABEL[remixMode]} · hecho a partir de <span className="font-medium text-label">«{remixSource.template.source.title}»</span>
            {remixSource.template.isOwner ? '' : ` de ${remixSource.template.source.author.name}`}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{activePlanets(song).length} {activePlanets(song).length === 1 ? 'elemento' : 'elementos'}</span>
          {restoredAt && <span>· borrador de {formatRelative(restoredAt)}</span>}
          {hasSource && <VersionOriginSelect options={source.options} originId={source.originId} loading={source.loading} onSelect={requestOrigin} />}
          {/* Acciones del encabezado, mutuamente excluyentes y con la misma presentación:
              creación normal → «Empezar de cero» (vacía el creador y su borrador);
              «otra versión» → «Crear canción nueva» (sale a /create). Vaciar los planetas ahí es «Empezar en blanco» del selector. */}
          {!hasSource && !empty && (
            <button
              type="button"
              onClick={() => (recoveryActive ? setDiscardRecoveryOpen(true) : restart())}
              disabled={recoveryActive && pending !== null}
              title={recoveryActive && pending !== null ? 'Primero confirmá tu pedido anterior (arriba).' : undefined}
              className={cn(HEADER_ACTION, 'disabled:cursor-not-allowed disabled:opacity-50')}
            >
              <Trash2 className="h-3 w-3" aria-hidden /> Empezar de cero
            </button>
          )}
          {hasSource && (
            <button type="button" onClick={newSongInstead} className={HEADER_ACTION}>
              <Plus className="h-3 w-3" aria-hidden /> Crear canción nueva
            </button>
          )}
        </div>
        {hasSource && (
          <>
            <VersionLiveRegion loading={source.loading} originId={source.originId} selected={source.options.find((o) => o.id === source.originId) ?? null} />
            <VersionNotes notes={source.hydration.notes} loading={source.loading} onRetry={source.retry} onRecreateVoice={openRecreateVoice} />
          </>
        )}
      </header>
      </div>

      {pending && (
        <PendingRequestNotice record={pending} busy={resolving} onConfirm={() => void resolvePending()} onDiscard={() => setDiscardOpen(true)} />
      )}

      {!hasSource && rec.candidate && !recoveryActive && live.phase === 'idle' && (
        <RecoveryBanner
          generation={rec.candidate}
          editorHasWork={!empty}
          busy={false}
          onRecover={() => requestRecovery((rec.candidate as { id: string }).id)}
          onDismiss={() => { const id = (rec.candidate as { id: string }).id; if (empty) rec.dismissCandidate(id); else setDismissConfirm(id); }}
        />
      )}

      {recoveryActive && rec.session && (
        <RecoveryPanel
          status={rec.status}
          recovery={rec.recovery}
          problem={rec.problem}
          retriedBy={rec.retriedBy}
          session={rec.session}
          notes={rec.hydration?.notes ?? []}
          restoring={restoring}
          onChoose={(choice) => rec.chooseDestination(choice)}
          onRestore={() => void restoreTargetSong()}
          onPickOrigin={() => setOriginOpen(true)}
          onHeld={(decision) => {
            const held = rec.recovery?.held.find((h) => h.field === 'LYRICS');
            rec.setHeldDecision(decision);
            if (held) setNormalSong((s) => (decision === 'KEEP' ? withHeldLyrics(s, held.text) : withoutHeldLyrics(s, held.text)));
          }}
          onDiscard={() => restart()} // solo se muestra con el editor vacío (cargando o con error): no hay nada que perder
          pendingBlocks={pending !== null}
          onViewRetry={(id) => { rec.end('SENT'); setLive({ phase: 'running', generationId: id }); }}
          onReload={() => void rec.refetchRecovery()}
          onRetryNote={() => void rec.refetchRecovery()}
          onRecreateVoice={openRecreateVoice}
        />
      )}

      {empty && !versionPending && !recoveryActive && (
        <div className="mb-5 flex flex-col gap-3 rounded-[28px] bg-surface p-4 text-sm sm:flex-row sm:items-center sm:rounded-full sm:py-3 sm:pr-3 sm:pl-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
          <Sparkles className="h-5 w-5 shrink-0 text-amber-strong" aria-hidden />
          <p className="min-w-0 flex-1">Empezá por <span className="font-semibold">Composición</span>: contanos una idea, pegá tu letra o pedí solo música.</p>
          </div>
          <Button className="w-full rounded-full sm:w-auto gradient-warm text-primary-foreground hover:text-primary-foreground" onClick={() => openEditor('composition')}>
            Empezar <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}

      <SolarSystem song={song} caps={caps} issues={issues} onOpenPlanet={openEditor} onOpenCatalog={openCatalog} registerRef={registerRef} launching={launching} onLaunchEnd={() => setLaunching(false)} arrival={arrival} pending={[...pendingPlanets, ...basePending]} onArrivalEnd={() => setArrival(null)} />
      </div>

      {/* ── Revisión antes de generar ── */}
      <section
        ref={reviewRef}
        aria-labelledby="review-title"
        className="wiz-review -mx-4 mt-10 bg-surface px-4 py-5 sm:-mx-6 sm:px-6 sm:py-7 min-[1366px]:col-start-2 min-[1366px]:row-span-2 min-[1366px]:row-start-1 min-[1366px]:min-w-0 min-[1366px]:px-5 min-[1366px]:py-6"
      >
        <h2 id="review-title" className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em] text-label">
          <span aria-hidden className="size-[7.5px] shrink-0 rounded-full bg-gold" />
          Materiales
        </h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">Cada elemento de tu canción. Tocá uno para editarlo.</p>

        {issues.some((i) => i.severity === 'error') && (
          /* Título fuera de las cápsulas; cada problema va en su propia cápsula (como «Seguí creando» del inicio): pegada al borde izquierdo, con la flecha en círculo dorado para ir al elemento */
          <div role="alert" className="mb-5 space-y-2.5">
            <p className="flex items-center gap-2 font-display text-base font-bold"><CircleAlert className="h-4 w-4 shrink-0 text-destructive" aria-hidden /> Antes de crear, falta resolver:</p>
            <ul className="space-y-2.5">
              {issues.filter((i) => i.severity === 'error').map((i, n) => (
                <li key={n} className="wiz-cap flex items-center gap-3 rounded-r-[40px] bg-[var(--m-capsule-tint)] py-3 pr-4 pl-5 text-foreground sm:pl-6">
                  <span className="min-w-0 flex-1 text-[13px] leading-snug">{i.message}</span>
                  <button
                    type="button"
                    onClick={() => openEditor(i.planet)}
                    aria-label={`Ir a ${planetDef(i.planet).label}`}
                    title={`Ir a ${planetDef(i.planet).label}`}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33] transition-[filter] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                  >
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className="space-y-2" aria-label="Elementos de tu canción">
          {activePlanets(song).map((id) => {
            const Icon = planetIcon(id);
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => openEditor(id)}
                  aria-label={`Editar ${planetDef(id).label}. ${summary[id]}`}
                  className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-full border border-border/70 bg-surface-2/40 p-2 pr-4 text-left transition-colors hover:border-amber/40 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
                >
                  <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', PLANET_DOT[id])} aria-hidden>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-sm font-bold">{planetDef(id).label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{summary[id]}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>

        {treatment.length > 0 && (
          <ul className="mt-5 space-y-2" aria-label="Cómo se aplica">
            {treatment.map((t, n) => (
              <li key={n} className="flex items-start gap-2 text-sm leading-relaxed">
                {t.kind === 'applied' ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                <span><span className="font-semibold">{t.kind === 'applied' ? 'Se aplica: ' : 'Ojo: '}</span>{t.text}</span>
              </li>
            ))}
          </ul>
        )}

        {(projects?.items?.length ?? 0) > 0 && !versionOfId && (
          <div className="mt-5 max-w-sm space-y-2">
            <Label htmlFor="song-project" className="text-xs font-medium text-muted-foreground">Guardar en un proyecto (opcional)</Label>
            <Select value={song.projectId} onValueChange={(v) => setSong((s) => ({ ...s, projectId: v }))}>
              <SelectTrigger id="song-project"><SelectValue placeholder="Sin proyecto" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sin proyecto</SelectItem>
                {(projects?.items ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}

        <p className="mt-5 flex items-center gap-2 rounded-full bg-voice px-4 py-3 text-sm text-on-voice">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-gold" />
          <span>Saldo: <span className="font-bold tabular-nums">{credits?.balance ?? '…'}</span> fichas. El costo exacto se confirma al generar.</span>
        </p>

        {/* Cupo de canciones del período: cápsula como los avisos de cada elemento («Falta resolver:»), pegada al borde izquierdo de la tarjeta */}
        {songMeter && (
          <div
            role="status"
            data-testid="songs-meter"
            className="mt-5 -ml-4 w-[calc(100%+1rem)] rounded-r-[40px] bg-[var(--m-capsule-tint)] py-3.5 pr-5 pl-5 text-foreground sm:-ml-6 sm:w-[calc(100%+1.5rem)] sm:pl-6 min-[1366px]:-ml-5 min-[1366px]:w-[calc(100%+1.25rem)]"
          >
            <p className="flex items-center gap-2 font-display text-base font-bold">
              {songMeter.exhausted ? <CircleAlert className="h-4 w-4 shrink-0 text-destructive" aria-hidden /> : <Info className="h-4 w-4 shrink-0" aria-hidden />}
              {songMeter.exhausted ? 'Atención:' : 'Nota:'}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{songMeter.text}</p>
          </div>
        )}
      </section>

      {/* ── Generar: barra pegada al borde izquierdo, debajo del sistema solar ── */}
      {createAction()}

      {/* ── Panel de un planeta ── */}
      <Sheet open={openPlanet !== null} onOpenChange={(o) => { if (!o) setOpenPlanet(null); }}>
        <SheetContent
          side="right"
          overlayClassName="bg-transparent"
          style={sheetWidth ? { width: sheetWidth, maxWidth: sheetWidth } : undefined}
          className={cn(
            'w-full overflow-y-auto border-0 sm:max-w-lg sm:rounded-l-[28px]',
            /* Mobile: hoja inferior con más radio arriba que abajo (Feed V2). */
            'max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:h-auto max-sm:max-h-[90dvh] max-sm:rounded-t-[28px] max-sm:border-t max-sm:border-l-0',
            'max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom'
          )}
          onCloseAutoFocus={(e) => { e.preventDefault(); restoreFocus(); }}
        >
          {current && (
            <>
              {/* El tacho de los editores de Crear (design-V2 · `.ehdr .ib.danger`): al lado de la ✕, fondo naranja */}
              {!current.base && (
                <button
                  type="button"
                  onClick={() => removeCurrent(current.id)}
                  aria-label="Quitar de mi canción"
                  title="Quitar de mi canción"
                  className="absolute top-3 right-[4.5rem] flex size-11 items-center justify-center rounded-full border-[1.5px] border-primary bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-[4px] focus-visible:ring-[var(--m-focus-ring)] focus:outline-hidden"
                >
                  <Trash2 className="size-[18px]" aria-hidden />
                </button>
              )}
              <SheetHeader className={current.base ? undefined : 'pr-32'}>
                <SheetTitle className="font-display text-xl">{current.label}</SheetTitle>
                <SheetDescription>{current.blurb}</SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-6 px-4">
                {current.id === 'composition' && (
                  <CompositionEditor
                    song={song}
                    patch={patch.composition}
                    issues={issues}
                    onOpenStudio={() => (lyricsGate.locked ? lyricsGate.prompt() : setStudioOpen(true))}
                    locks={locks}
                    lockedTitle={versionOfId ? source.song?.title ?? '' : undefined}
                    onApplySuggestion={(idea, genres) => {
                      setSong((s) => updatePlanet(updatePlanet(s, 'composition', idea ? { idea } : {}), 'style', genres.length ? { genres } : {}));
                    }}
                  />
                )}
                {current.id === 'style' && <StyleEditor song={song} patch={patch.style} issues={issues} />}
                {current.id === 'voice' && <VoiceEditor song={song} caps={caps} patch={patch.voice} issues={issues} onRecordVoice={() => { if (cloneGate.locked) { cloneGate.prompt(); return; } setRecreateVoiceId(null); setVoiceCloneOpen(true); }} onRecreateVoice={openRecreateVoice} locks={locks} />}
                {current.id === 'reference' && <ReferenceEditor song={song} caps={caps} patch={patch.reference} issues={issues} />}
                {current.id === 'production' && <ProductionEditor song={song} patch={patch.production} issues={issues} />}
                {current.id === 'creativity' && <CreativityEditor song={song} patch={patch.creativity} issues={issues} audioApplies={audioWeightApplies(song, caps)} />}
              </div>
              <SheetFooter className="flex-col items-start gap-2 pt-1">
                <Button
                  type="button"
                  size="lg"
                  className="-ml-4 h-14 w-[calc(100%+1rem)] max-w-none justify-between rounded-full rounded-l-none bg-voice py-0 pl-8 pr-0 font-display text-base font-bold text-on-voice hover:bg-voice/90 hover:text-on-voice"
                  onClick={confirmPlanet}
                >
                  <span>Listo</span>
                  <span aria-hidden className="-mr-px flex size-[58px] shrink-0 items-center justify-center rounded-full bg-gold text-on-gold">
                    <Check className="h-5 w-5" />
                  </span>
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Catálogo («+») ── */}
      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] gap-4 overflow-y-auto border-0 p-4 sm:max-w-lg sm:p-6" onCloseAutoFocus={(e) => { e.preventDefault(); restoreFocus(); }}>
          <DialogHeader>
            <DialogTitle>Agregar a tu canción</DialogTitle>
            <DialogDescription>Elegí un elemento para sumarlo. Podés quitarlo cuando quieras.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {catalog.map(({ def, present, available, reason }) => {
              const Icon = planetIcon(def.id);
              const cap = PLANET_CAPABILITY[def.id];
              const planLocked = !present && cap !== undefined && isLocked(entitlements, cap);
              const planExcluded = !present && cap !== undefined && isPlanExcluded(entitlements, cap); // corona: no depende de enforce
              const disabled = !available && !planLocked;
              return (
                <li key={def.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => (planLocked && cap ? promptPlanetUpgrade(cap) : addFromCatalog(def.id))}
                    aria-disabled={planLocked || undefined}
                    className={cn('flex min-h-14 w-full items-center gap-3 rounded-[28px] border border-border/70 bg-surface-2/40 p-2 pr-3 text-left sm:pr-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber', disabled ? 'cursor-not-allowed opacity-60' : planLocked ? cn('cursor-pointer', LOCKED_CONTROL) : 'cursor-pointer hover:border-amber/40 hover:bg-surface-2')}
                  >
                    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', PLANET_DOT[def.id], (disabled || planLocked) && 'opacity-50')} aria-hidden><Icon className="h-5 w-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="block text-sm font-bold leading-tight">{def.label}</span>
                        {planExcluded && cap && <RequiredPlanBadge capability={cap} />}
                      </span>
                      <span className="line-clamp-2 block text-xs text-muted-foreground">{present ? 'Ya está en tu canción.' : planLocked ? def.blurb : reason ?? def.blurb}</span>
                    </span>
                    {available && <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gold text-[#131C33]"><Plus className="h-3.5 w-3.5" strokeWidth={3} /></span>}
                    {present && <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success text-background"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>

      {/* Recuperación: reemplazar lo que se está armando, descartar o elegir otro origen */}
      <AlertDialog open={replaceTarget !== null} onOpenChange={(o) => { if (!o) setReplaceTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Reemplazar lo que estás armando?</AlertDialogTitle>
            <AlertDialogDescription>Se va a reemplazar la composición que tenés ahora en el editor (tu borrador de este dispositivo) por la de tu última canción, que no se pudo crear. Lo que armaste se descarta. Esa canción sigue en tu actividad, y si ya no se puede recuperar, no se toca nada.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir con lo mío</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (replaceTarget) startRecovery(replaceTarget); }}>Recuperar y reemplazar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={dismissConfirm !== null} onOpenChange={(o) => { if (!o) setDismissConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar y empezar de cero?</AlertDialogTitle>
            <AlertDialogDescription>Vas a vaciar lo que estás armando. Tu última canción, que no se pudo crear, no se borra: sigue en tu actividad.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (dismissConfirm) rec.dismissCandidate(dismissConfirm); setDismissConfirm(null); restart(); }}>Descartar y empezar de cero</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={discardRecoveryOpen} onOpenChange={setDiscardRecoveryOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Empezar de cero?</AlertDialogTitle>
            <AlertDialogDescription>Se vacía el editor y se cierra la recuperación. La generación que falló no se borra: sigue en tu actividad y la podés recuperar de nuevo desde ahí.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setDiscardRecoveryOpen(false); restart(); }}>Empezar de cero</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <OriginPickerDialog open={originOpen} onOpenChange={setOriginOpen} locks={locks} current={rec.session?.otherOrigin ?? null} onPick={(origin) => rec.chooseDestination('OTHER_ORIGIN', origin)} />

      {/* «Otra versión»: cambiar de origen o limpiar reemplaza lo que el usuario modificó */}
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{DISCARD_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{DISCARD_DESCRIPTION}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction onClick={discardPending}>Descartar de todos modos</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingOrigin !== null} onOpenChange={(o) => { if (!o) setPendingOrigin(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingOrigin === BLANK_ORIGIN ? '¿Limpiar los planetas?' : '¿Reemplazar lo que armaste?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingOrigin === BLANK_ORIGIN
                ? 'Vas a perder los cambios que hiciste en los planetas. Seguís creando otra versión de la misma canción.'
                : 'Vas a perder los cambios que hiciste en los planetas y cargar la configuración de la versión que elegiste.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir con lo mío</AlertDialogCancel>
            <AlertDialogAction onClick={confirmOrigin}>{pendingOrigin === BLANK_ORIGIN ? 'Limpiar' : 'Reemplazar'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Estudio de letras a pantalla completa */}
      <LyricsStudio
        open={studioOpen}
        onOpenChange={setStudioOpen}
        initialIdea={song.composition.idea}
        initialGenre={genresText}
        onApply={(outcome: StudioOutcome) => {
          // La letra pasa a ser la del usuario y su título se transfiere al creador (editable) si no escribió uno propio.
          setSong((s) => applyLyricsFromStudio(s, { lyrics: outcome.lyrics, title: outcome.title }));
          setStudioOpen(false);
          toast({ title: 'Letra cargada 📝', description: outcome.title ? `Usamos «${outcome.title}» como título si no pusiste uno: podés cambiarlo en Composición.` : 'Tu letra se usará para la canción.' });
        }}
      />

      {/* Crear voz en el momento (flujo Suno: grabar → frase → detalles) */}
      <VoiceCloneDialog
        open={voiceCloneOpen}
        onOpenChange={setVoiceCloneOpen}
        recreateSampleId={recreateVoiceId}
        onVoiceReady={(sample) => {
          setSong((s) => updatePlanet(addPlanet(s, 'voice'), 'voice', { voiceSampleId: sample.id, preference: '' }));
          void queryClient.invalidateQueries({ queryKey: ['samples'] });
          void queryClient.invalidateQueries({ queryKey: ['voice-availability'] });
          toast({ title: '¡Voz lista! 🎙️', description: `“${sample.name}” queda seleccionada para esta canción.` });
        }}
      />
    </div>
  );
}
