// Papelera general (Biblioteca › Papelera): lógica pura + comprobaciones estructurales del código fuente.
//  • trash-utils.ts es puro: se prueba el comportamiento (tipos, rutas, aviso previo a restaurar, refresco de caché, 404 = «ya no está»).
//  • El repo no tiene jsdom ni testing-library: los componentes se verifican leyendo el código para impedir que reaparezca el
//    «Eliminar» definitivo o que la Papelera pierda sus garantías (borrado lógico, sin purga ni vencimiento).
// Ejecutar: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TRASH_TYPE_KEYS, TRASH_TYPE_LABELS, TRASH_EMPTY, TRASH_RESTORED_TITLE, trashTypeFromPath, trashPathFor, isAlreadyGone, restoreWarning, keysToInvalidate,
} from '../src/features/library/trash-utils.ts';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('la Papelera cubre exactamente los cinco tipos y cada uno tiene etiqueta, vacío y aviso de restauración', () => {
  assert.deepEqual([...TRASH_TYPE_KEYS], ['songs', 'lyrics', 'projects', 'songwriters', 'samples']);
  for (const key of TRASH_TYPE_KEYS) {
    assert.ok(TRASH_TYPE_LABELS[key], `etiqueta de ${key}`);
    assert.ok(TRASH_EMPTY[key].title && TRASH_EMPTY[key].description, `estado vacío de ${key}`);
    assert.ok(TRASH_RESTORED_TITLE[key], `aviso de restaurado de ${key}`);
  }
});

test('ruta /library/trash/<tipo>: tipos válidos, por omisión canciones y vuelta de ida y vuelta', () => {
  for (const key of TRASH_TYPE_KEYS) assert.equal(trashTypeFromPath(trashPathFor(key)), key);
  for (const path of ['/library/trash', '/library/trash/', '/library/trash/algo-raro', '/library/songs']) assert.equal(trashTypeFromPath(path), 'songs', path);
});

test('un 404 al restaurar/enviar significa que otra sesión ya lo hizo: no es un error', () => {
  assert.equal(isAlreadyGone({ status: 404 }), true);
  for (const err of [{ status: 403 }, { status: 409 }, { status: 500 }, new Error('x'), null, undefined, 'x']) assert.equal(isAlreadyGone(err), false, String(err));
});

test('aviso previo a restaurar: canción pública y voz clonada sí; el resto se restaura sin confirmar', () => {
  assert.match(restoreWarning('songs', { visibility: 'PUBLIC' }), /Comunidad/);
  assert.equal(restoreWarning('songs', { visibility: 'PRIVATE' }), null);
  const voice = restoreWarning('samples', { sunoPersonaId: 'voice_1' });
  assert.match(voice, /no garantiza/, 'no se simula que la voz externa siga vigente');
  assert.equal(restoreWarning('samples', { sunoPersonaId: null }), null);
  for (const type of ['lyrics', 'projects', 'songwriters']) assert.equal(restoreWarning(type, { visibility: 'PUBLIC', sunoPersonaId: 'x' }), null, type);
});

test('refresco de caché: cada tipo refresca sus listas y siempre la Papelera; canciones también la Comunidad', () => {
  for (const type of TRASH_TYPE_KEYS) assert.deepEqual(keysToInvalidate(type).at(-1), ['trash'], type);
  assert.ok(keysToInvalidate('songs').some((k) => k[0] === 'community'));
  assert.ok(keysToInvalidate('songs').some((k) => k[0] === 'songs'));
  assert.ok(keysToInvalidate('projects').some((k) => k[0] === 'projects'));
  assert.ok(keysToInvalidate('samples').some((k) => k[0] === 'voice-sessions'));
});

/* ───────────── código: endpoints, textos y navegación ───────────── */

const api = read('src/lib/api/index.ts');
const tab = read('src/features/library/TrashTab.tsx');
const utils = read('src/features/library/library-utils.tsx');

test('cada recurso expone trash() y restore() contra su propio endpoint (sin endpoint genérico)', () => {
  for (const resource of ['songs', 'lyrics', 'projects', 'lyric-personas', 'samples']) {
    assert.ok(api.includes(`'/${resource}/trash'`), `GET /${resource}/trash`);
    assert.ok(api.includes(`/${resource}/\${id}/restore`), `POST /${resource}/:id/restore`);
  }
  assert.ok(!/['"`]\/trash['"`]/.test(api), 'no hay una tabla/endpoint genérico /trash');
});

test('Biblioteca tiene la pestaña «Papelera» y la renderiza', () => {
  assert.match(utils, /key: 'trash', label: 'Papelera'/);
  assert.match(read('src/features/library/LibraryView.tsx'), /tab === 'trash' && <TrashTab \/>/);
  assert.match(read('src/components/layout/Sidebar.tsx'), /\/library\/trash/);
});

test('la Papelera solo restaura: sin eliminación definitiva ni purga, y trata el 404 como «ya no estaba»', () => {
  assert.ok(!/\.remove\(|Eliminar definitivamente|Vaciar/.test(tab), 'sin acciones de borrado definitivo');
  assert.match(tab, /isAlreadyGone\(err\)/);
  assert.match(tab, /Por ahora no se borra nada definitivamente/);
});

test('las acciones de borrado ya no prometen un borrado: se llaman «Enviar a la Papelera» (voces/clonaciones fallidas no cambian)', () => {
  const files = {
    songs: 'src/features/library/SongsTab.tsx', lyrics: 'src/features/library/LyricsTab.tsx', projects: 'src/features/library/ProjectsTab.tsx',
    songwriters: 'src/features/library/SongwritersTab.tsx', samples: 'src/features/library/SamplesTab.tsx', voices: 'src/features/library/VoicesTab.tsx',
    detail: 'src/features/song/SongDetailView.tsx',
  };
  for (const [name, path] of Object.entries(files)) {
    const src = read(path).replace(/Eliminar (esta )?clonaci[oó]n[^\n]*/g, '').replace(/Eliminar comentario[^\n]*/g, '');
    assert.ok(src.includes('Enviar a la Papelera'), `${name}: usa «Enviar a la Papelera»`);
    assert.ok(!/No se puede deshacer|no se puede deshacer/.test(src), `${name}: ya no dice que no se puede deshacer`);
    assert.ok(!/<Trash2[^>]*\/> Eliminar\b/.test(src), `${name}: el ítem del menú ya no dice «Eliminar»`);
  }
});

test('restaurar usa un botón no destructivo (el ConfirmDialog admite destructive=false)', () => {
  assert.match(utils, /destructive = true/);
  assert.match(tab, /destructive=\{false\}/);
});
