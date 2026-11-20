/**
 * Remix: de dónde sale la configuración del creador y cómo se muestra. Lógica pura (sin React), probada con `node --test`.
 *
 *  • URL:  /create?remix=<songId>&mode=cover|prompt[&from=<versionId>]
 *      cover  → «Versionar (Cover)»: usa el AUDIO de la versión de origen como referencia (el servidor lo firma; el cliente no lo ve).
 *      prompt → «Reutilizar configuración»: reutiliza letra y estilo, sin el audio original.
 *  • Canción de OTRA persona: solo lo que la plantilla del servidor autoriza (letra, géneros, resumen de estilos, título sugerido).
 *    Variedad, rareza, influencia del estilo e influencia del audio quedan en Automático; no hay exclusiones, voces ni muestras.
 *  • Canción PROPIA: se recupera la configuración original (misma hidratación que «Otra versión») y se adapta a la modalidad.
 *  • Sin letra guardada, el creador arranca en modo instrumental y NO inventa una letra.
 */

import type { CapabilityLocks } from '@/lib/capabilities';
import type { RemixMode, RemixTemplate } from '@/types';
import { LIMITS, emptySong, normalizeGenres, type SongState } from './song-model';
import type { Hydration } from './version-source';

/* ───────────── URL ───────────── */

export const modeFromParam = (value: string | null | undefined): RemixMode => (value === 'cover' ? 'COVER' : 'PROMPT_REUSE');
export const paramFromMode = (mode: RemixMode): 'cover' | 'prompt' => (mode === 'COVER' ? 'cover' : 'prompt');

export function remixUrl(songId: string, mode: RemixMode, versionId?: string | null): string {
  const base = `/create?remix=${encodeURIComponent(songId)}&mode=${paramFromMode(mode)}`;
  return versionId ? `${base}&from=${encodeURIComponent(versionId)}` : base;
}

export const MODE_LABEL: Record<RemixMode, string> = {
  COVER: 'Versionar (Cover)',
  PROMPT_REUSE: 'Reutilizar configuración',
};

/* ───────────── Canción de otra persona: solo la plantilla ───────────── */

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export function songFromTemplate(t: RemixTemplate, mode: RemixMode): Hydration {
  const lyrics = t.lyrics && t.lyrics.trim() ? t.lyrics : null;
  const description = clip((t.styleSummary ?? '').trim() || t.tags.join(', '), LIMITS.description);
  const song: SongState = {
    ...emptySong,
    composition: {
      ...emptySong.composition,
      // Sin letra guardada ⇒ instrumental. Nunca se inventa una letra para forzar una ruta.
      mode: lyrics ? 'lyrics' : 'instrumental',
      lyrics: lyrics ? clip(lyrics, LIMITS.lyrics) : '',
      title: t.suggestedTitle,
    },
    style: { genres: normalizeGenres(t.genres), description },
    remix: { mode },
  };
  // Sin avisos propios: en el creador (sobre todo en móvil) ocupaban mucho lugar bajo el título. Lo copiado se ve en los planetas.
  return { song, notes: [], source: 'version', samples: [] };
}

/* ───────────── Canción propia: configuración original adaptada ───────────── */

/**
 * Adapta la hidratación de «Otra versión» a un remix: título propio sugerido, marca del remix y, en un Cover, sin el audio de
 * referencia original (lo reemplaza el audio de la versión de origen). La influencia del audio y la creatividad se conservan; la
 * duración y las exclusiones se descartan porque `upload-cover` no las admite (sin aviso: el planeta Producción simplemente no aparece).
 */
export function adaptOwnerHydration(h: Hydration, template: RemixTemplate | null, mode: RemixMode): Hydration {
  let notes = [...h.notes];
  let song: SongState = { ...h.song, remix: { mode } };
  if (template) song = { ...song, composition: { ...song.composition, title: template.suggestedTitle, titleFromLyrics: false } };
  // La composición sale de la VERSIÓN elegida, no del pedido original: un remix copia la letra que esa versión tiene de verdad (aunque la
  // haya escrito Melodya a partir de una idea) y, si no tiene letra, es instrumental. Así no se vuelve a pedir una letra ni se inventa una.
  // «En blanco» (origen vacío) se respeta tal cual.
  if (template && h.source !== 'blank') {
    const composition = { ...song.composition };
    if (template.lyrics && template.lyrics.trim()) {
      composition.mode = 'lyrics';
      composition.lyrics = clip(template.lyrics, LIMITS.lyrics);
    } else {
      composition.mode = 'instrumental';
      composition.lyrics = '';
    }
    song = { ...song, composition };
    notes = notes.filter((n) => n.id !== 'mode-undetermined');
    // Un instrumental no tiene voz: el planeta se quita en lugar de contradecir la composición.
    if (composition.mode === 'instrumental' && song.planets.includes('voice')) {
      song = { ...song, planets: song.planets.filter((p) => p !== 'voice'), voice: { ...emptySong.voice } };
    }
  }
  if (mode === 'COVER') {
    if (song.planets.includes('reference') || song.reference.sampleId) {
      // La referencia propia ya no aplica (se usa el audio de la versión); AUDIO_WEIGHT se conserva.
      song = { ...song, planets: song.planets.filter((p) => p !== 'reference'), reference: { ...emptySong.reference } };
    }
    if (song.planets.includes('production') && (song.production.durationSec || song.production.avoid)) {
      song = { ...song, planets: song.planets.filter((p) => p !== 'production'), production: { ...emptySong.production } };
    }
  }
  return { ...h, song, notes };
}

/* ───────────── Errores de la plantilla ───────────── */

export type RemixBlockedKind = 'not-found' | 'not-allowed' | 'not-in-plan' | 'not-current' | 'unavailable' | 'too-long' | 'error';

export function classifyTemplateError(status: number | undefined, code: string | undefined, detailsCode: string | undefined): RemixBlockedKind {
  if (status === 404) return 'not-found';
  if (status === 403) {
    // El 403 de capacidad (CAPABILITY_NOT_IN_PLAN) y el del autor (REMIX_NOT_ALLOWED) son cosas distintas: ver detailsCode.
    if (detailsCode === 'CAPABILITY_NOT_IN_PLAN') return 'not-in-plan';
    if (detailsCode === 'REMIX_NOT_ALLOWED') return 'not-allowed';
    return 'error';
  }
  if (status === 422) {
    if (detailsCode === 'REMIX_VERSION_NOT_CURRENT') return 'not-current';
    if (detailsCode === 'REMIX_AUDIO_UNAVAILABLE' || detailsCode === 'INVALID_VERSION' || detailsCode === 'REMIX_VERSION_UNAVAILABLE') return 'unavailable';
    if (detailsCode === 'REMIX_AUDIO_TOO_LONG') return 'too-long';
  }
  return 'error';
}

export const BLOCKED_TEXT: Record<RemixBlockedKind, string> = {
  'not-found': 'Esta canción no está disponible para hacer un remix.',
  'not-allowed': 'Su autor no permite hacer remixes de esta canción.',
  'not-in-plan': 'Tu plan no incluye Remix. Mejorá tu plan para crear canciones nuevas a partir de otras.',
  'not-current': 'De una canción de otra persona solo se puede hacer un remix de su versión vigente.',
  unavailable: 'La versión elegida no tiene audio disponible.',
  'too-long': 'El audio es demasiado largo para versionarlo (hasta 8 minutos). Podés reutilizar su configuración.',
  error: 'No pudimos cargar la canción por un problema temporal. Reintentá en unos segundos.',
};

/** ¿La modalidad pedida está disponible según la plantilla? (Cover depende del audio y su largo.) */
export function modeAvailability(t: RemixTemplate | null | undefined, mode: RemixMode): { ok: true } | { ok: false; kind: RemixBlockedKind } {
  if (!t) return { ok: true };
  if (mode === 'COVER' && !t.modes.COVER.available) return { ok: false, kind: t.modes.COVER.code === 'REMIX_AUDIO_TOO_LONG' ? 'too-long' : 'unavailable' };
  return { ok: true };
}

/* ───────────── Acceso por plan (capacidades EFECTIVAS; el servidor lo repite) ───────────── */

export type RemixAccess =
  | { allowed: true }
  | { allowed: false; capability: 'SONG_REMIX' | 'AUDIO_REFERENCE'; reason: string; canReusePrompt: boolean };

/**
 * ¿Puede esta persona usar la modalidad? Ambas exigen SONG_REMIX; Versionar (Cover) además AUDIO_REFERENCE (lo mismo que pide el servidor).
 * Sale de `creatorLocks` (capacidades efectivas: `enforced && !enabled`), nunca del nombre del plan. SONG_REMIX se evalúa primero.
 */
export function remixAccess(locks: CapabilityLocks, mode: RemixMode): RemixAccess {
  if (locks.remix) return { allowed: false, capability: 'SONG_REMIX', reason: locks.remix, canReusePrompt: false };
  if (mode === 'COVER' && locks.planets.reference) return { allowed: false, capability: 'AUDIO_REFERENCE', reason: locks.planets.reference, canReusePrompt: true };
  return { allowed: true };
}

/* ───────────── Menú «Remix» ───────────── */

export interface RemixMenuState {
  /** ¿Se muestra la entrada «Remix»? */
  visible: boolean;
  /** Motivo (de plan) por el que está bloqueada, si lo hay. */
  lockedReason?: string;
  /** Motivo por el que Versionar (Cover) está bloqueado aparte (necesita AUDIO_REFERENCE). */
  coverLockedReason?: string;
}

/**
 * Quién ve «Remix». El dueño, en cualquiera de sus canciones con audio. Otras personas, solo en una canción pública con
 * `allowRemix` activo y con sesión. El servidor vuelve a decidir al abrir la plantilla y al aceptar la generación.
 */
export function remixMenuState(args: {
  isOwner: boolean;
  signedIn: boolean;
  visibility: 'PUBLIC' | 'PRIVATE';
  allowRemix?: boolean;
  hasAudio: boolean;
  remixLock?: string;
  audioReferenceLock?: string;
}): RemixMenuState {
  const { isOwner, signedIn, visibility, allowRemix, hasAudio, remixLock, audioReferenceLock } = args;
  const visible = signedIn && hasAudio && (isOwner || (visibility === 'PUBLIC' && allowRemix === true));
  if (!visible) return { visible: false };
  return { visible: true, lockedReason: remixLock, coverLockedReason: remixLock ? undefined : audioReferenceLock };
}
