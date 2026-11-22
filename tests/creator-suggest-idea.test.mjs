// «Sugerime una idea» (Composición): pide y aplica SÓLO la idea. Estilo (géneros y descripción) no se pide ni se toca.
// Lógica pura (song-model) + garantías estáticas sobre PlanetEditors / CreatorWizard (no hay jsdom en este repositorio).
// Ejecutar: node --test tests/creator-suggest-idea.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const M = await import('../src/features/creator/song-model.ts');
const { emptySong, updatePlanet, addPlanet, suggestIdeaRequest, pickSuggestedIdea, applySuggestedIdea, validateSong } = M;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const styled = updatePlanet(emptySong, 'style', { genres: ['Rock', 'Indie'], description: 'guitarras sucias, voz cruda' });

test('el pedido al asistente contiene únicamente IDEA (nunca GENRE)', () => {
  const req = suggestIdeaRequest();
  assert.deepEqual(req.missing, ['IDEA']);
  assert.deepEqual(req.draft, {});
  assert.ok(!JSON.stringify(req).includes('GENRE'));
});

test('la respuesta del asistente: sólo se toma IDEA; GENRE y otros campos se ignoran', () => {
  assert.equal(pickSuggestedIdea({ IDEA: 'una canción sobre el mar', GENRE: 'Pop', STYLE_DESCRIPTION: 'x' }), 'una canción sobre el mar');
});

test('respuesta vacía o inválida: no hay idea', () => {
  for (const bad of [undefined, null, {}, { IDEA: null }, { IDEA: 42 }, { IDEA: ['a'] }, { IDEA: { text: 'x' } }, { GENRE: 'Pop' }]) {
    assert.equal(pickSuggestedIdea(bad), '', JSON.stringify(bad));
  }
});

test('la sugerencia actualiza la idea de la composición', () => {
  const next = applySuggestedIdea(emptySong, 'una canción sobre el mar');
  assert.equal(next.composition.idea, 'una canción sobre el mar');
});

test('Estilo vacío permanece vacío (y punteado)', () => {
  const next = applySuggestedIdea(emptySong, 'una idea');
  assert.deepEqual(next.style, emptySong.style);
  assert.deepEqual(next.style.genres, []);
  assert.equal(next.style.description, '');
});

test('los géneros y la descripción de estilo existentes no se modifican', () => {
  const next = applySuggestedIdea(styled, 'una idea nueva');
  assert.deepEqual(next.style.genres, ['Rock', 'Indie']);
  assert.equal(next.style.description, 'guitarras sucias, voz cruda');
  assert.deepEqual(next.style, styled.style);
  assert.equal(next.style, styled.style, 'ni siquiera se recrea el objeto de Estilo');
});

test('pedir otra idea reemplaza la anterior (comportamiento mantenido), sin tocar Estilo', () => {
  const a = applySuggestedIdea(styled, 'primera idea');
  const b = applySuggestedIdea(a, 'segunda idea');
  assert.equal(b.composition.idea, 'segunda idea');
  assert.deepEqual(b.style, styled.style);
});

test('idea vacía o en blanco: el borrador queda exactamente igual (misma referencia)', () => {
  const base = applySuggestedIdea(styled, 'idea previa');
  for (const idea of ['', '   ', '\n\t']) assert.equal(applySuggestedIdea(base, idea), base, JSON.stringify(idea));
});

test('el resto de la composición y los planetas opcionales no cambian', () => {
  const s = addPlanet(updatePlanet(styled, 'composition', { title: 'Mi tema', mood: 'alegre', mode: 'idea' }), 'production');
  const next = applySuggestedIdea(s, 'otra idea');
  assert.equal(next.composition.title, 'Mi tema');
  assert.equal(next.composition.mood, 'alegre');
  assert.equal(next.composition.mode, 'idea');
  assert.deepEqual(next.planets, s.planets);
  assert.deepEqual(next.production, s.production);
  assert.deepEqual(next.voice, s.voice);
});

test('la validación sigue funcionando con la idea sugerida (sin error de Composición por falta de idea)', () => {
  const caps = { voices: [], references: [] };
  const before = validateSong(emptySong, caps).filter((i) => i.planet === 'composition' && i.severity === 'error').length;
  const after = validateSong(applySuggestedIdea(emptySong, 'una idea'), caps).filter((i) => i.planet === 'composition' && i.severity === 'error').length;
  assert.ok(after < before, 'con idea hay menos errores de Composición');
});

test('PlanetEditors: «Sugerime una idea» usa suggestIdeaRequest, no pide GENRE y aplica sólo la idea', () => {
  const src = code('../src/features/creator/PlanetEditors.tsx');
  assert.match(src, /assistantApi\.suggestions\(suggestIdeaRequest\(\)\)/);
  assert.match(src, /onApplySuggestion\(pickSuggestedIdea\(res\.suggestions\)\)/);
  assert.match(src, /onApplySuggestion: \(idea: string\) => void;/);
  const suggest = src.slice(src.indexOf('const suggest = async'), src.indexOf('return (', src.indexOf('const suggest = async')));
  assert.doesNotMatch(suggest, /GENRE|genre/i, 'suggest() ya no pide ni lee géneros');
  assert.doesNotMatch(suggest, /'IDEA', ?'GENRE'/);
});

test('CreatorWizard: aplicar la sugerencia no actualiza Estilo', () => {
  const src = code('../src/features/creator/CreatorWizard.tsx');
  assert.match(src, /onApplySuggestion=\{\(idea\) => setSong\(\(s\) => applySuggestedIdea\(s, idea\)\)\}/);
  assert.doesNotMatch(src, /onApplySuggestion=\{\(idea, genres\)/);
});

test('el resto del asistente sigue como antes: letras y sugerencias de estilo no usan este camino', () => {
  const studio = code('../src/features/creator/LyricsStudio.tsx');
  assert.match(studio, /assistantApi\.lyricsAttempt/);
  assert.doesNotMatch(studio, /assistantApi\.suggestions/);
  const api = code('../src/lib/api/index.ts');
  assert.match(api, /suggestions: \(body: \{ draft: Record<string, unknown>; missing\?: string\[\] \}\) => postData<SuggestionsResult>\('\/assistant\/suggestions', body\)/);
});
