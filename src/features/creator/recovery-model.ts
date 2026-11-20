/**
 * Recuperar y reintentar una generación FAILED (E4). Lógica pura (sin React ni red; testeada en tests/recovery-model.test.mjs).
 *
 * El servidor reconstruye la solicitud original (`GET /generations/:id/recovery`, E2) y acepta el reintento (`POST /generations/:id/retry`,
 * E3). Este módulo solo traduce ese contrato a lo que el creador necesita:
 *  • qué generación ofrecer al volver al creador (`pickRecoveryCandidate`) y cuáles se pueden recuperar desde el historial;
 *  • los planetas (`songFromRecovery`), con lo que falta, lo que venció y lo que NO se reutiliza solo (letras de procedencia incierta);
 *  • el destino y la decisión que exige cuando ya no está disponible (`describeTarget`, `effectiveDestination`);
 *  • el pedido a enviar (`buildRecoverySubmit`): reintento enlazado, o creación normal cuando el usuario lo decide;
 *  • cómo interpretar los rechazos propios del reintento (`interpretRetryError`).
 *
 * Reglas: nada se cambia en silencio (ni el destino, ni la versión de origen, ni una referencia que falta); un destino no disponible EXIGE una
 * decisión; la letra retenida nunca se carga sola; descartar no borra nada del historial.
 */

import type { CapabilityLocks } from '@/lib/capabilities';
import { intentKey } from '../../lib/pending-request';
import { generationFailureMessage } from '../../lib/generation-failure';
import type { DestinationChoice, HandledState, OriginMode, RecoverySession } from '@/lib/recovery-store';
import type { Generation, GenerationRecovery, RetryBody } from '@/types';
import { buildGenerationRequest, LIMITS, type SongState } from './song-model';
import { songFromGeneration, type GenerationLike, type Hydration, type HydrationNote, type InputLike, type SampleResolution } from './version-source';

/* ───────────────────────────── Qué ofrecer ───────────────────────────── */

/** Una generación fallida más vieja que esto ya no se ofrece sola al volver al creador (sigue en Perfil → Actividad). */
export const RECOVERY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const NON_MUSIC = new Set(['COVER', 'LYRICS']);
/** Las portadas y las operaciones del asistente de letras no son composiciones de música: no se recuperan. */
export const isMusicGeneration = (types: readonly string[] | undefined): boolean => !(types?.length === 1 && NON_MUSIC.has(types[0]));

/** Remix de otra persona cuyo origen ya no está autorizado: no se puede recuperar. Lo informa el servidor (`retry.reason`). */
export const REMIX_BLOCKED_REASON = 'REMIX_ORIGIN_BLOCKED';
export const isRemixBlocked = (g: Pick<Generation, 'retry'>): boolean => g.retry?.reason === REMIX_BLOCKED_REASON;

/** Pantalla de bloqueo (texto acordado). */
export const REMIX_BLOCKED_TITLE = 'Este Remix ya no se puede recuperar';
export const REMIX_BLOCKED_DESCRIPTION = 'La canción original o la versión utilizada ya no está disponible para Remix. Para respetar los permisos del autor, esta generación no puede recuperarse.';
export const REMIX_BLOCKED_DISCARDED = 'También descartamos la composición que estabas editando a partir de ese Remix.';

/** Título que muestra Mi actividad para una generación. En un Remix bloqueado no se muestra ninguno: el título sugerido era el de la canción original. */
export const activityTitleOf = (g: Pick<Generation, 'retry' | 'requestedTitle'> & { song?: { title: string } | null }): string | null =>
  isRemixBlocked(g) ? null : (g.song?.title || g.requestedTitle || null);

/** ¿Se puede ofrecer «Recuperar» de esta fila del historial? Solo FAILED (no CANCELED), de música, sin reintento posterior y sin Remix bloqueado. */
export function canRecoverFromHistory(g: Pick<Generation, 'status' | 'generationTypes' | 'retriedBy' | 'retry'>): boolean {
  return g.status === 'FAILED' && !g.retriedBy && isMusicGeneration(g.generationTypes) && !isRemixBlocked(g);
}

/**
 * Qué generación ofrecer al entrar al creador (`items`: las más recientes, de la más nueva a la más vieja). Solo se mira la MÁS RECIENTE
 * que cuenta: si lo último que hizo el usuario fue crear otra cosa (en curso, terminada), ya siguió adelante y no se le insiste.
 * Se ignoran las canceladas y lo que no es música. Una ya atendida (recuperada, descartada o reintentada) no vuelve a aparecer.
 */
export function pickRecoveryCandidate(
  items: readonly Generation[],
  handled: Readonly<Record<string, { state: HandledState }>>,
  now: number,
): Generation | null {
  for (const g of items) {
    if (g.status === 'CANCELED' || !isMusicGeneration(g.generationTypes)) continue;
    if (g.status !== 'FAILED') return null; // lo último fue otra cosa
    if (g.retriedBy || handled[g.id] || isRemixBlocked(g)) return null; // un Remix bloqueado no se ofrece
    const age = now - Date.parse(g.createdAt);
    if (Number.isFinite(age) && age > RECOVERY_WINDOW_MS) return null;
    return g;
  }
  return null;
}

export const bannerMessage = (g: Pick<Generation, 'error'>): string => generationFailureMessage(g.error);

/* ───────────────────────────── Planetas ───────────────────────────── */

const MISSING_TEXT: Record<string, (what: string) => string> = {
  SAMPLE_DELETED: (what) => `${what} que usaste ya no existe: no la cargamos.`,
  SAMPLE_IN_TRASH: (what) => `${what} que usaste está en la Papelera: restauralo desde tu biblioteca o elegí otro.`,
  FILE_UNAVAILABLE: (what) => `El archivo de ${what.toLowerCase()} ya no está disponible: elegí otro.`,
  VOICE_NOT_READY: () => 'Tu voz todavía no está lista para cantar: terminá de crearla o elegí otra.',
  VOICE_EXPIRED: () => 'Tu voz clonada caducó: no la cargamos. Podés recrearla con tu grabación original.',
  LYRIC_PERSONA_UNAVAILABLE: () => 'El letrista que usaste ya no está disponible.',
};

/** Lo que el servidor informa como faltante (`missing`), como avisos del creador. El resto de la composición se conserva. */
export function missingNotes(recovery: Pick<GenerationRecovery, 'missing'>): HydrationNote[] {
  return recovery.missing.map((m, n) => {
    const isVoice = m.field === 'VOICE_SAMPLE';
    const what = isVoice ? 'La voz' : m.field === 'REFERENCE_SAMPLE' ? 'El audio de referencia' : 'Un dato';
    const text = (MISSING_TEXT[m.reason] ?? (() => `${what} ya no está disponible.`))(what);
    return {
      id: `missing-${m.field}-${m.reason}-${n}`,
      tone: 'warning',
      text,
      planet: isVoice ? 'voice' : m.field === 'REFERENCE_SAMPLE' ? 'reference' : undefined,
      ...(m.reason === 'VOICE_EXPIRED' && m.sampleId ? { action: 'recreate-voice' as const, sampleId: m.sampleId } : {}),
    };
  });
}

// Los avisos sobre el destino los explica la tarjeta de decisión: no se repiten como notas sueltas.
const TARGET_NOTE_CODES = new Set(['TARGET_UNAVAILABLE', 'REMIX_ORIGIN_UNAVAILABLE']);
const INFO_NOTE_CODES = new Set(['AI_LYRICS_REUSED', 'LYRICS_INPUT_NOT_NEEDED', 'AI_LYRICS_REGENERATE', 'COVER_AUDIO_NOT_AVAILABLE']);

/** Avisos del servidor (`notes`) como avisos del creador. El texto lo redacta el servidor y es público. */
export function serverNotes(recovery: Pick<GenerationRecovery, 'notes'>): HydrationNote[] {
  return recovery.notes
    .filter((n) => !TARGET_NOTE_CODES.has(n.code) && typeof n.text === 'string' && n.text.trim())
    .map((n, i) => ({ id: `server-${n.code}-${n.field ?? i}`, tone: INFO_NOTE_CODES.has(n.code) ? 'info' as const : 'warning' as const, text: n.text }));
}

/** Los inputs del servidor como lo que entiende la reconstrucción de «Otra versión» (misma forma que un `GenerationInput`). */
export function inputsOfRecovery(recovery: Pick<GenerationRecovery, 'request'>): InputLike[] {
  const inputs: InputLike[] = recovery.request.inputs.map((i) => ({ field: i.field, text: i.text ?? null, value: i.value, sampleId: i.sampleId ?? null }));
  if (recovery.request.options?.instrumental === true) inputs.push({ field: 'INSTRUMENTAL', value: true }); // el servidor lo declara en las opciones
  return inputs;
}

/** Forma que `sampleIdsOf` espera para resolver voz y referencia por id. */
export const generationLikeOfRecovery = (recovery: Pick<GenerationRecovery, 'request'>): GenerationLike => ({ inputs: inputsOfRecovery(recovery), jobs: [] });

/**
 * Reconstruye los planetas desde la solicitud del servidor. Reutiliza la misma reconstrucción que «Otra versión» (misma lectura de inputs,
 * mismas reglas de planes y de muestras) y suma lo que solo sabe el contrato de recuperación: faltantes, avisos del servidor, el título, el
 * proyecto y la decisión sobre una letra retenida.
 */
export function songFromRecovery(args: {
  recovery: GenerationRecovery;
  voice: SampleResolution | null;
  reference: SampleResolution | null;
  locks?: CapabilityLocks;
  heldDecision?: 'KEEP' | 'DROP' | null;
}): Hydration {
  const { recovery, locks } = args;
  const options = recovery.request.options ?? {};
  const instrumental = options.instrumental === true;
  const inputs = inputsOfRecovery(recovery);
  const hasLyrics = inputs.some((i) => i.field === 'LYRICS' && typeof i.text === 'string' && i.text.trim());
  // El servidor sabe si había paso de letras: se declara con un job para que la reconstrucción no dude entre idea y letra.
  const jobs = !instrumental && !hasLyrics && options.generateLyricsIfMissing ? [{ task: 'LYRICS' }] : [];
  const base = songFromGeneration({ generation: { inputs, jobs }, voice: args.voice, reference: args.reference, locks });

  let song: SongState = base.song;
  const composition = { ...song.composition };
  composition.mode = instrumental ? 'instrumental' : hasLyrics ? 'lyrics' : 'idea'; // el contrato lo declara: nunca «sin determinar»
  if (typeof recovery.request.title === 'string' && recovery.request.title.trim()) {
    composition.title = recovery.request.title.slice(0, LIMITS.title);
    composition.titleFromLyrics = false;
  }
  const held = recovery.held.find((h) => h.field === 'LYRICS');
  if (held && args.heldDecision === 'KEEP' && !instrumental) {
    composition.mode = 'lyrics';
    composition.lyrics = held.text.slice(0, LIMITS.lyrics);
  }
  song = { ...song, composition, projectId: recovery.request.projectId || 'none' };

  const notes = [
    ...base.notes.filter((n) => n.id !== 'mode-undetermined' && n.id !== 'unsupported-inputs'),
    ...missingNotes(recovery),
    ...serverNotes(recovery),
  ];
  return { song, notes, source: 'generation', samples: base.samples };
}

/* ───────────────────────────── Destino ───────────────────────────── */

export type DecisionOption = 'RESTORE' | 'NEW_SONG' | 'OTHER_ORIGIN';

export interface TargetDecision {
  /** El destino original ya no está disponible: hay que decidir (no se elige solo). */
  needsDecision: boolean;
  summary: string;
  options: DecisionOption[];
  /** «Otra versión» en la Papelera: se puede restaurar y seguir. */
  canRestore: boolean;
}

const REMIX_REASON_TEXT: Record<string, string> = {
  NOT_AVAILABLE: 'La canción original ya no está disponible para remixar.',
  NOT_ALLOWED: 'Su autor dejó de permitir remixes de esa canción.',
  VERSION_NOT_CURRENT: 'La versión que habías elegido ya no es la vigente.',
  VERSION_UNAVAILABLE: 'La versión que habías elegido ya no está disponible.',
  AUDIO_UNAVAILABLE: 'El audio de la versión original ya no está disponible.',
  AUDIO_TOO_LONG: 'El audio original es demasiado largo para versionarlo.',
};

export function describeTarget(recovery: Pick<GenerationRecovery, 'target' | 'destinationOptions'>): TargetDecision {
  const { target } = recovery;
  if (target.status !== 'UNAVAILABLE') {
    const summary = target.kind === 'NEW_VERSION' ? 'Se va a agregar como otra versión de la misma canción.'
      : target.kind === 'REMIX' ? 'Se va a crear como un remix, con el mismo origen que antes.'
        : 'Se va a crear como una canción nueva.';
    return { needsDecision: false, summary, options: [], canRestore: false };
  }
  if (target.kind === 'REMIX') {
    const why = REMIX_REASON_TEXT[target.reason ?? ''] ?? 'La canción original ya no está disponible.';
    return { needsDecision: true, summary: `${why} Podés crear una canción nueva con tus ajustes (sin su audio ni su atribución) o elegir otro origen.`, options: ['NEW_SONG', 'OTHER_ORIGIN'], canRestore: false };
  }
  const canRestore = target.reason === 'TRASHED' && recovery.destinationOptions.includes('RESTORE');
  const why = target.reason === 'TRASHED' ? 'La canción a la que ibas a agregar esta versión está en la Papelera.' : 'La canción a la que ibas a agregar esta versión ya no está disponible.';
  return { needsDecision: true, summary: `${why} ${canRestore ? 'Podés restaurarla o crear una canción nueva con tus ajustes.' : 'Podés crear una canción nueva con tus ajustes.'}`, options: canRestore ? ['RESTORE', 'NEW_SONG'] : ['NEW_SONG'], canRestore };
}

/**
 * A dónde se enviaría ahora: lo que el usuario eligió, o el destino original si sigue disponible. `null` = falta decidir (destino no disponible
 * sin elección): NUNCA se convierte sola en canción nueva.
 */
export function effectiveDestination(session: Pick<RecoverySession, 'destination'>, recovery: Pick<GenerationRecovery, 'target'> | null): DestinationChoice | null {
  if (session.destination) return session.destination;
  if (!recovery) return null;
  return recovery.target.status === 'UNAVAILABLE' ? null : 'SAME';
}

/** Por qué todavía no se puede enviar (texto para el usuario) o `null` si se puede. */
export function recoveryBlockedReason(args: {
  session: RecoverySession;
  recovery: GenerationRecovery | null;
  loading: boolean;
  failed: boolean;
}): string | null {
  const { session, recovery } = args;
  if (args.failed) return 'No pudimos recuperar esta composición: revisá el aviso de arriba.';
  if (args.loading || !recovery) return 'Estamos recuperando tu composición…';
  if (session.needsApply) return 'Estamos cargando tu composición…';
  const dest = effectiveDestination(session, recovery);
  if (dest === null) return 'Elegí qué hacer con el destino de tu canción (arriba).';
  if (dest === 'OTHER_ORIGIN' && !session.otherOrigin) return 'Elegí el otro origen del remix (arriba).';
  if (recovery.held.length > 0 && session.heldDecision === null) return 'Decidí qué hacer con la letra retenida (arriba).';
  return null;
}

/* ───────────────────────────── Pedido a enviar ───────────────────────────── */

export type RecoverySubmit =
  | { kind: 'RETRY'; endpoint: 'POST /generations/:id/retry'; intent: string; generationId: string; body: RetryBody }
  | { kind: 'PLAIN'; endpoint: 'POST /generations'; intent: string; body: Record<string, unknown> }
  | { kind: 'BLOCKED'; reason: string };

const modeOf = (m: string | null | undefined): OriginMode => (m === 'COVER' ? 'COVER' : 'PROMPT_REUSE');

/**
 * Arma lo que se envía.
 *  • Reintento enlazado (`POST /generations/:id/retry`): destino `SAME` o `NEW_SONG` (con `confirm`). `request` lleva TODO lo que el usuario ve
 *    en los planetas (reemplaza lo reconstruido: es su decisión explícita) y nunca `songId`/`remix`.
 *  • Creación normal (`POST /generations`): cuando se elige OTRO origen de remix, o cuando el reintento enlazado no está disponible y el usuario
 *    decide crearla igual. Sin vínculo con la original.
 */
/** ¿Se enviaría como reintento ENLAZADO (vinculado con la fallida)? Falso: generación independiente (otro origen, desvinculada o reintento no disponible). */
export const isLinkedRetry = (session: Pick<RecoverySession, 'detached' | 'destination'>, retryAvailable: boolean): boolean =>
  retryAvailable && !session.detached && session.destination !== 'OTHER_ORIGIN';

/** Texto del botón principal. Sin explicaciones técnicas: el reintento enlazado dice «Reintentar»; cualquier otra vía, el «Crear mi canción» de siempre. */
export function recoveryActionLabels(args: { session: Pick<RecoverySession, 'detached' | 'destination'>; retryAvailable: boolean }): { label: string } {
  return { label: isLinkedRetry(args.session, args.retryAvailable) ? 'Reintentar esta canción' : 'Crear mi canción' };
}

export function buildRecoverySubmit(args: { song: SongState; recovery: GenerationRecovery; session: RecoverySession; retryAvailable: boolean }): RecoverySubmit {
  const { song, recovery, session, retryAvailable } = args;
  const dest = effectiveDestination(session, recovery);
  if (dest === null) return { kind: 'BLOCKED', reason: 'Falta decidir el destino de la canción.' };
  const { target } = recovery;

  if (dest === 'OTHER_ORIGIN') {
    const other = session.otherOrigin;
    if (!other) return { kind: 'BLOCKED', reason: 'Falta elegir el otro origen del remix.' };
    const req = buildGenerationRequest({ ...song, remix: { mode: other.mode } }, { remix: { songId: other.songId, ...(other.versionId ? { versionId: other.versionId } : {}) } });
    return { kind: 'PLAIN', endpoint: 'POST /generations', intent: intentKey({ remixSongId: other.songId, remixMode: other.mode }), body: { ...req } };
  }

  const keepRemix = dest === 'SAME' && target.kind === 'REMIX' && target.remix;
  const keepVersion = dest === 'SAME' && target.kind === 'NEW_VERSION' && target.songId;
  const effective: SongState = { ...song, remix: keepRemix ? { mode: modeOf(target.remix?.mode) } : null };

  if (!retryAvailable || session.detached) {
    if (keepRemix && target.remix) {
      const req = buildGenerationRequest(effective, { remix: { songId: target.remix.songId, ...(target.remix.versionId ? { versionId: target.remix.versionId } : {}) } });
      return { kind: 'PLAIN', endpoint: 'POST /generations', intent: intentKey({ remixSongId: target.remix.songId, remixMode: modeOf(target.remix.mode) }), body: { ...req } };
    }
    if (keepVersion && target.songId) {
      const req = buildGenerationRequest(effective, { versionOfId: target.songId });
      return { kind: 'PLAIN', endpoint: 'POST /generations', intent: intentKey({ versionOfId: target.songId }), body: { ...req, songId: target.songId } };
    }
    return { kind: 'PLAIN', endpoint: 'POST /generations', intent: intentKey({}), body: { ...buildGenerationRequest(effective) } };
  }

  const req = buildGenerationRequest(effective, { versionOfId: keepVersion ? target.songId : null });
  const request: NonNullable<RetryBody['request']> = { inputs: req.inputs, options: req.options, ...(req.title ? { title: req.title } : {}), ...(req.projectId ? { projectId: req.projectId } : {}) };
  const destination: NonNullable<RetryBody['destination']> =
    dest === 'NEW_SONG' ? (target.kind === 'NEW_SONG' ? { kind: 'NEW_SONG' } : { kind: 'NEW_SONG', confirm: true }) : { kind: 'SAME' };
  const body: RetryBody = { request, destination, ...(session.regenerateLyrics ? { regenerateLyrics: true } : {}) };
  return { kind: 'RETRY', endpoint: 'POST /generations/:id/retry', intent: intentKey({ retryOfId: recovery.generationId }), generationId: recovery.generationId, body };
}

/* ───────────────────────────── Rechazos del reintento ───────────────────────────── */

export type RetryFailure =
  | { kind: 'DISABLED' }
  | { kind: 'ALREADY_RETRIED'; retriedBy: string | null }
  | { kind: 'NOT_RETRYABLE'; reason: string | null }
  | { kind: 'TARGET_CHANGED'; code: 'TARGET_UNAVAILABLE' | 'REMIX_ORIGIN_UNAVAILABLE'; reason: string | null }
  | { kind: 'OTHER' };

interface ApiErrorLike { status?: unknown; code?: unknown; details?: unknown }

/** Interpreta los rechazos propios del reintento (por forma, sin depender de la clase `ApiError`). */
export function interpretRetryError(err: unknown): RetryFailure {
  const e = (err && typeof err === 'object' ? err : {}) as ApiErrorLike;
  const d = (e.details && typeof e.details === 'object' ? e.details : {}) as { code?: unknown; reason?: unknown; retriedBy?: unknown };
  const detailsCode = typeof d.code === 'string' ? d.code : '';
  if (e.status === 404 && detailsCode === 'GENERATION_RETRY_DISABLED') return { kind: 'DISABLED' };
  if (e.status === 409 && detailsCode === 'RETRY_ALREADY_EXISTS') return { kind: 'ALREADY_RETRIED', retriedBy: typeof d.retriedBy === 'string' ? d.retriedBy : null };
  if (e.status === 409 && detailsCode === 'GENERATION_NOT_RETRYABLE') return { kind: 'NOT_RETRYABLE', reason: typeof d.reason === 'string' ? d.reason : null };
  if (e.status === 409 && (detailsCode === 'TARGET_UNAVAILABLE' || detailsCode === 'REMIX_ORIGIN_UNAVAILABLE')) {
    return { kind: 'TARGET_CHANGED', code: detailsCode, reason: typeof d.reason === 'string' ? d.reason : null };
  }
  return { kind: 'OTHER' };
}

export const RETRY_DISABLED_TEXT =
  'El reintento enlazado todavía no está disponible. Tu composición está a salvo en el editor: podés crearla ahora como una canción nueva (no se vincula con la que falló).';
export const RETRY_ALREADY_TEXT = 'Esta canción ya se había vuelto a intentar. Te mostramos ese intento.';
export const TARGET_CHANGED_TEXT = 'El destino de la canción cambió mientras la editabas. No se cobró nada: elegí de nuevo qué hacer con el destino.';

const NOT_RETRYABLE_TEXT: Record<string, string> = {
  COMPLETED: 'Esta generación ya terminó bien: no hace falta reintentarla.',
  CANCELED: 'Una generación cancelada no se recupera.',
  STILL_ACTIVE: 'Esta generación todavía está en curso.',
  OUTCOME_UNCERTAIN: 'Todavía estamos confirmando el resultado de esta generación. Probá de nuevo más tarde.',
  NOT_MUSIC: 'Esta generación no es una canción.',
};
export const notRetryableText = (reason: string | null): string => (reason && NOT_RETRYABLE_TEXT[reason]) || 'Esta generación ya no se puede recuperar.';

/* ───────────────────────────── Letra retenida (decisión explícita) ───────────────────────────── */

/** El usuario decidió conservar la letra retenida: pasa al planeta de letra tal cual (nunca se carga sola). */
export const withHeldLyrics = (song: SongState, text: string): SongState => ({
  ...song,
  composition: { ...song.composition, mode: 'lyrics', lyrics: text.slice(0, LIMITS.lyrics) },
});

/** El usuario decidió descartarla: solo se quita si el editor todavía tiene exactamente esa letra. */
export const withoutHeldLyrics = (song: SongState, text: string): SongState =>
  song.composition.lyrics === text.slice(0, LIMITS.lyrics)
    ? { ...song, composition: { ...song.composition, mode: 'idea', lyrics: '' } }
    : song;
