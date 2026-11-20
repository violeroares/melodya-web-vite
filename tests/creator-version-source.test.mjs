// «Otra versión»: reconstrucción de los planetas desde la generación original, origen elegido, muestras recuperadas por id y aislamiento.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente).
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const M = await import('../src/features/creator/song-model.ts');
const V = await import('../src/features/creator/version-source.ts');
const { emptySong, updatePlanet, addPlanet, buildGenerationRequest, validateSong, hasErrors, isEmptySong } = M;
const {
  songFromGeneration, songFromVersion, resolveSample, resolveOrigin, versionOptions, mergeCapabilities, mergeSamples, compositionModeOf,
  moodFromTheme, sampleIdsOf, lockTitle, BLANK_ORIGIN,
} = V;

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ───────── utilidades ───────── */

const noCaps = { voices: [], references: [] };
const voiceRec = { id: 'v1', name: 'Mi voz', kind: 'VOICE', type: 'VOICE', sunoPersonaId: 'persona-1', sunoPersonaModel: 'voice_persona', durationSec: 20 };
const refRec = { id: 'r1', name: 'Beatbox', kind: 'INSTRUMENT', type: 'BEATBOX', durationSec: 30 };
const found = (sample) => ({ state: 'found', sample });
const okVoice = resolveSample({ role: 'voice', sampleId: 'v1', lookup: found(voiceRec), check: { state: 'available' } });
const okRef = resolveSample({ role: 'reference', sampleId: 'r1', lookup: found(refRec) });

/** Lo que el backend guarda y entrega (`GET /generations/:id`) para un pedido hecho con `buildGenerationRequest`. */
function generationFor(song) {
  const req = buildGenerationRequest(song, { versionOfId: 'cancion-1' });
  const lyricsJob = song.composition.mode === 'idea'; // options.generateLyricsIfMissing → job LYRICS
  return {
    inputs: req.inputs.map((i, n) => ({ id: `i${n}`, source: 'USER', ...i })),
    jobs: [...(lyricsJob ? [{ task: 'LYRICS' }] : []), { task: 'MUSIC' }],
  };
}
const rebuild = (song, extra = {}) => songFromGeneration({ generation: generationFor(song), voice: null, reference: null, ...extra });

const idea = (patch = {}, base = emptySong) => updatePlanet(base, 'composition', { mode: 'idea', idea: 'Una cumbia sobre el verano', ...patch });

/* ───────── composición ───────── */

test('idea: recupera idea y temática de una lista (id de mood)', () => {
  const s = idea({ mood: 'amor' });
  const { song, notes } = rebuild(s);
  assert.equal(song.composition.mode, 'idea');
  assert.equal(song.composition.idea, 'Una cumbia sobre el verano');
  assert.equal(song.composition.mood, 'amor');
  assert.equal(song.composition.moodCustom, '');
  assert.deepEqual(notes, []);
});

test('idea: una temática libre vuelve como «Otra cosa» con su texto', () => {
  const { song } = rebuild(idea({ mood: 'libre', moodCustom: 'el primer día de clases' }));
  assert.equal(song.composition.mood, 'libre');
  assert.equal(song.composition.moodCustom, 'el primer día de clases');
  assert.deepEqual(moodFromTheme(''), { mood: '', moodCustom: '' });
});

test('letra propia: modo lyrics con su letra; el título no se carga', () => {
  const s = updatePlanet(emptySong, 'composition', { mode: 'lyrics', lyrics: '[Verse]\nHola', title: 'Mi título' });
  const { song } = rebuild(s);
  assert.equal(song.composition.mode, 'lyrics');
  assert.equal(song.composition.lyrics, '[Verse]\nHola');
  assert.equal(song.composition.title, '');
  assert.equal(song.composition.titleFromLyrics, false);
});

test('instrumental: solo con evidencia (sin letra ni job de letras, o input INSTRUMENTAL visible)', () => {
  // Sin LYRICS ni job de letras la evidencia es insuficiente: no se afirma «instrumental».
  const inst = updatePlanet(emptySong, 'composition', { mode: 'instrumental', idea: 'Piano suave' });
  const r = rebuild(inst);
  assert.equal(r.song.composition.mode, 'idea', 'no se infiere instrumental');
  assert.equal(r.song.composition.idea, 'Piano suave');
  assert.ok(r.notes.some((n) => n.id === 'mode-undetermined'));
  // Un administrador sí ve el input interno: ahí hay evidencia.
  const withFlag = { ...generationFor(inst), inputs: [...generationFor(inst).inputs, { field: 'INSTRUMENTAL', source: 'SYSTEM', value: true }] };
  const ok = songFromGeneration({ generation: withFlag, voice: null, reference: null });
  assert.equal(ok.song.composition.mode, 'instrumental');
  assert.equal(ok.notes.length, 0);
});

test('modo: lo que el servidor rechaza en un instrumental descarta esa lectura', () => {
  assert.equal(compositionModeOf([{ field: 'IDEA', text: 'x' }, { field: 'VOCAL_GENDER', value: 'male' }], [{ task: 'MUSIC' }]), 'idea');
  assert.equal(compositionModeOf([{ field: 'LYRICS', text: 'l' }], []), 'lyrics');
  assert.equal(compositionModeOf([{ field: 'IDEA', text: 'x' }], [{ task: 'LYRICS' }, { task: 'MUSIC' }]), 'idea');
  assert.equal(compositionModeOf([{ field: 'IDEA', text: 'x' }], [{ task: 'MUSIC' }]), 'undetermined');
  assert.equal(compositionModeOf([{ field: 'IDEA', text: 'x' }], undefined), 'undetermined');
});

/* ───────── estilo ───────── */

test('estilo: géneros normalizados y descripción', () => {
  const s = updatePlanet(idea(), 'style', { genres: ['Cumbia', 'Rock'], description: 'con acordeón' });
  const { song } = rebuild(s);
  assert.deepEqual(song.style.genres, ['Cumbia', 'Rock']);
  assert.equal(song.style.description, 'con acordeón');
});

/* ───────── planetas opcionales ───────── */

test('voz: preferencia femenina o masculina agrega el planeta', () => {
  const s = updatePlanet(addPlanet(idea(), 'voice'), 'voice', { preference: 'female' });
  const { song } = rebuild(s);
  assert.deepEqual(song.planets, ['voice']);
  assert.equal(song.voice.preference, 'female');
  assert.equal(song.voice.voiceSampleId, null);
});

test('voz propia recuperada por id: se carga y la muestra queda disponible para el creador', () => {
  const s = updatePlanet(addPlanet(idea(), 'voice'), 'voice', { voiceSampleId: 'v1' });
  const { song, samples, notes } = rebuild(s, { voice: okVoice });
  assert.equal(song.voice.voiceSampleId, 'v1');
  assert.deepEqual(song.planets, ['voice']);
  assert.deepEqual(samples.map((x) => x.id), ['v1']);
  assert.deepEqual(notes, []);
});

test('referencia, producción y creatividad: solo aparecen con datos y en orden canónico', () => {
  let s = idea();
  s = addPlanet(s, 'creativity'); s = updatePlanet(s, 'creativity', { styleWeight: 0.7, weirdness: 0.2, variety: 3 });
  s = addPlanet(s, 'production'); s = updatePlanet(s, 'production', { durationSec: '120', avoid: 'autotune, gritos' });
  s = addPlanet(s, 'reference'); s = updatePlanet(s, 'reference', { sampleId: 'r1' });
  const { song } = rebuild(s, { reference: okRef });
  assert.deepEqual(song.planets, ['reference', 'production', 'creativity']);
  assert.equal(song.reference.sampleId, 'r1');
  assert.deepEqual(song.production, { durationSec: '120', avoid: 'autotune, gritos' });
  assert.deepEqual(song.creativity, { styleWeight: 0.7, weirdness: 0.2, variety: 3, audioWeight: null });
});

test('no inventa parámetros: sin datos de un planeta, el planeta no se agrega', () => {
  const { song } = rebuild(updatePlanet(idea(), 'style', { genres: ['Rock'] }));
  assert.deepEqual(song.planets, []);
  assert.deepEqual(song.creativity, { styleWeight: null, weirdness: null, variety: null, audioWeight: null });
  assert.deepEqual(song.production, { durationSec: '', avoid: '' });
});

test('valores fuera de rango o con forma inesperada se descartan', () => {
  const g = { inputs: [{ field: 'IDEA', text: 'x' }, { field: 'STYLE_WEIGHT', value: 7 }, { field: 'VARIETY', value: 2.5 }, { field: 'DURATION_SECONDS', value: 5 }], jobs: [{ task: 'LYRICS' }] };
  const { song } = songFromGeneration({ generation: g, voice: null, reference: null });
  assert.deepEqual(song.planets, []);
});

test('inputs que el creador no maneja se informan y no se cargan', () => {
  const g = { inputs: [{ field: 'IDEA', text: 'x' }, { field: 'STRUCTURE', value: ['intro'] }, { field: 'PERSONA_ID', source: 'SYSTEM', value: { personaId: 'p' } }], jobs: [{ task: 'LYRICS' }] };
  const { notes } = songFromGeneration({ generation: g, voice: null, reference: null });
  assert.equal(notes.filter((n) => n.id === 'unsupported-inputs').length, 1);
  // PERSONA_ID es interno: no cuenta como «opción desconocida»
  const only = songFromGeneration({ generation: { inputs: [{ field: 'IDEA', text: 'x' }, { field: 'PERSONA_ID', value: {} }], jobs: [{ task: 'LYRICS' }] }, voice: null, reference: null });
  assert.equal(only.notes.length, 0);
});

/* ───────── capacidades del plan ───────── */

test('plan: los planetas que no incluye no se cargan y se explica', () => {
  let s = idea();
  s = addPlanet(s, 'production'); s = updatePlanet(s, 'production', { durationSec: '90' });
  s = addPlanet(s, 'creativity'); s = updatePlanet(s, 'creativity', { variety: 1 });
  const locks = { planets: { production: 'x', creativity: 'y' } };
  const { song, notes } = rebuild(s, { locks });
  assert.deepEqual(song.planets, []);
  assert.deepEqual(notes.map((n) => n.id).sort(), ['locked-creativity', 'locked-production']);
});

test('plan: sin cantar con voz clonada no se carga la voz, pero sí la preferencia de género', () => {
  const s = updatePlanet(addPlanet(idea(), 'voice'), 'voice', { voiceSampleId: 'v1' });
  const r = rebuild(s, { voice: okVoice, locks: { planets: {}, customVoice: 'No incluido' } });
  assert.deepEqual(r.song.planets, []);
  assert.ok(r.notes.some((n) => n.id === 'voice-locked'));
  const withGender = { inputs: [{ field: 'IDEA', text: 'x' }, { field: 'VOCAL_GENDER', value: 'male' }], jobs: [{ task: 'LYRICS' }] };
  const g = songFromGeneration({ generation: withGender, voice: null, reference: null, locks: { planets: {}, customVoice: 'No incluido' } });
  assert.deepEqual(g.song.planets, ['voice']);
});

/* ───────── muestras por id ───────── */

test('muestra fuera de la primera página: recuperada por id, no es un error de validación', () => {
  const listed = { voices: [{ id: 'otra', name: 'Otra', sunoPersonaId: 'p' }], references: [] }; // la lista paginada NO incluye v1 ni r1
  const s = updatePlanet(updatePlanet(addPlanet(addPlanet(idea(), 'voice'), 'reference'), 'voice', { voiceSampleId: 'v1' }), 'reference', { sampleId: 'r1' });
  const { song, samples } = rebuild(s, { voice: okVoice, reference: okRef });
  // Sin integrar lo recuperado, validateSong diría «ya no está disponible»
  assert.ok(hasErrors(validateSong(song, listed)));
  const caps = mergeCapabilities(listed, samples);
  assert.equal(hasErrors(validateSong(song, caps)), false);
  assert.deepEqual(caps.voices.map((v) => v.id), ['otra', 'v1']);
  assert.deepEqual(caps.references.map((v) => v.id), ['r1']);
});

test('integrar muestras no duplica las que ya están en la lista', () => {
  const listed = { voices: [{ id: 'v1', name: 'Mi voz', sunoPersonaId: 'persona-1' }], references: [{ id: 'r1', name: 'Beatbox' }] };
  const caps = mergeCapabilities(listed, [voiceRec, refRec]);
  assert.equal(caps.voices.length, 1);
  assert.equal(caps.references.length, 1);
  assert.equal(mergeSamples([{ id: 'a', name: 'A' }], [{ id: 'a', name: 'A2' }, { id: 'b', name: 'B' }]).length, 2);
  assert.equal(mergeCapabilities(listed, [{ ...voiceRec, kind: 'INSTRUMENT' }]).voices.length, 1, 'una muestra de instrumento no entra como voz');
});

test('estados de una muestra: cada uno es distinto y ninguno se confunde con otro', () => {
  const r = (over) => resolveSample({ role: 'voice', sampleId: 'v1', lookup: found(voiceRec), check: { state: 'available' }, ...over });
  assert.equal(r({ sampleId: null }).status, 'removed');
  assert.equal(r({ lookup: { state: 'not-found' } }).status, 'unavailable');
  assert.equal(r({ lookup: { state: 'error' } }).status, 'error', 'una falla temporal no es eliminación');
  assert.equal(r({ lookup: { state: 'loading' } }).status, 'loading');
  assert.equal(r({ check: { state: 'expired' } }).status, 'expired');
  assert.equal(r({ check: { state: 'unknown' } }).status, 'unverifiable', 'no verificable no es caducada');
  assert.equal(r({ check: { state: 'loading' } }).status, 'loading');
  assert.equal(r({}).status, 'ok');
  assert.equal(r({ lookup: found({ ...voiceRec, kind: 'INSTRUMENT' }) }).status, 'incompatible');
  assert.equal(r({ lookup: found({ ...voiceRec, sunoPersonaId: null }) }).status, 'incompatible');
  // Otro modelo de persona: no hay disponibilidad que comprobar
  assert.equal(r({ lookup: found({ ...voiceRec, sunoPersonaModel: 'style_persona' }), check: { state: 'idle' } }).status, 'ok');
  assert.equal(resolveSample({ role: 'reference', sampleId: 'r1', lookup: found({ ...refRec, kind: 'VOICE' }) }).status, 'incompatible');
});

test('voz caducada: no se carga, se ofrece recrearla con su muestra', () => {
  const s = updatePlanet(addPlanet(idea(), 'voice'), 'voice', { voiceSampleId: 'v1' });
  const expired = resolveSample({ role: 'voice', sampleId: 'v1', lookup: found(voiceRec), check: { state: 'expired' } });
  const { song, notes, samples } = rebuild(s, { voice: expired });
  assert.deepEqual(song.planets, []);
  assert.equal(samples.length, 0);
  const n = notes.find((x) => x.id === 'voice-expired');
  assert.equal(n.action, 'recreate-voice');
  assert.equal(n.sampleId, 'v1');
});

test('voz no verificable: se carga y se avisa; el servidor decide al crear', () => {
  const s = updatePlanet(addPlanet(idea(), 'voice'), 'voice', { voiceSampleId: 'v1' });
  const unknown = resolveSample({ role: 'voice', sampleId: 'v1', lookup: found(voiceRec), check: { state: 'unknown' } });
  const { song, notes } = rebuild(s, { voice: unknown });
  assert.equal(song.voice.voiceSampleId, 'v1');
  assert.equal(notes[0].id, 'voice-unverifiable');
  assert.equal(notes[0].tone, 'info');
});

test('error temporal: no se descarta en silencio, ofrece reintento y no dice «eliminada»', () => {
  const s = updatePlanet(addPlanet(idea(), 'reference'), 'reference', { sampleId: 'r1' });
  const temp = resolveSample({ role: 'reference', sampleId: 'r1', lookup: { state: 'error' } });
  const { song, notes } = rebuild(s, { reference: temp });
  assert.deepEqual(song.planets, []);
  const n = notes.find((x) => x.id === 'reference-error');
  assert.equal(n.action, 'retry');
  assert.ok(!/elimin|caduc/i.test(n.text));
});

test('referencia eliminada / no disponible / incompatible: cada una con su explicación', () => {
  const s = updatePlanet(addPlanet(idea(), 'reference'), 'reference', { sampleId: 'r1' });
  const removed = rebuild(s, { reference: resolveSample({ role: 'reference', sampleId: null, lookup: { state: 'loading' } }) });
  assert.match(removed.notes[0].text, /eliminó/);
  const gone = rebuild(s, { reference: resolveSample({ role: 'reference', sampleId: 'r1', lookup: { state: 'not-found' } }) });
  assert.match(gone.notes[0].text, /no está disponible/);
  const bad = rebuild(s, { reference: resolveSample({ role: 'reference', sampleId: 'r1', lookup: found({ ...refRec, kind: 'VOICE' }) }) });
  assert.match(bad.notes[0].text, /no se puede usar/);
  for (const r of [removed, gone, bad]) assert.deepEqual(r.song.planets, []);
});

test('mientras se resuelven las muestras no se agregan notas ni planetas a medias', () => {
  const s = updatePlanet(addPlanet(idea(), 'reference'), 'reference', { sampleId: 'r1' });
  const r = rebuild(s, { reference: { status: 'loading' } });
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.song.planets, []);
});

test('sampleIdsOf distingue «no hay input» de «el input perdió su muestra»', () => {
  const none = sampleIdsOf({ inputs: [{ field: 'IDEA', text: 'x' }] });
  assert.equal(none.hasVoice, false);
  const lost = sampleIdsOf({ inputs: [{ field: 'VOICE_SAMPLE', sampleId: null }] });
  assert.equal(lost.hasVoice, true);
  assert.equal(lost.voice, null);
  assert.equal(sampleIdsOf({ inputs: [{ field: 'REFERENCE_SAMPLE', sampleId: 'r1' }] }).reference, 'r1');
});

/* ───────── datos históricos incompletos ───────── */

test('versión sin generación: se recupera solo lo que la versión guardó', () => {
  const r = songFromVersion({ id: 'x', versionNumber: 1, generationId: null, genre: 'Cumbia, Rock', lyricsText: 'Letra del usuario', lyricsSource: 'USER' });
  assert.deepEqual(r.song.style.genres, ['Cumbia', 'Rock']);
  assert.equal(r.song.composition.mode, 'lyrics');
  assert.equal(r.song.composition.lyrics, 'Letra del usuario');
  assert.equal(r.source, 'version');
  assert.match(r.notes[0].text, /el estilo y tu letra/);
});

test('una letra de IA (o editada desde IA) nunca pasa a ser «tu letra»', () => {
  for (const lyricsSource of ['AI', 'AI_EDITED', null]) {
    const r = songFromVersion({ id: 'x', versionNumber: 1, generationId: null, genre: 'Pop', lyricsText: 'Generada', lyricsSource });
    assert.equal(r.song.composition.mode, 'idea');
    assert.equal(r.song.composition.lyrics, '');
  }
});

test('versión sin nada recuperable: planetas vacíos, con explicación y se puede continuar', () => {
  const r = songFromVersion({ id: 'x', versionNumber: 1, generationId: null, genre: null, lyricsText: null, lyricsSource: null });
  assert.ok(isEmptySong(r.song));
  assert.equal(r.source, 'blank');
  assert.match(r.notes[0].text, /vacíos/);
  assert.ok(isEmptySong(songFromVersion(null).song));
});

/* ───────── versiones y origen ───────── */

const versions = [
  { id: 'a', versionNumber: 1, generationId: 'g1', createdAt: '2026-01-01', genre: 'Cumbia', lyricsSource: 'AI' },
  { id: 'b', versionNumber: 2, generationId: 'g1', createdAt: '2026-01-01', genre: 'Cumbia', lyricsSource: 'AI' },
  { id: 'c', versionNumber: 3, generationId: 'g2', createdAt: '2026-02-01', genre: 'Rock', lyricsSource: 'USER' },
  { id: 'd', versionNumber: 4, generationId: null, createdAt: '2026-03-01' },
];

test('versionOptions: todas las versiones, la más nueva primero, con la vigente marcada', () => {
  const o = versionOptions(versions, 'c');
  assert.deepEqual(o.map((x) => x.versionNumber), [4, 3, 2, 1]);
  assert.deepEqual(o.filter((x) => x.isCurrent).map((x) => x.id), ['c']);
  assert.equal(o.find((x) => x.id === 'd').hasConfig, false);
  assert.equal(o.find((x) => x.id === 'c').hasConfig, true);
});

test('versiones que comparten generación se identifican y comparten la misma consulta', () => {
  const o = versionOptions(versions, 'a');
  assert.equal(o.find((x) => x.id === 'a').sameRequestAs, null);
  assert.equal(o.find((x) => x.id === 'b').sameRequestAs, 1);
  assert.equal(o.find((x) => x.id === 'c').sameRequestAs, null);
  // La clave de caché es la generación: dos versiones, una sola consulta
  const keys = new Set(['a', 'b'].map((id) => versions.find((v) => v.id === id).generationId));
  assert.equal(keys.size, 1);
});

test('origen: por defecto la vigente; una versión elegida; en blanco; y cae a la vigente si el enlace es viejo', () => {
  const r = (from, cur = 'c') => resolveOrigin({ from, versions, currentVersionId: cur });
  assert.equal(r(null), 'c');
  assert.equal(r('a'), 'a');
  assert.equal(r(BLANK_ORIGIN), BLANK_ORIGIN);
  assert.equal(r('borrada'), 'c');
  assert.equal(r(null, null), null, 'sin versión vigente ni elegida, no hay origen');
  assert.equal(r(null, 'inexistente'), null);
  assert.equal(resolveOrigin({ from: null, versions: [], currentVersionId: null }), null);
});

test('recarga: la misma URL produce el mismo origen', () => {
  const url = '?song=s1&from=a';
  const from = new URLSearchParams(url).get('from');
  assert.equal(resolveOrigin({ from, versions, currentVersionId: 'c' }), 'a');
  assert.equal(resolveOrigin({ from: new URLSearchParams(url).get('from'), versions, currentVersionId: 'c' }), 'a');
});

/* ───────── payload final ───────── */

test('payload: lo recuperado se reenvía igual que el pedido original, sin título y ligado a la canción', () => {
  let s = updatePlanet(idea({ mood: 'amor' }), 'style', { genres: ['Cumbia'], description: 'alegre' });
  s = updatePlanet(addPlanet(s, 'production'), 'production', { durationSec: '150', avoid: 'autotune' });
  const original = buildGenerationRequest(s, { versionOfId: 'cancion-1' });
  const { song } = rebuild(s);
  const again = buildGenerationRequest(lockTitle(song), { versionOfId: 'cancion-1' });
  assert.deepEqual(again, original);
  assert.equal('title' in again, false);
  assert.equal(again.projectId, undefined);
});

test('payload: tras modificar, agregar o quitar planetas se envía lo nuevo', () => {
  const base = rebuild(updatePlanet(addPlanet(idea(), 'production'), 'production', { durationSec: '150' })).song;
  const edited = M.removePlanet(updatePlanet(base, 'style', { genres: ['Jazz'] }), 'production');
  const req = buildGenerationRequest(edited, { versionOfId: 's1' });
  assert.deepEqual(req.inputs.map((i) => i.field), ['IDEA', 'GENRE']);
});

test('limpiar: planetas vacíos pero el pedido sigue ligado a la misma canción', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.match(src, /songId: versionOfId/);
  assert.match(src, /onSelect=\{requestOrigin\}/, '«Empezar en blanco» del selector pasa por el cambio de origen (con confirmación)');
  assert.match(read('src/features/creator/VersionSourcePicker.tsx'), /<SelectItem value=\{BLANK_ORIGIN\}>Empezar en blanco/);
  assert.ok(!/Limpiar planetas/.test(read('src/features/creator/VersionSourcePicker.tsx')), 'una sola acción para vaciar: «Empezar de cero»');
  assert.ok(isEmptySong(V.blankHydration().song));
});

test('el título de la canción original se conserva: se bloquea y nunca viaja', () => {
  const dirty = updatePlanet(emptySong, 'composition', { title: 'Otro', titleFromLyrics: true });
  const locked = lockTitle(dirty);
  assert.equal(locked.composition.title, '');
  assert.equal(locked.composition.titleFromLyrics, false);
  assert.equal(lockTitle(emptySong), emptySong, 'sin título no se crea un estado nuevo');
  assert.equal(buildGenerationRequest(dirty, { versionOfId: 's1' }).title, undefined);
});

/* ───────── protección de ediciones y aislamiento (estructura del creador) ───────── */

test('lo editado siempre gana sobre la configuración recuperada (sin efectos que sincronicen)', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.match(src, /versionEdits \?\? versionBase/, 'el estado mostrado prefiere lo editado');
  assert.match(src, /prev \?\? versionBase/, 'una edición parte de lo que se ve');
  assert.match(src, /if \(versionPending\) return;/, 'no se edita mientras se lee la configuración');
  const hook = read('src/features/creator/use-version-source.ts');
  assert.ok(!/useEffect/.test(hook), 'el hook no sincroniza con efectos');
});

test('cambiar de origen o limpiar con ediciones pide confirmación', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.match(src, /if \(versionDirty\) \{ setPendingOrigin\(id\); return; \}/);
  assert.match(src, /confirmOrigin/);
});

test('aislamiento: generar otra versión no borra el borrador de una canción nueva', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  // `hasSource` = «otra versión» o remix: ambos viven de su canción de origen y nunca tocan el borrador de una canción nueva
  assert.match(src, /if \(!hasSource && clearTheDraft\) clearDraft\(browserStorage\(\), userId, NEW_DRAFT\);/);
  // «Empezar de cero» en creación normal sigue vaciando el borrador (restart); en «otra versión» pasa por el origen en blanco
  assert.match(src, /\{!hasSource && !empty && \(\s*<button\s+type="button"\s+onClick=\{\(\) => \(recoveryActive \? setDiscardRecoveryOpen\(true\) : restart\(\)\)\}/);
  // el borrador solo se lee y se escribe fuera del modo versión/remix
  assert.match(src, /if \(!hydrated \|\| hasSource \|\| live\.phase !== 'idle'\) return;/);
  assert.match(src, /const hasSource = Boolean\(versionOfId\) \|\| isRemix;/);
});

test('aislamiento: cada canción de origen es una instancia propia del creador', () => {
  const page = read('src/routes.tsx');
  // «otra versión» se identifica por su canción de origen; un remix, por canción y modalidad (instancias separadas, sin arrastrar estado)
  assert.match(page, /const key = query\.get\('remix'\) \? `remix:\$\{query\.get\('remix'\)\}:\$\{query\.get\('mode'\) \?\? ''\}` : \(query\.get\('song'\) \?\? 'new'\);/);
  assert.match(page, /<CreatorWizard key=\{key\} \/>/);
});

test('el borrador de la creación normal se restaura igual que antes', () => {
  const draft = M.parseSong(JSON.parse(JSON.stringify({ ...emptySong, composition: { ...emptySong.composition, idea: 'mi borrador' } })));
  assert.equal(draft.composition.idea, 'mi borrador');
  assert.equal(isEmptySong(emptySong), true);
});

test('navegación: el creador pide todo por id con los métodos existentes y no usa listas para validar lo recuperado', () => {
  const hook = read('src/features/creator/use-version-source.ts');
  for (const call of ['songsApi.get(', 'songsApi.versions(', 'generationApi.get(', 'samplesApi.get(']) assert.ok(hook.includes(call), call);
  assert.ok(hook.includes('useVoiceAvailability('));
  assert.ok(!/samplesApi\.list|generationApi\.list|songsApi\.list/.test(hook), 'ninguna lista paginada');
  for (const key of ["['song', songId]", "['song', songId, 'versions']", "['generation', generationId]"]) assert.ok(hook.includes(key), key);
});

test('canción en la Papelera, inexistente o ajena: el creador no se muestra', () => {
  const hook = read('src/features/creator/use-version-source.ts');
  assert.match(hook, /status === 404/);
  assert.match(hook, /status === 403/);
  assert.match(hook, /song\.userId !== userId/);
  const wiz = read('src/features/creator/CreatorWizard.tsx');
  assert.match(wiz, /source\.status === 'blocked'/);
});

test('encabezado: sin tarjetas nuevas; el aviso, el selector y la salida viven en el encabezado existente', () => {
  const wiz = read('src/features/creator/CreatorWizard.tsx');
  assert.ok(!/<VersionBanner|<VersionSourcePicker/.test(wiz), 'no hay tarjeta de aviso ni de selector');
  assert.match(wiz, /Otra versión de <span/);
  assert.match(wiz, /<VersionOriginSelect/);
  assert.match(wiz, /Crear canción nueva/);
  const ui = read('src/features/creator/VersionSourcePicker.tsx');
  assert.match(ui, /Partir de:/);
  assert.ok(!/rounded-2xl border border-border\/70 bg-surface-2/.test(ui), 'sin tarjeta contenedora');
});

test('mensajes: la carga correcta no deja texto visible; solo hay notas cuando hay algo que decir, y el anuncio es para lectores de pantalla', () => {
  const ui = read('src/features/creator/VersionSourcePicker.tsx');
  assert.match(ui, /if \(loading \|\| notes\.length === 0\) return null;/);
  assert.match(ui, /className="sr-only" role="status" aria-live="polite"/);
  // sin notas = nada que mostrar: la reconstrucción completa no genera ninguna
  const full = rebuild(updatePlanet(idea(), 'style', { genres: ['Rock'] }));
  assert.deepEqual(full.notes, []);
});

test('acciones del encabezado: mutuamente excluyentes según el modo y con la misma presentación', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  // «Empezar de cero»: solo en creación normal (y con algo escrito); nunca en «otra versión»
  assert.match(src, /\{!hasSource && !empty && \(\s*<button\s+type="button"\s+onClick=\{\(\) => \(recoveryActive \? setDiscardRecoveryOpen\(true\) : restart\(\)\)\}/);
  assert.equal((src.match(/<Trash2 className="h-3 w-3" aria-hidden \/> Empezar de cero/g) ?? []).length, 1, 'una sola aparición como botón del encabezado');
  assert.ok(!/requestOrigin\(BLANK_ORIGIN\)\s*:\s*restart|versionOfId \? \(\) => requestOrigin/.test(src), 'el botón ya no limpia el origen');
  // «Crear canción nueva»: solo en «otra versión», navega a /create y no toca el borrador
  assert.match(src, /\{hasSource && \(\s*<button type="button" onClick=\{newSongInstead\} className=\{HEADER_ACTION\}>\s*<Plus /);
  assert.match(src, /const newSongInstead = \(\) => navigate\('\/create'\);/);
  // misma clase en ambos: un solo estilo, no dos
  assert.equal((src.match(/HEADER_ACTION[,}]/g) ?? []).length, 2);
  // «Empezar en blanco» del selector es la única vía de limpiar sin salir del modo
  const ui = read('src/features/creator/VersionSourcePicker.tsx');
  assert.match(ui, /Empezar en blanco/);
  assert.match(src, /requestOrigin = \(id: string\)/);
});

test('encabezado: el nombre de la canción usa el mismo color que «En armado» (token text-label)', () => {
  const src = read('src/features/creator/CreatorWizard.tsx');
  assert.match(src, /tracking-\[0\.12em\] text-label">\s*<span aria-hidden className="size-1\.5 rounded-full bg-gold" \/>\s*En armado/);
  assert.match(src, /Otra versión de <span className="font-medium text-label">«\{source\.song\.title\}»<\/span>/);
});

/* ───────── Influencia del audio (AUDIO_WEIGHT) en «Otra versión» ───────── */

const coverWith = (weight, over = {}) => {
  let s = updatePlanet(emptySong, 'composition', { mode: 'lyrics', lyrics: '[Verso]\nhola', ...over });
  s = addPlanet(s, 'reference'); s = updatePlanet(s, 'reference', { sampleId: 'r1' });
  s = addPlanet(s, 'creativity'); s = updatePlanet(s, 'creativity', { audioWeight: weight });
  return s;
};

test('AUDIO_WEIGHT · «Otra versión» recupera el valor guardado cuando la referencia sigue disponible', () => {
  const { song } = rebuild(coverWith(0.42), { reference: okRef });
  assert.equal(song.creativity.audioWeight, 0.42);
  assert.deepEqual(song.planets, ['reference', 'creativity']);
  assert.equal(song.reference.sampleId, 'r1');
});

test('AUDIO_WEIGHT · 0 es un valor recuperable (no se confunde con automático)', () => {
  assert.strictEqual(rebuild(coverWith(0), { reference: okRef }).song.creativity.audioWeight, 0);
});

test('AUDIO_WEIGHT · generaciones anteriores (sin el input) quedan en automático y no agregan el planeta', () => {
  const { song } = rebuild(coverWith(null), { reference: okRef });
  assert.equal(song.creativity.audioWeight, null);
  assert.deepEqual(song.planets, ['reference']);
});

test('AUDIO_WEIGHT · referencia eliminada, no disponible o incompatible: el valor se descarta (el control no aparece ni se envía)', () => {
  for (const reference of [
    resolveSample({ role: 'reference', sampleId: 'r1', lookup: { state: 'not-found' } }),
    resolveSample({ role: 'reference', sampleId: 'r1', lookup: { state: 'error' } }),
    resolveSample({ role: 'reference', sampleId: 'r1', lookup: found({ ...refRec, kind: 'VOICE' }) }),
    undefined,
  ]) {
    const { song } = rebuild(coverWith(0.42), { reference });
    assert.equal(song.creativity.audioWeight, null, JSON.stringify(reference?.status));
    assert.equal(song.planets.includes('reference'), false);
    assert.equal(buildGenerationRequest(song).inputs.some((i) => i.field === 'AUDIO_WEIGHT'), false);
  }
});

test('AUDIO_WEIGHT · un valor que quedó en una generación instrumental no se carga', () => {
  const g = { inputs: [{ field: 'GENRE', value: ['jazz'] }, { field: 'REFERENCE_SAMPLE', sampleId: 'r1' }, { field: 'AUDIO_WEIGHT', value: 0.5 }, { field: 'INSTRUMENTAL', source: 'SYSTEM', value: true }], jobs: [{ task: 'MUSIC' }] };
  const { song, notes } = songFromGeneration({ generation: g, voice: null, reference: okRef });
  assert.equal(song.creativity.audioWeight, null);
  assert.equal(notes.some((n) => n.id === 'unsupported-inputs'), false, 'AUDIO_WEIGHT es un campo que el creador maneja');
});

test('AUDIO_WEIGHT · valores inválidos se descartan y el redondeo es a 2 decimales', () => {
  const g = (value) => ({ inputs: [{ field: 'LYRICS', text: 'l' }, { field: 'REFERENCE_SAMPLE', sampleId: 'r1' }, { field: 'AUDIO_WEIGHT', value }], jobs: [{ task: 'MUSIC' }] });
  assert.equal(songFromGeneration({ generation: g(1.5), voice: null, reference: okRef }).song.creativity.audioWeight, null);
  assert.equal(songFromGeneration({ generation: g('x'), voice: null, reference: okRef }).song.creativity.audioWeight, null);
  assert.equal(songFromGeneration({ generation: g(0.456), voice: null, reference: okRef }).song.creativity.audioWeight, 0.46);
});
