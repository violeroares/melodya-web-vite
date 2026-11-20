import type { CapabilityLocks } from '@/lib/capabilities';
import { emptySong, MOODS, LIMITS, normalizeGenres, planetDef, type SongState, type SampleLite, type Capabilities, type PlanetId } from './song-model';

/**
 * «Otra versión»: reconstruye el estado del creador (los planetas) a partir de lo que realmente quedó guardado de la versión elegida.
 * Módulo puro (sin React ni red; testeado en tests/creator-version-source.test.mjs).
 *
 * Tres niveles de datos que no se mezclan:
 *  • Parámetros originales: los `GenerationInput` de la generación que creó la versión (`SongVersion.generationId`). Fuente fiel.
 *  • Metadatos derivados de la versión (`genre`, `lyricsText`, `lyricsSource`): respaldo parcial si no hay generación.
 *  • La canción: título y portada. No guarda parámetros.
 *
 * Reglas: no se inventan parámetros ausentes; una letra generada por IA nunca pasa a ser «letra del usuario»; el modo instrumental
 * solo se declara con evidencia suficiente; una falla temporal de consulta nunca se presenta como eliminación ni caducidad.
 */

/* ───────────────────────────── Tipos ───────────────────────────── */

export interface InputLike { field: string; value?: unknown; text?: string | null; sampleId?: string | null }
export interface JobLike { task?: string }
export interface GenerationLike { inputs?: InputLike[] | null; jobs?: JobLike[] | null }
export interface VersionLike {
  id: string;
  versionNumber: number;
  generationId: string | null;
  title?: string | null;
  genre?: string | null;
  lyricsText?: string | null;
  lyricsSource?: 'USER' | 'AI' | 'AI_EDITED' | null;
  createdAt?: string;
  coverUrl?: string | null;
}
export interface SampleRecord {
  id: string;
  name: string;
  kind: string;
  type?: string;
  durationSec?: number | null;
  sunoPersonaId?: string | null;
  sunoPersonaModel?: string | null;
}

/** Resultado de buscar UNA muestra por su id (nunca dentro de una lista paginada). */
export type SampleLookup =
  | { state: 'loading' }
  | { state: 'found'; sample: SampleRecord }
  | { state: 'not-found' } // 404: no existe, no es del usuario o está en la Papelera (el backend no lo distingue)
  | { state: 'error' }; // red, timeout o 5xx: temporal, no dice nada sobre la muestra

/** Disponibilidad de una voz clonada (solo aplica a `voice_persona`). */
export type VoiceCheck =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'available' }
  | { state: 'expired' }
  | { state: 'unknown' }; // `available: null` o fallo de la consulta: NO es caducada

export type SampleRole = 'voice' | 'reference';

export type SampleResolution =
  | { status: 'loading' }
  | { status: 'ok'; sample: SampleRecord }
  | { status: 'unverifiable'; sample: SampleRecord } // existe, pero no se pudo comprobar la voz: se carga y el servidor decide
  | { status: 'removed' } // el input ya no apunta a ninguna muestra (borrada para siempre)
  | { status: 'unavailable' } // 404 al pedirla por id
  | { status: 'incompatible'; sample: SampleRecord; reason: string }
  | { status: 'expired'; sample: SampleRecord }
  | { status: 'error'; sampleId: string }; // falla temporal de consulta: se puede reintentar

export type NoteAction = 'retry' | 'recreate-voice';
export interface HydrationNote {
  id: string;
  tone: 'info' | 'warning';
  text: string;
  planet?: PlanetId;
  action?: NoteAction;
  /** Muestra a la que se refiere (para recrear la voz). */
  sampleId?: string;
}

export type SourceKind = 'generation' | 'version' | 'blank';

export interface Hydration {
  song: SongState;
  notes: HydrationNote[];
  /** De dónde salieron los datos: `generation` (completo), `version` (parcial) o `blank` (nada recuperable / en blanco). */
  source: SourceKind;
  /** Muestras recuperadas por id que el creador debe poder mostrar aunque no estén en la primera página de sus listas. */
  samples: SampleRecord[];
}

/* ───────────────────────────── Muestras ───────────────────────────── */

export function resolveSample(args: { role: SampleRole; sampleId: string | null | undefined; lookup: SampleLookup; check?: VoiceCheck }): SampleResolution {
  const { role, sampleId, lookup } = args;
  const check = args.check ?? { state: 'idle' };
  if (!sampleId) return { status: 'removed' };
  if (lookup.state === 'loading') return { status: 'loading' };
  if (lookup.state === 'error') return { status: 'error', sampleId };
  if (lookup.state === 'not-found') return { status: 'unavailable' };
  const sample = lookup.sample;

  if (role === 'reference') {
    // El selector de «Referencia de audio» solo ofrece muestras de instrumento: lo demás no se podría mostrar ni cambiar.
    if (sample.kind !== 'INSTRUMENT') return { status: 'incompatible', sample, reason: 'no es un audio de referencia' };
    return { status: 'ok', sample };
  }

  if (sample.kind !== 'VOICE') return { status: 'incompatible', sample, reason: 'no es una voz' };
  if (!sample.sunoPersonaId) return { status: 'incompatible', sample, reason: 'todavía no está lista para cantar' };
  // La caducidad solo existe para voces clonadas de Suno Voice; con otro modelo no hay nada que comprobar.
  if (sample.sunoPersonaModel !== 'voice_persona') return { status: 'ok', sample };
  if (check.state === 'loading' || check.state === 'idle') return { status: 'loading' };
  if (check.state === 'expired') return { status: 'expired', sample };
  if (check.state === 'unknown') return { status: 'unverifiable', sample };
  return { status: 'ok', sample };
}

export const isResolving = (r: SampleResolution | null | undefined): boolean => r?.status === 'loading';

/** Une las muestras de las listas del creador con las recuperadas por id, sin duplicar (la lista manda en el orden). */
export function mergeSamples(listed: readonly SampleLite[], extra: readonly SampleLite[]): SampleLite[] {
  const seen = new Set(listed.map((s) => s.id));
  return [...listed, ...extra.filter((s) => !seen.has(s.id))];
}

/** Las muestras recuperadas por id, vistas como lo que el creador espera en sus capacidades. */
export function mergeCapabilities(listed: Capabilities, resolved: readonly SampleRecord[]): Capabilities {
  const voices = resolved.filter((s) => s.kind === 'VOICE' && s.sunoPersonaId).map(toLite);
  const references = resolved.filter((s) => s.kind === 'INSTRUMENT').map(toLite);
  return { voices: mergeSamples(listed.voices, voices), references: mergeSamples(listed.references, references) };
}

const toLite = (s: SampleRecord): SampleLite => ({ id: s.id, name: s.name, type: s.type, sunoPersonaId: s.sunoPersonaId ?? null, durationSec: s.durationSec ?? null });

/* ───────────────────────────── Lectura de inputs ───────────────────────────── */

const HANDLED_FIELDS = new Set([
  'IDEA', 'THEME', 'GENRE', 'STYLE_DESCRIPTION', 'LYRICS', 'DURATION_SECONDS', 'VOCAL_GENDER', 'NEGATIVE_TAGS',
  'STYLE_WEIGHT', 'WEIRDNESS', 'VARIETY', 'AUDIO_WEIGHT', 'REFERENCE_SAMPLE', 'VOICE_SAMPLE',
  'INSTRUMENTAL', 'PERSONA_ID', // internos: el servidor los escribe a partir de las opciones y de la voz; no son datos del usuario
]);

const inputOf = (inputs: readonly InputLike[], field: string): InputLike | undefined => inputs.find((i) => i.field === field);
const textOf = (i?: InputLike): string => (typeof i?.text === 'string' ? i.text : '');
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v.trim() ? [v] : []);
const unit = (v: unknown): number | null => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && n >= 0 && n <= 1 ? n : null; };

/** Modo de composición según la evidencia disponible. `undetermined` = no hay base para afirmar «instrumental». */
export function compositionModeOf(inputs: readonly InputLike[], jobs: readonly JobLike[] | null | undefined): 'idea' | 'lyrics' | 'instrumental' | 'undetermined' {
  if (inputOf(inputs, 'LYRICS')) return 'lyrics';
  if (inputOf(inputs, 'INSTRUMENTAL')?.value === true) return 'instrumental'; // lo ve solo un administrador
  // Entradas que el servidor rechaza en un instrumental: si están, no lo era.
  if (['THEME', 'VOCAL_GENDER', 'VOICE_SAMPLE'].some((f) => inputOf(inputs, f))) return 'idea';
  if (jobs?.some((j) => j.task === 'LYRICS')) return 'idea'; // Melodya escribió la letra: se partió de una idea
  return 'undetermined';
}

/* ───────────────────────────── Reconstrucción ───────────────────────────── */

/** Texto de THEME → temática: un id conocido es esa temática; cualquier otro texto es «Otra cosa» con su contenido. */
export function moodFromTheme(text: string): { mood: string; moodCustom: string } {
  const t = text.trim();
  if (!t) return { mood: '', moodCustom: '' };
  const preset = MOODS.find((m) => m.id !== 'libre' && m.id === t);
  return preset ? { mood: preset.id, moodCustom: '' } : { mood: 'libre', moodCustom: t.slice(0, LIMITS.theme) };
}

const planetLockedNote = (id: PlanetId): HydrationNote => ({
  id: `locked-${id}`, tone: 'warning', planet: id,
  text: `Tu plan actual no incluye «${planetDef(id).label}»: no lo cargamos.`,
});

function sampleNote(role: SampleRole, r: SampleResolution, planet: PlanetId): HydrationNote | null {
  const what = role === 'voice' ? 'La voz' : 'El audio de referencia';
  switch (r.status) {
    case 'ok':
    case 'loading':
      return null;
    case 'removed':
      return { id: `${role}-removed`, tone: 'warning', planet, text: `${what} que se usó en esa versión se eliminó: no la cargamos.` };
    case 'unavailable':
      return { id: `${role}-unavailable`, tone: 'warning', planet, text: `${what} que se usó en esa versión ya no está disponible (puede estar en la Papelera o haberse eliminado): no la cargamos.` };
    case 'incompatible':
      return { id: `${role}-incompatible`, tone: 'warning', planet, text: `${what} “${r.sample.name}” ya no se puede usar acá (${r.reason}): no la cargamos.` };
    case 'expired':
      return { id: `${role}-expired`, tone: 'warning', planet, action: 'recreate-voice', sampleId: r.sample.id, text: `Tu voz “${r.sample.name}” caducó: no la cargamos. Podés recrearla.` };
    case 'unverifiable':
      return { id: `${role}-unverifiable`, tone: 'info', planet, text: `No pudimos comprobar si tu voz “${r.sample.name}” sigue disponible. La cargamos y lo confirmamos al crear la canción.` };
    case 'error':
      return { id: `${role}-error`, tone: 'warning', planet, action: 'retry', sampleId: r.sampleId, text: `No pudimos consultar ${role === 'voice' ? 'la voz' : 'el audio de referencia'} por un problema temporal. No se descartó: reintentá.` };
  }
}

/**
 * Reconstruye el estado de los planetas desde los `GenerationInput` de la generación original. No inventa nada: un planeta
 * opcional solo aparece si hay datos suyos, y lo que el plan no incluye o ya no se puede usar se informa en `notes`.
 */
export function songFromGeneration(args: {
  generation: GenerationLike;
  voice: SampleResolution | null;
  reference: SampleResolution | null;
  locks?: CapabilityLocks;
}): Hydration {
  const { generation, locks } = args;
  const inputs = generation.inputs ?? [];
  const notes: HydrationNote[] = [];
  const samples: SampleRecord[] = [];
  const mode = compositionModeOf(inputs, generation.jobs);

  const theme = moodFromTheme(textOf(inputOf(inputs, 'THEME')));
  const lyrics = textOf(inputOf(inputs, 'LYRICS'));
  let song: SongState = {
    ...emptySong,
    composition: {
      ...emptySong.composition,
      mode: mode === 'undetermined' ? 'idea' : mode,
      idea: textOf(inputOf(inputs, 'IDEA')),
      lyrics,
      mood: theme.mood,
      moodCustom: theme.moodCustom,
    },
    style: {
      genres: normalizeGenres(stringList(inputOf(inputs, 'GENRE')?.value)),
      description: textOf(inputOf(inputs, 'STYLE_DESCRIPTION')),
    },
    planets: [],
  };
  if (mode === 'undetermined') {
    notes.push({ id: 'mode-undetermined', tone: 'info', planet: 'composition', text: 'No pudimos saber si esa versión era instrumental. Revisá «Composición» y elegí cómo querés crear esta.' });
  }

  const planets: PlanetId[] = [];
  const optional = (id: PlanetId): boolean => {
    const why = locks?.planets[id];
    if (why) { notes.push(planetLockedNote(id)); return false; }
    return true;
  };

  // Voz: una preferencia (VOCAL_GENDER) o una voz propia (VOICE_SAMPLE). Una pieza instrumental no tiene voz.
  const gender = inputOf(inputs, 'VOCAL_GENDER')?.value;
  const voiceInput = inputOf(inputs, 'VOICE_SAMPLE');
  if (song.composition.mode !== 'instrumental' && (gender === 'female' || gender === 'male' || voiceInput)) {
    let preference: SongState['voice']['preference'] = gender === 'female' || gender === 'male' ? gender : '';
    let voiceSampleId: string | null = null;
    if (voiceInput) {
      const r = args.voice ?? { status: 'removed' as const };
      if (locks?.customVoice) {
        notes.push({ id: 'voice-locked', tone: 'warning', planet: 'voice', text: 'Tu plan actual no incluye cantar con una voz clonada: no la cargamos.' });
      } else {
        const note = sampleNote('voice', r, 'voice');
        if (note) notes.push(note);
        if (r.status === 'ok' || r.status === 'unverifiable') { voiceSampleId = r.sample.id; samples.push(r.sample); preference = ''; }
      }
    }
    if (preference || voiceSampleId) { planets.push('voice'); song.voice = { preference, voiceSampleId }; }
  }

  const refInput = inputOf(inputs, 'REFERENCE_SAMPLE');
  if (refInput && optional('reference')) {
    const r = args.reference ?? { status: 'removed' as const };
    const note = sampleNote('reference', r, 'reference');
    if (note) notes.push(note);
    if (r.status === 'ok') { planets.push('reference'); song.reference = { sampleId: r.sample.id }; samples.push(r.sample); }
  }

  const duration = Number(inputOf(inputs, 'DURATION_SECONDS')?.value);
  const avoid = stringList(inputOf(inputs, 'NEGATIVE_TAGS')?.value);
  const hasDuration = Number.isInteger(duration) && duration >= LIMITS.durationMin && duration <= LIMITS.durationMax;
  if ((hasDuration || avoid.length) && optional('production')) {
    planets.push('production');
    song.production = { durationSec: hasDuration ? String(duration) : '', avoid: avoid.join(', ') };
  }

  const styleWeight = unit(inputOf(inputs, 'STYLE_WEIGHT')?.value);
  const weirdness = unit(inputOf(inputs, 'WEIRDNESS')?.value);
  const rawVariety = inputOf(inputs, 'VARIETY')?.value;
  const variety = typeof rawVariety === 'number' && Number.isInteger(rawVariety) && rawVariety >= 0 && rawVariety <= 4 ? rawVariety : null;
  // Influencia del audio: solo se recupera si la referencia SE PUDO CARGAR (planeta de referencia presente) y la pieza no es instrumental;
  // con una referencia eliminada, vencida o incompatible el valor se descarta (el control no debe aparecer ni enviarse).
  const rawAudio = unit(inputOf(inputs, 'AUDIO_WEIGHT')?.value);
  const audioWeight = rawAudio !== null && planets.includes('reference') && song.reference.sampleId && song.composition.mode !== 'instrumental' ? Math.round(rawAudio * 100) / 100 : null;
  if ((styleWeight !== null || weirdness !== null || variety !== null || audioWeight !== null) && optional('creativity')) {
    planets.push('creativity');
    song.creativity = { styleWeight, weirdness, variety, audioWeight };
  }

  // Orden de incorporación canónico (el que usa el catálogo).
  const order: PlanetId[] = ['voice', 'reference', 'production', 'creativity'];
  song = { ...song, planets: order.filter((p) => planets.includes(p)) };

  const unsupported = [...new Set(inputs.map((i) => i.field).filter((f) => !HANDLED_FIELDS.has(f)))];
  if (unsupported.length) {
    notes.push({ id: 'unsupported-inputs', tone: 'info', text: 'Esa versión usó opciones que este creador no muestra, así que no se cargaron.' });
  }

  return { song, notes, source: 'generation', samples };
}

/**
 * Respaldo cuando no hay generación que leer (versión antigua sin `generationId`, o generación que ya no se puede consultar).
 * Solo se usa lo que la versión guardó de verdad: los géneros y, únicamente si la escribió el usuario, la letra.
 * Una letra de IA (o editada desde una de IA) NO se convierte en «tu letra»; la duración real y las etiquetas tampoco son pedidos.
 */
export function songFromVersion(version: VersionLike | null | undefined): Hydration {
  const genres = normalizeGenres(String(version?.genre ?? '').split(','));
  const userLyrics = version?.lyricsSource === 'USER' && version.lyricsText?.trim() ? version.lyricsText : '';
  const song: SongState = {
    ...emptySong,
    composition: { ...emptySong.composition, mode: userLyrics ? 'lyrics' : 'idea', lyrics: userLyrics },
    style: { genres, description: '' },
  };
  const recovered = [genres.length ? 'el estilo' : '', userLyrics ? 'tu letra' : ''].filter(Boolean).join(' y ');
  const notes: HydrationNote[] = [{
    id: 'partial-version', tone: 'info',
    text: recovered
      ? `Esa versión no guarda su configuración completa. Recuperamos solo ${recovered}; el resto lo definís vos.`
      : 'Esa versión no guarda su configuración original. Empezás con los planetas vacíos, siempre dentro de esta canción.',
  }];
  return { song, notes, source: recovered ? 'version' : 'blank', samples: [] };
}

export const blankHydration = (): Hydration => ({ song: emptySong, notes: [], source: 'blank', samples: [] });

/* ───────────────────────────── Versiones y origen ───────────────────────────── */

export const BLANK_ORIGIN = 'blank';

export interface VersionOption {
  id: string;
  versionNumber: number;
  label: string;
  isCurrent: boolean;
  /** `generationId` guardado: sin él la configuración original no se puede leer. */
  hasConfig: boolean;
  /** Número de la versión más antigua que salió del mismo pedido (dos clips de una generación), si no es esta misma. */
  sameRequestAs: number | null;
  createdAt?: string;
  genre?: string | null;
  userLyrics: boolean;
}

/** Todas las versiones de la canción, la más nueva primero, con la vigente marcada y las que comparten generación identificadas. */
export function versionOptions(versions: readonly VersionLike[], currentVersionId: string | null | undefined): VersionOption[] {
  const asc = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
  const firstOfGeneration = new Map<string, number>();
  for (const v of asc) if (v.generationId && !firstOfGeneration.has(v.generationId)) firstOfGeneration.set(v.generationId, v.versionNumber);
  return asc
    .map((v): VersionOption => {
      const first = v.generationId ? firstOfGeneration.get(v.generationId) ?? null : null;
      return {
        id: v.id,
        versionNumber: v.versionNumber,
        label: `Versión ${v.versionNumber}`,
        isCurrent: v.id === currentVersionId,
        hasConfig: Boolean(v.generationId),
        sameRequestAs: first !== null && first !== v.versionNumber ? first : null,
        createdAt: v.createdAt,
        genre: v.genre ?? null,
        userLyrics: v.lyricsSource === 'USER',
      };
    })
    .reverse();
}

/**
 * Origen elegido: `from` de la URL si es `blank` o una versión que existe; si no, la versión vigente; si no hay, `null` (sin origen).
 * Un `from` desconocido (versión borrada, enlace viejo) no rompe nada: cae a la vigente.
 */
export function resolveOrigin(args: { from: string | null | undefined; versions: readonly VersionLike[]; currentVersionId: string | null | undefined }): string | null {
  const { from, versions, currentVersionId } = args;
  if (from === BLANK_ORIGIN) return BLANK_ORIGIN;
  if (from && versions.some((v) => v.id === from)) return from;
  if (currentVersionId && versions.some((v) => v.id === currentVersionId)) return currentVersionId;
  return null;
}

/** Ids de muestras que hay que resolver por id para reconstruir esta generación. */
export function sampleIdsOf(generation: GenerationLike | null | undefined): { voice: string | null | undefined; reference: string | null | undefined; hasVoice: boolean; hasReference: boolean } {
  const inputs = generation?.inputs ?? [];
  const voice = inputOf(inputs, 'VOICE_SAMPLE');
  const reference = inputOf(inputs, 'REFERENCE_SAMPLE');
  return { voice: voice?.sampleId, reference: reference?.sampleId, hasVoice: Boolean(voice), hasReference: Boolean(reference) };
}

/** El título de una versión nueva nunca se envía: la canción conserva el suyo. Ver también `buildGenerationRequest`. */
export const lockTitle = (s: SongState): SongState =>
  s.composition.title === '' && !s.composition.titleFromLyrics ? s : { ...s, composition: { ...s.composition, title: '', titleFromLyrics: false } };
