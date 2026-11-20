// Capacidades del plan en la web (E5): qué se bloquea, cuándo, y cómo se traduce al creador de canciones.
// Ejecutar: node --test "tests/*.test.mjs"  (sin dependencias nuevas; Node 24 carga .ts directamente).
import test from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../src/lib/capabilities.ts');
const M = await import('../src/features/creator/song-model.ts');
const { isLocked, creatorLocks, capabilityDenial, capabilityDenialMessage, LOCK_REASON } = C;
const { emptySong, addPlanet, updatePlanet, availability, validateSong, hasErrors, buildGenerationRequest } = M;

const entry = (enabled, enforced) => ({ enabled, enforced });
const noCaps = { voices: [], references: [] };

test('solo se bloquea lo que el servidor exige (enforced) y el plan no incluye (enabled=false)', () => {
  const e = {
    PRODUCTION_CONTROLS: entry(false, true),   // exigida y fuera del plan → bloqueada
    CREATIVITY_SETTINGS: entry(true, true),    // exigida pero incluida → libre
    LYRICS_AI: entry(false, false),            // fuera del plan pero el servidor no la exige (off / shadow / interruptor) → libre
    VOICE_CLONING: { enabled: false },         // backend anterior a E5 (sin `enforced`) → libre
  };
  assert.equal(isLocked(e, 'PRODUCTION_CONTROLS'), true);
  assert.equal(isLocked(e, 'CREATIVITY_SETTINGS'), false);
  assert.equal(isLocked(e, 'LYRICS_AI'), false);
  assert.equal(isLocked(e, 'VOICE_CLONING'), false);
  assert.equal(isLocked(e, 'AUDIO_REFERENCE'), false); // clave ausente
  assert.equal(isLocked(null, 'PRODUCTION_CONTROLS'), false); // sesión sin cargar
  assert.equal(isLocked(undefined, 'PRODUCTION_CONTROLS'), false);
});

test('creatorLocks: cada capacidad bloqueada produce su motivo; sin bloqueos no hay ninguno', () => {
  const free = {
    AUDIO_REFERENCE: entry(false, true), PRODUCTION_CONTROLS: entry(false, true), CREATIVITY_SETTINGS: entry(false, true),
    VOICE_COVER: entry(false, true), VOICE_CLONING: entry(false, true), LYRICS_AI: entry(false, true),
  };
  const l = creatorLocks(free);
  assert.deepEqual(Object.keys(l.planets).sort(), ['creativity', 'production', 'reference']);
  assert.equal(l.planets.production, LOCK_REASON.PRODUCTION_CONTROLS);
  assert.equal(l.customVoice, LOCK_REASON.VOICE_COVER);
  assert.equal(l.voiceCloning, LOCK_REASON.VOICE_CLONING);
  assert.equal(l.lyricsAi, LOCK_REASON.LYRICS_AI);

  const pro = Object.fromEntries(Object.keys(free).map((k) => [k, entry(true, true)]));
  assert.deepEqual(creatorLocks(pro), { planets: {} });
  assert.deepEqual(creatorLocks(null), { planets: {} });
});

test('Creator: Producción sí, Creatividad no; los motivos nombran los planetas reales', () => {
  const creator = creatorLocks({ PRODUCTION_CONTROLS: entry(true, true), CREATIVITY_SETTINGS: entry(false, true) });
  assert.deepEqual(Object.keys(creator.planets), ['creativity']);
  assert.match(creator.planets.creativity, /Creatividad/);
  assert.match(LOCK_REASON.PRODUCTION_CONTROLS, /Producción/);
});

test('el catálogo de planetas muestra los bloqueados como no disponibles, con motivo, y deja el resto intacto', () => {
  const locks = creatorLocks({ PRODUCTION_CONTROLS: entry(false, true), CREATIVITY_SETTINGS: entry(false, true), AUDIO_REFERENCE: entry(true, true) });
  const byId = Object.fromEntries(availability(emptySong, locks).map((a) => [a.def.id, a]));
  for (const id of ['production', 'creativity']) {
    assert.equal(byId[id].available, false, id);
    assert.match(byId[id].reason, /Tu plan no incluye/);
  }
  assert.equal(byId.reference.available, true);
  assert.equal(byId.voice.available, true);
  // sin bloqueos (o sin argumento) el comportamiento anterior no cambia
  for (const a of availability(emptySong)) assert.equal(a.available, true);
  for (const a of availability(emptySong, { planets: {} })) assert.equal(a.available, true);
});

test('un borrador con un planeta que el plan ya no incluye no se puede crear, y el motivo se ve en ese planeta', () => {
  const locks = creatorLocks({ PRODUCTION_CONTROLS: entry(false, true) });
  const song = updatePlanet(addPlanet(updatePlanet(emptySong, 'composition', { mode: 'instrumental', idea: 'lluvia' }), 'production'), 'production', { durationSec: '30' });
  assert.equal(hasErrors(validateSong(song, noCaps)), false, 'sin bloqueos es válida');
  const issues = validateSong(song, noCaps, locks);
  const err = issues.find((i) => i.severity === 'error' && i.planet === 'production');
  assert.ok(err);
  assert.match(err.message, /Producción/);
  assert.match(err.message, /Quitá este elemento/);
  assert.equal(hasErrors(issues), true);
});

test('sin asistente de letras (LYRICS_AI) se puede crear igual: desde una idea y estilos, con letra propia o instrumental', () => {
  const locks = creatorLocks({ LYRICS_AI: entry(false, true) });
  const idea = updatePlanet(emptySong, 'composition', { mode: 'idea', idea: 'una cumbia para el verano' });
  const idea2 = updatePlanet(idea, 'style', { genres: ['pop'] });
  // El asistente de letras sigue bloqueado (locks.lyricsAi), pero eso no impide crear una canción a partir de una idea y estilos.
  assert.equal(locks.lyricsAi, LOCK_REASON.LYRICS_AI);
  assert.equal(hasErrors(validateSong(idea2, noCaps, locks)), false);

  const own = updatePlanet(emptySong, 'composition', { mode: 'lyrics', lyrics: '[Verso] mi letra' });
  const own2 = updatePlanet(own, 'style', { genres: ['pop'] });
  assert.equal(hasErrors(validateSong(own2, noCaps, locks)), false);
  const inst = updatePlanet(emptySong, 'composition', { mode: 'instrumental', idea: 'lluvia' });
  assert.equal(hasErrors(validateSong(inst, noCaps, locks)), false);
});

test('una voz clonada propia exige VOICE_COVER; la preferencia vocal no', () => {
  const locks = creatorLocks({ VOICE_COVER: entry(false, true) });
  const base = updatePlanet(emptySong, 'composition', { mode: 'lyrics', lyrics: '[Verso] mi letra' });
  const withVoice = updatePlanet(addPlanet(base, 'voice'), 'voice', { voiceSampleId: 'v1', preference: '' });
  const caps = { voices: [{ id: 'v1', name: 'Mi voz', sunoPersonaId: 'p1' }], references: [] };
  const errs = validateSong(withVoice, caps, locks).filter((i) => i.severity === 'error' && i.planet === 'voice');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, LOCK_REASON.VOICE_COVER);

  const pref = updatePlanet(addPlanet(base, 'voice'), 'voice', { voiceSampleId: null, preference: 'female' });
  assert.equal(validateSong(pref, caps, locks).filter((i) => i.severity === 'error' && i.planet === 'voice').length, 0);
});

test('el contrato de la solicitud no cambia: los planetas permitidos siguen enviando sus campos', () => {
  const song = updatePlanet(addPlanet(updatePlanet(emptySong, 'composition', { mode: 'instrumental', idea: 'lluvia' }), 'production'), 'production', { durationSec: '30' });
  const req = buildGenerationRequest(song, {});
  assert.ok(req.inputs.some((i) => i.field === 'DURATION_SECONDS' && i.value === 30));
});

test('el 403 CAPABILITY_NOT_IN_PLAN del servidor se reconoce y se explica con los planes que la incluyen', () => {
  const denied = (plans) => ({ status: 403, details: { code: 'CAPABILITY_NOT_IN_PLAN', capability: 'CREATIVITY_SETTINGS', capabilityName: 'Planeta Creatividad', includedInPlans: plans } });
  const d1 = capabilityDenial(denied([{ code: 'pro', name: 'Pro' }]));
  assert.equal(d1.capability, 'CREATIVITY_SETTINGS');
  assert.equal(capabilityDenialMessage(d1), 'Tu plan actual no incluye «Planeta Creatividad». Lo incluye el plan Pro.');
  const d2 = capabilityDenial(denied([{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }, { code: 'c', name: 'C' }]));
  assert.equal(capabilityDenialMessage(d2), 'Tu plan actual no incluye «Planeta Creatividad». Lo incluyen los planes A, B y C.');
  assert.equal(capabilityDenialMessage(capabilityDenial(denied([]))), 'Tu plan actual no incluye «Planeta Creatividad».');

  assert.equal(capabilityDenial({ status: 403, details: { code: 'FORBIDDEN' } }), null);
  assert.equal(capabilityDenial({ status: 402, details: { code: 'CAPABILITY_NOT_IN_PLAN', capability: 'X' } }), null);
  assert.equal(capabilityDenial(new Error('x')), null);
  assert.equal(capabilityDenial(null), null);
});

/* ───────────── Cupos (E6) ───────────── */

const { songsMeterText, limitExceeded, limitExceededMessage, formatRenewal } = C;
const usage = (songs, period = { kind: 'calendar', resetsAt: '2026-12-01T00:00:00.000Z' }) => ({ period, songs });

test('el mes calendario se muestra en UTC: la renovación del 1 de diciembre no se adelanta al 30 de noviembre', () => {
  assert.equal(formatRenewal('2026-12-01T00:00:00.000Z', 'calendar'), '1 de diciembre');
  assert.equal(formatRenewal('', 'calendar'), '');
});

test('medidor de canciones: cuánto queda, cuándo se renueva y cuándo está agotado', () => {
  const some = songsMeterText(usage({ included: true, limit: 15, used: 4, remaining: 11, enforced: true }));
  assert.equal(some.text, 'Te quedan 11 de 15 canciones en este período. Se renueva el 1 de diciembre.');
  assert.equal(some.exhausted, false);
  assert.match(songsMeterText(usage({ included: true, limit: 15, used: 14, remaining: 1, enforced: true })).text, /Te queda 1 de 15/);
  const full = songsMeterText(usage({ included: true, limit: 15, used: 15, remaining: 0, enforced: true }));
  assert.match(full.text, /Usaste las 15 canciones/);
  assert.equal(full.exhausted, true);
  // Agotado pero el servidor no lo exige (off / shadow / interruptor): se informa sin bloquear.
  assert.equal(songsMeterText(usage({ included: true, limit: 15, used: 20, remaining: 0, enforced: false })).exhausted, false);
});

test('sin tope, sin cupo incluido o sin datos no hay medidor', () => {
  assert.equal(songsMeterText(usage({ included: true, limit: null, used: 3, remaining: null, enforced: true })), null);
  assert.equal(songsMeterText(usage({ included: false, limit: 0, used: 0, remaining: null, enforced: true })), null);
  assert.equal(songsMeterText(null), null);
  assert.equal(songsMeterText(undefined), null);
});

test('el 403 LIMIT_EXCEEDED se reconoce y se explica con la fecha de renovación; otros 403 no', () => {
  const err = { status: 403, details: { code: 'LIMIT_EXCEEDED', capability: 'SONGS_PER_PERIOD', limit: 40, used: 40, resetsAt: '2026-12-01T00:00:00.000Z' } };
  const l = limitExceeded(err);
  assert.deepEqual([l.capability, l.limit, l.used], ['SONGS_PER_PERIOD', 40, 40]);
  assert.match(limitExceededMessage(l), /^Alcanzaste las 40 canciones de tu plan en este período\. Se renueva el \d+ de /);
  assert.equal(limitExceeded({ status: 403, details: { code: 'CAPABILITY_NOT_IN_PLAN', capability: 'X' } }), null);
  assert.equal(limitExceeded({ status: 402, details: err.details }), null);
  assert.equal(limitExceeded(null), null);
  assert.equal(capabilityDenial(err), null, 'un cupo agotado no es una capacidad faltante');
});

/* ───────────── Descargas (E6) ───────────── */

const { downloadState } = C;
const { downloadFilename } = await import('../src/lib/audio-download.ts');
const dl = (d, period = { kind: 'calendar', resetsAt: '2026-12-01T00:00:00.000Z' }) => ({ period, downloads: d });

test('descargas: el botón se bloquea solo si el servidor exige la capacidad y el plan no la incluye', () => {
  const locked = downloadState({ DOWNLOAD_AUDIO: { enabled: false, enforced: true } }, null);
  assert.equal(locked.allowed, false);
  assert.equal(locked.reason, LOCK_REASON.DOWNLOAD_AUDIO);
  assert.equal(downloadState({ DOWNLOAD_AUDIO: { enabled: false, enforced: false } }, null).allowed, true, 'sin exigencia (off / shadow) no se bloquea');
  assert.equal(downloadState({ DOWNLOAD_AUDIO: { enabled: true, enforced: true } }, null).allowed, true);
  assert.equal(downloadState(null, undefined).allowed, true, 'sin datos decide el servidor');
});

test('descargas: medidor, cupo agotado (solo bloquea si se exige) y plan sin cupo incluido', () => {
  const ent = { DOWNLOAD_AUDIO: { enabled: true, enforced: true } };
  const some = downloadState(ent, dl({ included: true, limit: 20, used: 5, remaining: 15, enforced: true }));
  assert.deepEqual([some.allowed, some.reason], [true, null]);
  assert.equal(some.hint, 'Te quedan 15 de 20 descargas en este período. Se renueva el 1 de diciembre.');
  assert.match(downloadState(ent, dl({ included: true, limit: 20, used: 19, remaining: 1, enforced: true })).hint, /Te queda 1 de 20/);
  const full = downloadState(ent, dl({ included: true, limit: 20, used: 20, remaining: 0, enforced: true }));
  assert.equal(full.allowed, false);
  assert.match(full.reason, /Usaste las 20 descargas de tu plan/);
  const soft = downloadState(ent, dl({ included: true, limit: 20, used: 25, remaining: 0, enforced: false }));
  assert.equal(soft.allowed, true, 'agotado pero no exigido: se informa sin bloquear');
  assert.match(soft.hint, /Usaste las 20 descargas/);
  assert.equal(downloadState(ent, dl({ included: false, limit: 0, used: 0, remaining: null, enforced: true })).allowed, false);
  assert.equal(downloadState(ent, dl({ included: true, limit: null, used: 3, remaining: null, enforced: true })).hint, null, 'sin tope no hay medidor');
});

test('el 403 LIMIT_EXCEEDED de descargas se explica con «descargas»', () => {
  const l = limitExceeded({ status: 403, details: { code: 'LIMIT_EXCEEDED', capability: 'DOWNLOADS_PER_PERIOD', limit: 20, used: 20, resetsAt: '2026-12-01T00:00:00.000Z' } });
  assert.match(limitExceededMessage(l), /^Alcanzaste las 20 descargas de tu plan en este período\./);
});

test('nombre del archivo descargado: título sin caracteres inválidos y extensión por el tipo real; sin tipo conocido no se inventa una', () => {
  assert.equal(downloadFilename('Mi canción: ¿final?', 'audio/mpeg'), 'Mi canción ¿final.mp3');
  assert.equal(downloadFilename('   ', 'audio/mpeg'), 'cancion.mp3');
  assert.equal(downloadFilename(null, 'audio/mpeg; charset=x'), 'cancion.mp3');
  assert.equal(downloadFilename('a/b\\c', 'audio/mpeg'), 'abc.mp3');
  assert.equal(downloadFilename('Tema', 'application/octet-stream'), 'Tema');
  assert.equal(downloadFilename('Tema', null), 'Tema');
});

/* ── COVER_ART (F4): generar una portada con Melodya ───────────────────────── */

test('COVER_ART: habilitada nunca bloquea; deshabilitada bloquea solo si el servidor la exige (enforce); con la matriz vigente (true en los tres planes) no bloquea', () => {
  assert.equal(isLocked({ COVER_ART: entry(true, true) }, 'COVER_ART'), false);   // matriz vigente, enforce
  assert.equal(isLocked({ COVER_ART: entry(true, false) }, 'COVER_ART'), false);  // matriz vigente, off/shadow
  assert.equal(isLocked({ COVER_ART: entry(false, true) }, 'COVER_ART'), true);   // plan sin portadas + enforce → no se ofrece
  assert.equal(isLocked({ COVER_ART: entry(false, false) }, 'COVER_ART'), false); // el servidor no lo exige (off/shadow/interruptor): se ofrece
  assert.equal(isLocked(undefined, 'COVER_ART'), false);                          // sin datos decide el servidor
  assert.equal(LOCK_REASON.COVER_ART, 'Tu plan no incluye generar portadas.');
});

test('SongDetailView: «Generar» portada sin COVER_ART no se dispara y muestra el aviso de upgrade (corona + plan), sin tocar «Subir portada»', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/features/song/SongDetailView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /const coverGate = usePlanGate\('COVER_ART'\)/);
  assert.match(src, /if \(coverGate\.locked\) \{\n\s+coverGate\.prompt\(\);\n\s+return;/); // la acción no se dispara: se muestra el aviso
  assert.match(src, /<RequiredPlanBadge capability="COVER_ART" \/>/);
  assert.match(src, /coverArtLocked \? coverGate\.copy\?\.message \?\? LOCK_REASON\.COVER_ART : 'No gasta fichas\.'/);
  // subir una portada propia no depende de COVER_ART: el botón «Subir portada» no menciona coverArtLocked
  const upload = src.slice(src.indexOf('Subir portada') - 600, src.indexOf('Subir portada'));
  assert.equal(upload.includes('coverArtLocked'), false);
});
