// Planetas base (Composición y Estilo): se dibujan punteados según la configuración ACTUAL, nunca según si alguna vez se pulsó «Listo».
// Lógica pura (isBasePlanetEmpty / pendingBasePlanets) + garantías estáticas sobre CreatorWizard (no hay jsdom en este repositorio).
// Ejecutar: node --test tests/creator-base-planets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const M = await import('../src/features/creator/song-model.ts');
const { emptySong, updatePlanet, addPlanet, isBasePlanetEmpty, pendingBasePlanets, validateSong } = M;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const comp = (patch, s = emptySong) => updatePlanet(s, 'composition', patch);
const style = (patch, s = emptySong) => updatePlanet(s, 'style', patch);
/** El estado que el CreatorWizard guarda al abrir un editor. */
const openAs = (s, id) => ({ id, empty: isBasePlanetEmpty(s, id) });

/* ── Composición ── */

test('Composición vacía: sin idea, letra ni título (y en modo idea) está sin configurar', () => {
  assert.equal(isBasePlanetEmpty(emptySong, 'composition'), true);
  assert.equal(isBasePlanetEmpty(comp({ idea: '   ', lyrics: '\n', title: ' ' }), 'composition'), true, 'sólo espacios = vacío');
});

test('Composición con idea, letra, título o modo instrumental: configurada', () => {
  assert.equal(isBasePlanetEmpty(comp({ idea: 'una canción sobre el mar' }), 'composition'), false);
  assert.equal(isBasePlanetEmpty(comp({ mode: 'lyrics', lyrics: 'La la la' }), 'composition'), false);
  assert.equal(isBasePlanetEmpty(comp({ title: 'Mi tema' }), 'composition'), false);
  assert.equal(isBasePlanetEmpty(comp({ mode: 'instrumental' }), 'composition'), false, 'instrumental ya es configurarla, sin texto');
});

test('mood y moodCustom NO cuentan: no son condición de completado (semántica actual)', () => {
  assert.equal(isBasePlanetEmpty(comp({ mood: 'alegre' }), 'composition'), true);
  assert.equal(isBasePlanetEmpty(comp({ moodCustom: 'nostálgico' }), 'composition'), true);
  assert.equal(isBasePlanetEmpty(comp({ mode: 'lyrics' }), 'composition'), true, 'elegir «letra» sin escribirla tampoco configura');
});

test('volver de instrumental a idea sin texto deja Composición vacía otra vez', () => {
  const inst = comp({ mode: 'instrumental' });
  assert.equal(isBasePlanetEmpty(inst, 'composition'), false);
  assert.equal(isBasePlanetEmpty(comp({ mode: 'idea' }, inst), 'composition'), true);
});

/* ── Estilo ── */

test('Estilo vacío, con géneros o con descripción', () => {
  assert.equal(isBasePlanetEmpty(emptySong, 'style'), true);
  assert.equal(isBasePlanetEmpty(style({ genres: ['Rock'] }), 'style'), false);
  assert.equal(isBasePlanetEmpty(style({ description: 'guitarras sucias' }), 'style'), false);
  assert.equal(isBasePlanetEmpty(style({ description: '   ' }), 'style'), true);
  assert.equal(isBasePlanetEmpty(style({ genres: [], description: '' }, style({ genres: ['Rock'] })), 'style'), true, 'quitar todo vuelve a vacío');
});

test('los planetas opcionales no tienen «vacío ⇒ punteado»: isBasePlanetEmpty es false', () => {
  for (const id of ['voice', 'reference', 'production', 'creativity']) assert.equal(isBasePlanetEmpty(addPlanet(emptySong, id), id), false, id);
});

/* ── El flujo: completar, «Listo», volver a editar, vaciar, «Listo» ── */

test('Composición: completar → Listo (relleno) → reabrir → vaciar → Listo (vuelve a punteado al instante)', () => {
  let s = emptySong;
  // Se abre vacía: punteada mientras se edita, aunque ya se haya escrito algo.
  let opened = openAs(s, 'composition');
  s = comp({ idea: 'una idea' }, s);
  assert.ok(pendingBasePlanets(s, opened, 'composition').includes('composition'), 'abierta y vacía al abrir: sigue punteada');
  // «Listo»: el editor se cierra y sólo se recalcula de la configuración.
  assert.ok(!pendingBasePlanets(s, opened, null).includes('composition'), 'con idea y cerrada: rellena');
  // Se reabre con contenido, se vacía, y mientras está abierta conserva el aspecto relleno.
  opened = openAs(s, 'composition');
  s = comp({ idea: '' }, s);
  assert.ok(!pendingBasePlanets(s, opened, 'composition').includes('composition'), 'abierta y rellena al abrir: no parpadea a punteada mientras se edita');
  // «Listo»: vuelve a punteada sin recargar.
  assert.ok(pendingBasePlanets(s, opened, null).includes('composition'), 'vaciada y cerrada: punteada');
});

test('Estilo: Rock → Listo → reabrir → quitar Rock → Listo (vuelve a punteado)', () => {
  let s = style({ genres: ['Rock'] });
  assert.ok(!pendingBasePlanets(s, null, null).includes('style'));
  const opened = openAs(s, 'style');
  s = style({ genres: [] }, s);
  assert.ok(!pendingBasePlanets(s, opened, 'style').includes('style'), 'abierto: conserva el aspecto relleno');
  assert.ok(pendingBasePlanets(s, opened, null).includes('style'), 'cerrado y vacío: punteado');
});

test('instrumental sin texto sigue rellena después de «Listo» (antes lo sostenía «baseConfirmed»)', () => {
  const s = comp({ mode: 'instrumental' });
  assert.ok(!pendingBasePlanets(s, openAs(emptySong, 'composition'), null).includes('composition'));
});

test('Composición y Estilo son independientes', () => {
  const s = comp({ idea: 'algo' });
  assert.deepEqual(pendingBasePlanets(s, null, null), ['style']);
  assert.deepEqual(pendingBasePlanets(style({ genres: ['Pop'] }, s), null, null), []);
  assert.deepEqual(pendingBasePlanets(emptySong, null, null), ['composition', 'style']);
});

/* ── Reiniciar, cambiar de canción, «Otra versión» ── */

test('reiniciar o cambiar de canción: el resultado depende sólo de la canción nueva (no hay memoria de «Listo»)', () => {
  const armada = style({ genres: ['Rock'] }, comp({ idea: 'algo' }));
  assert.deepEqual(pendingBasePlanets(armada, null, null), []);
  // Reiniciar (emptySong) y cargar otra canción dan los mismos resultados que con un asistente recién abierto.
  assert.deepEqual(pendingBasePlanets(emptySong, null, null), ['composition', 'style']);
  assert.deepEqual(pendingBasePlanets(comp({ mode: 'instrumental' }), null, null), ['style']);
});

test('«Otra versión»: la canción de origen se refleja tal cual (Estilo con géneros de la versión, Composición con su letra)', () => {
  const origen = style({ genres: ['Cumbia'] }, comp({ mode: 'lyrics', lyrics: 'Letra de origen' }));
  assert.deepEqual(pendingBasePlanets(origen, null, null), []);
  assert.deepEqual(pendingBasePlanets(style({ genres: [] }, origen), null, null), ['style']);
});

/* ── Sin regresiones: la validación y los demás planetas no cambian ── */

test('la validación sigue igual: Composición vacía es un error de la canción y no depende del aspecto del planeta', () => {
  const issues = validateSong(emptySong, { voices: [], references: [] });
  assert.ok(issues.some((i) => i.planet === 'composition' && i.severity === 'error'));
});

test('CreatorWizard: ya no guarda un «confirmado» y deriva el punteado con pendingBasePlanets', () => {
  const w = code('../src/features/creator/CreatorWizard.tsx');
  assert.doesNotMatch(w, /baseConfirmed|setBaseConfirmed|baseEditing/);
  assert.match(w, /pendingBasePlanets\(song, baseOpened, openPlanet\)/);
  assert.match(w, /pending=\{\[\.\.\.pendingPlanets, \.\.\.basePending\]\}/, 'los opcionales siguen con pendingPlanets');
  // «Listo» sólo quita el pendiente de un planeta agregado con «+» y cierra el editor.
  const confirm = w.slice(w.indexOf('const confirmPlanet'), w.indexOf('const removeCurrent'));
  assert.match(confirm, /setPendingPlanets/);
  assert.match(confirm, /setOpenPlanet\(null\)/);
  assert.doesNotMatch(confirm, /Base/);
});
