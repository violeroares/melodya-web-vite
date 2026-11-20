// Remix (canción NUEVA a partir de otra): URL, plantilla segura, configuración propia vs ajena, ruta de Suno, solicitud, menús y atribución.
// Dos modalidades: Versionar (Cover, con el audio de la versión) y Reutilizar configuración (letra y estilo, sin audio).
// «Crear otra versión» es otra cosa y no cambia. Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M = await import('../src/features/creator/song-model.ts');
const R = await import('../src/features/creator/remix-source.ts');
const A = await import('../src/features/song/remix-attribution.ts');
const C = await import('../src/lib/capabilities.ts');

const { emptySong, updatePlanet, addPlanet, availability, predictRoute, audioWeightApplies, buildGenerationRequest, validateSong, hasErrors, ideaJoinsStyle, parseSong, isEmptySong, describeTreatment } = M;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const caps = { voices: [], references: [{ id: 'r1', name: 'Beatbox', durationSec: 30 }] };
const get = (req, f) => req.inputs.find((i) => i.field === f);
const fields = (req) => req.inputs.map((i) => i.field);
const errorsOf = (s, planet) => validateSong(s, caps).filter((i) => i.severity === 'error' && (!planet || i.planet === planet));

const template = (over = {}) => ({
  source: { songId: 'song-1', versionId: 'ver-1', versionNumber: 2, title: 'Luces de Neón', author: { id: 'u1', name: 'Ana' } },
  isOwner: false,
  modes: { COVER: { available: true }, PROMPT_REUSE: { available: true } },
  suggestedTitle: 'Luces de Neón',
  lyrics: '[Verso]\nhola',
  instrumental: false,
  genres: ['Rock', 'Blues'],
  tags: ['guitarra', 'nocturno'],
  styleSummary: 'Rock íntimo con guitarra',
  ...over,
});

/* ───────────── URL y modalidades ───────────── */

test('URL: /create?remix=<id>&mode=cover|prompt[&from=<versión>] y modalidad por defecto segura', () => {
  assert.equal(R.modeFromParam('cover'), 'COVER');
  assert.equal(R.modeFromParam('prompt'), 'PROMPT_REUSE');
  assert.equal(R.modeFromParam(null), 'PROMPT_REUSE', 'sin modalidad: la que no usa el audio');
  assert.equal(R.modeFromParam('cualquier-cosa'), 'PROMPT_REUSE');
  assert.equal(R.remixUrl('song-1', 'COVER'), '/create?remix=song-1&mode=cover');
  assert.equal(R.remixUrl('song-1', 'PROMPT_REUSE', 'ver 2'), '/create?remix=song-1&mode=prompt&from=ver%202');
  assert.equal(R.paramFromMode('COVER'), 'cover');
  assert.deepEqual({ ...R.MODE_LABEL }, { COVER: 'Versionar (Cover)', PROMPT_REUSE: 'Reutilizar configuración' });
});

/* ───────────── Canción de otra persona: solo la plantilla ───────────── */

test('ajena con letra: copia letra y estilo público, título sugerido y deja la creatividad en Automático', () => {
  const h = R.songFromTemplate(template(), 'PROMPT_REUSE');
  const s = h.song;
  assert.equal(s.composition.mode, 'lyrics');
  assert.equal(s.composition.lyrics, '[Verso]\nhola');
  assert.equal(s.composition.title, 'Luces de Neón');
  assert.deepEqual(s.style.genres, ['Rock', 'Blues']);
  assert.equal(s.style.description, 'Rock íntimo con guitarra');
  assert.deepEqual(s.creativity, { styleWeight: null, weirdness: null, variety: null, audioWeight: null });
  assert.deepEqual(s.planets, [], 'ni voces, ni referencias, ni producción: nada privado');
  assert.deepEqual(s.production, { durationSec: '', avoid: '' });
  assert.deepEqual(s.voice, { preference: '', voiceSampleId: null });
  assert.deepEqual(s.remix, { mode: 'PROMPT_REUSE' });
  assert.equal(h.source, 'version');
  assert.deepEqual(h.samples, []);
});

test('ajena sin letra: arranca instrumental y NUNCA inventa una letra; el estilo cae a las etiquetas si no hay resumen', () => {
  const s = R.songFromTemplate(template({ lyrics: null, instrumental: true, styleSummary: null }), 'COVER').song;
  assert.equal(s.composition.mode, 'instrumental');
  assert.equal(s.composition.lyrics, '');
  assert.equal(s.style.description, 'guitarra, nocturno');
  assert.deepEqual(s.remix, { mode: 'COVER' });
  const blank = R.songFromTemplate(template({ lyrics: '   \n', instrumental: true }), 'COVER').song;
  assert.equal(blank.composition.mode, 'instrumental', 'una letra en blanco tampoco cuenta');
});

test('sin avisos propios: el creador no agrega mensajes bajo el título (ocupaban mucho lugar en móvil)', () => {
  for (const mode of ['COVER', 'PROMPT_REUSE']) {
    assert.deepEqual(R.songFromTemplate(template(), mode).notes, [], `ajena con letra · ${mode}`);
    assert.deepEqual(R.songFromTemplate(template({ lyrics: null }), mode).notes, [], `ajena instrumental · ${mode}`);
  }
  const src = read('src/features/creator/remix-source.ts');
  for (const id of ['remix-template', 'remix-instrumental', 'remix-cover-production']) assert.equal(src.includes(id), false, id);
  assert.equal(/Copiamos la letra|usamos el audio de la canción original como referencia/.test(src), false);
});

test('ajena: lo largo se acota a los límites del contrato (no se rechaza una canción por tener un resumen largo)', () => {
  const s = R.songFromTemplate(template({ styleSummary: 'x'.repeat(5000), lyrics: 'y'.repeat(9000) }), 'PROMPT_REUSE').song;
  assert.equal(s.style.description.length, M.LIMITS.description);
  assert.equal(s.composition.lyrics.length, M.LIMITS.lyrics);
});

/* ───────────── Canción propia: configuración original adaptada ───────────── */

function ownerHydration() {
  let s = updatePlanet(emptySong, 'composition', { mode: 'lyrics', lyrics: 'mi letra', title: '' });
  s = addPlanet(addPlanet(addPlanet(addPlanet(s, 'voice'), 'reference'), 'production'), 'creativity');
  s = updatePlanet(s, 'voice', { preference: 'female' });
  s = updatePlanet(s, 'reference', { sampleId: 'r1' });
  s = updatePlanet(s, 'production', { durationSec: '', avoid: 'autotune' });
  s = updatePlanet(s, 'creativity', { styleWeight: 0.7, weirdness: 0.2, variety: 3, audioWeight: 0.4 });
  return { song: s, notes: [{ id: 'n1', tone: 'info', text: 'nota previa' }], source: 'generation', samples: [{ id: 'r1' }] };
}

test('propia · Cover: recupera creatividad y AUDIO_WEIGHT, quita la referencia original (la reemplaza el audio de la versión) y la exclusión', () => {
  const h = R.adaptOwnerHydration(ownerHydration(), template({ isOwner: true }), 'COVER');
  assert.deepEqual(h.song.creativity, { styleWeight: 0.7, weirdness: 0.2, variety: 3, audioWeight: 0.4 });
  assert.equal(h.song.planets.includes('reference'), false);
  assert.equal(h.song.reference.sampleId, null);
  assert.equal(h.song.planets.includes('production'), false, 'upload-cover no admite exclusiones ni duración');
  assert.deepEqual(h.song.production, { durationSec: '', avoid: '' });
  assert.equal(h.song.voice.preference, 'female', 'la voz se conserva');
  assert.equal(h.song.composition.title, 'Luces de Neón');
  assert.deepEqual(h.song.remix, { mode: 'COVER' });
  assert.equal(h.notes.some((n) => n.id === 'remix-cover-production'), false, 'sin aviso propio');
  assert.ok(h.notes.some((n) => n.id === 'n1'), 'las notas previas se conservan');
  assert.equal(h.samples.length, 1);
});

test('propia · Reutilizar configuración: conserva todo lo recuperable, incluida su propia referencia', () => {
  const h = R.adaptOwnerHydration(ownerHydration(), template({ isOwner: true }), 'PROMPT_REUSE');
  assert.equal(h.song.reference.sampleId, 'r1');
  assert.equal(h.song.planets.includes('reference'), true);
  assert.equal(h.song.production.avoid, 'autotune');
  assert.deepEqual(h.song.remix, { mode: 'PROMPT_REUSE' });
  assert.equal(h.notes.some((n) => n.id === 'remix-cover-production'), false);
});

test('propia: no muta la hidratación original ni toca el estado de «Otra versión»', () => {
  const original = ownerHydration();
  const snapshot = JSON.stringify(original);
  R.adaptOwnerHydration(original, template(), 'COVER');
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(original.song.remix, null);
});

/* ───────────── Ruta de Suno, validación y solicitud ───────────── */

const coverState = (over = {}) => {
  const s = R.songFromTemplate(template(over), 'COVER').song;
  return s;
};

test('Cover: la ruta es SIEMPRE upload-cover (con letra o instrumental) y AUDIO_WEIGHT aplica sin elegir una muestra', () => {
  const sung = coverState();
  assert.deepEqual(predictRoute(sung), { custom: true, withReference: true, endpoint: 'cover' });
  assert.equal(audioWeightApplies(sung), true);
  assert.equal(audioWeightApplies(sung, caps), true);
  const instr = coverState({ lyrics: null, instrumental: true });
  assert.equal(predictRoute(instr).endpoint, 'cover', 'un instrumental con Cover NO cae en la ruta de guía');
  assert.equal(audioWeightApplies(instr), true);
  assert.equal(ideaJoinsStyle(updatePlanet(instr, 'composition', { idea: 'más oscuro' })), true, 'la idea se incorpora al estilo (el planificador la anexa)');
});

test('Reutilizar configuración no cambia la ruta: sin referencia propia es la creación normal', () => {
  const s = R.songFromTemplate(template(), 'PROMPT_REUSE').song;
  assert.equal(predictRoute(s).endpoint, 'standard');
  assert.equal(audioWeightApplies(s), false);
  const withOwnRef = updatePlanet(addPlanet(s, 'reference'), 'reference', { sampleId: 'r1' });
  assert.equal(predictRoute(withOwnRef).endpoint, 'cover', 'con su propia referencia y letra: el flujo normal de referencia');
});

test('solicitud · Cover instrumental: instrumental, sin letra ni REFERENCE_SAMPLE, AUDIO_WEIGHT exacto, título propio y remix', () => {
  let s = coverState({ lyrics: null, instrumental: true });
  s = addPlanet(s, 'creativity');
  s = updatePlanet(s, 'creativity', { audioWeight: 0.3, variety: 2 });
  const req = buildGenerationRequest(s, { remix: { songId: 'song-1', versionId: 'ver-1' } });
  assert.equal(req.options.instrumental, true);
  assert.equal(get(req, 'LYRICS'), undefined, 'no se inventa una letra');
  assert.equal(get(req, 'REFERENCE_SAMPLE'), undefined, 'el audio lo agrega el servidor');
  assert.strictEqual(get(req, 'AUDIO_WEIGHT').value, 0.3);
  assert.strictEqual(get(req, 'VARIETY').value, 2);
  assert.equal(req.title, 'Luces de Neón');
  assert.deepEqual(req.remix, { songId: 'song-1', versionId: 'ver-1', mode: 'COVER' });
  assert.equal(get(req, 'GENRE').value.join(','), 'Rock,Blues');
});

test('solicitud · Cover con letra y AUDIO_WEIGHT en Automático: la letra viaja, no se envía ningún valor de influencia', () => {
  const req = buildGenerationRequest(coverState(), { remix: { songId: 'song-1' } });
  assert.equal(get(req, 'LYRICS').text, '[Verso]\nhola');
  assert.equal(get(req, 'AUDIO_WEIGHT'), undefined);
  assert.equal(get(req, 'VARIETY'), undefined);
  assert.deepEqual(req.remix, { songId: 'song-1', mode: 'COVER' });
  assert.equal(req.options.instrumental, undefined);
});

test('solicitud · Reutilizar configuración: letra y estilo, sin audio; con referencia propia envía el REFERENCE_SAMPLE normal', () => {
  const s = R.songFromTemplate(template(), 'PROMPT_REUSE').song;
  const plain = buildGenerationRequest(s, { remix: { songId: 'song-1', versionId: 'ver-1' } });
  assert.equal(get(plain, 'REFERENCE_SAMPLE'), undefined);
  assert.deepEqual(plain.remix, { songId: 'song-1', versionId: 'ver-1', mode: 'PROMPT_REUSE' });
  const own = buildGenerationRequest(updatePlanet(addPlanet(s, 'reference'), 'reference', { sampleId: 'r1' }), { remix: { songId: 'song-1' } });
  assert.equal(get(own, 'REFERENCE_SAMPLE').sampleId, 'r1');
});

test('solicitud · «Crear otra versión» y la creación normal NO llevan remix, y una versión sigue sin título', () => {
  const s = updatePlanet(emptySong, 'composition', { mode: 'lyrics', lyrics: 'l', title: 'Mi tema' });
  assert.equal('remix' in buildGenerationRequest(s), false);
  assert.equal('remix' in buildGenerationRequest(s, { versionOfId: 'song-9' }), false);
  assert.equal('title' in buildGenerationRequest(s, { versionOfId: 'song-9' }), false, 'otra versión: sin título');
  assert.equal(buildGenerationRequest(s).title, 'Mi tema');
  // un estado sin `remix` nunca envía el campo aunque se pida (la marca vive en el estado)
  assert.equal('remix' in buildGenerationRequest(s, { remix: { songId: 'song-1' } }), false);
});

test('validación · Cover: sin duración ni exclusiones, sin otro audio de referencia; un instrumental necesita estilo o idea', () => {
  let s = coverState();
  assert.equal(hasErrors(validateSong(s, caps)), false);
  s = addPlanet(s, 'production');
  assert.equal(errorsOf(updatePlanet(s, 'production', { durationSec: '120' }), 'production').length, 1);
  assert.equal(errorsOf(updatePlanet(s, 'production', { avoid: 'autotune' }), 'production').length, 1);
  assert.match(errorsOf(updatePlanet(s, 'production', { avoid: 'autotune' }), 'production')[0].message, /Quitá las exclusiones/);
  // otro audio de referencia: el planeta ni se puede agregar, y si estuviera sería un error
  const row = availability(coverState(), undefined).find((a) => a.def.id === 'reference');
  assert.equal(row.available, false);
  assert.match(row.reason, /audio de la canción original/);
  const forced = { ...coverState(), planets: ['reference'] };
  assert.equal(errorsOf(forced, 'reference').some((e) => /Un Cover ya usa el audio/.test(e.message)), true);
  // el instrumental mantiene la regla de siempre (estilo o idea)
  const bare = { ...coverState({ lyrics: null, instrumental: true, genres: [], tags: [], styleSummary: null }) };
  assert.equal(errorsOf(bare, 'style').length, 1);
  assert.equal(errorsOf(updatePlanet(bare, 'composition', { idea: 'algo más oscuro' }), 'style').length, 0);
});

test('validación · la creatividad y la voz conviven con un Cover; en Reutilizar configuración, la referencia propia sí se puede sumar', () => {
  let s = addPlanet(addPlanet(coverState(), 'creativity'), 'voice');
  s = updatePlanet(updatePlanet(s, 'creativity', { styleWeight: 0.5, weirdness: 0.3, variety: 1, audioWeight: 0.6 }), 'voice', { preference: 'male' });
  assert.equal(hasErrors(validateSong(s, caps)), false);
  const row = availability(R.songFromTemplate(template(), 'PROMPT_REUSE').song).find((a) => a.def.id === 'reference');
  assert.equal(row.available, true);
});

test('tratamiento: el Cover explica que se transforma el audio de la canción ORIGINAL (no «tu audio»)', () => {
  const text = describeTreatment(coverState()).map((t) => t.text).join(' ');
  assert.match(text, /El audio de la canción original se transforma conservando su melodía/);
  assert.doesNotMatch(text, /Tu audio se transforma/);
});

test('borrador: el remix vive en la URL y nunca se guarda ni se restaura', () => {
  const stored = JSON.parse(JSON.stringify(coverState()));
  assert.equal(stored.remix.mode, 'COVER');
  assert.equal(parseSong(stored).remix, null);
  assert.equal(isEmptySong(emptySong), true);
});

/* ───────────── Errores de la plantilla ───────────── */

test('errores: 404 / 403 REMIX_NOT_ALLOWED / 422 por versión, audio y largo se explican sin revelar nada del original', () => {
  const k = R.classifyTemplateError;
  assert.equal(k(404, 'NOT_FOUND', undefined), 'not-found');
  assert.equal(k(403, 'FORBIDDEN', 'REMIX_NOT_ALLOWED'), 'not-allowed');
  assert.equal(k(422, 'UNPROCESSABLE', 'REMIX_VERSION_NOT_CURRENT'), 'not-current');
  assert.equal(k(422, 'UNPROCESSABLE', 'REMIX_AUDIO_UNAVAILABLE'), 'unavailable');
  assert.equal(k(422, 'UNPROCESSABLE', 'REMIX_AUDIO_TOO_LONG'), 'too-long');
  assert.equal(k(500, 'INTERNAL', undefined), 'error');
  assert.equal(k(undefined, undefined, undefined), 'error');
  for (const text of Object.values(R.BLOCKED_TEXT)) assert.ok(text.length > 10);
  assert.doesNotMatch(R.BLOCKED_TEXT['not-found'], /privada|Papelera|bloque/i, 'no distingue por qué no está disponible');
});

test('modalidades: Cover no disponible si el audio supera el límite; Reutilizar configuración siempre', () => {
  const long = template({ modes: { COVER: { available: false, code: 'REMIX_AUDIO_TOO_LONG' }, PROMPT_REUSE: { available: true } } });
  assert.deepEqual(R.modeAvailability(long, 'COVER'), { ok: false, kind: 'too-long' });
  assert.deepEqual(R.modeAvailability(long, 'PROMPT_REUSE'), { ok: true });
  assert.deepEqual(R.modeAvailability(null, 'COVER'), { ok: true });
});

/* ───────────── Menú: quién ve «Remix» ───────────── */

test('menú: el dueño ve Remix con audio; otra persona solo en una pública con allowRemix y con sesión', () => {
  const base = { isOwner: false, signedIn: true, visibility: 'PUBLIC', allowRemix: true, hasAudio: true };
  assert.equal(R.remixMenuState(base).visible, true);
  assert.equal(R.remixMenuState({ ...base, allowRemix: false }).visible, false, 'allowRemix apagado (por defecto)');
  assert.equal(R.remixMenuState({ ...base, allowRemix: undefined }).visible, false);
  assert.equal(R.remixMenuState({ ...base, visibility: 'PRIVATE' }).visible, false);
  assert.equal(R.remixMenuState({ ...base, signedIn: false }).visible, false, 'invitado');
  assert.equal(R.remixMenuState({ ...base, hasAudio: false }).visible, false);
  assert.equal(R.remixMenuState({ ...base, isOwner: true, allowRemix: false, visibility: 'PRIVATE' }).visible, true, 'el dueño remixa lo suyo aunque sea privado');
  assert.equal(R.remixMenuState({ ...base, isOwner: true, hasAudio: false }).visible, false);
});

test('menú: los bloqueos del plan salen de las capacidades EFECTIVAS (nunca se bloquea lo que el servidor no exige)', () => {
  const ent = (remix, ref) => ({ SONG_REMIX: remix, AUDIO_REFERENCE: ref });
  assert.equal(C.creatorLocks(ent({ enabled: false, enforced: true })).remix, C.LOCK_REASON.SONG_REMIX);
  assert.equal(C.creatorLocks(ent({ enabled: false, enforced: false })).remix, undefined, 'sin punto de control activo: no se bloquea');
  assert.equal(C.creatorLocks(ent({ enabled: true, enforced: true })).remix, undefined);
  assert.equal(C.creatorLocks({}).remix, undefined);
  assert.equal(C.creatorLocks(null).remix, undefined);
  // Cover además necesita AUDIO_REFERENCE (planeta de referencia)
  assert.ok(C.creatorLocks(ent({ enabled: true, enforced: true }, { enabled: false, enforced: true })).planets.reference);
  const s = R.remixMenuState({ isOwner: true, signedIn: true, visibility: 'PRIVATE', hasAudio: true, remixLock: 'x' });
  assert.equal(s.lockedReason, 'x');
  assert.equal(R.remixMenuState({ isOwner: true, signedIn: true, visibility: 'PRIVATE', hasAudio: true, audioReferenceLock: 'ref' }).coverLockedReason, 'ref');
});

/* ───────────── Atribución ───────────── */

test('atribución (vista): canción original y autor; sin versión ni modalidad; la atribución completa no se toca', () => {
  const origin = { kind: 'COVER', available: true, versionNumber: 3, song: { id: 's1', title: 'Luces', coverUrl: '/api/files/f1/stream' }, author: { id: 'u1', name: 'Ana' } };
  const snapshot = JSON.stringify(origin);
  const v = A.remixAttributionView(origin);
  assert.deepEqual(v, { available: true, songId: 's1', title: 'Luces', coverUrl: '/api/files/f1/stream', authorId: 'u1', authorName: 'Ana' });
  assert.equal(/V3|Cover|COVER|versionad|reutiliz/i.test(JSON.stringify(v).replace(/coverUrl/g, '')), false, 'ni versión ni modalidad en la vista');
  assert.equal(JSON.stringify(origin), snapshot, 'SongOrigin conserva la atribución completa (kind, versionNumber…)');
  assert.deepEqual(A.remixAttributionView({ kind: 'PROMPT_REUSE', available: true, song: { id: 's1', title: 'Luces' } }), { available: true, songId: 's1', title: 'Luces', coverUrl: null, authorId: null, authorName: null });
  assert.equal(A.remixAttributionView(null), null);
  assert.equal(A.remixAttributionView(undefined), null);
});

test('atribución (vista): sin acceso al original no hay título, autor, portada ni enlaces — aunque el servidor enviara de más', () => {
  assert.deepEqual(A.remixAttributionView({ kind: 'COVER', available: false }), { available: false });
  const leaky = A.remixAttributionView({ kind: 'COVER', available: false, song: { id: 's1', title: 'Secreta', coverUrl: '/api/files/secreta/stream' }, author: { id: 'u-secreto', name: 'Reservado' }, versionNumber: 2 });
  assert.deepEqual(leaky, { available: false });
  assert.equal(/Secreta|Reservado|u-secreto|s1|secreta.stream/.test(JSON.stringify(leaky)), false, 'sin portada del original si no está disponible');
  // disponible pero sin datos de la canción: tampoco se inventa nada
  assert.deepEqual(A.remixAttributionView({ kind: 'COVER', available: true }), { available: false });
});

test('atribución: las rutas llevan al detalle de la canción original y al perfil público del autor original (ids codificados)', () => {
  assert.equal(A.originSongPath('s1'), '/songs/s1');
  assert.equal(A.originAuthorPath('u1'), '/user/u1');
  assert.equal(A.originSongPath('a/b c'), '/songs/a%2Fb%20c');
  // mismas rutas que ya usa el detalle para el autor y la Biblioteca para la canción
  assert.match(read('src/features/song/SongDetailView.tsx'), /to=\{`\/user\/\$\{encodeURIComponent\(community\.author\.id\)\}`\}/);
  assert.match(read('src/features/library/SongsTab.tsx'), /navigate\(`\/songs\/\$\{song\.id\}`\)/);
});

test('componente «Hecho a partir de»: portada circular real + etiqueta + título + autor, con enlaces independientes y sin comillas', () => {
  const src = read('src/features/song/RemixAttribution.tsx');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // portada circular a la izquierda, con la portada real del original (no genérica) y navegación al original
  assert.match(src, /<CoverArt id=\{view\.songId\} src=\{view\.coverUrl\} alt="" className="size-12" rounded="rounded-full" \/>/);
  assert.match(src, /<Link to=\{songPath\} tabIndex=\{-1\} aria-hidden[^>]*data-testid="remix-origin-cover">/);
  // textos: arriba «Hecho a partir de», debajo el nombre (sin comillas) y debajo el autor
  assert.ok(src.indexOf('Hecho a partir de</p>') < src.indexOf('data-testid="remix-origin-title"'));
  assert.ok(src.indexOf('data-testid="remix-origin-title"') < src.indexOf('data-testid="remix-origin-author"'));
  assert.equal(/[«»"]\s*\{view\.title\}|\{view\.title\}\s*[«»"]/.test(code), false, 'el nombre va sin comillas');
  // navegación independiente: título → canción, autor → perfil
  assert.match(src, /<Link\s+to=\{songPath\}\s+title=\{view\.title\}\s+data-testid="remix-origin-title"/);
  assert.match(src, /<Link\s+to=\{originAuthorPath\(view\.authorId\)\}\s+data-testid="remix-origin-author"/);
  // no se muestra versión ni modalidad
  assert.equal(/versionNumber|\bCover\b|\bkind\b|configuración reutilizada|versionad/.test(code), false, 'ni versión ni modalidad en la presentación');
  // móvil: la fila no desborda (min-w-0 + truncate) y la portada no se achica
  assert.match(src, /className="flex max-w-md items-center gap-3"/);
  assert.match(src, /className="min-w-0 leading-tight"/);
  assert.equal((src.match(/truncate/g) ?? []).length >= 3, true, 'título, autor y estado no disponible se recortan');
  assert.match(src, /className="shrink-0 rounded-full"/);
  // accesibilidad: sección con nombre, enlaces de texto enfocables con foco visible, portada fuera del orden de tabulación
  assert.match(src, /<section aria-label="Origen del remix"/);
  assert.equal((src.match(/focus-visible:outline-2/g) ?? []).length, 2);
});

test('componente: origen no disponible → «Canción no disponible» sin portada, enlaces ni datos; mientras llega la portada, círculo neutro', () => {
  const src = read('src/features/song/RemixAttribution.tsx');
  const unavailable = src.slice(src.indexOf('if (!view.available) {'), src.indexOf('const songPath'));
  assert.match(unavailable, /Canción no disponible/);
  assert.match(unavailable, /data-testid="remix-origin-unavailable"/);
  assert.equal(/<Link|CoverArt|view\.title|authorName|songId|useQuery/.test(unavailable), false, 'sin enlaces, portada ni datos del original');
  // la portada ya viene en origin.song.coverUrl: sin consultas extra ni estado de carga
  assert.equal(/useQuery|useOriginCover|isPending|animate-pulse/.test(src), false);
});

test('portada del original: viene en origin.song.coverUrl (tipo, vista y componente), sin consultas adicionales', () => {
  assert.match(read('src/types/index.ts'), /song?: { id: string; title: string; coverUrl?: string | null };/);
  const src = read('src/features/song/RemixAttribution.tsx');
  assert.equal(/songsApi|communityApi/.test(src), false);
  assert.match(src, /<CoverArt id={view.songId} src={view.coverUrl}/);
});

test('contador de remixes: junto a los demás contadores, con el ícono de Remix y el número real del backend (remixCount)', () => {
  const detail = read('src/features/song/SongDetailView.tsx');
  const row = detail.slice(detail.indexOf('{/* stats (solo si hay interacción o es pública) */}'), detail.indexOf('{/* Reproducir como en «Canción destacada»'));
  // mismo contenedor, mismas clases y mismo orden (después de comentarios)
  assert.ok(row.indexOf('<MessageCircle') < row.indexOf('data-testid="remix-count"'));
  assert.match(row, /<span className="inline-flex items-center gap-1\.5" title="Remixes" aria-label=\{`\$\{song\.remixCount\} \$\{song\.remixCount === 1 \? 'remix' : 'remixes'\}`\} data-testid="remix-count">\s*<RemixIcon className="h-3\.5 w-3\.5" aria-hidden \/>\s*\{formatNumber\(song\.remixCount\)\}/);
  // número real: solo si el backend lo informa; sin estado local ni valores inventados
  assert.match(row, /typeof song\.remixCount === 'number' && \(/);
  assert.equal(/useState|setRemixCount/.test(row), false, 'sin contador local');
  // el mismo ícono que el menú Remix
  assert.match(read('src/features/song/RemixMenu.tsx'), /import \{ RemixIcon \} from '@\/features\/song\/RemixIcon'/);
  assert.equal(/Shuffle/.test(read('src/features/song/RemixMenu.tsx') + read('src/features/song/RemixAttribution.tsx')), false, 'Shuffle es el de reproducción aleatoria, no el de Remix');
  const icon = read('src/features/song/RemixIcon.tsx');
  assert.match(icon, /createLucideIcon\('remix'/);
  assert.match(icon, /M3 12a9 9 0 0 1 9-9 9\.75 9\.75 0 0 1 6\.74 2\.74L21 8/, 'dos flechas circulares');
  assert.match(icon, /remix-spark/, 'chispa central');
  // sin duplicados: el componente de atribución ya no recibe ni muestra el contador
  const attribution = read('src/features/song/RemixAttribution.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/remixCount|data-testid="remix-count"/.test(attribution), false);
  assert.equal((detail.match(/data-testid="remix-count"/g) ?? []).length, 1, 'un solo contador en la página');
  // la fila de contadores también aparece si solo hay remixes
  assert.match(detail, /song\.commentsCount \+ \(song\.remixCount \?\? 0\) > 0/);
});

/* ───────────── Estructura del código ───────────── */

test('el creador usa el mismo circuito para «otra versión» y para remix, y «Otra versión» no cambia', () => {
  const wiz = read('src/features/creator/CreatorWizard.tsx');
  assert.match(wiz, /const remixSongId = versionOfId \? null : query\.get\('remix'\);/, 'son excluyentes');
  assert.match(wiz, /const source = isRemix \? remixSource : versionSource;/);
  assert.match(wiz, /remix: isRemix && remixSongId \? \{ songId: remixSongId, versionId: remixSource\.template\?\.source\.versionId \} : null/);
  assert.match(wiz, /\.\.\.\(versionOfId \? \{ songId: versionOfId \} : \{\}\)/, 'otra versión sigue enviando songId');
  assert.match(wiz, /return isRemix \? next : lockTitle\(next\);/, 'el remix tiene título propio y editable');
  assert.match(wiz, /lockedTitle=\{versionOfId \? source\.song\?\.title \?\? '' : undefined\}/, 'solo «otra versión» fija el título');
  assert.match(wiz, /\(projects\?\.items\?\.length \?\? 0\) > 0 && !versionOfId/, 'un remix puede guardarse en un proyecto');
  assert.match(wiz, /if \(isRemix && err instanceof ApiError && \[403, 404, 422\]\.includes\(err\.status\)\)/, 'se revalida al generar');
  const page = read('src/routes.tsx');
  assert.match(page, /query\.get\('song'\) \?\? 'new'/);
});

test('el servidor es quien firma el audio: el cliente nunca arma una URL ni un archivo', () => {
  for (const f of ['src/features/creator/use-remix-source.ts', 'src/features/creator/remix-source.ts', 'src/features/song/RemixMenu.tsx']) {
    const src = read(f);
    assert.equal(/\/stream|\?st=|audioFileId|fileId/.test(src), false, `${f} no debe manejar archivos`);
  }
  const hook = read('src/features/creator/use-remix-source.ts');
  assert.match(hook, /songsApi\.remixTemplate\(/);
  assert.equal(hook.includes('generationApi.get'), false, 'la canción ajena nunca lee GenerationInput');
  assert.match(hook, /useVersionSource\(\{ songId: isOwner \? songId : null/, 'solo la canción propia recupera su configuración');
});

test('menús: Remix en detalle, Comunidad y Biblioteca; «Otra versión» queda donde estaba y con su ruta', () => {
  const detail = read('src/features/song/SongDetailView.tsx');
  assert.match(detail, /remixMenuState\(\{ isOwner, signedIn: Boolean\(user\), visibility: song\.visibility, allowRemix: song\.allowRemix, hasAudio: Boolean\(currentVersion\?\.audioUrl\) \}\)\.visible/);
  assert.match(detail, /<RemixMenu songId=\{song\.id\} \/>/);
  assert.match(detail, /navigate\(`\/create\?song=\$\{songId\}`\)/);
  assert.match(detail, /<Sparkles className="h-4 w-4" aria-hidden \/> Otra versión/);
  assert.match(read('src/features/community/CommunityView.tsx'), /remixMenuState\(\{ isOwner: false, signedIn: Boolean\(useAuthStore\.getState\(\)\.user\), visibility: 'PUBLIC', allowRemix: song\.allowRemix/);
  const lib = read('src/features/library/SongsTab.tsx');
  assert.equal((lib.match(/<RemixMenu songId=\{song\.id\} \/>/g) ?? []).length, 2, 'fila y tarjeta');
  const menu = read('src/features/song/RemixMenu.tsx');
  assert.match(menu, /navigate\(remixUrl\(songId, mode, versionId\)\)/);
  assert.equal(menu.includes('/create?song='), false);
  assert.match(menu, /Versionar|MODE_LABEL\.COVER/);
  assert.match(menu, /if \(remixGate\.locked\) \{ remixGate\.prompt\(\); return; \}/);
  assert.match(menu, /if \(mode === 'COVER' && referenceGate\.locked\)/, 'Cover también exige AUDIO_REFERENCE');
});

test('allowRemix: interruptor «Permitir Remixes» del dueño, sin leyenda, alineado con el de comentarios; los remixes existentes se conservan', () => {
  const detail = read('src/features/song/SongDetailView.tsx');
  assert.match(detail, /aria-label="Permitir Remixes"/);
  assert.match(detail, /Permitir Remixes\n\s*<\/label>/);
  assert.equal(/Permití que otras personas creen nuevas canciones/.test(detail), false, 'sin la leyenda larga');
  assert.equal(detail.includes('allow-remix-help') || detail.includes('ALLOW_REMIX_TEXT'), false);
  // los dos interruptores comparten columna alineada a la izquierda (el grupo sigue a la derecha de la sección)
  assert.match(detail, /<div className="flex flex-col items-start gap-2">\s*<label[^>]*>\s*<Switch[\s\S]*?Permitir comentarios[\s\S]*?Permitir Remixes/);
  assert.match(detail, /checked=\{song\.allowRemix === true\}/);
  assert.match(detail, /onCheckedChange=\{\(val\) => visibilityMutation\.mutate\(\{ allowRemix: val \}\)\}/);
  assert.match(detail, /Los remixes que ya existen se conservan\./);
  assert.match(detail, /allowRemix: c\.allowRemix \?\? false/, 'una canción ajena sin el dato se trata como no permitida');
  assert.match(detail, /<RemixAttribution origin=\{song\.origin\} \/>/);
});

/* ───────────── Propia: la composición sale de la VERSIÓN elegida (no del pedido original) ───────────── */

test('propia · un instrumental original arranca instrumental (no vuelve a pedir una letra), conserva su idea y quita la voz', () => {
  let s = updatePlanet(emptySong, 'composition', { mode: 'idea', idea: 'Un tema synthwave nocturno' });
  s = updatePlanet(addPlanet(s, 'voice'), 'voice', { preference: 'female' });
  const h = { song: s, notes: [{ id: 'mode-undetermined', tone: 'info', text: 'No pudimos saber si esa versión era instrumental.' }], source: 'generation', samples: [] };
  const out = R.adaptOwnerHydration(h, template({ isOwner: true, lyrics: null, instrumental: true }), 'COVER');
  assert.equal(out.song.composition.mode, 'instrumental');
  assert.equal(out.song.composition.lyrics, '');
  assert.equal(out.song.composition.idea, 'Un tema synthwave nocturno', 'la idea se conserva (se incorpora al estilo)');
  assert.equal(out.song.planets.includes('voice'), false);
  assert.equal(out.notes.some((n) => n.id === 'mode-undetermined'), false, 'ya se sabe: sin letra ⇒ instrumental');
});

test('propia · una versión cuya letra escribió Melodya (pedido por idea) copia esa letra real, no la regenera', () => {
  const s = updatePlanet(emptySong, 'composition', { mode: 'idea', idea: 'una cumbia' });
  const out = R.adaptOwnerHydration({ song: s, notes: [], source: 'generation', samples: [] }, template({ isOwner: true, lyrics: '[Coro]\nla letra final' }), 'PROMPT_REUSE');
  assert.equal(out.song.composition.mode, 'lyrics');
  assert.equal(out.song.composition.lyrics, '[Coro]\nla letra final');
  assert.equal(buildGenerationRequest(out.song, { remix: { songId: 'song-1' } }).inputs.find((i) => i.field === 'LYRICS').text, '[Coro]\nla letra final');
});

test('propia · «En blanco» se respeta: no se rellena con la plantilla', () => {
  const out = R.adaptOwnerHydration({ song: emptySong, notes: [], source: 'blank', samples: [] }, template({ isOwner: true }), 'COVER');
  assert.equal(out.song.composition.mode, emptySong.composition.mode);
  assert.equal(out.song.composition.lyrics, '');
  assert.deepEqual(out.song.remix, { mode: 'COVER' });
});

/* ───────────── Remix y plan: bloqueo por capacidades efectivas ───────────── */

const PG = await import('../src/lib/plan-gate.ts');
const lockedEnt = (remix, reference) => ({
  SONG_REMIX: { enabled: remix, enforced: true },
  AUDIO_REFERENCE: { enabled: reference, enforced: true },
});

test('acceso: sin SONG_REMIX ninguna modalidad (y SONG_REMIX se informa primero aunque falte también AUDIO_REFERENCE)', () => {
  const free = C.creatorLocks(lockedEnt(false, false));
  for (const mode of ['COVER', 'PROMPT_REUSE']) {
    const a = R.remixAccess(free, mode);
    assert.equal(a.allowed, false, mode);
    assert.equal(a.capability, 'SONG_REMIX', `${mode}: el motivo es Remix`);
    assert.equal(a.reason, C.LOCK_REASON.SONG_REMIX);
    assert.equal(a.canReusePrompt, false, 'sin Remix no hay salida a la otra modalidad');
  }
});

test('acceso: con SONG_REMIX pero sin AUDIO_REFERENCE, Reutilizar sí y Versionar no (con salida a Reutilizar)', () => {
  const locks = C.creatorLocks(lockedEnt(true, false));
  assert.deepEqual(R.remixAccess(locks, 'PROMPT_REUSE'), { allowed: true });
  const cover = R.remixAccess(locks, 'COVER');
  assert.equal(cover.allowed, false);
  assert.equal(cover.capability, 'AUDIO_REFERENCE');
  assert.equal(cover.canReusePrompt, true);
});

test('acceso: con ambas capacidades (Creator/Pro) se permiten las dos modalidades; sin exigencia del servidor no se bloquea nada', () => {
  const both = C.creatorLocks(lockedEnt(true, true));
  for (const mode of ['COVER', 'PROMPT_REUSE']) assert.deepEqual(R.remixAccess(both, mode), { allowed: true });
  const notEnforced = C.creatorLocks({ SONG_REMIX: { enabled: false, enforced: false }, AUDIO_REFERENCE: { enabled: false, enforced: false } });
  for (const mode of ['COVER', 'PROMPT_REUSE']) assert.deepEqual(R.remixAccess(notEnforced, mode), { allowed: true }, 'el bloqueo exige enforced && !enabled');
  assert.deepEqual(R.remixAccess(C.creatorLocks(null), 'COVER'), { allowed: true }, 'sin datos decide el servidor');
});

test('acceso: el 403 del servidor distingue plan (CAPABILITY_NOT_IN_PLAN) de permiso del autor (REMIX_NOT_ALLOWED)', () => {
  assert.equal(R.classifyTemplateError(403, 'FORBIDDEN', 'CAPABILITY_NOT_IN_PLAN'), 'not-in-plan');
  assert.equal(R.classifyTemplateError(403, 'FORBIDDEN', 'REMIX_NOT_ALLOWED'), 'not-allowed');
  assert.equal(R.classifyTemplateError(403, 'FORBIDDEN', undefined), 'error', 'un 403 desconocido no se explica con una causa inventada');
  assert.match(R.BLOCKED_TEXT['not-in-plan'], /Tu plan no incluye Remix/);
});

test('aviso de mejora: Remix tiene nombre propio y los planes que lo incluyen salen del catálogo (sin nombres de plan en el código)', () => {
  const plans = [
    { code: 'free', name: 'Free', isDefault: true, entitlements: { SONG_REMIX: { enabled: false } } },
    { code: 'creator', name: 'Creator', isActive: true, entitlements: { SONG_REMIX: { enabled: true } } },
    { code: 'pro', name: 'Pro', isActive: true, entitlements: { SONG_REMIX: { enabled: true } } },
  ];
  const copy = PG.upgradeCopy('SONG_REMIX', plans);
  assert.equal(copy.feature, 'Remix de canciones');
  assert.deepEqual(copy.planNames, ['Creator', 'Pro']);
  // Si el catálogo cambia, el aviso cambia: nada fijo en el código.
  assert.deepEqual(PG.upgradeCopy('SONG_REMIX', [{ code: 'pro', name: 'Pro', isActive: true, entitlements: { SONG_REMIX: { enabled: true } } }]).planNames, ['Pro']);
  for (const f of ['src/features/song/RemixMenu.tsx', 'src/features/creator/RemixPlanBlocked.tsx', 'src/features/creator/remix-source.ts', 'src/features/creator/use-remix-source.ts']) {
    assert.equal(/\b(Free|Creator|Pro|GRATIS|PRO)\b/.test(read(f)), false, `${f} no debe nombrar planes`);
  }
});

test('menú: sin la capacidad, Remix se ve bloqueado con corona y abre el aviso; las modalidades NO se despliegan', () => {
  const menu = read('src/features/song/RemixMenu.tsx');
  const locked = menu.slice(menu.indexOf('if (remixGate.locked) {\n    return ('), menu.indexOf('return (\n    <DropdownMenuSub>'));
  assert.match(locked, /<DropdownMenuItem onClick=\{\(\) => remixGate\.prompt\(\)\}[^>]*data-testid="remix-locked">/);
  assert.match(locked, /<RequiredPlanBadge capability="SONG_REMIX" className="ml-auto" \/>/, 'corona + plan mínimo');
  assert.equal(/DropdownMenuSub|remix-cover|remix-prompt|navigate\(/.test(locked), false, 'el bloqueo no despliega modalidades ni navega');
  assert.ok(menu.indexOf('if (remixGate.locked) {\n    return (') < menu.indexOf('<DropdownMenuSub>'), 'el bloqueo se resuelve antes del submenú');
  // Versionar mantiene su propio bloqueo por AUDIO_REFERENCE
  assert.match(menu, /if \(mode === 'COVER' && referenceGate\.locked\) \{ referenceGate\.prompt\(\); return; \}/);
  assert.match(menu, /<RequiredPlanBadge capability="AUDIO_REFERENCE" className="ml-auto" \/>/);
});

test('URL directa: sin la capacidad no se pide la plantilla ni se muestra el creador; el servidor igual la rechaza', () => {
  const wiz = read('src/features/creator/CreatorWizard.tsx');
  assert.match(wiz, /const access = isRemix \? remixAccess\(locks, remixMode\) : null;/);
  assert.match(wiz, /enabled: !access \|\| access\.allowed/);
  assert.match(wiz, /if \(isRemix && \(\(access && !access\.allowed\) \|\| remixSource\.blockedKind === 'not-in-plan'\)\) \{/);
  assert.match(wiz, /<RemixPlanBlocked/);
  // el bloqueo por plan se resuelve antes que el resto de las pantallas de error y que el creador
  assert.ok(wiz.indexOf('<RemixPlanBlocked') < wiz.indexOf('<VersionUnavailable'));
  const hook = read('src/features/creator/use-remix-source.ts');
  assert.match(hook, /const on = Boolean\(songId\) && enabled;/);
  assert.match(hook, /enabled: on,/, 'la plantilla solo se pide con acceso');
  const blocked = read('src/features/creator/RemixPlanBlocked.tsx');
  assert.match(blocked, /Mejorar plan/);
  assert.match(blocked, /usePlanGate\(capability\)/);
  assert.match(blocked, /\{canReusePrompt && /, 'si solo falta el audio de referencia, queda Reutilizar configuración');
  // «Otra versión» no pasa por este bloqueo
  assert.equal(/remixAccess/.test(read('src/features/creator/use-version-source.ts')), false);
});

test('sección «Remixes»: después de «Más de…», con el filtro remixOf del backend y solo si el contador informa remixes', () => {
  const detail = read('src/features/song/SongDetailView.tsx');
  assert.match(read('src/lib/api/index.ts'), /authorId\?: string; remixOf\?: string;/);
  assert.match(detail, /communityApi\.feed\(\{ remixOf: songId, sort: 'newest', limit: 4 \}\)/);
  assert.match(detail, /enabled: Boolean\(community\) && \(song\?\.remixCount \?\? 0\) > 0/);
  const genre = detail.indexOf('id="song-more-genre"');
  const remixes = detail.indexOf('id="song-remixes"');
  assert.ok(genre > 0 && remixes > genre, 'va después de «Más de [género]»');
  assert.match(detail, /\{remixes\.length > 0 && \(\s*<CommunitySongSection id="song-remixes" title="Remixes" songs=\{remixes\}/);
});
