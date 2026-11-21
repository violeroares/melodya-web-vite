import type { CapabilityLocks } from '@/lib/capabilities';
import type { RemixMode } from '@/types';

/**
 * Modelo de la canción como «sistema solar»: el centro es la canción y cada elemento que se incorpora es un planeta.
 * Este módulo es puro (sin React, sin red): define el estado, las operaciones de agregar / editar / quitar planetas, las
 * validaciones, la predicción del tratamiento y la traducción al contrato POST /generations.
 *
 * Responsabilidades:
 *  • La web expresa la intención del usuario en inputs separados y no arma texto de estilo ni elige endpoints.
 *  • El backend valida, decide customMode/endpoint y construye la solicitud a Suno (SunoProvider.planRequest).
 *  • Lo que acá se valida y predice (`validateSong`, `predictRoute`) espeja las reglas del backend para avisar ANTES de
 *    generar; la respuesta del backend (422) sigue siendo la fuente de verdad.
 *
 * Contrato vigente (ver contracts/openapi.yaml del backend): `title` en la raíz (≤80), `options.instrumental`, y los
 * inputs IDEA, GENRE, STYLE_DESCRIPTION, THEME, LYRICS, DURATION_SECONDS, VOCAL_GENDER, NEGATIVE_TAGS, STYLE_WEIGHT,
 * WEIRDNESS, VARIETY, REFERENCE_SAMPLE y VOICE_SAMPLE. No hay BPM, tonalidad ni intensidad: Suno no los admite como
 * parámetros de una canción.
 */

export type PlanetId = 'composition' | 'style' | 'voice' | 'reference' | 'production' | 'creativity';
export type CompositionMode = 'idea' | 'lyrics' | 'instrumental';

export const LIMITS = {
  idea: 2000,
  description: 1000, // STYLE_DESCRIPTION (la serie V6 admite 1000 en `style`; géneros + descripción comparten ese presupuesto)
  theme: 120,
  title: 80, // máximo de Suno: se valida, no se recorta
  lyrics: 5000, // máximo de la serie V6
  avoid: 1000, // NEGATIVE_TAGS (total)
  durationMin: 10,
  durationMax: 360,
  styleBudget: 1000, // `style` en la serie V6 (géneros + descripción)
  genres: 8, // GENRE: cantidad máxima (generation.schema.js)
  genreLength: 30, // largo máximo de cada género: el del contrato es 60, pero las etiquetas de la canción admiten 30 (buildSongTags)
  coverMaxSec: 480, // upload-cover: hasta 8 minutos
  referenceMinSec: 6, // audioUrls: de 6 s a 30 min
  referenceMaxSec: 1800,
} as const;

/** Temáticas rápidas de «Composición». `libre` abre un campo de texto (`moodCustom`). El pedido guarda el id (o el texto libre) en THEME. */
export const MOODS = [
  { id: 'amor', label: 'Amor', emoji: '💗' },
  { id: 'fiesta', label: 'Fiesta', emoji: '🎉' },
  { id: 'nostalgia', label: 'Nostalgia', emoji: '🌗' },
  { id: 'superacion', label: 'Superación', emoji: '🌱' },
  { id: 'amistad', label: 'Amistad', emoji: '🤝' },
  { id: 'libre', label: 'Otra cosa', emoji: '✍️' },
];

export interface SongState {
  composition: {
    mode: CompositionMode;
    idea: string;
    mood: string;
    moodCustom: string;
    lyrics: string;
    /** Único título de la solicitud (`title` raíz). Editable siempre. */
    title: string;
    /** true si el título lo propuso Melodya al incorporar una letra del Estudio (y el usuario no lo tocó). */
    titleFromLyrics: boolean;
  };
  style: { genres: string[]; description: string };
  /** Planetas opcionales incorporados, en orden de incorporación. */
  planets: PlanetId[];
  voice: { preference: '' | 'female' | 'male'; voiceSampleId: string | null };
  reference: { sampleId: string | null };
  production: { durationSec: string; avoid: string };
  /**
   * null = automático (no se envía un valor propio). `audioWeight` (Influencia del audio) solo existe con un audio de referencia
   * que Melodya transforma con letra (ver `audioWeightApplies`): sin él se descarta, no se envía ni se muestra.
   */
  creativity: { styleWeight: number | null; weirdness: number | null; variety: number | null; audioWeight: number | null };
  projectId: string;
  /**
   * Remix (canción NUEVA a partir de otra). `COVER` usa el audio de la canción de origen como referencia (el servidor lo firma): no hay
   * planeta de referencia y la ruta es siempre `upload-cover`, con letra o instrumental. `PROMPT_REUSE` solo reutiliza letra y estilo.
   * Nunca se guarda en el borrador: el remix vive en la URL.
   */
  remix: { mode: RemixMode } | null;
}

export interface SampleLite {
  id: string;
  name: string;
  type?: string;
  sunoPersonaId?: string | null;
  durationSec?: number | null;
  /** Cuándo se creó (ISO), para mostrarlo en la lista de voces. */
  createdAt?: string | null;
}

export interface Capabilities {
  /** Voces propias con Persona lista. */
  voices: SampleLite[];
  /** Audios de referencia disponibles (samples de instrumento). */
  references: SampleLite[];
}

export const emptySong: SongState = {
  composition: { mode: 'idea', idea: '', mood: '', moodCustom: '', lyrics: '', title: '', titleFromLyrics: false },
  style: { genres: [], description: '' },
  planets: [],
  voice: { preference: '', voiceSampleId: null },
  reference: { sampleId: null },
  production: { durationSec: '', avoid: '' },
  creativity: { styleWeight: null, weirdness: null, variety: null, audioWeight: null },
  projectId: 'none',
  remix: null,
};

/* ───────────────────────────── Catálogo de planetas ───────────────────────────── */

export interface PlanetDef {
  id: PlanetId;
  label: string;
  /** Una frase: qué aporta este elemento a la canción. */
  blurb: string;
  /** Los planetas base están siempre y no se quitan. */
  base: boolean;
}

export const PLANETS: readonly PlanetDef[] = [
  { id: 'composition', label: 'Composición', blurb: 'La idea o tu letra, el título y si lleva voz o es instrumental.', base: true },
  { id: 'style', label: 'Estilo', blurb: 'Géneros y una descripción de cómo debería sonar.', base: true },
  { id: 'voice', label: 'Voz', blurb: 'Una preferencia masculina o femenina, o tu propia voz.', base: false },
  { id: 'reference', label: 'Audio', blurb: 'Un audio tuyo como guía o para transformarlo.', base: false },
  { id: 'production', label: 'Producción', blurb: 'Duración y cosas que querés evitar.', base: false },
  { id: 'creativity', label: 'Creatividad', blurb: 'Rareza, influencia del estilo y variedad.', base: false },
];

export const planetDef = (id: PlanetId): PlanetDef => PLANETS.find((p) => p.id === id) as PlanetDef;

export interface PlanetAvailability {
  def: PlanetDef;
  present: boolean;
  /** Se puede agregar ahora. */
  available: boolean;
  /** Si no se puede agregar, por qué (visible, no solo un tooltip). */
  reason?: string;
}

/** Planetas presentes: los base y los agregados. */
export function activePlanets(s: SongState): PlanetId[] {
  return ['composition', 'style', ...s.planets];
}

export function availability(s: SongState, locks?: CapabilityLocks): PlanetAvailability[] {
  return PLANETS.filter((p) => !p.base).map((def) => {
    const present = s.planets.includes(def.id);
    // Capacidades del plan (E5): un planeta que el plan no incluye se ve, con el motivo, pero no se puede agregar.
    const locked = !present ? locks?.planets[def.id] : undefined;
    if (locked) return { def, present, available: false, reason: locked };
    // Versionar (Cover) ya usa el audio de la canción original como referencia: no se suma otro.
    if (def.id === 'reference' && s.remix?.mode === 'COVER' && !present) {
      return { def, present, available: false, reason: 'Versionar usa el audio de la canción original como referencia. Para usar otro audio, elegí «Reutilizar configuración».' };
    }
    if (def.id === 'voice' && s.composition.mode === 'instrumental' && !present) {
      return { def, present, available: false, reason: 'Una pieza instrumental no tiene voz. Cambiá la composición para usarlo.' };
    }
    return { def, present, available: !present };
  });
}

/* ───────────────────────────── Operaciones ───────────────────────────── */

/** Agrega un planeta opcional. No hace nada si ya está o no está disponible. */
export function addPlanet(s: SongState, id: PlanetId): SongState {
  const a = availability(s).find((x) => x.def.id === id);
  if (!a || !a.available) return s;
  return { ...s, planets: [...s.planets, id] };
}

/** Quita un planeta opcional y descarta su configuración (vuelve a «automático»). */
export function removePlanet(s: SongState, id: PlanetId): SongState {
  if (planetDef(id).base || !s.planets.includes(id)) return s;
  const next: SongState = { ...s, planets: s.planets.filter((p) => p !== id) };
  if (id === 'voice') next.voice = { ...emptySong.voice };
  if (id === 'reference') {
    next.reference = { ...emptySong.reference };
    next.creativity = { ...next.creativity, audioWeight: null }; // sin audio no hay influencia del audio
  }
  if (id === 'production') next.production = { ...emptySong.production };
  if (id === 'creativity') next.creativity = { ...emptySong.creativity };
  return next;
}

/** Actualiza la configuración de un planeta (parche parcial). */
export function updatePlanet<K extends 'composition' | 'style' | 'voice' | 'reference' | 'production' | 'creativity'>(
  s: SongState,
  id: K,
  patch: Partial<SongState[K]>
): SongState {
  const next: SongState = { ...s, [id]: { ...s[id], ...patch } };
  // Si el audio de referencia se vacía o se cambia por otro, la influencia del audio (que era sobre aquel audio) vuelve a automático.
  if (id === 'reference' && next.reference.sampleId !== s.reference.sampleId && next.creativity.audioWeight !== null) {
    next.creativity = { ...next.creativity, audioWeight: null };
  }
  // Escribir un título a mano lo vuelve del usuario: deja de ser «propuesto por Melodya».
  if (id === 'composition' && 'title' in (patch as object) && !('titleFromLyrics' in (patch as object))) {
    next.composition = { ...next.composition, titleFromLyrics: false };
  }
  // Una canción instrumental no tiene voz: el planeta se quita en lugar de quedar contradiciendo la composición.
  if (id === 'composition' && next.composition.mode === 'instrumental' && next.planets.includes('voice')) {
    return removePlanet(next, 'voice');
  }
  return next;
}

/**
 * Incorpora la letra (y su título) que produjo el Estudio de letras. La letra pasa a ser la del usuario. El título de la
 * letra se transfiere al creador SOLO si el usuario no había escrito uno: queda editable y es el que se envía como `title`.
 */
export function applyLyricsFromStudio(s: SongState, outcome: { lyrics: string; title?: string | null }): SongState {
  const proposed = (outcome.title ?? '').replace(/\s+/g, ' ').trim();
  const keepUser = s.composition.title.trim() !== '' && !s.composition.titleFromLyrics;
  return {
    ...s,
    composition: {
      ...s.composition,
      mode: 'lyrics',
      lyrics: outcome.lyrics,
      title: keepUser ? s.composition.title : proposed || s.composition.title,
      titleFromLyrics: keepUser ? false : Boolean(proposed),
    },
  };
}

/* ───────────────────────────── Tratamiento y validación ───────────────────────────── */

const splitList = (t: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of t.split(',')) {
    const v = raw.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
};

export function durationValue(s: SongState): number | null {
  const raw = s.production.durationSec.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

const validDuration = (d: number | null): d is number => d !== null && Number.isInteger(d) && d >= LIMITS.durationMin && d <= LIMITS.durationMax;

export function hasStyleInputs(s: SongState): boolean {
  return s.style.genres.length > 0 || s.style.description.trim().length > 0;
}

/* ───────── géneros y presupuesto del `style` ───────── */

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
/** Un género sin espacios sobrantes: «  indie   rock » → «indie rock». */
export const cleanGenre = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
/** Clave de comparación: ignora mayúsculas, acentos y espacios de más (igual criterio que el planner del backend). */
export const genreKey = (g: string): string => fold(cleanGenre(g));

export type AddGenreStatus = 'added' | 'empty' | 'duplicate' | 'too-long' | 'limit';

/** Agrega un género a la lista (sin mutar). Lo rechaza si está vacío, repetido, demasiado largo o si ya hay `LIMITS.genres`. */
export function addGenre(genres: string[], raw: string): { genres: string[]; status: AddGenreStatus } {
  const g = cleanGenre(raw);
  if (!g) return { genres, status: 'empty' };
  if (genres.some((x) => genreKey(x) === genreKey(g))) return { genres, status: 'duplicate' };
  if (g.length > LIMITS.genreLength) return { genres, status: 'too-long' };
  if (genres.length >= LIMITS.genres) return { genres, status: 'limit' };
  return { genres: [...genres, g], status: 'added' };
}

/** Lo que escribió el usuario (Enter o botón): admite varios separados por coma. Se detiene en el primero que no se pueda agregar. */
export function addGenresFromText(genres: string[], text: string): { genres: string[]; status: AddGenreStatus } {
  let next = genres;
  let status: AddGenreStatus = 'empty';
  for (const piece of text.split(',')) {
    if (!piece.trim()) continue;
    const r = addGenre(next, piece);
    next = r.genres;
    status = r.status;
    if (r.status !== 'added') break;
  }
  return { genres: next, status };
}

/** Géneros limpios y sin repetidos (misma clave que el planner: sin mayúsculas, acentos ni espacios de más). Conserva el orden. */
export function normalizeGenres(genres: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of genres) {
    const g = cleanGenre(String(raw ?? ''));
    const k = genreKey(g);
    if (!g || seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

export const removeGenre = (genres: string[], g: string): string[] => genres.filter((x) => genreKey(x) !== genreKey(g));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ¿La descripción ya nombra este género como palabra completa? (misma regla que `composeStyle` del backend). */
const namedIn = (description: string, genre: string) =>
  new RegExp(`(^|[^a-z0-9])${escapeRe(fold(genre))}($|[^a-z0-9])`).test(fold(description));

/**
 * Lo que realmente ocupa el texto de `style` que arma el planner de Suno (suno-request.js → composeStyle):
 * géneros + descripción separados por «, », sin repetir los géneros que la descripción ya nombra. Los géneros
 * omitidos igual viajan en GENRE (clasificación). La idea del planner entra solo en el espacio sobrante y se ajusta
 * a él, así que nunca puede hacer que se supere el límite y no se cuenta acá.
 */
export function styleUsage(style: SongState['style']) {
  const description = style.description.trim();
  const unique = normalizeGenres(style.genres);
  const kept = unique.filter((g) => !description || !namedIn(description, g));
  const text = [...kept, description].filter(Boolean).join(', ');
  const limit = LIMITS.styleBudget;
  return { text, used: text.length, limit, over: Math.max(0, text.length - limit), remaining: limit - text.length, omitted: unique.filter((g) => !kept.includes(g)) };
}

export const avoidList = (s: SongState): string[] => (s.planets.includes('production') ? splitList(s.production.avoid) : []);
const creativitySet = (s: SongState): boolean =>
  s.planets.includes('creativity') && (s.creativity.styleWeight !== null || s.creativity.weirdness !== null || s.creativity.variety !== null);

/**
 * ¿Aplica la Influencia del audio (`AUDIO_WEIGHT`)? Solo cuando Melodya transforma un audio de referencia con letra (`upload-cover`):
 * no con instrumental ni con el audio usado solo como guía, y no sin audio. Si se pasan las capacidades, además el audio elegido debe
 * seguir existiendo (una referencia eliminada o vencida no habilita el control).
 */
export function audioWeightApplies(s: SongState, caps?: Capabilities): boolean {
  if (s.remix?.mode === 'COVER') return true; // el audio de la canción de origen: siempre disponible para el servidor
  if (predictRoute(s).endpoint !== 'cover') return false;
  return !caps || caps.references.some((r) => r.id === s.reference.sampleId);
}

export type Route = { custom: boolean; withReference: boolean; endpoint: 'standard' | 'cover' | 'reference' };

/**
 * Predicción de cómo llegará la canción a Suno (misma lógica de elección de modo que el backend, `planSunoRequest`):
 *  • Con letra (propia o que escribe Melodya) → Custom. Instrumental → Custom si hay estilo, título o controles.
 *  • Con audio de referencia: con letra → `upload-cover` (Suno transforma el audio); sin letra (instrumental) → `/generate`
 *    con `audioUrls` (el audio es solo una guía). Los controles NUNCA cambian este endpoint: si no lo admite, es un error.
 */
export function predictRoute(s: SongState): Route {
  const coverRemix = s.remix?.mode === 'COVER';
  const withReference = coverRemix || (s.planets.includes('reference') && Boolean(s.reference.sampleId));
  const instrumental = s.composition.mode === 'instrumental';
  const controls = validDuration(durationValue(s)) || avoidList(s).length > 0 || creativitySet(s);
  const custom = instrumental ? hasStyleInputs(s) || Boolean(s.composition.title.trim()) || controls : true;
  // Versionar (Cover): `upload-cover` siempre, con letra o instrumental (señal explícita; no cambia las referencias normales).
  if (coverRemix) return { custom: true, withReference, endpoint: 'cover' };
  if (withReference) return { custom: !instrumental, withReference, endpoint: instrumental ? 'reference' : 'cover' };
  return { custom, withReference, endpoint: 'standard' };
}

/**
 * ¿La IDEA puede sumarse al final de `style`? El planner (suno-plan.js → `ideaTail`) la agrega solo en Custom sin letra, o
 * sea en instrumental cuando `predictRoute` da Custom. Entra únicamente en el espacio que dejan géneros + descripción
 * (se ajusta a él) y nunca supera el máximo: por eso el contador cuenta el estilo base y no descuenta la idea.
 */
export function ideaJoinsStyle(s: SongState): boolean {
  return s.composition.mode === 'instrumental' && s.composition.idea.trim().length > 0 && predictRoute(s).custom;
}

export type IssueSeverity = 'error' | 'warning' | 'info';
export interface Issue {
  severity: IssueSeverity;
  planet: PlanetId;
  message: string;
}

/**
 * Valida la canción contra el contrato y las capacidades reales del endpoint de Suno que se usaría. Todo lo que el
 * backend rechazaría es un error acá (no se puede crear); no hay «se va a ignorar».
 */
export function validateSong(s: SongState, caps: Capabilities, locks?: CapabilityLocks): Issue[] {
  const out: Issue[] = [];
  const add = (severity: IssueSeverity, planet: PlanetId, message: string) => out.push({ severity, planet, message });
  const c = s.composition;
  const route = predictRoute(s);

  // Capacidades del plan (E5): lo que el servidor rechazaría con 403 es un error acá (p. ej. un borrador de un plan anterior).
  if (locks) {
    for (const id of s.planets) {
      const why = locks.planets[id];
      if (why) add('error', id, `${why} Quitá este elemento para poder crear la canción.`);
    }
    if (locks.customVoice && s.planets.includes('voice') && s.voice.voiceSampleId && c.mode !== 'instrumental') add('error', 'voice', locks.customVoice);
  }

  if (c.mode === 'idea' && c.idea.trim().length < 3) add('error', 'composition', 'Contanos tu idea (al menos unas palabras).');
  if (c.mode === 'lyrics' && !c.lyrics.trim()) add('error', 'composition', 'Escribí o pegá tu letra.');
  if (c.mode === 'lyrics' && c.lyrics.length > LIMITS.lyrics) add('error', 'composition', `La letra supera los ${LIMITS.lyrics} caracteres permitidos (tiene ${c.lyrics.length}). Acortala: no se recorta sola.`);
  if (c.idea.length > LIMITS.idea) add('error', 'composition', `La idea admite hasta ${LIMITS.idea} caracteres.`);
  if (c.mode === 'instrumental' && !hasStyleInputs(s) && !c.idea.trim()) {
    add('error', 'style', 'Indicá un género, una descripción o una idea para el instrumental.');
  }
  if (c.title.trim().length > LIMITS.title) {
    add('error', 'composition', `El título admite hasta ${LIMITS.title} caracteres (tiene ${c.title.trim().length}). Acortalo: no se recorta solo.`);
  }
  if (c.title.trim() && c.titleFromLyrics) add('info', 'composition', 'Título propuesto por Melodya a partir de tu letra. Podés cambiarlo.');

  if (s.style.description.length > LIMITS.description) add('error', 'style', `La descripción admite hasta ${LIMITS.description} caracteres.`);
  if (s.style.genres.length > LIMITS.genres) add('error', 'style', `Elegiste ${s.style.genres.length} géneros y el máximo es ${LIMITS.genres}. Quitá ${s.style.genres.length - LIMITS.genres}.`);
  if (s.style.genres.some((g) => cleanGenre(g).length > LIMITS.genreLength)) add('error', 'style', `Cada género admite hasta ${LIMITS.genreLength} caracteres.`);
  const usage = styleUsage(s.style);
  if (usage.over > 0 && s.style.description.length <= LIMITS.description) {
    add('error', 'style', `Géneros y descripción suman ${usage.used} de ${usage.limit} caracteres: sobran ${usage.over}. Acortá la descripción o quitá géneros.`);
  }

  if (s.remix?.mode === 'COVER' && s.planets.includes('reference')) {
    add('error', 'reference', 'Un Cover ya usa el audio de la canción de origen como referencia. Quitá el audio de referencia.');
  }

  if (s.planets.includes('voice')) {
    const v = s.voice;
    if (v.voiceSampleId && !caps.voices.some((x) => x.id === v.voiceSampleId)) {
      add('error', 'voice', 'La voz elegida ya no está disponible o todavía no está lista. Elegí otra.');
    }
    if (v.voiceSampleId && v.preference) add('error', 'voice', 'Con tu propia voz no se puede indicar una preferencia masculina/femenina.');
    if (v.preference && route.endpoint === 'reference') add('error', 'voice', 'Con un audio de referencia usado como guía no se puede indicar preferencia vocal. Quitá la referencia o sumá tu letra.');
    if (v.voiceSampleId && route.endpoint === 'reference') add('error', 'voice', 'Tu voz necesita una canción con letra.');
    if (!v.voiceSampleId && !v.preference) add('info', 'voice', 'Sin preferencia: Melodya elige la voz.');
  }

  if (s.planets.includes('reference')) {
    if (!s.reference.sampleId) add('error', 'reference', 'Elegí un audio de referencia o quitá este elemento.');
    else if (!caps.references.some((x) => x.id === s.reference.sampleId)) add('error', 'reference', 'El audio elegido ya no está disponible.');
    else {
      // Límites documentados: «cubrir» acepta audios de hasta 8 min; la referencia en /generate, entre 6 s y 30 min.
      const dur = caps.references.find((x) => x.id === s.reference.sampleId)?.durationSec ?? null;
      if (dur !== null && route.endpoint === 'cover' && dur > LIMITS.coverMaxSec) add('error', 'reference', 'Para transformar un audio con tu letra se aceptan hasta 8 minutos. Elegí uno más corto.');
      else if (dur !== null && route.endpoint === 'reference' && (dur < LIMITS.referenceMinSec || dur > LIMITS.referenceMaxSec)) add('error', 'reference', 'Como referencia se aceptan audios de entre 6 segundos y 30 minutos.');
    }
    if (!out.some((i) => i.planet === 'reference' && i.severity === 'error')) {
      if (route.endpoint === 'cover') add('info', 'reference', 'Con letra, Melodya transforma tu audio conservando su melodía (máx. 8 min).');
      else add('info', 'reference', 'Instrumental: el audio se usa solo como guía junto a tu estilo.');
    }
  }

  const d = durationValue(s);
  if (s.planets.includes('production')) {
    if (d !== null && !validDuration(d)) add('error', 'production', `La duración debe ser un número entero de segundos entre ${LIMITS.durationMin} y ${LIMITS.durationMax}.`);
    else if (d !== null && route.withReference) {
      add('error', 'production', route.endpoint === 'cover'
        ? 'Cuando Melodya transforma un audio no se puede elegir la duración. Quitá la duración o la referencia.'
        : 'Con un audio de referencia usado como guía no se puede elegir la duración. Quitá la duración o la referencia.');
    }
    const avoid = avoidList(s);
    if (avoid.length && route.withReference) {
      add('error', 'production', route.endpoint === 'cover'
        ? 'Las exclusiones no funcionan cuando se transforma un audio de referencia. Quitá las exclusiones o la referencia.'
        : 'Con un audio de referencia usado como guía no se pueden usar exclusiones. Quitá las exclusiones o la referencia.');
    }
    if (s.production.avoid.length > LIMITS.avoid) add('error', 'production', `Lo que querés evitar admite hasta ${LIMITS.avoid} caracteres.`);
    if (d === null && !avoid.length) add('info', 'production', 'Sin duración ni exclusiones: Melodya decide la duración.');
  }

  if (s.planets.includes('creativity')) {
    const k = s.creativity;
    if (route.endpoint === 'reference' && creativitySet(s)) {
      add('error', 'creativity', 'Con un audio de referencia usado como guía no se pueden usar estos controles. Pasalos a automático, quitá la referencia o sumá tu letra.');
    }
    const audioSet = k.audioWeight !== null && audioWeightApplies(s, caps);
    if (k.styleWeight === null && k.weirdness === null && k.variety === null && !audioSet) {
      add('info', 'creativity', 'Todo en automático: se usan los valores predeterminados de Melodya.');
    }
  }
  return out;
}

export const hasErrors = (issues: Issue[]): boolean => issues.some((i) => i.severity === 'error');

/** Estado del centro: qué falta o que está lista para generar. */
export function songStatus(s: SongState, caps: Capabilities): { ready: boolean; missing: string[] } {
  const errors = validateSong(s, caps).filter((i) => i.severity === 'error');
  return { ready: errors.length === 0, missing: errors.map((e) => e.message) };
}

/* ───────────────────────────── Resumen para revisar ───────────────────────────── */

export function moodLabel(s: SongState): string {
  return s.composition.mood === 'libre' ? s.composition.moodCustom.trim() : s.composition.mood.trim();
}

/** Una línea por planeta con lo que contiene (para el centro, los planetas y la revisión). */
export function summarize(s: SongState, caps: Capabilities): Record<PlanetId, string> {
  const c = s.composition;
  const comp =
    c.mode === 'lyrics' ? `Con tu letra${c.title.trim() ? ` · «${c.title.trim()}»` : ''}` :
    c.mode === 'instrumental' ? 'Instrumental, sin voz' :
    c.idea.trim() ? `Idea: ${c.idea.trim().slice(0, 60)}${c.idea.trim().length > 60 ? '…' : ''}` : 'Sin idea todavía';
  // Estilo: el CONTENIDO real (géneros y/o texto de la descripción), no el nombre del campo. Lo usan el planeta y la revisión.
  const genres = s.style.genres.join(', ');
  const descFull = s.style.description.replace(/\s+/g, ' ').trim();
  const desc = descFull.length > 60 ? `${descFull.slice(0, 60).trimEnd()}…` : descFull;
  const style = genres && desc ? `${genres} · «${desc}»` : genres || desc || 'Sin estilo definido';
  const voice = s.voice.voiceSampleId
    ? `Tu voz: ${caps.voices.find((v) => v.id === s.voice.voiceSampleId)?.name ?? 'elegida'}`
    : s.voice.preference === 'female' ? 'Preferencia femenina' : s.voice.preference === 'male' ? 'Preferencia masculina' : 'Sin preferencia';
  const d = durationValue(s);
  const avoid = splitList(s.production.avoid);
  const prod = [d !== null && Number.isFinite(d) ? `${d} s` : '', avoid.length ? `evitar ${avoid.length}` : ''].filter(Boolean).join(' · ') || 'Automática';
  const k = s.creativity;
  const kParts = [
    k.styleWeight !== null ? `estilo ${Math.round(k.styleWeight * 100)}%` : '',
    k.weirdness !== null ? `rareza ${Math.round(k.weirdness * 100)}%` : '',
    k.variety !== null ? `variedad ${k.variety}` : '',
    k.audioWeight !== null && audioWeightApplies(s, caps) ? `audio ${Math.round(k.audioWeight * 100)}%` : '',
  ].filter(Boolean);
  return {
    composition: comp,
    style,
    voice,
    reference: caps.references.find((r) => r.id === s.reference.sampleId)?.name ?? 'Sin audio elegido',
    production: prod,
    creativity: kParts.length ? kParts.join(' · ') : 'Automática',
  };
}

/** Qué se aplica y cómo, en lenguaje llano, para la revisión final. Solo describe lo que SÍ llega a Suno. */
export function describeTreatment(s: SongState): Array<{ kind: 'applied' | 'note'; text: string }> {
  const out: Array<{ kind: 'applied' | 'note'; text: string }> = [];
  const route = predictRoute(s);
  const c = s.composition;
  if (c.mode === 'lyrics') out.push({ kind: 'applied', text: 'Tu letra se canta tal como la escribiste.' });
  if (c.mode === 'instrumental') out.push({ kind: 'applied', text: 'Se pide música sin voz.' });
  if (s.planets.includes('voice') && c.mode !== 'instrumental') {
    if (s.voice.voiceSampleId) out.push({ kind: 'applied', text: 'Se usa tu voz clonada.' });
  }
  if (route.withReference) {
    out.push({
      kind: 'applied',
      text: s.remix?.mode === 'COVER' ? 'El audio de la canción original se transforma conservando su melodía.' : route.endpoint === 'cover' ? 'Tu audio se transforma conservando su melodía.' : 'Tu audio se usa solo como guía.',
    });
  }
  if (creativitySet(s)) out.push({ kind: 'note', text: 'Los controles de creatividad se envían tal cual; su efecto sonoro depende de Melodya.' });
  return out;
}

/* ───────────────────────────── Contrato POST /generations ───────────────────────────── */

export interface RequestInput {
  field: string;
  value?: string | number | boolean | Array<string | number>;
  text?: string;
  sampleId?: string;
}

export interface GenerationRequest {
  inputs: RequestInput[];
  options: { generateLyricsIfMissing?: boolean; instrumental?: boolean };
  title?: string;
  projectId?: string;
  /** Remix: el servidor valida el permiso y, en un Cover, firma el audio de la versión de origen. */
  remix?: { songId: string; versionId?: string; mode: RemixMode };
}

/**
 * Traduce la canción al contrato real. Solo se envía lo que pertenece a un planeta presente y válido: un planeta quitado
 * no deja datos viajando. La IDEA va limpia (la temática es THEME) y solo cuando se usa: en modo «letra propia» la idea no
 * existe, aunque quede escrita de un modo anterior.
 */
export function buildGenerationRequest(s: SongState, opts: { versionOfId?: string | null; remix?: { songId: string; versionId?: string } | null } = {}): GenerationRequest {
  const c = s.composition;
  const instrumental = c.mode === 'instrumental';
  const inputs: RequestInput[] = [];

  if (c.mode !== 'lyrics' && c.idea.trim()) inputs.push({ field: 'IDEA', text: c.idea.trim() });
  if (c.mode === 'idea' && moodLabel(s)) inputs.push({ field: 'THEME', text: moodLabel(s) });
  const genres = normalizeGenres(s.style.genres); // lo mismo que cuenta styleUsage y que el planner deduplica
  if (genres.length) inputs.push({ field: 'GENRE', value: genres });
  if (s.style.description.trim()) inputs.push({ field: 'STYLE_DESCRIPTION', text: s.style.description.trim() });

  const options: GenerationRequest['options'] = {};
  if (instrumental) options.instrumental = true;
  if (c.mode === 'lyrics') inputs.push({ field: 'LYRICS', text: c.lyrics });
  if (c.mode === 'idea') options.generateLyricsIfMissing = true;

  if (s.planets.includes('voice') && !instrumental) {
    if (s.voice.voiceSampleId) inputs.push({ field: 'VOICE_SAMPLE', sampleId: s.voice.voiceSampleId });
    else if (s.voice.preference) inputs.push({ field: 'VOCAL_GENDER', value: s.voice.preference });
  }
  // En un Cover el audio es el de la canción de origen (lo agrega el servidor): nunca se envía otro REFERENCE_SAMPLE.
  if (s.planets.includes('reference') && s.reference.sampleId && s.remix?.mode !== 'COVER') {
    inputs.push({ field: 'REFERENCE_SAMPLE', sampleId: s.reference.sampleId });
  }
  if (s.planets.includes('production')) {
    const d = durationValue(s);
    if (validDuration(d)) inputs.push({ field: 'DURATION_SECONDS', value: d });
    const avoid = avoidList(s);
    if (avoid.length) inputs.push({ field: 'NEGATIVE_TAGS', value: avoid });
  }
  if (s.planets.includes('creativity')) {
    const k = s.creativity;
    if (k.styleWeight !== null) inputs.push({ field: 'STYLE_WEIGHT', value: k.styleWeight });
    if (k.weirdness !== null) inputs.push({ field: 'WEIRDNESS', value: k.weirdness });
    if (k.variety !== null) inputs.push({ field: 'VARIETY', value: k.variety });
    // Solo con una referencia que se transforma con letra; en cualquier otro caso un valor guardado NO viaja (el servidor lo rechazaría).
    if (k.audioWeight !== null && audioWeightApplies(s)) inputs.push({ field: 'AUDIO_WEIGHT', value: k.audioWeight });
  }

  const title = c.title.trim();
  return {
    inputs,
    options,
    // `title` es la única forma de enviar el título; una nueva versión de una canción no lo lleva.
    ...(title && !opts.versionOfId ? { title } : {}),
    ...(s.projectId && s.projectId !== 'none' ? { projectId: s.projectId } : {}),
    ...(opts.remix && s.remix ? { remix: { songId: opts.remix.songId, ...(opts.remix.versionId ? { versionId: opts.remix.versionId } : {}), mode: s.remix.mode } } : {}),
  };
}

/* ───────────────────────────── Persistencia del borrador ───────────────────────────── */

/**
 * Clave del borrador LEGADO (sin dueño). Ya NO se lee ni se escribe ni se borra: el creador usa `lib/draft-store.ts` (aislado por cuenta).
 * Se conserva el nombre solo para documentar la clave; recuperación manual en docs/borradores-locales.md.
 */
export const DRAFT_KEY = 'melodya.creator.solar.v1';

/** Reconstruye un estado seguro desde JSON del navegador (borradores corruptos → null; lo desconocido se ignora). */
export function parseSong(raw: unknown): SongState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SongState>;
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const num01 = (v: unknown): number | null => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
  const comp = (r.composition ?? {}) as Partial<SongState['composition']>;
  const mode: CompositionMode = comp.mode === 'lyrics' || comp.mode === 'instrumental' ? comp.mode : 'idea';
  const known: PlanetId[] = ['voice', 'reference', 'production', 'creativity'];
  const planets = (Array.isArray(r.planets) ? r.planets : []).filter((p): p is PlanetId => known.includes(p as PlanetId));
  const style = (r.style ?? {}) as Partial<SongState['style']>;
  const voice = (r.voice ?? {}) as Partial<SongState['voice']>;
  const prod = (r.production ?? {}) as Partial<SongState['production']>;
  const cr = (r.creativity ?? {}) as Partial<SongState['creativity']>;
  const variety = typeof cr.variety === 'number' && Number.isInteger(cr.variety) && cr.variety >= 0 && cr.variety <= 4 ? cr.variety : null;
  let song: SongState = {
    composition: {
      mode, idea: str(comp.idea), mood: str(comp.mood), moodCustom: str(comp.moodCustom), lyrics: str(comp.lyrics),
      title: str(comp.title), titleFromLyrics: comp.titleFromLyrics === true && str(comp.title) !== '',
    },
    style: { genres: Array.isArray(style.genres) ? normalizeGenres(style.genres.filter((g): g is string => typeof g === 'string')) : [], description: str(style.description) },
    planets: [...new Set(planets)],
    voice: { preference: voice.preference === 'female' || voice.preference === 'male' ? voice.preference : '', voiceSampleId: typeof voice.voiceSampleId === 'string' ? voice.voiceSampleId : null },
    reference: { sampleId: typeof (r.reference as { sampleId?: unknown } | undefined)?.sampleId === 'string' ? (r.reference as { sampleId: string }).sampleId : null },
    production: { durationSec: str(prod.durationSec), avoid: str(prod.avoid) },
    creativity: { styleWeight: num01(cr.styleWeight), weirdness: num01(cr.weirdness), variety, audioWeight: num01(cr.audioWeight) === null ? null : Math.round((cr.audioWeight as number) * 100) / 100 },
    projectId: str(r.projectId, 'none') || 'none',
    remix: null, // el remix vive en la URL, nunca en el borrador
  };
  if (mode === 'instrumental' && song.planets.includes('voice')) song = removePlanet(song, 'voice');
  // Un borrador sin audio de referencia no puede conservar su influencia (el planeta o el audio pudieron quitarse antes).
  if (!song.planets.includes('reference') || !song.reference.sampleId) song = { ...song, creativity: { ...song.creativity, audioWeight: null } };
  return song;
}

/** ¿Hay algo escrito que valga la pena retomar? */
export function isEmptySong(s: SongState): boolean {
  return JSON.stringify(s) === JSON.stringify(emptySong);
}
