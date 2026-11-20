// Modelo de la canción («sistema solar») y su traducción al contrato POST /generations.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const M = await import('../src/features/creator/song-model.ts');
const {
  emptySong, addPlanet, removePlanet, updatePlanet, availability, activePlanets, validateSong, hasErrors, predictRoute, LIMITS,
  buildGenerationRequest, applyLyricsFromStudio, parseSong, summarize, describeTreatment, songStatus, isEmptySong,
  addGenre, addGenresFromText, removeGenre, genreKey, styleUsage, normalizeGenres, ideaJoinsStyle,
} = M;

const caps = {
  voices: [{ id: 'v1', name: 'Mi voz', sunoPersonaId: 'persona-1' }],
  references: [{ id: 'r1', name: 'Beatbox', durationSec: 30 }, { id: 'rLong', name: 'Largo', durationSec: 600 }, { id: 'rTiny', name: 'Mini', durationSec: 3 }],
};
const comp = (patch, base = emptySong) => updatePlanet(base, 'composition', patch);
const withPlanets = (state, ...ids) => ids.reduce((s, id) => addPlanet(s, id), state);
const fields = (req) => req.inputs.map((i) => i.field);
const get = (req, f) => req.inputs.find((i) => i.field === f);
const errorsOf = (s, planet) => validateSong(s, caps).filter((i) => i.severity === 'error' && (!planet || i.planet === planet));
const idea = (text = 'una canción sobre el mar') => comp({ idea: text });
const PUBLIC_FIELDS = ['IDEA', 'GENRE', 'STYLE_DESCRIPTION', 'THEME', 'LYRICS', 'DURATION_SECONDS', 'VOCAL_GENDER', 'NEGATIVE_TAGS', 'STYLE_WEIGHT', 'WEIRDNESS', 'VARIETY', 'REFERENCE_SAMPLE', 'VOICE_SAMPLE'];

/* ─────────────── operaciones: agregar, editar, quitar ─────────────── */

test('estado inicial: solo los planetas base; nada para enviar', () => {
  assert.deepEqual(activePlanets(emptySong), ['composition', 'style']);
  assert.equal(isEmptySong(emptySong), true);
  assert.equal(buildGenerationRequest(emptySong).inputs.length, 0);
});

test('agregar un planeta opcional lo incorpora una sola vez y respeta el orden', () => {
  const s = addPlanet(addPlanet(addPlanet(emptySong, 'voice'), 'production'), 'voice');
  assert.deepEqual(s.planets, ['voice', 'production']);
  assert.deepEqual(activePlanets(s), ['composition', 'style', 'voice', 'production']);
  assert.equal(emptySong.planets.length, 0, 'no muta el estado anterior');
});

test('los planetas base no se quitan; quitar uno opcional descarta su configuración y deja de enviarse', () => {
  assert.equal(removePlanet(emptySong, 'composition'), emptySong);
  let s = updatePlanet(addPlanet(idea(), 'production'), 'production', { durationSec: '120', avoid: 'autotune' });
  s = removePlanet(s, 'production');
  assert.deepEqual(s.planets, []);
  assert.deepEqual(s.production, emptySong.production);
  assert.equal(fields(buildGenerationRequest(s)).includes('DURATION_SECONDS'), false);
});

test('editar un planeta no toca a los demás', () => {
  const s = updatePlanet(updatePlanet(emptySong, 'style', { genres: ['cumbia'] }), 'composition', { idea: 'x' });
  assert.deepEqual(s.style.genres, ['cumbia']);
  assert.equal(s.composition.idea, 'x');
});

test('voz no disponible en una pieza instrumental; si estaba, se quita al cambiar la composición', () => {
  const inst = comp({ mode: 'instrumental' });
  const a = availability(inst).find((x) => x.def.id === 'voice');
  assert.equal(a.available, false);
  assert.match(a.reason, /instrumental/);
  assert.equal(addPlanet(inst, 'voice'), inst);
  const s = comp({ mode: 'instrumental' }, updatePlanet(addPlanet(emptySong, 'voice'), 'voice', { preference: 'male' }));
  assert.deepEqual(s.planets, []);
  assert.equal(s.voice.preference, '');
});

/* ─────────────── validaciones ─────────────── */

test('composición: cada modo exige lo suyo', () => {
  assert.equal(errorsOf(emptySong, 'composition').length, 1);
  assert.equal(errorsOf(idea(), 'composition').length, 0);
  assert.equal(errorsOf(comp({ mode: 'lyrics' }), 'composition').length, 1);
  assert.equal(errorsOf(comp({ mode: 'lyrics', lyrics: '[Verse] hola' }), 'composition').length, 0);
  const inst = comp({ mode: 'instrumental' });
  assert.equal(errorsOf(inst, 'style').length, 1);
  assert.equal(errorsOf(updatePlanet(inst, 'style', { genres: ['jazz'] }), 'style').length, 0);
});

test('título: máximo 80 caracteres; si se excede es un ERROR (no se recorta en silencio)', () => {
  assert.equal(errorsOf(comp({ title: 'x'.repeat(80) }, idea()), 'composition').length, 0);
  const long = comp({ title: 'x'.repeat(81) }, idea());
  assert.equal(errorsOf(long, 'composition').length, 1);
  assert.equal(buildGenerationRequest(long).title.length, 81, 'el título no se trunca al armar la solicitud');
});

test('letra y estilo: los excesos son errores (nada se recorta solo)', () => {
  assert.equal(errorsOf(comp({ mode: 'lyrics', lyrics: 'x'.repeat(LIMITS.lyrics) }), 'composition').length, 0, 'exactamente 5000 se acepta');
  assert.equal(errorsOf(comp({ mode: 'lyrics', lyrics: 'x'.repeat(LIMITS.lyrics + 1) }), 'composition').length, 1);
  assert.equal(errorsOf(updatePlanet(idea(), 'style', { description: 'x'.repeat(LIMITS.description + 1) }), 'style').length >= 1, true);
  assert.equal(errorsOf(updatePlanet(idea(), 'style', { description: 'x'.repeat(LIMITS.description) }), 'style').length, 0, 'exactamente 1000 se acepta');
  // Los géneros comparten el presupuesto de `style` (1000): 'pop, ' + 995 cabe; un carácter más es error y no se recorta.
  assert.equal(errorsOf(updatePlanet(idea(), 'style', { genres: ['pop'], description: 'x'.repeat(995) }), 'style').length, 0);
  assert.equal(errorsOf(updatePlanet(idea(), 'style', { genres: ['pop'], description: 'x'.repeat(996) }), 'style').length, 1);
});

test('estilo de 1000 caracteres: límite, solicitud completa y borrador intacto', () => {
  assert.equal(LIMITS.description, 1000);
  const text = 'a'.repeat(1000);
  const s = updatePlanet(idea(), 'style', { description: text });
  assert.equal(get(buildGenerationRequest(s), 'STYLE_DESCRIPTION').text, text, 'se envía completo');
  const restored = parseSong(JSON.parse(JSON.stringify(s)));
  assert.equal(restored.style.description, text, 'el borrador conserva los 1000');
  assert.equal(errorsOf(updatePlanet(idea(), 'style', { description: text + 'a' }), 'style').length >= 1, true, 'el 1001 se rechaza');
});

test('producción: duración entera entre 10 y 360', () => {
  const base = withPlanets(idea(), 'production');
  for (const bad of ['5', '361', 'abc', '90.5']) assert.equal(errorsOf(updatePlanet(base, 'production', { durationSec: bad }), 'production').length, 1, bad);
  for (const good of ['10', '360', '', '120']) assert.equal(errorsOf(updatePlanet(base, 'production', { durationSec: good }), 'production').length, 0, good);
});

test('referencia: exige un audio disponible y respeta los límites del endpoint', () => {
  const base = withPlanets(idea(), 'reference');
  assert.equal(errorsOf(base, 'reference').length, 1, 'sin audio elegido');
  assert.equal(errorsOf(updatePlanet(base, 'reference', { sampleId: 'otro' }), 'reference').length, 1, 'audio inexistente');
  assert.equal(errorsOf(updatePlanet(base, 'reference', { sampleId: 'r1' }), 'reference').length, 0);
  assert.equal(errorsOf(updatePlanet(base, 'reference', { sampleId: 'rLong' }), 'reference').length, 1, 'cover: máx. 8 minutos');
  const inst = updatePlanet(withPlanets(comp({ mode: 'instrumental', idea: 'x' }), 'reference'), 'reference', { sampleId: 'rLong' });
  assert.equal(errorsOf(inst, 'reference').length, 0, 'como guía admite hasta 30 minutos');
  assert.equal(errorsOf(updatePlanet(inst, 'reference', { sampleId: 'rTiny' }), 'reference').length, 1, 'como guía: mínimo 6 s');
});

test('endpoint: con letra la referencia transforma (cover); en instrumental es solo guía y los controles NO lo cambian', () => {
  const withRef = (s) => updatePlanet(withPlanets(s, 'reference'), 'reference', { sampleId: 'r1' });
  assert.equal(predictRoute(withRef(idea())).endpoint, 'cover');
  assert.equal(predictRoute(withRef(comp({ mode: 'lyrics', lyrics: 'l' }))).endpoint, 'cover');
  const inst = withRef(comp({ mode: 'instrumental', idea: 'x' }, updatePlanet(emptySong, 'style', { genres: ['jazz'] })));
  assert.equal(predictRoute(inst).endpoint, 'reference');
  const instControls = updatePlanet(withPlanets(inst, 'production', 'creativity'), 'creativity', { variety: 2 });
  assert.equal(predictRoute(instControls).endpoint, 'reference', 'los controles no convierten la guía en cover');
  assert.equal(predictRoute(idea()).endpoint, 'standard');
});

test('referencia + controles incompatibles: son errores (cover: sin duración ni exclusiones; guía: sin ninguno de los controles)', () => {
  const ref = (s) => updatePlanet(withPlanets(s, 'reference'), 'reference', { sampleId: 'r1' });
  // cover (idea con letra de Melodya)
  const cover = updatePlanet(withPlanets(ref(idea()), 'production'), 'production', { durationSec: '120' });
  assert.equal(errorsOf(cover, 'production').length, 1);
  assert.equal(errorsOf(updatePlanet(cover, 'production', { durationSec: '', avoid: 'autotune' }), 'production').length, 1);
  const coverCreative = updatePlanet(withPlanets(ref(idea()), 'creativity', 'voice'), 'creativity', { variety: 2 });
  assert.equal(errorsOf(updatePlanet(coverCreative, 'voice', { preference: 'male' })).length, 0, 'cover admite creatividad y preferencia vocal');
  // guía (instrumental)
  const guide = updatePlanet(ref(comp({ mode: 'instrumental' }, updatePlanet(emptySong, 'style', { genres: ['jazz'] }))), 'style', { genres: ['jazz'] });
  assert.equal(errorsOf(withPlanets(guide, 'creativity')).length, 0);
  assert.equal(errorsOf(updatePlanet(withPlanets(guide, 'creativity'), 'creativity', { weirdness: 0.3 }), 'creativity').length, 1);
  assert.equal(errorsOf(updatePlanet(withPlanets(guide, 'production'), 'production', { avoid: 'voces' }), 'production').length, 1);
  assert.equal(errorsOf(updatePlanet(withPlanets(guide, 'production'), 'production', { durationSec: '90' }), 'production').length, 1);
});

test('voz propia: debe estar entre las listas; no convive con una preferencia', () => {
  const s = updatePlanet(withPlanets(idea(), 'voice'), 'voice', { voiceSampleId: 'ghost' });
  assert.equal(errorsOf(s, 'voice').length, 1);
  assert.equal(errorsOf(updatePlanet(s, 'voice', { voiceSampleId: 'v1' }), 'voice').length, 0);
  assert.equal(errorsOf(updatePlanet(s, 'voice', { voiceSampleId: 'v1', preference: 'male' }), 'voice').length, 1);
});

test('estado del centro, resumen y tratamiento', () => {
  assert.equal(songStatus(emptySong, caps).ready, false);
  assert.equal(songStatus(idea('una cumbia'), caps).ready, true);
  assert.equal(hasErrors([]), false);
  let s = updatePlanet(withPlanets(idea('una cumbia'), 'production', 'voice'), 'production', { durationSec: '120', avoid: 'autotune, reggaetón' });
  s = updatePlanet(s, 'voice', { preference: 'male' });
  assert.match(summarize(s, caps).voice, /masculina/);
  assert.match(summarize(s, caps).production, /120 s · evitar 2/);
  const t = describeTreatment(s);
  // El panel de Materiales ya no muestra avisos de duración, exclusiones, preferencia vocal ni «escribe la letra a partir de tu idea».
  assert.equal(t.some((x) => /Duración|exclusiones|probabilidad|a partir de tu idea/.test(x.text)), false);
  assert.ok(t.every((x) => x.kind === 'applied' || x.kind === 'note'), 'no existe «no se aplica»: lo incompatible se bloquea antes');
  // Los avisos que sí quedan siguen apareciendo según el modo.
  const own = describeTreatment(comp({ mode: 'lyrics', lyrics: '[Verse]\nhola' }));
  assert.ok(own.some((x) => x.kind === 'applied' && /Tu letra se canta tal como la escribiste/.test(x.text)));
  const instrumental = describeTreatment(comp({ mode: 'instrumental' }));
  assert.ok(instrumental.some((x) => x.kind === 'applied' && /sin voz/.test(x.text)));
});

/* ─────────────── construcción de la solicitud ─────────────── */

test('guiado: IDEA limpia, THEME aparte, descripción libre intacta, Melodya escribe la letra', () => {
  const s = updatePlanet(comp({ idea: 'una cumbia para festejar el final del cursado', mood: 'Fiesta', title: 'Final de cursada' }), 'style', {
    genres: ['Cumbia', 'Pop'],
    description: 'cumbia argentina moderna, voz masculina principal con coros grupales, bajo marcado, teclado cumbiero, güiro, timbal',
  });
  const req = buildGenerationRequest(s);
  assert.deepEqual(get(req, 'IDEA'), { field: 'IDEA', text: 'una cumbia para festejar el final del cursado' });
  assert.deepEqual(get(req, 'THEME'), { field: 'THEME', text: 'Fiesta' });
  assert.deepEqual(get(req, 'GENRE').value, ['Cumbia', 'Pop']);
  assert.equal(get(req, 'STYLE_DESCRIPTION').text, s.style.description);
  assert.deepEqual(req.options, { generateLyricsIfMissing: true });
  assert.equal(req.title, 'Final de cursada');
  assert.equal(fields(req).includes('LYRICS'), false);
});

test('tema libre: viaja el texto del usuario', () => {
  const req = buildGenerationRequest(comp({ idea: 'algo', mood: 'libre', moodCustom: 'volver al barrio' }));
  assert.equal(get(req, 'THEME').text, 'volver al barrio');
});

test('letra propia: LYRICS; sin IDEA ni THEME aunque hayan quedado escritas de otro modo; sin pedir letra a Melodya', () => {
  const s = comp({ mode: 'lyrics', lyrics: '[Verse]\nhola', idea: 'idea vieja', mood: 'Amor', title: 'Mi tema' });
  const req = buildGenerationRequest(s);
  assert.deepEqual(get(req, 'LYRICS'), { field: 'LYRICS', text: '[Verse]\nhola' });
  assert.ok(req.inputs.every((i) => !('source' in i)), 'el cliente no envía «source»: el servidor fija el origen');
  assert.equal(get(req, 'IDEA'), undefined, 'una idea escondida no viaja en modo letra propia (acababa como título)');
  assert.equal(get(req, 'THEME'), undefined);
  assert.deepEqual(req.options, {});
  assert.equal(req.title, 'Mi tema');
});

test('instrumental: options.instrumental es la única forma; sin THEME, sin voz ni preferencia vocal aunque hubiera una guardada', () => {
  let s = updatePlanet(addPlanet(emptySong, 'voice'), 'voice', { preference: 'female' });
  s = updatePlanet(comp({ mode: 'instrumental', idea: 'música para estudiar', mood: 'Amor' }, s), 'style', { genres: ['lofi'] });
  const req = buildGenerationRequest(s);
  assert.equal(req.options.instrumental, true);
  assert.equal(req.options.generateLyricsIfMissing, undefined);
  assert.equal(get(req, 'IDEA').text, 'música para estudiar');
  for (const f of ['VOCAL_GENDER', 'VOICE_SAMPLE', 'THEME', 'LYRICS']) assert.equal(get(req, f), undefined, f);
  assert.equal(fields(req).includes('INSTRUMENTAL'), false, 'INSTRUMENTAL no es un campo público');
});

test('voz: preferencia → VOCAL_GENDER; voz propia → VOICE_SAMPLE (y no la preferencia)', () => {
  let s = updatePlanet(withPlanets(idea(), 'voice'), 'voice', { preference: 'female' });
  assert.deepEqual(get(buildGenerationRequest(s), 'VOCAL_GENDER'), { field: 'VOCAL_GENDER', value: 'female' });
  s = updatePlanet(s, 'voice', { voiceSampleId: 'v1' });
  const req = buildGenerationRequest(s);
  assert.deepEqual(get(req, 'VOICE_SAMPLE'), { field: 'VOICE_SAMPLE', sampleId: 'v1' });
  assert.equal(get(req, 'VOCAL_GENDER'), undefined);
  assert.equal(fields(buildGenerationRequest(withPlanets(idea(), 'voice'))).includes('VOCAL_GENDER'), false);
});

test('referencia, producción y creatividad: cada control viaja con su campo y solo si se configuró', () => {
  let s = withPlanets(idea(), 'production', 'creativity');
  s = updatePlanet(s, 'production', { durationSec: '150', avoid: 'autotune, reggaetón, Autotune' });
  s = updatePlanet(s, 'creativity', { styleWeight: 0.7, weirdness: 0.25, variety: 3 });
  const req = buildGenerationRequest(s);
  assert.equal(get(req, 'DURATION_SECONDS').value, 150);
  assert.deepEqual(get(req, 'NEGATIVE_TAGS').value, ['autotune', 'reggaetón'], 'sin repetidos');
  assert.equal(get(req, 'STYLE_WEIGHT').value, 0.7);
  assert.equal(get(req, 'WEIRDNESS').value, 0.25);
  assert.equal(get(req, 'VARIETY').value, 3);
  assert.deepEqual(buildGenerationRequest(withPlanets(idea(), 'creativity')).inputs.map((i) => i.field), ['IDEA'], 'creatividad automática: no se envía nada');
  const ref = updatePlanet(withPlanets(idea(), 'reference'), 'reference', { sampleId: 'r1' });
  assert.deepEqual(get(buildGenerationRequest(ref), 'REFERENCE_SAMPLE'), { field: 'REFERENCE_SAMPLE', sampleId: 'r1' });
});

test('ningún flujo envía campos retirados: solo campos del contrato público; el título nunca es un input', () => {
  const full = updatePlanet(updatePlanet(updatePlanet(updatePlanet(updatePlanet(withPlanets(comp({ idea: 'x', mood: 'Amor', title: 'T' }), 'voice', 'reference', 'production', 'creativity'), 'style', { genres: ['pop'], description: 'festiva' }),
    'voice', { preference: 'male' }), 'reference', { sampleId: 'r1' }), 'production', { durationSec: '120' }), 'creativity', { styleWeight: 0.5, variety: 1 });
  for (const state of [full, comp({ mode: 'lyrics', lyrics: 'l' }, full), comp({ mode: 'instrumental' }, full)]) {
    for (const f of fields(buildGenerationRequest(state))) assert.ok(PUBLIC_FIELDS.includes(f), `${f} no es un campo público`);
  }
  for (const retired of ['TITLE', 'STYLE_TAGS', 'INSTRUMENTS', 'BPM', 'KEY', 'ENERGY', 'INSTRUMENTAL', 'EXTRAS', 'VOICE_MODEL_ID', 'USER_VOICE']) {
    assert.equal(fields(buildGenerationRequest(full)).includes(retired), false, retired);
  }
});

test('nueva versión de una canción: no se envía title; proyecto solo si se eligió', () => {
  const s = comp({ mode: 'lyrics', lyrics: 'l', title: 'X' });
  assert.equal(buildGenerationRequest(s, { versionOfId: 's1' }).title, undefined);
  assert.equal(buildGenerationRequest({ ...s, projectId: 'p1' }).projectId, 'p1');
  assert.equal(buildGenerationRequest(s).projectId, undefined);
});

/* ─────────────── título: Estudio de letras → creador → solicitud ─────────────── */

test('título del Estudio: se transfiere al creador, queda editable y se envía como `title`', () => {
  let s = applyLyricsFromStudio(idea('mi idea'), { lyrics: '[Verse] hola mar', title: 'Mar de noche' });
  assert.equal(s.composition.mode, 'lyrics');
  assert.equal(s.composition.lyrics, '[Verse] hola mar');
  assert.equal(s.composition.title, 'Mar de noche');
  assert.equal(s.composition.titleFromLyrics, true);
  assert.ok(validateSong(s, caps).some((i) => i.planet === 'composition' && i.severity === 'info' && /Melodya/.test(i.message)));
  assert.equal(buildGenerationRequest(s).title, 'Mar de noche');
  // el usuario lo edita: pasa a ser suyo y se envía editado
  s = updatePlanet(s, 'composition', { title: 'Mar de madrugada' });
  assert.equal(s.composition.titleFromLyrics, false);
  assert.equal(buildGenerationRequest(s).title, 'Mar de madrugada');
});

test('título del usuario: una letra nueva del Estudio NO lo pisa; uno propuesto antes sí se reemplaza', () => {
  const mine = comp({ title: 'El mío' }, idea());
  const kept = applyLyricsFromStudio(mine, { lyrics: '[Verse] l', title: 'Propuesto' });
  assert.equal(kept.composition.title, 'El mío');
  assert.equal(kept.composition.titleFromLyrics, false);
  const proposed = applyLyricsFromStudio(applyLyricsFromStudio(idea(), { lyrics: 'a', title: 'Uno' }), { lyrics: 'b', title: 'Dos' });
  assert.equal(proposed.composition.title, 'Dos');
  assert.equal(proposed.composition.titleFromLyrics, true);
});

test('título del Estudio vacío o demasiado largo: no se inventa ni se recorta (el error pide acortarlo)', () => {
  const empty = applyLyricsFromStudio(idea(), { lyrics: '[Verse] l', title: '  ' });
  assert.equal(empty.composition.title, '');
  assert.equal(empty.composition.titleFromLyrics, false);
  assert.equal(buildGenerationRequest(empty).title, undefined);
  const long = applyLyricsFromStudio(idea(), { lyrics: '[Verse] l', title: 'palabra '.repeat(15).trim() });
  assert.ok(long.composition.title.length > LIMITS.title, 'se transfiere completo');
  assert.equal(errorsOf(long, 'composition').length, 1);
});

/* ─────────────── borrador ─────────────── */

test('borrador: estado seguro desde JSON; lo viejo o corrupto se descarta y la voz no sobrevive a un borrador instrumental', () => {
  assert.equal(parseSong(null), null);
  assert.equal(parseSong('x'), null);
  const s = parseSong({ composition: { mode: 'rara', idea: 5, lyricTitle: 'viejo', title: '' , titleFromLyrics: true }, planets: ['voice', 'luna', 'voice'], creativity: { styleWeight: 2, variety: 9 }, style: { genres: ['a', 3, ''] } });
  assert.equal(s.composition.mode, 'idea');
  assert.equal(s.composition.idea, '');
  assert.equal(s.composition.titleFromLyrics, false, 'sin título no hay título propuesto');
  assert.equal('lyricTitle' in s.composition, false, 'campo anterior ignorado');
  assert.deepEqual(s.planets, ['voice']);
  assert.deepEqual([s.creativity.styleWeight, s.creativity.variety], [null, null]);
  assert.deepEqual(s.style.genres, ['a']);
  assert.equal(parseSong(JSON.parse(JSON.stringify(updatePlanet(addPlanet(emptySong, 'creativity'), 'creativity', { variety: 2 })))).creativity.variety, 2);
  assert.deepEqual(parseSong({ composition: { mode: 'instrumental' }, planets: ['voice'] }).planets, []);
});

/* ─────────────── compatibilidad con el backend (si el repo hermano está disponible) ─────────────── */

const backendDir = path.resolve(import.meta.dirname, '../../melodya.backend/src');
const haveBackend = fs.existsSync(path.join(backendDir, 'models/generation.schema.js')) && fs.existsSync(path.join(backendDir, 'providers/music/suno-plan.js'));

/** Lo que haría el servicio con una solicitud de la web: esquema → hidratación de muestras → planificador de Suno. */
function backendVerdict(request) {
  const req = createRequire(path.join(backendDir, 'x.js'));
  const { createGenerationSchema } = req('./models/generation.schema.js');
  const { planSunoRequest } = req('./providers/music/suno-plan.js');
  const sampleIds = { REFERENCE_SAMPLE: 'sample-ref-0001', VOICE_SAMPLE: 'sample-voice-001' };
  const body = JSON.parse(JSON.stringify({ ...request, clientRequestId: 'abcdefgh1' }));
  for (const i of body.inputs) if (i.sampleId) i.sampleId = sampleIds[i.field];
  const parsed = createGenerationSchema.safeParse(body);
  if (!parsed.success) return { ok: false, why: `esquema: ${parsed.error.issues.map((i) => i.message).join(' | ')}` };
  const inputs = parsed.data.inputs.map((i) => ({ ...i }));
  for (const i of inputs) if (i.field === 'REFERENCE_SAMPLE') i.value = 'https://pub.test/ref.mp3';
  if (inputs.some((i) => i.field === 'VOICE_SAMPLE')) inputs.push({ field: 'PERSONA_ID', source: 'SYSTEM', value: { personaId: 'p1', personaModel: 'voice_persona' } });
  const instrumental = Boolean(parsed.data.options.instrumental);
  const lyricsNeeded = !instrumental && !inputs.some((i) => i.field === 'LYRICS') && parsed.data.options.generateLyricsIfMissing !== false;
  const plan = planSunoRequest({ inputs, options: { instrumental, title: parsed.data.title }, ctx: { pendingLyrics: lyricsNeeded }, model: { code: 'V6', config: {} }, callBackUrl: 'https://x.test/cb' });
  return plan.errors.length ? { ok: false, why: `planificador: ${plan.errors.map((e) => `${e.field}: ${e.message}`).join(' | ')}`, plan } : { ok: true, plan };
}

test('contrato web → backend: cada flujo válido pasa el esquema real Y el planificador de Suno', { skip: !haveBackend && 'melodya.backend no está disponible' }, () => {
  let full = withPlanets(comp({ idea: 'una cumbia', mood: 'Fiesta', title: 'T' }), 'voice', 'production', 'creativity');
  full = updatePlanet(updatePlanet(updatePlanet(updatePlanet(full, 'style', { genres: ['Cumbia'], description: 'festiva' }), 'voice', { preference: 'male' }), 'production', { durationSec: '120', avoid: 'autotune' }), 'creativity', { styleWeight: 0.65, weirdness: 0.3, variety: 1 });
  const flows = {
    guiado: full,
    'letra propia': comp({ mode: 'lyrics', lyrics: '[Verse] hola', idea: 'oculta' }, full),
    instrumental: comp({ mode: 'instrumental' }, full),
    mínimo: idea('una canción'),
  };
  for (const [name, state] of Object.entries(flows)) {
    assert.equal(hasErrors(validateSong(state, caps)), false, `${name}: la web lo bloquea`);
    const v = backendVerdict(buildGenerationRequest(state));
    assert.equal(v.ok, true, `${name}: ${v.why}`);
  }
});

test('la solicitud de cada flujo llega a Suno con los campos esperados (letra en lyrics, título solo el elegido, idea nunca cantada)', { skip: !haveBackend && 'melodya.backend no está disponible' }, () => {
  const guided = backendVerdict(buildGenerationRequest(updatePlanet(comp({ idea: 'una cumbia', title: 'Mi tema', mood: 'Fiesta' }), 'style', { genres: ['Cumbia'] }))).plan.body;
  assert.equal(guided.customMode, true);
  assert.equal(guided.title, 'Mi tema');
  assert.equal(guided.prompt, undefined);
  const own = backendVerdict(buildGenerationRequest(comp({ mode: 'lyrics', lyrics: '[Verse] hola', idea: 'oculta' }))).plan.body;
  assert.equal(own.lyrics, '[Verse] hola');
  assert.equal(own.title, undefined, 'sin título elegido no se envía ninguno');
  const inst = backendVerdict(buildGenerationRequest(updatePlanet(comp({ mode: 'instrumental', idea: 'para estudiar' }), 'style', { genres: ['lofi'] }))).plan.body;
  assert.equal(inst.instrumental, true);
  assert.equal(inst.lyrics, undefined);
});

test('la web y el backend coinciden: una combinación está bloqueada en la web si y solo si el backend la rechaza', { skip: !haveBackend && 'melodya.backend no está disponible' }, () => {
  const modes = ['idea', 'lyrics', 'instrumental'];
  const refs = [false, true];
  const voices = ['none', 'pref', 'own'];
  const prods = ['none', 'duration', 'avoid'];
  const creatives = [false, true];
  let checked = 0;
  for (const mode of modes) for (const ref of refs) for (const voice of voices) for (const prod of prods) for (const creative of creatives) {
    let s = comp({ mode, idea: 'una canción', lyrics: mode === 'lyrics' ? '[Verse] hola' : '' }, updatePlanet(emptySong, 'style', { genres: ['pop'] }));
    if (ref) s = updatePlanet(withPlanets(s, 'reference'), 'reference', { sampleId: 'r1' });
    if (voice !== 'none') s = updatePlanet(withPlanets(s, 'voice'), 'voice', voice === 'pref' ? { preference: 'male' } : { voiceSampleId: 'v1' });
    if (prod !== 'none') s = updatePlanet(withPlanets(s, 'production'), 'production', prod === 'duration' ? { durationSec: '120' } : { avoid: 'autotune' });
    if (creative) s = updatePlanet(withPlanets(s, 'creativity'), 'creativity', { variety: 2 });
    const label = JSON.stringify({ mode, ref, voice, prod, creative });
    const web = hasErrors(validateSong(s, caps));
    const backend = !backendVerdict(buildGenerationRequest(s)).ok;
    assert.equal(web, backend, `${label}: web=${web ? 'bloquea' : 'permite'} backend=${backend ? 'rechaza' : 'acepta'} (${backendVerdict(buildGenerationRequest(s)).why ?? 'ok'})`);
    checked += 1;
  }
  assert.equal(checked, 108);
});

/* ─────────────── resumen del planeta Estilo (planeta y revisión comparten summarize) ─────────────── */

test('ESTILO · solo descripción libre, sin chips: el resumen muestra el texto real (no «descripción»)', () => {
  const s = updatePlanet(idea(), 'style', { description: 'Cumbia argentina moderna' });
  assert.equal(summarize(s, caps).style, 'Cumbia argentina moderna');
  assert.ok(!/^descripci[oó]n$/i.test(summarize(s, caps).style));
});

test('ESTILO · solo géneros: lista los géneros', () => {
  assert.equal(summarize(updatePlanet(idea(), 'style', { genres: ['Cumbia'] }), caps).style, 'Cumbia');
  assert.equal(summarize(updatePlanet(idea(), 'style', { genres: ['Cumbia', 'Pop'] }), caps).style, 'Cumbia, Pop');
});

test('ESTILO · géneros y descripción: se representan ambos componentes', () => {
  const s = updatePlanet(idea(), 'style', { genres: ['Cumbia', 'Pop'], description: 'voz masculina con coros grupales' });
  assert.equal(summarize(s, caps).style, 'Cumbia, Pop · «voz masculina con coros grupales»');
});

test('ESTILO · descripción larga: se acorta solo en el resumen (en el borde de una palabra o con «…»), no en lo que se envía', () => {
  const long = 'cumbia argentina moderna con voz masculina principal, coros grupales, bajo marcado, teclado cumbiero, güiro y timbal';
  const s = updatePlanet(idea(), 'style', { description: long });
  const shown = summarize(s, caps).style;
  assert.ok(shown.endsWith('…') && shown.length <= 61 && long.startsWith(shown.slice(0, -1)));
  assert.equal(buildGenerationRequest(s).inputs.find((i) => i.field === 'STYLE_DESCRIPTION').text, long, 'el texto persistido/enviado queda completo');
});

test('ESTILO · vacío (o solo espacios): estado vacío, sin inventar una descripción', () => {
  assert.equal(summarize(emptySong, caps).style, 'Sin estilo definido');
  assert.equal(summarize(updatePlanet(emptySong, 'style', { description: '   ' }), caps).style, 'Sin estilo definido');
});

test('ESTILO · el request lleva el texto exacto en STYLE_DESCRIPTION (con y sin géneros) y nada cuando está vacío', () => {
  const onlyText = buildGenerationRequest(updatePlanet(idea(), 'style', { description: '  Cumbia argentina moderna  ' }));
  assert.deepEqual(get(onlyText, 'STYLE_DESCRIPTION'), { field: 'STYLE_DESCRIPTION', text: 'Cumbia argentina moderna' });
  assert.equal(get(onlyText, 'GENRE'), undefined);
  const both = buildGenerationRequest(updatePlanet(idea(), 'style', { genres: ['Pop'], description: 'festiva' }));
  assert.deepEqual(get(both, 'GENRE').value, ['Pop']);
  assert.equal(get(both, 'STYLE_DESCRIPTION').text, 'festiva');
  const none = buildGenerationRequest(idea());
  assert.equal(get(none, 'STYLE_DESCRIPTION'), undefined);
  assert.equal(get(none, 'GENRE'), undefined);
});

test('Estudio de letras: contador y aviso usan el límite real (LIMITS.lyrics) y no afirman que se recorte', () => {
  const src = fs.readFileSync(new URL('../src/features/creator/LyricsStudio.tsx', import.meta.url), 'utf8');
  assert.match(src, /LYRICS_SOFT_LIMIT = LIMITS\.lyrics;/);
  assert.doesNotMatch(src, /se cortar[ií]a/);
  assert.equal(LIMITS.lyrics, 5000);
  // «Mejorar» valida el máximo ANTES de entregar la solicitud al controlador.
  assert.ok(src.indexOf('improveLyricsTooLong(') > -1 && src.indexOf('improveLyricsTooLong((') < src.indexOf('controller.submit(buildBody(opts)'));
});

/* ─────────────── géneros propios y presupuesto de `style` ─────────────── */

const styleOf = (genres, description = '') => ({ genres, description });
const backendReq = (() => {
  try { return createRequire(import.meta.url)('../../melodya.backend/src/providers/music/suno-request.js'); } catch { return null; }
})();

test('géneros propios: agregar con Enter / botón (misma función), vacíos, repetidos, largo y cantidad', () => {
  assert.deepEqual(addGenre([], '  indie   folk ').genres, ['indie folk']);
  assert.equal(addGenre(['Pop'], '   ').status, 'empty');
  assert.equal(addGenre(['Electrónica'], ' ELECTRONICA ').status, 'duplicate', 'ignora mayúsculas, acentos y espacios');
  assert.equal(addGenre(['indie folk'], 'Indie    Folk').status, 'duplicate');
  assert.equal(LIMITS.genreLength, 30);
  assert.equal(addGenre([], 'x'.repeat(30)).status, 'added', '30 caracteres se aceptan');
  assert.equal(addGenre([], 'x'.repeat(31)).status, 'too-long', '31 se rechazan');
  assert.equal(addGenresFromText([], 'x'.repeat(31)).status, 'too-long');
  assert.equal(errorsOf(updatePlanet(idea(), 'style', { genres: ['x'.repeat(30)] }), 'style').length, 0);
  const tooLong = errorsOf(updatePlanet(idea(), 'style', { genres: ['x'.repeat(31)] }), 'style');
  assert.equal(tooLong.length, 1, 'un género heredado de más de 30 bloquea con un mensaje claro');
  assert.match(tooLong[0].message, /hasta 30 caracteres/);
  const eight = Array.from({ length: LIMITS.genres }, (_, i) => `g${i}`);
  assert.equal(addGenre(eight, 'otro').status, 'limit');
  assert.deepEqual(addGenresFromText(['Pop'], 'synthwave, indie folk').genres, ['Pop', 'synthwave', 'indie folk'], 'varios separados por coma');
  assert.equal(addGenresFromText(['Pop'], 'pop').status, 'duplicate');
  assert.deepEqual(removeGenre(['Pop', 'Rock'], ' pop '), ['Rock']);
  assert.equal(genreKey('  Électro  Pop '), 'electro pop');
});

test('géneros propios + predefinidos: mismo estado, borrador y GENRE del payload', () => {
  const genres = ['Cumbia', 'cumbia villera', 'Synthwave'];
  const s = updatePlanet(idea(), 'style', { genres, description: 'bajo marcado' });
  assert.deepEqual(get(buildGenerationRequest(s), 'GENRE').value, genres, 'sin pérdidas ni duplicados');
  assert.equal(get(buildGenerationRequest(s), 'STYLE_DESCRIPTION').text, 'bajo marcado');
  assert.deepEqual(parseSong(JSON.parse(JSON.stringify(s))).style.genres, genres, 'el borrador los recupera');
  // Los tres modos de composición los envían como GENRE.
  for (const mode of ['idea', 'lyrics', 'instrumental']) {
    const m = updatePlanet(comp({ mode, idea: 'una idea larga', lyrics: '[Verse] hola' }), 'style', { genres });
    assert.deepEqual(get(buildGenerationRequest(m), 'GENRE').value, genres, mode);
    assert.equal(errorsOf(m, 'style').length, 0, mode);
  }
  assert.ok(!fields(buildGenerationRequest(updatePlanet(idea(), 'style', { genres: [] }))).includes('GENRE'));
});

test('presupuesto del style: 1000 exactos con y sin géneros; 1001 se rechaza con el total y lo que sobra', () => {
  assert.equal(styleUsage(styleOf([], 'x'.repeat(1000))).used, 1000);
  assert.equal(errorsOf(updatePlanet(idea(), 'style', styleOf([], 'x'.repeat(1000))), 'style').length, 0);
  // 'a, b, c, ' = 9 caracteres de géneros.
  const fit = updatePlanet(idea(), 'style', styleOf(['a', 'b', 'c'], 'x'.repeat(991)));
  assert.equal(styleUsage(fit.style).used, 1000);
  assert.equal(errorsOf(fit, 'style').length, 0);
  const over = updatePlanet(idea(), 'style', styleOf(['a', 'b', 'c'], 'x'.repeat(992)));
  assert.equal(styleUsage(over.style).over, 1);
  const errs = errorsOf(over, 'style');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /1001 de 1000/);
  assert.match(errs[0].message, /sobran 1/);
  assert.equal(hasErrors(validateSong(over, caps)), true, 'bloquea el envío');
  // Espacios sobrantes de la descripción no cuentan (el backend la recorta).
  assert.equal(styleUsage(styleOf([], `  ${'x'.repeat(1000)}  `)).used, 1000);
});

test('presupuesto del style: duplicados, géneros que la descripción ya nombra y separadores', () => {
  assert.equal(styleUsage(styleOf(['Pop', 'pop', ' POP '])).text, 'Pop');
  assert.equal(styleUsage(styleOf(['Pop', 'Rock'], 'bajo')).text, 'Pop, Rock, bajo');
  const named = styleUsage(styleOf(['Synthwave', 'Pop'], 'synthwave oscuro'));
  assert.equal(named.text, 'Pop, synthwave oscuro');
  assert.deepEqual(named.omitted, ['Synthwave']);
  assert.equal(styleUsage(styleOf(['Pop'], 'popular en bares')).text, 'Pop, popular en bares', 'solo palabras completas');
  assert.equal(styleUsage(styleOf(['Electrónica'], 'electronica suave')).omitted.length, 1, 'ignora acentos');
});

test('el contador coincide con el style que arma el planner del backend (paridad)', { skip: backendReq ? false : 'melodya.backend no está junto a melodya_web' }, () => {
  const cases = [
    styleOf([], 'x'.repeat(1000)),
    styleOf(['Cumbia', 'cumbia villera', 'Synthwave'], 'bajo marcado, güiro'),
    styleOf(['Pop', 'pop', 'Electrónica', 'electronica'], 'electronica suave con pop'),
    styleOf(['Synthwave', 'Pop'], 'synthwave oscuro'),
    styleOf(['a', 'b', 'c'], 'x'.repeat(991)),
    styleOf(['a', 'b', 'c'], 'x'.repeat(992)),
    styleOf(['Rock'], ''),
    styleOf([], '  espacios  '),
  ];
  for (const st of cases) {
    const description = backendReq.readPreferences([{ field: 'STYLE_DESCRIPTION', text: st.description }]).description;
    const composed = backendReq.composeStyle({ genres: backendReq.toList(st.genres), description, tail: '', limit: 1000 });
    const u = styleUsage(st);
    assert.equal(u.text, composed.style, JSON.stringify(st).slice(0, 80));
    assert.equal(u.over > 0, composed.overflow, 'mismo veredicto de desborde');
  }
});

/* ─────────────── normalización de géneros y paridad con la idea como cola ─────────────── */

test('normalizeGenres y payload: espacios dobles y repetidos (también acentos y mayúsculas) salen limpios y una sola vez', () => {
  assert.deepEqual(normalizeGenres(['indie  folk', ' Indie Folk ', 'Electrónica', 'electronica', '', '  ', 'Pop']), ['indie folk', 'Electrónica', 'Pop']);
  const s = updatePlanet(idea(), 'style', { genres: ['indie  folk', 'INDIE FOLK', 'Pop', 'pop'] });
  assert.deepEqual(get(buildGenerationRequest(s), 'GENRE').value, ['indie folk', 'Pop']);
  assert.ok(!fields(buildGenerationRequest(updatePlanet(idea(), 'style', { genres: ['  ', ''] }))).includes('GENRE'), 'solo vacíos: no se envía GENRE');
  // El estado de la interfaz no se reescribe al enviar; el contador usa los mismos géneros que el payload.
  assert.deepEqual(s.style.genres, ['indie  folk', 'INDIE FOLK', 'Pop', 'pop']);
  assert.equal(styleUsage(s.style).text, 'indie folk, Pop');
});

test('borrador antiguo con géneros repetidos o con espacios: se recupera normalizado y no provoca errores por duplicados', () => {
  const old = { composition: { mode: 'idea', idea: 'una idea larga' }, style: { genres: ['Rock', 'rock', ' Synthwave ', 'synthwave', 'indie   folk', 7, ''], description: 'bajo' } };
  const s = parseSong(old);
  assert.deepEqual(s.style.genres, ['Rock', 'Synthwave', 'indie folk']);
  assert.deepEqual(get(buildGenerationRequest(s), 'GENRE').value, ['Rock', 'Synthwave', 'indie folk']);
  assert.equal(errorsOf(s, 'style').length, 0);
  assert.deepEqual(parseSong(JSON.parse(JSON.stringify(s))).style.genres, s.style.genres, 'idempotente');
});

test('paridad real: el GENRE del payload, pasado por el planner del backend, da el mismo style que el contador (con y sin idea como cola)', { skip: backendReq ? false : 'melodya.backend no está junto a melodya_web' }, () => {
  const specs = [
    { genres: ['indie  folk', 'Indie Folk', 'Pop', 'pop'], description: 'indie folk suave' },
    { genres: ['Electrónica', 'electronica', 'Cumbia villera'], description: 'bajo marcado' },
    { genres: ['a', 'b', 'c'], description: 'x'.repeat(991) },
    { genres: ['a', 'b', 'c'], description: 'x'.repeat(992) },
    { genres: [], description: 'x'.repeat(1000) },
    { genres: ['Pop'], description: 'e'.repeat(900) },
    { genres: ['Pop'], description: 'e'.repeat(985) },
  ];
  for (const st of specs) {
    // Instrumental: la IDEA viaja y el planner la agrega como cola solo en el espacio que sobra.
    const s = updatePlanet(comp({ mode: 'instrumental', idea: 'una canción sobre el mar y la lluvia en la ciudad' }), 'style', st);
    const req = buildGenerationRequest(s);
    const inputs = req.inputs;
    const prefs = backendReq.readPreferences(inputs);
    const ideaText = inputs.find((i) => i.field === 'IDEA')?.text ?? '';
    const noTail = backendReq.composeStyle({ genres: prefs.genres, description: prefs.description, tail: '', limit: 1000 });
    const withTail = backendReq.composeStyle({ genres: prefs.genres, description: prefs.description, tail: ideaText, limit: 1000 });
    const u = styleUsage(s.style);
    const label = JSON.stringify({ g: st.genres, d: st.description.length });
    assert.equal(u.text, noTail.style, label);
    assert.equal(u.over > 0, noTail.overflow, label);
    if (!noTail.overflow) {
      assert.ok(withTail.style.length <= 1000, `${label}: el style con idea no supera 1000 (${withTail.style.length})`);
      assert.ok(withTail.style.startsWith(u.text), `${label}: la idea solo se agrega al final, no cambia lo contado`);
      assert.ok(u.used <= withTail.style.length);
    }
  }
});

test('la idea se suma al style solo donde el planner la agrega (ideaJoinsStyle) y siempre cabe en los 1000', { skip: backendReq ? false : 'melodya.backend no está junto a melodya_web' }, () => {
  const { planSunoRequest } = createRequire(import.meta.url)('../../melodya.backend/src/providers/music/suno-plan.js');
  const IDEA = 'una canción sobre el mar y la lluvia en la ciudad';
  const styled = { genres: ['Pop'], description: 'bajo marcado' };
  const matrix = [
    ['instrumental + idea + estilo', comp({ mode: 'instrumental', idea: IDEA }), styled, true],
    ['instrumental + idea, sin estilo ni controles', comp({ mode: 'instrumental', idea: IDEA }), { genres: [], description: '' }, false],
    ['instrumental sin idea', comp({ mode: 'instrumental', idea: '' }), styled, false],
    ['guiado (la letra la escribe Melodya)', comp({ mode: 'idea', idea: IDEA }), styled, false],
    ['letra propia', comp({ mode: 'lyrics', idea: IDEA, lyrics: '[Verse] hola' }), styled, false],
    ['instrumental + idea + descripción larga (sin lugar)', comp({ mode: 'instrumental', idea: IDEA }), { genres: ['Pop'], description: 'e'.repeat(985) }, true],
  ];
  for (const [name, base, st, expected] of matrix) {
    const s = updatePlanet(base, 'style', st);
    assert.equal(ideaJoinsStyle(s), expected, name);
    const req = buildGenerationRequest(s);
    const plan = planSunoRequest({ inputs: req.inputs, options: { ...req.options }, ctx: { modelCode: 'V6', pendingLyrics: req.options.generateLyricsIfMissing }, model: { code: 'V6' }, callBackUrl: 'https://example.test/cb' });
    assert.deepEqual(plan.errors, [], name);
    const own = styleUsage(s.style).text;
    const sent = plan.body.style ?? '';
    assert.ok(sent.length <= 1000, `${name}: lo enviado a Suno no supera 1000 (${sent.length})`);
    assert.ok(sent.startsWith(own), `${name}: el estilo propio queda intacto al principio`);
    // Sin cola el style es lo contado; sin estilo propio, Suno exige uno y el planner usa la idea en su lugar (no hay presupuesto de usuario que descontar).
    if (!expected) assert.equal(sent, own || IDEA.slice(0, 1000), `${name}: sin cola, el style es exactamente lo contado`);
  }
  // Donde sí entra, ocupa lo que sobra y el total nunca pasa de 1000.
  const s = updatePlanet(comp({ mode: 'instrumental', idea: IDEA }), 'style', { genres: ['Pop'], description: 'e'.repeat(900) });
  const req = buildGenerationRequest(s);
  const plan = planSunoRequest({ inputs: req.inputs, options: { ...req.options }, ctx: { modelCode: 'V6' }, model: { code: 'V6' }, callBackUrl: 'https://example.test/cb' });
  assert.ok(plan.body.style.length > styleUsage(s.style).used && plan.body.style.length <= 1000);
  assert.ok(plan.body.style.endsWith(IDEA));
});

/* ─────────────── Influencia del audio (AUDIO_WEIGHT) ─────────────── */

const { audioWeightApplies } = M;
const withRef = (s, id = 'r1') => updatePlanet(withPlanets(s, 'reference'), 'reference', { sampleId: id });
const lyricsSong = (extra = {}) => comp({ mode: 'lyrics', lyrics: '[Verso]\nhola', ...extra });
const coverSong = (weight = 0.42) => updatePlanet(withPlanets(withRef(lyricsSong()), 'creativity'), 'creativity', { audioWeight: weight });
const instrumental = () => updatePlanet(comp({ mode: 'instrumental', idea: 'x' }), 'style', { genres: ['jazz'] });

test('AUDIO_WEIGHT · solo aplica con referencia + letra (cover) y, con capacidades, si el audio sigue existiendo', () => {
  assert.equal(audioWeightApplies(coverSong(), caps), true);
  assert.equal(audioWeightApplies(coverSong()), true);
  assert.equal(audioWeightApplies(withRef(idea()), caps), true, 'idea con letra de Melodya también es cover');
  assert.equal(audioWeightApplies(lyricsSong(), caps), false, 'sin audio de referencia');
  assert.equal(audioWeightApplies(withRef(instrumental()), caps), false, 'instrumental: el audio es solo guía y Suno no lo admite sin voces');
  assert.equal(audioWeightApplies(withRef(lyricsSong(), 'eliminado'), caps), false, 'audio eliminado o vencido: no habilita el control');
  assert.equal(audioWeightApplies(withPlanets(lyricsSong(), 'reference'), caps), false, 'planeta agregado pero sin audio elegido');
});

test('AUDIO_WEIGHT · se envía con el valor exacto solo en cover; automático no envía nada', () => {
  assert.strictEqual(get(buildGenerationRequest(coverSong(0.42)), 'AUDIO_WEIGHT').value, 0.42);
  assert.strictEqual(get(buildGenerationRequest(coverSong(0)), 'AUDIO_WEIGHT').value, 0, '0 es un valor explícito, no automático');
  assert.strictEqual(get(buildGenerationRequest(coverSong(1)), 'AUDIO_WEIGHT').value, 1);
  assert.equal(get(buildGenerationRequest(coverSong(null)), 'AUDIO_WEIGHT'), undefined, 'automático: no se envía');
  assert.deepEqual(fields(buildGenerationRequest(coverSong(0.3))), ['LYRICS', 'REFERENCE_SAMPLE', 'AUDIO_WEIGHT']);
});

test('AUDIO_WEIGHT · un valor guardado NO viaja si la ruta ya no es cover (instrumental, sin audio, sin planeta de creatividad)', () => {
  const stale = coverSong(0.6);
  assert.equal(get(buildGenerationRequest(updatePlanet(stale, 'composition', { mode: 'instrumental', idea: 'x' })), 'AUDIO_WEIGHT'), undefined);
  assert.equal(get(buildGenerationRequest(removePlanet(stale, 'creativity')), 'AUDIO_WEIGHT'), undefined, 'planeta quitado: no deja datos');
  const noRef = removePlanet(stale, 'reference');
  assert.equal(noRef.creativity.audioWeight, null, 'quitar la referencia devuelve la influencia a automático');
  assert.equal(get(buildGenerationRequest(noRef), 'AUDIO_WEIGHT'), undefined);
});

test('AUDIO_WEIGHT · cambiar o vaciar el audio reinicia el valor; elegir el mismo audio no lo toca', () => {
  const s = coverSong(0.6);
  assert.equal(updatePlanet(s, 'reference', { sampleId: 'r1' }).creativity.audioWeight, 0.6, 'mismo audio');
  assert.equal(updatePlanet(s, 'reference', { sampleId: 'rLong' }).creativity.audioWeight, null, 'otro audio');
  assert.equal(updatePlanet(s, 'reference', { sampleId: null }).creativity.audioWeight, null, 'sin audio');
});

test('AUDIO_WEIGHT · no afecta a las demás rutas ni al envío existente (regresión)', () => {
  assert.deepEqual(fields(buildGenerationRequest(updatePlanet(withPlanets(idea(), 'creativity'), 'creativity', { styleWeight: 0.7, variety: 3 }))), ['IDEA', 'STYLE_WEIGHT', 'VARIETY']);
  assert.equal(predictRoute(coverSong(0.5)).endpoint, 'cover');
  assert.equal(predictRoute(withRef(instrumental())).endpoint, 'reference');
  // el valor no cuenta como «control de creatividad» que rechaza la guía (y tampoco se envía)
  const guide = updatePlanet(withPlanets(withRef(instrumental()), 'creativity'), 'creativity', { audioWeight: 0.5 });
  assert.equal(errorsOf(guide, 'creativity').length, 0);
  assert.equal(get(buildGenerationRequest(guide), 'AUDIO_WEIGHT'), undefined);
});

test('AUDIO_WEIGHT · resumen y borrador: se muestra solo si aplica y el borrador lo valida', () => {
  assert.match(summarize(coverSong(0.42), caps).creativity, /audio 42%/);
  assert.equal(summarize(updatePlanet(coverSong(0.42), 'composition', { mode: 'instrumental', idea: 'x' }), caps).creativity, 'Automática');
  const raw = () => JSON.parse(JSON.stringify(coverSong(0.42)));
  assert.equal(parseSong(raw()).creativity.audioWeight, 0.42);
  assert.equal(parseSong({ ...raw(), creativity: { audioWeight: 7 } }).creativity.audioWeight, null, 'fuera de rango se descarta');
  assert.equal(parseSong({ ...raw(), creativity: { audioWeight: 0.123 } }).creativity.audioWeight, 0.12, 'se redondea a 2 decimales');
  const noRefDraft = raw(); noRefDraft.reference = { sampleId: null };
  assert.equal(parseSong(noRefDraft).creativity.audioWeight, null, 'un borrador sin audio no conserva la influencia');
  assert.equal(parseSong({}).creativity.audioWeight, null);
});

test('AUDIO_WEIGHT · el planeta Creatividad: cuarto control solo con audioApplies, pasos de 0,01 y Automático', () => {
  const src = (f) => fs.readFileSync(path.resolve(import.meta.dirname, `../src/features/creator/${f}`), 'utf8').replace(/\r\n/g, '\n');
  const editors = src('PlanetEditors.tsx');
  const wizard = src('CreatorWizard.tsx');
  assert.match(editors, /\{audioApplies && \(\s*<UnitControl id="cr-audio" label="Influencia del audio"[\s\S]*?step=\{1\}/);
  assert.match(editors, /audioApplies = false/);
  assert.match(editors, /function UnitControl\([^)]*step = 5/s, 'los otros controles conservan su paso de 5');
  assert.match(editors, /step=\{step\}/);
  assert.match(wizard, /audioApplies=\{audioWeightApplies\(song, caps\)\}/);
});
