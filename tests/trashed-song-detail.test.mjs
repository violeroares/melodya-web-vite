// Canción propia en la Papelera dentro del MISMO detalle (#/songs/:id).
//  • trashed-song.ts es puro: se prueba qué se ofrece (solo lectura + restaurar), qué se pide a Comunidad (nada) y cuándo se cae al detalle público.
//  • El repo no tiene jsdom: SongDetailView/TrashTab se verifican leyendo el código fuente (mismo criterio que trash.test.mjs).
// Ejecutar: node --test tests/trashed-song-detail.test.mjs
import './_helpers/register-ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { isSongTrashed, songDetailAccess, shouldFallbackToCommunity, restoreInvalidationKeys } = await import('../src/features/song/trashed-song.ts');
const { songDetailPath } = await import('../src/features/library/trash-utils.ts');

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const active = { deletedAt: null, visibility: 'PUBLIC' };
const trashedPublic = { deletedAt: '2026-11-17T10:00:00.000Z', visibility: 'PUBLIC' };
const trashedPrivate = { deletedAt: '2026-11-17T10:00:00.000Z', visibility: 'PRIVATE' };

test('isSongTrashed: solo `deletedAt` con fecha', () => {
  assert.equal(isSongTrashed(trashedPublic), true);
  assert.equal(isSongTrashed(active), false);
  assert.equal(isSongTrashed({}), false);
  assert.equal(isSongTrashed(null), false);
});

test('en la Papelera (dueño): aviso + restaurar, y todo lo que modifica, comparte, descarga o vive en Comunidad queda cerrado', () => {
  for (const song of [trashedPublic, trashedPrivate]) {
    const a = songDetailAccess(song, true);
    assert.equal(a.trashed, true);
    assert.equal(a.showTrashBanner, true);
    assert.equal(a.canModify, false, 'sin edición, portada, visibilidad, otra versión ni versión activa');
    assert.equal(a.canDownload, false, 'sin MP3/WAV');
    assert.equal(a.canShare, false);
    assert.equal(a.showCommunity, false, 'sin reacciones, comentarios, remix ni «más del autor»');
    assert.equal(a.fetchCommunity, false, 'no se pide GET /community/songs/:id (daría 404)');
  }
});

test('una canción pública en la Papelera NO pide Comunidad aunque conserve visibility PUBLIC', () => {
  assert.equal(songDetailAccess(trashedPublic, true).fetchCommunity, false);
  assert.equal(songDetailAccess(trashedPublic, false).fetchCommunity, false);
});

test('canción activa: el comportamiento no cambia', () => {
  const owner = songDetailAccess(active, true);
  assert.deepEqual(owner, { trashed: false, showTrashBanner: false, canModify: true, canDownload: true, canShare: true, showCommunity: true, fetchCommunity: true });
  const guest = songDetailAccess(active, false);
  assert.equal(guest.canModify, false);
  assert.equal(guest.canDownload, false);
  assert.equal(guest.showCommunity, true);
  const priv = songDetailAccess({ deletedAt: null, visibility: 'PRIVATE' }, true);
  assert.equal(priv.canModify, true);
  assert.equal(priv.showCommunity, false);
  assert.equal(priv.fetchCommunity, false);
});

test('el detalle propio solo cae al detalle público con 404/403; red, 5xx y 401 se muestran', () => {
  assert.equal(shouldFallbackToCommunity({ status: 404 }), true);
  assert.equal(shouldFallbackToCommunity({ status: 403 }), true);
  for (const status of [0, 401, 429, 500, 502, 503]) assert.equal(shouldFallbackToCommunity({ status }), false, String(status));
  assert.equal(shouldFallbackToCommunity(new Error('Network Error')), false);
  assert.equal(shouldFallbackToCommunity(null), false);
});

test('restaurar refresca la canción, Biblioteca, Papelera y Comunidad', () => {
  const keys = restoreInvalidationKeys('abc').map((k) => k.join('/'));
  for (const expected of ['song/abc', 'songs', 'trash', 'community', 'generations']) assert.ok(keys.includes(expected), expected);
});

test('Papelera: la ruta de una canción es el mismo detalle #/songs/:id', () => {
  assert.equal(songDetailPath('8a20d14f-0e26-4873-ae2e-6e343fc6def3'), '/songs/8a20d14f-0e26-4873-ae2e-6e343fc6def3');
});

/* ── estructura del código (sin jsdom) ── */
const detail = read('src/features/song/SongDetailView.tsx');

test('SongDetailView: el catch del detalle propio ya no es vacío y delega en shouldFallbackToCommunity', () => {
  assert.doesNotMatch(detail, /catch\s*\{\s*\/\*[^*]*\*\/\s*\}/, 'no queda un catch vacío');
  assert.match(detail, /catch \(err\) \{[\s\S]{0,400}if \(!shouldFallbackToCommunity\(err\)\) throw err;/);
});

test('SongDetailView: todo lo que habla con Comunidad pasa por `access` (Papelera = ninguna llamada)', () => {
  assert.match(detail, /enabled: access\.fetchCommunity/);
  assert.match(detail, /const community = access\.showCommunity \?/);
  // authorMore / genreMore / remixes dependen de `community`, que es null en la Papelera.
  assert.match(detail, /enabled: Boolean\(community\)/);
  assert.match(detail, /enabled: Boolean\(community && primaryGenre\)/);
  assert.match(detail, /enabled: Boolean\(community\) && \(song\?\.remixCount/);
  // El registro de reproducciones solo corre para canciones públicas y activas.
  assert.match(detail, /onPlayed:\s*\n\s*access\.showCommunity/);
  assert.doesNotMatch(detail, /song\.visibility === 'PUBLIC' &&\s*\(\s*<section className="space-y-4" aria-label="Autor y reacciones"/);
});

test('SongDetailView: banner, Restaurar y acciones restringidas se gobiernan con `access`', () => {
  assert.match(detail, /Esta canción está en la Papelera/);
  assert.match(detail, /songsApi\.restore\(songId\)/);
  assert.match(detail, /restoreInvalidationKeys\(songId\)/);
  for (const flag of ['access.canModify && (', 'access.canDownload && currentVersion?.audioUrl', 'access.canShare && (', 'access.showCommunity ? (']) {
    assert.ok(detail.includes(flag), flag);
  }
  assert.match(detail, /disabled=\{!access\.canModify \|\| /, 'la versión activa no se cambia en la Papelera');
  assert.match(detail, /\{!isTrashed && remixMenuState/);
  assert.match(detail, /trashed: isTrashed \|\| undefined/);
});

test('SongDetailView: consultar una canción en la Papelera no la restaura (solo el botón lo hace)', () => {
  const uses = [...detail.matchAll(/restoreMutation\.mutate\(\)/g)];
  assert.equal(uses.length, 2, 'solo el botón del aviso y el ítem del menú');
  assert.doesNotMatch(detail, /useEffect\([^)]*restore/);
});

test('TrashTab: portada y título de las canciones abren el detalle; los demás tipos y Restaurar no cambian', () => {
  const trash = read('src/features/library/TrashTab.tsx');
  assert.equal([...trash.matchAll(/<Link to=\{songDetailPath\(row\.id\)\}/g)].length, 2, 'portada + título');
  assert.match(trash, /type === 'songs' \? \(\s*\n\s*\/\*[^\n]*\n\s*<Link/);
  assert.match(trash, /\{type === 'songs' \? \(\s*\n\s*<Link to=\{songDetailPath\(row\.id\)\}/);
  assert.match(trash, /aria-label=\{`Restaurar \$\{row\.title\}`\}/);
  assert.match(trash, /onClick=\{\(\) => ask\(row\)\}/);
});

test('Mi actividad: el enlace «Ver canción» no cambió (#/songs/:id)', () => {
  assert.match(read('src/features/activity/ActivityHistory.tsx'), /navigate\(`\/songs\/\$\{g\.songId\}`\)/);
});

test('el reproductor no descarga canciones en la Papelera', () => {
  assert.match(read('src/components/player/ExpandedPlayer.tsx'), /track\?\.own !== false && !track\?\.trashed/);
});

test('reproducción en la Papelera: la pista usa descarga autenticada (isPublic false) y no lleva gancho de conteo', async () => {
  const { usesAuthenticatedSource } = await import('../src/stores/player-source.ts');
  assert.equal(usesAuthenticatedSource({ audioUrl: 'http://api/files/1/stream', isPublic: false }, true), true, 'el audio de una canción borrada solo lo sirve el backend al dueño con sesión');
  const detail = read('src/features/song/SongDetailView.tsx');
  assert.match(detail, /isPublic: access\.showCommunity,/);
  assert.match(detail, /trashed: isTrashed \|\| undefined/);
  // «Reproducir a continuación / cola» solo existe en la sección de Comunidad, que no se muestra en la Papelera.
  assert.match(detail, /\{access\.showCommunity && \(\s*<section className="space-y-4" aria-label="Autor y reacciones">[\s\S]*onQueue\('next'\)/);
});

test('el reproductor expandido oculta Compartir (no lo deshabilita) y bloquea la descarga en la Papelera', () => {
  const player = read('src/components/player/ExpandedPlayer.tsx');
  assert.match(player, /\{!track\.trashed && \(\s*<Tooltip>\s*<TooltipTrigger asChild>\s*<Button variant="ghost" size="icon" onClick=\{\(\) => void share\(\)\}/);
  assert.doesNotMatch(player, /disabled=\{Boolean\(track\.trashed\)\}/);
});

test('canción enviada a la Papelera con la pista ya en el reproductor: se marca desde los 4 puntos de entrada, sin consultas nuevas', () => {
  assert.match(read('src/features/library/SongsTab.tsx'), /onSuccess: \(_res, id\) => \{\s*usePlayerStore\.getState\(\)\.setTrackTrashed\(id, true\)/);
  const detail = read('src/features/song/SongDetailView.tsx');
  assert.match(detail, /setTrackTrashed\(songId, true\); \/\/ si estaba en la cola/);
  assert.match(detail, /setTrackTrashed\(songId, false\);/);
  assert.match(detail, /if \(isTrashed\) usePlayerStore\.getState\(\)\.setTrackTrashed\(songId, true\)/);
  assert.match(read('src/features/library/TrashTab.tsx'), /if \(type === 'songs'\) usePlayerStore\.getState\(\)\.setTrackTrashed\(id, false\)/);
});
