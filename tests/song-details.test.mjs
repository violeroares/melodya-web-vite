// «Editar detalles de la canción»: lógica pura del formulario + comprobaciones estructurales del código fuente.
//  • song-details.ts es puro: se prueba el comportamiento (normalización, límites, parche mínimo, vacíos, texto derivado).
//  • El repo no tiene jsdom ni testing-library: los componentes se verifican leyendo el código para fijar lo que NO debe pasar
//    (tocar versiones, mostrar bloques vacíos, ofrecer la edición a quien no es dueño, cambiar «Otra versión»).
// Ejecutar: node --test "tests/*.test.mjs"
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const D = await import('../src/features/song/song-details.ts');
const { DETAIL_LIMITS, normalizeDetail, charCount, draftFrom, validateDetails, buildDetailsPatch, hasChanges, hasText, customStyleSummary, derivedStyleHint } = D;

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const song = (over = {}) => ({ title: 'Luces de Neón', styleSummary: null, description: null, ...over });

/* ───────────── normalización y límites (espejo del backend) ───────────── */

test('los límites coinciden con los del backend: nombre 120, resumen 200, descripción 500', () => {
  assert.deepEqual({ ...DETAIL_LIMITS }, { title: 120, styleSummary: 200, description: 500 });
});

test('normalizeDetail: recorta, quita caracteres de control y respeta una línea o párrafos', () => {
  assert.equal(normalizeDetail('  hola\u0000 ​mundo  '), 'hola mundo');
  assert.equal(normalizeDetail('a\nb   c'), 'a b c');
  assert.equal(normalizeDetail('p1\r\n\r\n\r\n\r\np2 \n', true), 'p1\n\np2');
  assert.equal(normalizeDetail(null), '');
  assert.equal(normalizeDetail('​  \n'), '');
});

test('charCount cuenta caracteres reales (un emoji es uno)', () => {
  assert.equal(charCount('🎸🎸'), 2);
  assert.equal(charCount('canción'), 7);
});

test('validateDetails: nombre obligatorio y límites exactos', () => {
  const ok = { title: 'a'.repeat(120), styleSummary: 'b'.repeat(200), description: 'c'.repeat(500) };
  assert.deepEqual(validateDetails(ok), {});
  assert.ok(validateDetails({ ...ok, title: '   ' }).title, 'el nombre no puede quedar vacío');
  assert.ok(validateDetails({ ...ok, title: 'a'.repeat(121) }).title);
  assert.ok(validateDetails({ ...ok, styleSummary: 'b'.repeat(201) }).styleSummary);
  assert.ok(validateDetails({ ...ok, description: 'c'.repeat(501) }).description);
});

test('el largo se mide después de normalizar (el relleno de espacios no cuenta)', () => {
  assert.deepEqual(validateDetails({ title: 'x', styleSummary: `${' '.repeat(300)}${'b'.repeat(200)}`, description: '' }), {});
});

test('resumen y descripción son opcionales: vacíos son válidos', () => {
  assert.deepEqual(validateDetails({ title: 'x', styleSummary: '', description: '' }), {});
});

/* ───────────── parche mínimo ───────────── */

test('sin cambios ⇒ parche vacío (nada que guardar)', () => {
  const s = song({ styleSummary: 'Folk', description: 'Hola' });
  assert.equal(hasChanges(buildDetailsPatch(s, draftFrom(s))), false);
  // espacios de más o saltos de línea sobrantes tampoco cuentan como cambio
  assert.equal(hasChanges(buildDetailsPatch(s, { title: 'Luces de Neón  ', styleSummary: '  Folk ', description: 'Hola\n\n\n' })), false);
});

test('solo viajan los campos que cambiaron', () => {
  const s = song({ styleSummary: 'Folk', description: 'Hola' });
  assert.deepEqual(buildDetailsPatch(s, { ...draftFrom(s), title: 'Otro nombre' }), { title: 'Otro nombre' });
  assert.deepEqual(buildDetailsPatch(s, { ...draftFrom(s), description: 'Chau' }), { description: 'Chau' });
  assert.deepEqual(buildDetailsPatch(s, { ...draftFrom(s), styleSummary: 'Rock' }), { styleSummary: 'Rock' });
});

test('vaciar un campo guardado lo borra (null); vaciar uno ya vacío no cambia nada', () => {
  const filled = song({ styleSummary: 'Folk', description: 'Hola' });
  assert.deepEqual(buildDetailsPatch(filled, { title: filled.title, styleSummary: '', description: '   ' }), { styleSummary: null, description: null });
  const bare = song();
  assert.equal(hasChanges(buildDetailsPatch(bare, { title: bare.title, styleSummary: '', description: '' })), false);
});

test('canción histórica (campos ausentes): agregar una descripción es solo ese campo', () => {
  const legacy = { title: 'Vieja' }; // sin styleSummary ni description
  assert.deepEqual(buildDetailsPatch(legacy, { title: 'Vieja', styleSummary: '', description: 'Nueva' }), { description: 'Nueva' });
});

test('el nombre nunca viaja vacío: un nombre en blanco no genera cambio de título', () => {
  const s = song();
  assert.equal('title' in buildDetailsPatch(s, { ...draftFrom(s), title: '   ' }), false);
});

test('el parche nunca incluye versión vigente, visibilidad, proyecto ni portada', () => {
  const s = song({ description: 'a' });
  const patch = buildDetailsPatch(s, { title: 'n', styleSummary: 'r', description: 'd' });
  assert.deepEqual(Object.keys(patch).sort(), ['description', 'styleSummary', 'title']);
});

/* ───────────── presentación ───────────── */

test('hasText y customStyleSummary: sin texto no hay bloque (null, vacío, espacios)', () => {
  for (const empty of [null, undefined, '', '   ', '\n']) {
    assert.equal(hasText(empty), false);
    assert.equal(customStyleSummary({ styleSummary: empty }), null);
  }
  assert.equal(hasText('hola'), true);
  assert.equal(customStyleSummary({ styleSummary: '  Folk suave  ' }), 'Folk suave');
});

test('derivedStyleHint: estilos derivados de la versión, sin comillas ni repetidos', () => {
  assert.equal(derivedStyleHint('"folk", pop', ['pop', 'guitarra']), 'folk, pop, guitarra');
  assert.equal(derivedStyleHint(null, null), '');
});

/* ───────────── estructura del código ───────────── */

test('el formulario guarda con UN PATCH (songsApi.update) y no toca versiones, generaciones ni archivos', () => {
  const dialog = read('src/features/song/EditSongDetailsDialog.tsx');
  assert.match(dialog, /songsApi\.update\(song\.id, patch\)/);
  for (const forbidden of ['songsApi.versions', 'songsApi.uploadCover', 'generationApi', 'currentVersionId', 'songsApi.setVisibility', 'songsApi.remove']) {
    assert.equal(dialog.includes(forbidden), false, `el diálogo no debe usar ${forbidden}`);
  }
  // sincroniza lo que ya sincronizaba el renombrado: canción, listados, generaciones (embeben el título) y player
  assert.match(dialog, /invalidateQueries\(\{ queryKey: \['song', song\.id\] \}\)/);
  assert.match(dialog, /invalidateQueries\(\{ queryKey: \['songs'\] \}\)/);
  assert.match(dialog, /invalidateQueries\(\{ queryKey: \['community', 'song', song\.id\] \}\)/);
  assert.match(dialog, /renameTrack\(song\.id, patch\.title\)/);
});

test('el formulario es accesible: etiquetas, errores anunciados, contadores, tamaño táctil y no se cierra guardando', () => {
  const dialog = read('src/features/song/EditSongDetailsDialog.tsx');
  assert.match(dialog, /htmlFor=\{id\('title'\)\}/);
  assert.match(dialog, /htmlFor=\{id\('style'\)\}/);
  assert.match(dialog, /htmlFor=\{id\('desc'\)\}/);
  assert.match(dialog, /role="alert"/);
  assert.match(dialog, /aria-invalid/);
  assert.match(dialog, /aria-describedby/);
  assert.match(dialog, /aria-busy/);
  assert.match(dialog, /min-h-11/);
  assert.match(dialog, /if \(mutation\.isPending\) return;/);
  assert.match(dialog, /disabled=\{!dirty \|\| invalid \|\| pending\}/);
});

test('la portada reutiliza el diálogo «Cambiar portada» existente (no se duplica la subida)', () => {
  const dialog = read('src/features/song/EditSongDetailsDialog.tsx');
  const view = read('src/features/song/SongDetailView.tsx');
  assert.match(dialog, /onChangeCover/);
  assert.match(view, /onChangeCover=\{\(\) => setCoverDialogOpen\(true\)\}/);
  assert.match(view, /uploadCoverMutation/);
  assert.match(view, /<DialogTitle className="font-display">Cambiar portada<\/DialogTitle>/);
});

test('el detalle ofrece «Editar detalles» y monta el formulario SOLO para el dueño', () => {
  const view = read('src/features/song/SongDetailView.tsx');
  // `access.canModify` = dueño y canción activa (en la Papelera no se edita): ver features/song/trashed-song.ts
  assert.match(view, /\{access\.canModify && \(\s*<DropdownMenuItem onClick=\{\(\) => setDetailsOpen\(true\)\}[^>]*>\s*<Pencil[^>]*\/> Editar detalles/);
  assert.match(view, /\{access\.canModify && \(\s*<EditSongDetailsDialog/);
  assert.equal(view.includes('Editar título'), false, 'el renombrado ahora vive en el formulario unificado');
});

test('la descripción solo se pinta si existe y el resumen cae a los estilos derivados', () => {
  const view = read('src/features/song/SongDetailView.tsx');
  assert.match(view, /\{hasText\(song\.description\) && \(/);
  assert.match(view, /customStyleSummary\(song\)/);
  assert.match(view, /styleSummary \? \(/);
  // sin resumen propio se conservan el género y las etiquetas de la versión (presentación derivada)
  assert.match(view, /\{genre && <Chip/);
  assert.match(view, /tags\.map\(\(t\) => \(/);
});

test('el detalle público recibe los textos nuevos (songFromCommunity) y los tipos los declaran', () => {
  const view = read('src/features/song/SongDetailView.tsx');
  assert.match(view, /styleSummary: c\.styleSummary \?\? null,/);
  assert.match(view, /description: c\.description \?\? null,/);
  const types = read('src/types/index.ts');
  assert.match(types, /styleSummary\?: string \| null;/);
  assert.match(types, /description\?: string \| null;/);
  const api = read('src/lib/api/index.ts');
  assert.match(api, /styleSummary\?: string \| null; description\?: string \| null/);
});

test('«Otra versión» sigue igual: misma entrada de menú, misma ruta y el creador no se tocó', () => {
  const view = read('src/features/song/SongDetailView.tsx');
  assert.match(view, /navigate\(`\/create\?song=\$\{songId\}`\)/);
  assert.match(view, /<Sparkles className="h-4 w-4" aria-hidden \/> Otra versión/);
  // «Editar detalles» no navega al creador ni usa su parámetro
  const dialog = read('src/features/song/EditSongDetailsDialog.tsx');
  assert.equal(dialog.includes('/create'), false);
});
