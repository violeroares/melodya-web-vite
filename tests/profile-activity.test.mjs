// Mi Perfil → Actividad: etiquetas de las generaciones (generation-label.ts), carga incremental (generation-pages.ts)
// y su uso en ProfileView.tsx.
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { generationLabels, GENERIC_GENERATION_LABEL } = await import('../src/features/profile/generation-label.ts');
const { nextGenerationPage, flattenGenerationPages } = await import('../src/features/profile/generation-pages.ts');

const LEAK = /suno|\bv6\b|text_prompt|voice_cover|melody_ref|beatbox_rhythm|\blyrics\b|\bcover\b|mureka|mock/i;

test('cada modalidad confirmada tiene su etiqueta', () => {
  assert.deepEqual(generationLabels(['TEXT_PROMPT']), ['Creación de canción']);
  assert.deepEqual(generationLabels(['TEXT_PROMPT', 'MELODY_REF']), ['Creación de canción', 'Con melodía de referencia']);
  assert.deepEqual(generationLabels(['TEXT_PROMPT', 'BEATBOX_RHYTHM']), ['Creación de canción', 'Con ritmo de referencia']);
  assert.deepEqual(generationLabels(['TEXT_PROMPT', 'VOICE_COVER']), ['Creación de canción', 'Con tu voz']);
  assert.deepEqual(generationLabels(['COVER']), ['Creación de portada']);
});

test('combinaciones: una etiqueta por modalidad, sin concatenar códigos y en orden fijo', () => {
  assert.deepEqual(generationLabels(['TEXT_PROMPT', 'MELODY_REF', 'VOICE_COVER']), [
    'Creación de canción',
    'Con melodía de referencia',
    'Con tu voz',
  ]);
  // el orden de entrada no cambia el de salida
  assert.deepEqual(generationLabels(['VOICE_COVER', 'BEATBOX_RHYTHM', 'TEXT_PROMPT']), generationLabels(['TEXT_PROMPT', 'BEATBOX_RHYTHM', 'VOICE_COVER']));
  // sin repetidos
  assert.deepEqual(generationLabels(['TEXT_PROMPT', 'TEXT_PROMPT', 'VOICE_COVER', 'VOICE_COVER']), ['Creación de canción', 'Con tu voz']);
});

test('no se inventan modalidades: solo sale lo que generationTypes confirma', () => {
  assert.deepEqual(generationLabels(['TEXT_PROMPT']), ['Creación de canción']);
  assert.ok(!generationLabels(['TEXT_PROMPT']).some((l) => /voz|melodía|ritmo|letra/i.test(l)));
  // la letra no se etiqueta: generationTypes no la confirma para una canción
  assert.ok(!generationLabels(['TEXT_PROMPT', 'LYRICS']).some((l) => /letra/i.test(l)));
});

test('tipos desconocidos se omiten; sin ninguno reconocido, texto genérico', () => {
  assert.deepEqual(generationLabels(['TEXT_PROMPT', 'ALGO_NUEVO']), ['Creación de canción']);
  assert.deepEqual(generationLabels(['ALGO_NUEVO']), [GENERIC_GENERATION_LABEL]);
  assert.deepEqual(generationLabels(['LYRICS']), [GENERIC_GENERATION_LABEL]);
  assert.deepEqual(generationLabels([]), [GENERIC_GENERATION_LABEL]);
  for (const bad of [null, undefined, 'TEXT_PROMPT', 42, {}, [null, 7, {}]]) {
    assert.deepEqual(generationLabels(bad), [GENERIC_GENERATION_LABEL], String(bad));
  }
  // propiedades heredadas no se confunden con tipos
  assert.deepEqual(generationLabels(['constructor', '__proto__']), [GENERIC_GENERATION_LABEL]);
});

test('ninguna etiqueta expone modelos, proveedores ni códigos internos', () => {
  const all = ['TEXT_PROMPT', 'MELODY_REF', 'BEATBOX_RHYTHM', 'VOICE_COVER', 'COVER', 'LYRICS', 'ALGO_NUEVO', 'Suno V6'];
  for (const combo of [all, [], ['Suno V6'], ['TEXT_PROMPT', 'VOICE_COVER']]) {
    for (const label of generationLabels(combo)) assert.doesNotMatch(label, LEAK, label);
  }
});

test('nextGenerationPage: hay siguiente solo mientras la página actual sea menor que pages', () => {
  assert.equal(nextGenerationPage({ page: 1, pages: 3 }), 2);
  assert.equal(nextGenerationPage({ page: 2, pages: 3 }), 3);
  assert.equal(nextGenerationPage({ page: 3, pages: 3 }), undefined);
  assert.equal(nextGenerationPage({ page: 1, pages: 1 }), undefined);
  assert.equal(nextGenerationPage({ page: 1, pages: 0 }), undefined);
});

test('flattenGenerationPages: conserva el orden, une páginas y no repite ids', () => {
  const g = (id) => ({ id, title: `t${id}` });
  const pages = [{ items: [g('a'), g('b'), g('c')] }, { items: [g('c'), g('d')] }, { items: [g('b'), g('e')] }];
  assert.deepEqual(flattenGenerationPages(pages).map((x) => x.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(flattenGenerationPages([]), []);
  assert.deepEqual(flattenGenerationPages(undefined), []);
  assert.deepEqual(flattenGenerationPages([{ items: [] }]), []);
  // conserva la primera aparición (la más reciente en pantalla)
  assert.equal(flattenGenerationPages([{ items: [{ id: 'x', v: 1 }] }, { items: [{ id: 'x', v: 2 }] }])[0].v, 1);
});

const view = fs.readFileSync(new URL('../src/features/profile/ProfileView.tsx', import.meta.url), 'utf8');
const hist = fs.readFileSync(new URL('../src/features/activity/ActivityHistory.tsx', import.meta.url), 'utf8');
const tab = view.slice(view.indexOf('function ActivityTab'), view.indexOf('/* ── Tab Comunidad'));
const genRow = hist.slice(hist.indexOf('function GenerationOnlyRow'), hist.indexOf('const STATE_TEXT'));

test('Perfil › Mi actividad: la pestaña usa el historial unificado y conserva el enlace a fichas', () => {
  assert.match(view, /label: 'Mi actividad'/);
  assert.match(tab, /<ActivityHistory \/>/);
  assert.match(tab, /Ver fichas/);
  assert.doesNotMatch(view, /function GenerationRow|ACTIVITY_PAGE_SIZE/);
});

test('Mi actividad: filtros, carga incremental con «Ver más», estados de carga, error y vacío', () => {
  for (const label of ['Todas', 'Compras', 'Generaciones', 'Devoluciones']) assert.match(hist, new RegExp(`label: '${label}'`));
  assert.match(hist, /PACKAGE_PURCHASE', 'PLAN_GRANT'/, 'Compras combina las dos fuentes');
  assert.match(hist, /useInfiniteQuery\(/);
  assert.match(hist, /generationApi\.list\(\{ page: pageParam, pageSize: PAGE_SIZE \}\)/);
  assert.match(hist, /timeline\.hasMore &&/);
  assert.match(hist, /Ver más/);
  assert.match(hist, /No pudimos cargar tu actividad\./);
  assert.match(hist, /Todavía no hay actividad/);
});

test('Mi actividad: la generación sin movimientos usa las etiquetas y no imprime generationTypes', () => {
  assert.match(genRow, /generationLabels\(g\.generationTypes\)/);
  assert.doesNotMatch(genRow, /generationTypes\.slice|\{t\}/);
  assert.match(genRow, /formatRelative\(g\.createdAt\)/);
});
